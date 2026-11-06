// The whole pipeline: compare versions, find what the upgrade breaks, fix it, and keep only the
// fixes the compiler accepts.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { buildSurface } from "./surface.ts";
import type { Surface } from "./surface.ts";
import { deriveRules, indexRules, withNotesFrom } from "./rules.ts";
import type { Rule } from "./rules.ts";
import { fetchPackage, installedPackage, resolveVersion } from "./npm.ts";
import { loadProject, overlayFor, ProgramFactory, diagnosticsOf, diagKey, diagKind } from "./project.ts";
import type { Diag, Project } from "./project.ts";
import { findUsages } from "./usages.ts";
import type { Usage } from "./usages.ts";
import { applyEdits } from "./edits.ts";
import type { Placed } from "./edits.ts";
import { loadRecipes } from "./recipes.ts";

export interface MigrateOptions {
  projectDir: string;
  pkg: string;
  to: string;
  deprecations?: boolean; // also rewrite deprecated calls that still compile
  log?: (msg: string) => void;
}

export interface FixedUsage { usage: Usage }
export interface RejectedUsage { usage: Usage; reason: string }

export interface MigrateResult {
  project: Project;
  pkg: string;
  from: string;
  to: string;
  rules: Rule[];
  usages: Usage[];
  brokenBefore: Diag[]; // errors the upgrade causes in the untouched code
  hiddenBreaks: Usage[]; // uses of removed APIs whose error is hidden behind another one
  remaining: Diag[]; // errors the upgrade still causes after Unbreak's fixes
  fixed: FixedUsage[];
  rejected: RejectedUsage[]; // fixes the compiler did not accept, so they were undone
  triedFirst: RejectedUsage[]; // replacements that failed before a later suggestion worked
  manual: Usage[]; // places Unbreak recognised but could not rewrite safely
  originals: Map<string, string>;
  updated: Map<string, string>;
  rounds: number;
  timings: Record<string, number>;
}

const MAX_ROUNDS = 6;

function overlaps(d: Diag, u: Usage): boolean {
  const dEnd = d.start + Math.max(d.length, 1);
  return d.file === u.file && d.start < u.end && dEnd > u.start;
}

/** Maps a position in edited text back to the original text. */
function toOld(placed: Placed[], pos: number): number {
  let delta = 0;
  for (const p of placed) {
    if (p.newEnd <= pos) delta = p.oldEnd - p.newEnd;
    else if (p.newStart <= pos) return p.oldStart;
    else break;
  }
  return pos + delta;
}

function subtractByKind(after: Diag[], baseline: Diag[]): Diag[] {
  const counts = new Map<string, number>();
  for (const d of baseline) { const k = d.file + "|" + diagKind(d); counts.set(k, (counts.get(k) ?? 0) + 1); }
  const out: Diag[] = [];
  for (const d of after) {
    const k = d.file + "|" + diagKind(d);
    const c = counts.get(k) ?? 0;
    if (c > 0) counts.set(k, c - 1);
    else out.push(d);
  }
  return out;
}

