// unbreak <package>[@version] [options]   fix the code an upgrade breaks
// unbreak diff <package> <from> <to>       show what changed between two versions
import { execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { migrate, writeResult } from "./migrate.ts";
import { diffText, markdownReport, terminalSummary, bold, dim, green, red, yellow } from "./report.ts";
import { fetchPackage } from "./npm.ts";
import { buildSurface } from "./surface.ts";
import { deriveRules } from "./rules.ts";
import { loadRecipes } from "./recipes.ts";

const HELP = `Unbreak: upgrade a library and fix the code it breaks.

Usage
  unbreak <package>[@version] [options]
  unbreak diff <package> <from> <to>

Examples
  unbreak @faker-js/faker@9            dry run: show what would change
  unbreak @faker-js/faker@9 --apply    write the fixes and bump package.json
  unbreak diff @faker-js/faker 8 9     list API changes between two versions

Options
  --project <dir>    project folder (default: current folder)
  --apply            write the changes (default is a dry run)
  --deprecations     also update deprecated calls that still work
  --test "<cmd>"     after --apply, install and run this command; undo everything if it fails
  --report <file>    write a Markdown report (good as a pull request description)
  --json             print the result as JSON
  --no-diff          don't print the diff
  -h, --help         show this help
  -v, --version      show the version
`;

function parseArgs(argv: string[]) {
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h") flags.help = true;
    else if (a === "-v") flags.version = true;
    else if (a.startsWith("--no-")) flags[a.slice(5)] = false;
    else if (a.startsWith("--")) {
      const [k, v] = a.slice(2).split("=", 2);
      if (v !== undefined) flags[k] = v;
      else if (["project", "test", "report"].includes(k)) flags[k] = argv[++i] ?? "";
      else flags[k] = true;
    } else positional.push(a);
  }
  return { flags, positional };
}

function splitSpec(spec: string): { name: string; version: string } {
  const at = spec.lastIndexOf("@");
  if (at > 0) return { name: spec.slice(0, at), version: spec.slice(at + 1) || "latest" };
  return { name: spec, version: "latest" };
}

function packageManager(dir: string): string {
  if (existsSync(join(dir, "pnpm-lock.yaml"))) return "pnpm install";
  if (existsSync(join(dir, "yarn.lock"))) return "yarn install";
  if (existsSync(join(dir, "bun.lockb")) || existsSync(join(dir, "bun.lock"))) return "bun install";
  return "npm install";
}

function run(cmd: string, cwd: string): boolean {
  try { execSync(cmd, { cwd, stdio: "inherit" }); return true; } catch { return false; }
}

function cmdDiff(name: string, from: string, to: string) {
  const a = fetchPackage(name, from);
  const b = fetchPackage(name, to);
  const prev = buildSurface(a.dir, name, a.version);
  const next = buildSurface(b.dir, name, b.version);
  const rules = deriveRules(prev, next, loadRecipes(name, a.version, b.version));
  const added = [...next.entries.keys()].filter((k) => !prev.entries.has(k) && !k.includes("("));
  console.log(bold(`${name} ${a.version} → ${b.version}`));
  console.log(`  ${prev.entries.size} → ${next.entries.size} API members, ${added.length} new`);
  const renames = rules.filter((r) => r.kind === "rename" || r.kind === "toObject" || r.kind === "renameOption");
  const removed = rules.filter((r) => r.kind === "removed");
  console.log(green(`\n  Unbreak can migrate (${renames.length}):`));
  for (const r of renames) {
    if (r.kind === "rename") console.log(`    ${r.from} → ${r.to}${r.objectArgs ? `({ ${r.objectArgs.join(", ")} })` : ""}  ${dim(r.source)}`);
    else if (r.kind === "toObject") console.log(`    ${r.path}(${r.names.join(", ")}) → ${r.path}({ ${r.names.join(", ")} })  ${dim(r.source)}`);
    else if (r.kind === "renameOption") console.log(`    ${r.path} → ${r.to}  ${dim(r.source)}`);
  }
  console.log(yellow(`\n  Removed with no automatic fix (${removed.length}):`));
  for (const r of removed) if (r.kind === "removed") console.log(`    ${r.path}  ${dim(r.note.slice(0, 100))}`);
}

export function main(argv = process.argv.slice(2)): number {
  const { flags, positional } = parseArgs(argv);
  if (flags.version) {
    const pj = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    console.log(pj.version);
    return 0;
  }
  if (flags.help || !positional.length) { console.log(HELP); return positional.length || flags.help ? 0 : 1; }
  try {
    if (positional[0] === "diff") {
      if (positional.length < 4) { console.error("Usage: unbreak diff <package> <from> <to>"); return 1; }
      cmdDiff(positional[1], positional[2], positional[3]);
      return 0;
    }
    const { name, version } = splitSpec(positional[0]);
    const projectDir = resolve(String(flags.project ?? "."));
    const quiet = !!flags.json;
    const result = migrate({ projectDir, pkg: name, to: version, deprecations: !!flags.deprecations, log: quiet ? undefined : (m) => console.log(dim("· " + m)) });
    const apply = !!flags.apply;
    if (!quiet && flags.diff !== false && result.updated.size) console.log("\n" + diffText(result));
    let testResult: { command: string; ok: boolean } | undefined;
    if (apply) {
      const pjBefore = existsSync(join(projectDir, "package.json")) ? readFileSync(join(projectDir, "package.json"), "utf8") : undefined;
      const written = writeResult(result);
      if (!quiet) console.log(green(`Wrote ${written.length} file(s): ${written.join(", ")}`));
      if (typeof flags.test === "string" && flags.test) {
        const install = packageManager(projectDir);
        console.log(dim(`· Running ${install} …`));
        const ok = run(install, projectDir) && run(flags.test, projectDir);
        testResult = { command: flags.test, ok };
        if (!ok) {
          for (const [file, text] of result.originals) writeFileSync(file, text);
          if (pjBefore !== undefined) writeFileSync(join(projectDir, "package.json"), pjBefore);
          console.log(red(`Tests failed, so every change was undone. Run "${install}" to restore your installed packages.`));
        }
      }
    }
    if (typeof flags.report === "string" && flags.report) {
      writeFileSync(resolve(flags.report), markdownReport(result, { applied: apply, testResult }));
      if (!quiet) console.log(dim(`· Report written to ${flags.report}`));
    }
    if (quiet) {
      console.log(JSON.stringify({
        package: result.pkg, from: result.from, to: result.to,
        broken: result.brokenBefore.length, fixed: result.fixed.length, undone: result.rejected.length, remaining: result.remaining.length,
        fixes: result.fixed.map((f) => ({ file: f.usage.file, line: f.usage.line + 1, change: f.usage.summary, source: f.usage.rule.source })),
        remainingErrors: result.remaining.map((d) => ({ file: d.file, line: d.line + 1, message: d.message })),
        test: testResult,
      }, null, 2));
    } else {
      console.log("\n" + terminalSummary(result, apply));
    }
    if (testResult && !testResult.ok) return 1;
    return result.remaining.length ? 2 : 0;
  } catch (e) {
    console.error(red("unbreak: ") + (e instanceof Error ? e.message : String(e)));
    return 1;
  }
}

const invoked = process.argv[1] && /(cli\.(ts|js)|unbreak(\.js)?)$/.test(process.argv[1]);
if (invoked) process.exitCode = main();
