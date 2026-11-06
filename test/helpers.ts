import { cpSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export const FIXTURES = resolve(import.meta.dirname, "fixtures");
process.env.UNBREAK_CACHE = join(FIXTURES, "cache");
process.env.UNBREAK_OFFLINE = "1"; // demo-lib@2.0.0 lives here: tests never touch the network

/** Copies a fixture project (with its node_modules) to a temp folder so tests can write to it. */
export function copyFixture(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), `unbreak-${name}-`));
  cpSync(join(FIXTURES, name), dir, { recursive: true });
  return dir;
}
