// Turns two API surfaces (old and new version) into migration rules.
// Sources, in order of trust: hand-written recipes, the library's own @deprecated notes
// ("Use `faker.string.numeric()` instead"), and same-signature renames found by comparison.
import type { ApiEntry, SigInfo, Surface } from "./surface.ts";

export type Rule =
  | { kind: "rename"; from: string; to: string; objectArgs?: string[]; alternatives?: string[]; source: RuleSource; note: string }
  | { kind: "toObject"; path: string; sigKey: string; names: string[]; source: RuleSource; note: string }
  | { kind: "renameOption"; path: string; to: string; source: RuleSource; note: string }
  | { kind: "removed"; path: string; source: RuleSource; note: string };

export type RuleSource = "recipe" | "deprecation" | "signature-match" | "removed";

export interface HintTarget {
  path: string;
  objectArgs?: string[];
  bare: boolean;
}

const CODE_SPAN = /`([^`]+)`/g;
const PATH_CALL = /^\s*([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*(?:\(([\s\S]*)\))?\s*;?\s*$/;

/** Reads the replacement(s) named in a @deprecated note. */
export function parseHint(text: string): HintTarget[] {
  const out: HintTarget[] = [];
  const spans = [...text.matchAll(CODE_SPAN)].map((m) => m[1]);
  if (!spans.length) {
    const m = text.match(/\b(?:use|replaced (?:by|with))\s+([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+)\s*(\(\))?/i);
    if (m) spans.push(m[1] + (m[2] ?? ""));
  }
  for (const span of spans) {
    const m = span.match(PATH_CALL);
    if (!m) continue;
    const path = m[1];
    let objectArgs: string[] | undefined;
    const args = m[2]?.trim();
    if (args) {
      const obj = args.match(/^\{([\s\S]*)\}$/);
      if (obj) {
        objectArgs = obj[1].split(",").map((s) => s.trim().replace(/^\.\.\./, "").replace(/[?:].*$/, "").trim()).filter((s) => /^[A-Za-z_$][\w$]*$/.test(s));
        if (!objectArgs.length) objectArgs = undefined;
      }
    }
    out.push({ path, objectArgs, bare: !path.includes(".") && m[2] === undefined });
  }
  return out;
}

function lastSegment(path: string): string {
  return path.split(/[.#:]/).pop()!;
}

function parentOf(path: string): string {
  const i = Math.max(path.lastIndexOf("."), path.lastIndexOf("#"));
  return i === -1 ? "" : path.slice(0, i);
}

/** Tries the hint path as written, then rooted like the old path (hint "person.firstName" for "faker.name.x"). */
export function locate(hint: string, oldPath: string, next: Surface): string | undefined {
  if (next.entries.has(hint)) return hint;
  const root = oldPath.split(/[.#]/)[0];
  if (next.entries.has(root + "." + hint)) return root + "." + hint;
  const prefixed = oldPath.includes(":") ? oldPath.slice(0, oldPath.indexOf(":") + 1) + hint : undefined;
  if (prefixed && next.entries.has(prefixed)) return prefixed;
  // Hints often name an instance ("client.users.get()") rather than the export ("Client#users.get").
  const tail = hint.split(".").slice(1).join(".");
  if (tail) {
    const matches = [...next.entries.keys()].filter((k) => k.startsWith(root) && (k.endsWith("." + tail) || k.endsWith("#" + tail)) && !k.includes("("));
    if (matches.length === 1) return matches[0];
  }
  return undefined;
}

function positionalNames(sig: SigInfo, hintNames: string[]): string[] | undefined {
  const params = sig.params.filter((p) => !p.rest);
  if (!params.length || params.length !== sig.params.length) return undefined;
  // An overload that already takes an options object is not "positional": leave it to the compiler check.
  if (params.some((p) => p.type.trim().startsWith("{") || /^(options|opts|config)$/i.test(p.name))) return undefined;
  if (params.every((p) => hintNames.includes(p.name))) return params.map((p) => p.name);
  if (params.length <= hintNames.length) return hintNames.slice(0, params.length);
  return undefined;
}

/** A callable can only be replaced by a callable, and a path can't be replaced by its own parent. */
function compatible(from: ApiEntry, to: ApiEntry): boolean {
  if (from.path.startsWith(to.path + ".") || from.path.startsWith(to.path + "#")) return false;
  const callable = (e: ApiEntry) => e.signatures.length > 0 || e.kind === "method" || e.kind === "function";
  return callable(from) === callable(to) || from.kind === "class" || to.kind === "class";
}

/** Same-signature renames must also look alike (closeConnection / disconnect share "connect"),
 *  otherwise any two `() => string` methods would match (internet.avatar / internet.jwtAlgorithm). */
export function similarNames(a: string, b: string): boolean {
  const x = a.toLowerCase(), y = b.toLowerCase();
  let best = 0;
  for (let i = 0; i < x.length; i++) {
    for (let j = 0; j < y.length; j++) {
      let k = 0;
      while (i + k < x.length && j + k < y.length && x[i + k] === y[j + k]) k++;
      if (k > best) best = k;
    }
  }
  return best >= Math.min(5, Math.min(x.length, y.length));
}

/** Copies @deprecated notes from a newer release of the same major (they are usually added
 *  there, just before the removal) onto the installed version's surface. */
export function withNotesFrom(prev: Surface, bridge: Surface | undefined): Surface {
  if (!bridge) return prev;
  const entries = new Map(prev.entries);
  for (const [path, e] of prev.entries) {
    const b = bridge.entries.get(path);
    if (!b) continue;
    const signatures = e.signatures.map((s) => s.deprecated ? s : { ...s, deprecated: b.signatures.find((x) => x.text === s.text)?.deprecated });
    if (!e.deprecated && b.deprecated) entries.set(path, { ...e, deprecated: b.deprecated, signatures });
    else if (signatures.some((s, i) => s.deprecated !== e.signatures[i].deprecated)) entries.set(path, { ...e, signatures });
  }
  return { ...prev, entries };
}

export function deriveRules(prev: Surface, next: Surface, recipeRules: Rule[] = []): Rule[] {
  const rules: Rule[] = [...recipeRules];
  const covered = new Set(recipeRules.map((r) => (r.kind === "rename" ? r.from : r.path)));

  for (const e of prev.entries.values()) {
    if (covered.has(e.path)) continue;
    const goneInNext = !next.entries.has(e.path);

    // 1. Deprecated option property: `{ abbr: true }` -> `{ abbreviated: true }`
    if (e.kind === "option" && e.deprecated) {
      const hint = parseHint(e.deprecated).find((h) => h.bare);
      if (hint) rules.push({ kind: "renameOption", path: e.path, to: hint.path, source: "deprecation", note: e.deprecated });
      continue;
    }
    if (e.kind === "option") continue;

    // 2. Deprecated member with a documented replacement.
    if (e.deprecated) {
      const hints = parseHint(e.deprecated).filter((h) => !h.bare || !e.path.includes("."));
      const targets: Array<{ to: string; objectArgs?: string[] }> = [];
      for (const h of hints) {
        const target = locate(h.path, e.path, next);
        if (!target || !compatible(e, next.entries.get(target)!)) continue;
        if (target === e.path && !h.objectArgs) continue;
        if (!targets.some((t) => t.to === target)) targets.push({ to: target, objectArgs: h.objectArgs });
      }
      if (targets.length) {
        rules.push({ kind: "rename", from: e.path, to: targets[0].to, objectArgs: targets[0].objectArgs, alternatives: targets.slice(1).map((t) => t.to), source: "deprecation", note: e.deprecated });
      } else if (goneInNext) rules.push({ kind: "removed", path: e.path, source: "removed", note: e.deprecated });
    }

    // 3. Deprecated overload of a method that still exists: f(a, b) -> f({ a, b })
    for (const sig of e.signatures) {
      if (!sig.deprecated || !sig.declKey) continue;
      const hint = parseHint(sig.deprecated).find((h) => h.objectArgs);
      if (!hint) continue;
      const target = locate(hint.path, e.path, next) ?? (lastSegment(hint.path) === lastSegment(e.path) ? e.path : undefined);
      const names = positionalNames(sig, hint.objectArgs!);
      if (!names || !target) continue;
      if (target === e.path) rules.push({ kind: "toObject", path: e.path, sigKey: sig.declKey, names, source: "deprecation", note: sig.deprecated });
      else rules.push({ kind: "rename", from: e.path, to: target, objectArgs: names, source: "deprecation", note: sig.deprecated });
    }

    // 4. Removed without a note.
    if (goneInNext && !e.deprecated && e.kind !== "type") {
      rules.push({ kind: "removed", path: e.path, source: "removed", note: `Removed in ${next.version}; the library documents no replacement.` });
    }
  }

  // 5. Same-signature renames: one member disappeared and exactly one new member with the same
  //    parent and identical signature appeared. Low confidence; the compiler check decides.
  const added = [...next.entries.values()].filter((e) => !prev.entries.has(e.path) && e.signatures.length);
  const removedPaths = new Set(rules.filter((r) => r.kind === "removed").map((r) => (r as { path: string }).path));
  for (const path of removedPaths) {
    const old = prev.entries.get(path)!;
    if (!old.signatures.length) continue;
    const sigText = old.signatures.map((s) => s.text).join("|");
    const matches = added.filter((a) => parentOf(a.path) === parentOf(path) && a.signatures.map((s) => s.text).join("|") === sigText && similarNames(lastSegment(path), lastSegment(a.path)));
    if (matches.length === 1) {
      const i = rules.findIndex((r) => r.kind === "removed" && r.path === path);
      rules[i] = { kind: "rename", from: path, to: matches[0].path, source: "signature-match", note: `Renamed in ${next.version} (same signature).` };
    }
  }
  return rules;
}

export interface RuleIndex {
  byPath: Map<string, Rule[]>;
  bySig: Map<string, Rule>;
}

export function indexRules(rules: Rule[]): RuleIndex {
  const byPath = new Map<string, Rule[]>();
  const bySig = new Map<string, Rule>();
  for (const r of rules) {
    if (r.kind === "toObject") { bySig.set(r.sigKey, r); continue; }
    const key = r.kind === "rename" ? r.from : r.path;
    const list = byPath.get(key) ?? [];
    list.push(r);
    byPath.set(key, list);
  }
  return { byPath, bySig };
}

/** Finds the rule for a full path, falling back to a rule on a parent (faker.name -> faker.person). */
export function ruleForPath(index: RuleIndex, path: string, next: Surface): { rule: Rule; to?: string } | undefined {
  const exact = index.byPath.get(path)?.[0];
  if (exact) return { rule: exact, to: exact.kind === "rename" ? exact.to : undefined };
  let parent = parentOf(path);
  while (parent) {
    const r = index.byPath.get(parent)?.find((x) => x.kind === "rename");
    if (r && r.kind === "rename") {
      const candidate = r.to + path.slice(parent.length);
      if (next.entries.has(candidate)) return { rule: r, to: candidate };
      return undefined;
    }
    parent = parentOf(parent);
  }
  return undefined;
}

export type { ApiEntry };
