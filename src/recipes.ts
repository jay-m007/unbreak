// Hand-written rules for changes a library did not document in its types.
// recipes/<package>.json:
//   { "package": "x", "migrations": [ { "breaksAfter": 8, "rules": [ { "kind": "rename", "from": "...", "to": "..." } ] } ] }
// A migration applies when the installed major version is <= breaksAfter and the target major is above it.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Rule } from "./rules.ts";

const here = dirname(fileURLToPath(import.meta.url));
const RECIPE_DIRS = [join(here, "..", "recipes")];

export function recipeFile(pkg: string): string | undefined {
  const name = pkg.replace(/^@/, "").replace(/\//g, "__") + ".json";
  return RECIPE_DIRS.map((d) => join(d, name)).find(existsSync);
}

const major = (v: string) => parseInt(v.split(".")[0], 10);

export function loadRecipes(pkg: string, fromVersion: string, toVersion: string): Rule[] {
  const file = recipeFile(pkg);
  if (!file) return [];
  const data = JSON.parse(readFileSync(file, "utf8"));
  const out: Rule[] = [];
  for (const m of data.migrations ?? []) {
    if (!(major(fromVersion) <= m.breaksAfter && major(toVersion) > m.breaksAfter)) continue;
    for (const r of m.rules ?? []) {
      const note = r.note ?? "From Unbreak's recipe for this upgrade.";
      if (r.kind === "rename") out.push({ kind: "rename", from: r.from, to: r.to, objectArgs: r.objectArgs, source: "recipe", note });
      else if (r.kind === "renameOption") out.push({ kind: "renameOption", path: r.path, to: r.to, source: "recipe", note });
      else if (r.kind === "removed") out.push({ kind: "removed", path: r.path, source: "recipe", note });
    }
  }
  return out;
}
