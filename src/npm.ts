// Fetches a published version of a package (types included) into a local cache, using the
// user's own npm so registry settings, proxies and private-registry logins keep working.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { extractTgz } from "./tar.ts";

export interface FetchedPackage {
  name: string;
  version: string;
  dir: string;
}

export function cacheRoot(): string {
  return process.env.UNBREAK_CACHE || join(homedir(), ".cache", "unbreak");
}

function safeName(name: string): string {
  return name.replace(/^@/, "").replace(/\//g, "__");
}

function npmCommand(): { cmd: string; shell: boolean } {
  return process.platform === "win32" ? { cmd: "npm.cmd", shell: true } : { cmd: "npm", shell: false };
}

export function npm(args: string[], cwd?: string): string {
  const { cmd, shell } = npmCommand();
  return execFileSync(cmd, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], shell, maxBuffer: 64 * 1024 * 1024 });
}

/** Resolves a version range or tag ("9", "latest", "^9.1") to an exact published version. */
export function resolveVersion(name: string, spec: string): string {
  const out = npm(["view", `${name}@${spec}`, "version", "--json"]).trim();
  if (!out) throw new Error(`No published version of ${name} matches "${spec}".`);
  const parsed = JSON.parse(out);
  const list: string[] = Array.isArray(parsed) ? parsed : [parsed];
  return list[list.length - 1];
}

export function fetchPackage(name: string, spec: string): FetchedPackage {
  const version = /^\d+\.\d+\.\d+(-[\w.]+)?$/.test(spec) ? spec : resolveVersion(name, spec);
  const dir = join(cacheRoot(), "packages", `${safeName(name)}@${version}`);
  if (existsSync(join(dir, "package.json"))) return { name, version, dir };
  const tmp = join(tmpdir(), `unbreak-pack-${process.pid}-${Date.now()}`);
  mkdirSync(tmp, { recursive: true });
  try {
    npm(["pack", `${name}@${version}`, "--pack-destination", tmp, "--silent"], tmp);
    const tgz = readdirSync(tmp).find((f) => f.endsWith(".tgz"));
    if (!tgz) throw new Error(`npm pack did not produce a file for ${name}@${version}`);
    mkdirSync(dir, { recursive: true });
    extractTgz(readFileSync(join(tmp, tgz)), dir);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  return { name, version, dir };
}

/** Finds the copy of `name` the project currently uses. */
export function installedPackage(projectDir: string, name: string): FetchedPackage | undefined {
  let cur = projectDir;
  for (;;) {
    const dir = join(cur, "node_modules", name);
    const pj = join(dir, "package.json");
    if (existsSync(pj)) {
      const version = JSON.parse(readFileSync(pj, "utf8")).version as string;
      return { name, version, dir };
    }
    const parent = join(cur, "..");
    if (parent === cur) return undefined;
    cur = parent;
  }
}