export function migrate(opts: MigrateOptions): MigrateResult {
  const log = opts.log ?? (() => {});
  const timings: Record<string, number> = {};
  const t = (label: string, start: number) => { timings[label] = Date.now() - start; };

  let s = Date.now();
  const project = loadProject(opts.projectDir);
  const installed = installedPackage(project.dir, opts.pkg);
  if (!installed) throw new Error(`${opts.pkg} is not installed in ${project.dir}. Run your package manager's install first, so Unbreak can see the version you use today.`);
  log(`Found ${opts.pkg}@${installed.version} in node_modules.`);
  const target = fetchPackage(opts.pkg, opts.to);
  if (target.version === installed.version) throw new Error(`${opts.pkg} is already at ${target.version}.`);
  log(`Fetched ${opts.pkg}@${target.version} for comparison (nothing is installed).`);
  t("fetch", s);

  s = Date.now();
  const installedSurface: Surface = buildSurface(installed.dir, opts.pkg, installed.version);
  const next: Surface = buildSurface(target.dir, opts.pkg, target.version);
  // Libraries usually add "@deprecated, use X" in the last releases before a major. If the project
  // is on an older release, borrow those notes from the newest release of its major.
  let bridge: Surface | undefined;
  const major = installed.version.split(".")[0];
  if (!process.env.UNBREAK_OFFLINE) try {
    const newest = resolveVersion(opts.pkg, major);
    if (newest !== installed.version && newest.split(".")[0] === major && newest !== target.version) {
      const b = fetchPackage(opts.pkg, newest);
      bridge = buildSurface(b.dir, opts.pkg, b.version);
      log(`Read deprecation notes from ${opts.pkg}@${newest}, the newest ${major}.x release.`);
    }
  } catch { /* offline or unpublished: carry on without */ }
  const prev = withNotesFrom(installedSurface, bridge);
  const rules = deriveRules(prev, next, loadRecipes(opts.pkg, installed.version, target.version));
  const index = indexRules(rules);
  log(`Compared the two APIs: ${prev.entries.size} → ${next.entries.size} members, ${rules.filter((r) => r.kind !== "removed").length} migration rules.`);
  t("surfaces", s);

  s = Date.now();
  const factory = new ProgramFactory(project);
  const baseProgram = factory.create(undefined, undefined);
  const baseline = diagnosticsOf(baseProgram, project);
  const usages = findUsages(baseProgram, project, opts.pkg, prev, next, index);
  t("scan", s);

  s = Date.now();
  const overlay = overlayFor(installed.dir, target.dir);
  const upgraded = factory.create(overlay, undefined);
  const upgradedDiags = diagnosticsOf(upgraded, project);
  const baseKeys = new Set(baseline.map(diagKey));
  const brokenBefore = upgradedDiags.filter((d) => !baseKeys.has(diagKey(d)));
  log(`Type-checked your code against ${target.version}: the upgrade breaks ${brokenBefore.length} place(s).`);
  t("check-upgraded", s);

  // Pick the usages to fix: those on an error the upgrade causes, plus those whose API is gone from the
  // new version (their errors can be hidden behind an earlier break, e.g. a missing import makes
  // everything after it untyped). With --deprecations, every deprecated use too.
  const willBreak = (u: Usage): boolean => {
    const r = u.rule;
    if (r.kind === "rename" || r.kind === "removed") return !next.entries.has(u.path);
    if (r.kind === "renameOption") {
      const method = u.path.slice(0, u.path.indexOf("("));
      const key = u.path.slice(u.path.lastIndexOf(".") + 1);
      return ![...next.entries.keys()].some((k) => k.startsWith(method + "(") && k.endsWith("." + key));
    }
    if (r.kind === "toObject") {
      const oldSig = prev.entries.get(r.path)?.signatures.find((x) => x.declKey === r.sigKey)?.text;
      return !next.entries.get(r.path)?.signatures.some((x) => x.text === oldSig);
    }
    return false;
  };
  const relevant = (u: Usage) => opts.deprecations || brokenBefore.some((d) => overlaps(d, u)) || willBreak(u);
  const hiddenBreaks = usages.filter((u) => willBreak(u) && !brokenBefore.some((d) => overlaps(d, u)));
  if (hiddenBreaks.length) log(`${hiddenBreaks.length} more use(s) of removed APIs are hidden behind those errors.`);
  const candidates = usages.filter((u) => u.edits.length && relevant(u));
  const manual = usages.filter((u) => !u.edits.length && relevant(u));
  const active = new Set(candidates.map((u) => u.id));
  const rejected: RejectedUsage[] = [];
  const originals = new Map<string, string>();
  for (const u of candidates) if (!originals.has(u.file)) originals.set(u.file, readFileSync(u.file, "utf8"));

  s = Date.now();
  let updated = new Map<string, string>();
  let remaining: Diag[] = brokenBefore;
  let rounds = 0;
  let last = upgraded;
  for (;; rounds++) {
    updated = new Map();
    const placedByFile = new Map<string, Placed[]>();
    for (const [file, text] of originals) {
      const edits = candidates.filter((u) => u.file === file && active.has(u.id)).flatMap((u) => u.edits.map((e) => ({ ...e, owner: u.id })));
      if (!edits.length) continue;
      const res = applyEdits(text, edits);
      for (const id of res.dropped) { active.delete(id); rejected.push({ usage: candidates.find((u) => u.id === id)!, reason: "overlaps another fix" }); }
      updated.set(file, res.text);
      placedByFile.set(file, res.placed);
    }
    const program = factory.create(overlay, updated, last);
    last = program;
    const after = diagnosticsOf(program, project);
    // Unchanged files compare exactly; edited files compare by error kind (positions moved).
    const unchanged = after.filter((d) => !updated.has(d.file));
    const edited = after.filter((d) => updated.has(d.file));
    remaining = [
      ...unchanged.filter((d) => !baseKeys.has(diagKey(d))),
      ...subtractByKind(edited, baseline.filter((d) => updated.has(d.file))),
    ];
    // Which fixes does the compiler reject?
    //  - an error inside a fix, or on its line, is blamed on that fix, unless the error sits on a
    //    known break Unbreak is not fixing (a removed API, an undone fix): that one is expected;
    //  - an error of a kind the upgrade alone never produced, not explained by a known break,
    //    undoes the fixes in that file (cautious: we can't tell which fix caused it).
    const blame = new Map<number, string>();
    const upgradedKinds = new Set(upgradedDiags.map((d) => d.file + "|" + diagKind(d)));
    for (const d of remaining) {
      const text = updated.get(d.file);
      const placed = placedByFile.get(d.file);
      if (!text || !placed) continue;
      const oldStart = toOld(placed, d.start);
      const explained = usages.some((u) => !active.has(u.id) && u.file === d.file && oldStart < u.end && oldStart + Math.max(d.length, 1) > u.start);
      const lineStart = text.lastIndexOf("\n", d.start - 1) + 1;
      const lineEndIdx = text.indexOf("\n", d.start);
      const lineEnd = lineEndIdx === -1 ? text.length : lineEndIdx;
      let blamed = false;
      for (const p of placed) {
        const inside = d.start < p.newEnd && d.start + Math.max(d.length, 1) > p.newStart;
        const sameLine = p.newEnd >= lineStart && p.newStart <= lineEnd;
        if ((inside || (sameLine && !explained)) && !blame.has(p.owner)) { blame.set(p.owner, d.message); blamed = true; }
      }
      if (blamed || explained || upgradedKinds.has(d.file + "|" + diagKind(d))) continue;
      for (const u of candidates) if (u.file === d.file && active.has(u.id) && !blame.has(u.id)) blame.set(u.id, `${d.message} (new error elsewhere in the file)`);
    }
    // Every round undoes at least one fix, so this loop always ends with a clean, final check.
    if (!blame.size) break;
    if (rounds >= MAX_ROUNDS) {
      // Many rounds usually means fixes interact badly: undo every fix in the files still blamed.
      const files = new Set([...blame.keys()].map((id) => candidates.find((u) => u.id === id)!.file));
      for (const u of candidates) if (files.has(u.file) && active.has(u.id) && !blame.has(u.id)) blame.set(u.id, "undone with the other fixes in this file");
    }
    for (const [id, reason] of blame) {
      if (!active.has(id)) continue;
      const u = candidates.find((x) => x.id === id)!;
      rejected.push({ usage: { ...u }, reason });
      // The library suggested more than one replacement: try the next one before giving up.
      const alt = u.alternates.shift();
      if (alt) { u.edits = alt.edits; u.summary = alt.summary; u.review = alt.review; continue; }
      active.delete(id);
    }
  }
  t("fix-and-verify", s);

  const fixed = candidates.filter((u) => active.has(u.id)).map((usage) => ({ usage }));
  // A fix that worked on a later suggestion is not "undone"; keep those attempts for the report.
  const fixedIds = new Set(fixed.map((f) => f.usage.id));
  const triedFirst = rejected.filter((x) => fixedIds.has(x.usage.id));
  rejected.splice(0, rejected.length, ...rejected.filter((x) => !fixedIds.has(x.usage.id) && rejected.filter((y) => y.usage.id === x.usage.id).pop() === x));
  for (const f of [...updated.keys()]) if (!fixed.some((x) => x.usage.file === f)) updated.delete(f);
  log(`Kept ${fixed.length} fix(es) the compiler accepts; undid ${rejected.length}.`);
  return { project, pkg: opts.pkg, from: installed.version, to: target.version, rules, usages, brokenBefore, hiddenBreaks, remaining, fixed, rejected, triedFirst, manual, originals, updated, rounds: rounds + 1, timings };
}

/** Writes the fixed files and bumps the version in package.json. Returns the files written. */
export function writeResult(r: MigrateResult, bumpPackageJson = true): string[] {
  const written: string[] = [];
  for (const [file, text] of r.updated) { writeFileSync(file, text); written.push(relative(r.project.dir, file)); }
  const pjPath = join(r.project.dir, "package.json");
  if (bumpPackageJson && existsSync(pjPath)) {
    const raw = readFileSync(pjPath, "utf8");
    const pj = JSON.parse(raw);
    let changed = false;
    for (const field of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
      const cur = pj[field]?.[r.pkg];
      if (typeof cur !== "string" || /^(workspace|file|link|git|https?):/.test(cur)) continue;
      const prefix = cur.match(/^[\^~]/)?.[0] ?? "";
      pj[field][r.pkg] = prefix + r.to;
      changed = true;
    }
    if (changed) {
      const indent = raw.match(/^[ \t]+(?=")/m)?.[0] ?? "  ";
      writeFileSync(pjPath, JSON.stringify(pj, null, indent) + (raw.endsWith("\n") ? "\n" : ""));
      written.push("package.json");
    }
  }
  return written;
}
