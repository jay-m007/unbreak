// Turns a migration result into a terminal summary and a Markdown report (usable as a PR description).
import { relative } from "node:path";
import type { MigrateResult } from "./migrate.ts";
import type { Usage } from "./usages.ts";
import type { Diag } from "./project.ts";
import { unifiedDiff } from "./edits.ts";

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code: number) => (s: string) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
export const bold = c(1), dim = c(2), red = c(31), green = c(32), yellow = c(33), cyan = c(36);

function where(r: MigrateResult, file: string, line: number): string {
  return `${relative(r.project.dir, file).replace(/\\/g, "/")}:${line + 1}`;
}

function diagLine(r: MigrateResult, d: Diag): string {
  return `${where(r, d.file, d.line)}  ${d.message}`;
}

export function diffText(r: MigrateResult): string {
  return [...r.updated].map(([file, text]) => unifiedDiff(relative(r.project.dir, file).replace(/\\/g, "/"), r.originals.get(file)!, text)).join("\n");
}

export function counts(r: MigrateResult) {
  return {
    broken: r.brokenBefore.length + r.hiddenBreaks.length,
    hidden: r.hiddenBreaks.length,
    fixes: r.fixed.length,
    undone: r.rejected.length,
    manual: r.manual.length,
    remaining: r.remaining.length,
    files: r.updated.size,
  };
}

export function terminalSummary(r: MigrateResult, applied: boolean): string {
  const n = counts(r);
  const lines: string[] = [];
  lines.push(bold(`Unbreak · ${r.pkg} ${r.from} → ${r.to}`));
  if (!n.broken && !n.fixes) {
    lines.push(green(`  Your code already type-checks against ${r.to}. Nothing to fix.`));
    return lines.join("\n");
  }
  lines.push(`  The upgrade breaks ${bold(String(n.broken))} place(s) in your code${n.hidden ? ` (${n.hidden} hidden behind other errors)` : ""}.`);
  lines.push(green(`  Fixed: ${n.fixes} change(s) in ${n.files} file(s), each one type-checks against ${r.to}.`));
  if (n.undone) lines.push(yellow(`  Undone: ${n.undone} change(s) the compiler did not accept.`));
  if (n.remaining) {
    lines.push((n.remaining ? red : green)(`  Still broken: ${n.remaining} place(s) need you:`));
    for (const d of r.remaining.slice(0, 12)) {
      const hint = r.manual.find((u) => u.file === d.file && u.line === d.line);
      const tried = r.rejected.find((x) => x.usage.file === d.file && x.usage.line === d.line);
      lines.push(`    ${dim(where(r, d.file, d.line))}  ${d.message.slice(0, 140)}`);
      if (hint) lines.push(`      ${cyan("hint:")} ${hint.rule.note.slice(0, 160)}`);
      if (tried) lines.push(`      ${cyan("tried:")} ${tried.usage.summary}, but the compiler said: ${tried.reason.slice(0, 140)}`);
    }
    if (r.remaining.length > 12) lines.push(dim(`    … and ${r.remaining.length - 12} more (see the report)`));
  } else {
    lines.push(green(`  Nothing left broken: your code type-checks against ${r.to}.`));
  }
  lines.push("");
  lines.push(applied ? green("Files written.") : dim("Dry run: nothing was changed. Add --apply to write these changes."));
  return lines.join("\n");
}

function group(usages: Usage[]): Map<string, Usage[]> {
  const m = new Map<string, Usage[]>();
  for (const u of usages) { const l = m.get(u.summary) ?? []; l.push(u); m.set(u.summary, l); }
  return m;
}

export function markdownReport(r: MigrateResult, opts: { applied: boolean; testResult?: { command: string; ok: boolean } }): string {
  const n = counts(r);
  const out: string[] = [];
  out.push(`## Upgrade ${r.pkg} from ${r.from} to ${r.to}`);
  out.push("");
  out.push(`Prepared with [Unbreak](https://github.com/jay-m007/unbreak). Every change below was type-checked against ${r.pkg}@${r.to} before it was kept.`);
  out.push("");
  out.push("| | |");
  out.push("|---|---|");
  out.push(`| Places the upgrade breaks | ${n.broken} |`);
  out.push(`| Changes made | ${n.fixes} in ${n.files} file(s) |`);
  out.push(`| Changes undone (compiler rejected them) | ${n.undone} |`);
  out.push(`| Still broken, needs a person | ${n.remaining} |`);
  if (opts.testResult) out.push(`| Tests (\`${opts.testResult.command}\`) | ${opts.testResult.ok ? "passed" : "**failed**"} |`);
  out.push("");
  if (r.fixed.length) {
    out.push("### What changed");
    out.push("");
    for (const [summary, list] of group(r.fixed.map((f) => f.usage))) {
      const src = list[0].rule.source === "deprecation" ? "the library's own deprecation note" : list[0].rule.source === "recipe" ? "Unbreak recipe" : "same signature under a new name";
      out.push(`- \`${summary}\` (${list.length}×, from ${src}): ${list.slice(0, 6).map((u) => where(r, u.file, u.line)).join(", ")}${list.length > 6 ? ", …" : ""}`);
    }
    out.push("");
  }
  if (r.remaining.length) {
    out.push("### Needs a person");
    out.push("");
    for (const d of r.remaining) {
      const hint = r.manual.find((u) => u.file === d.file && u.line === d.line);
      const tried = r.rejected.find((x) => x.usage.file === d.file && x.usage.line === d.line);
      if (tried) out.push(`- \`${diagLine(r, d)}\`  \n  Unbreak tried \`${tried.usage.summary}\` but the compiler said: ${tried.reason}`);
      else out.push(`- \`${diagLine(r, d)}\`${hint ? `  \n  Library note: ${hint.rule.note}${hint.problem && hint.problem !== hint.rule.note ? `  \n  Why not automatic: ${hint.problem}` : ""}` : ""}`);
    }
    out.push("");
  }
  if (r.rejected.length) {
    out.push("<details><summary>Changes Unbreak tried and undid</summary>");
    out.push("");
    for (const x of r.rejected) out.push(`- \`${x.usage.summary}\` at ${where(r, x.usage.file, x.usage.line)}: ${x.reason}`);
    out.push("");
    out.push("</details>");
    out.push("");
  }
  out.push("### How this was checked");
  out.push("");
  out.push(`1. Unbreak compared the public API of ${r.from} and ${r.to} from their type definitions.`);
  out.push(`2. It type-checked your unchanged code against ${r.to} to find what breaks (${n.broken}).`);
  out.push(`3. It rewrote only those places, using the library's own deprecation notes where available.`);
  out.push(`4. It type-checked again and undid any change that produced an error (${r.rounds} round(s)).`);
  out.push("");
  out.push("Type checks prove the code matches the new API. They cannot see changes in behaviour, so run your tests too.");
  return out.join("\n") + "\n";
}
