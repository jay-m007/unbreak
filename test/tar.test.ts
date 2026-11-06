import { test } from "node:test";
import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractTgz, readTgz } from "../src/tar.ts";

function header(name: string, size: number, type = "0"): Buffer {
  const h = Buffer.alloc(512);
  h.write(name, 0, 100, "utf8");
  h.write("0000644\0", 100);
  h.write(size.toString(8).padStart(11, "0") + "\0", 124);
  h.write(type, 156);
  h.write("ustar\0", 257);
  h.fill(" ", 148, 156);
  let sum = 0;
  for (const b of h) sum += b;
  h.write(sum.toString(8).padStart(6, "0") + "\0 ", 148);
  return h;
}

function tgz(files: Array<[string, string]>): Buffer {
  const parts: Buffer[] = [];
  for (const [name, body] of files) {
    const data = Buffer.from(body);
    parts.push(header(name, data.length), data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  parts.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(parts));
}

test("reads files from an npm-style tarball", () => {
  const entries = readTgz(tgz([["package/package.json", '{"name":"x"}'], ["package/index.d.ts", "export {};"]]));
  assert.deepEqual(entries.map((e) => e.path), ["package/package.json", "package/index.d.ts"]);
});

test("extracts without the leading package/ folder", () => {
  const dir = mkdtempSync(join(tmpdir(), "unbreak-tar-"));
  extractTgz(tgz([["package/lib/a.d.ts", "export declare const a: 1;"]]), dir);
  assert.equal(readFileSync(join(dir, "lib/a.d.ts"), "utf8"), "export declare const a: 1;");
});

test("refuses paths that escape the destination", () => {
  const dir = mkdtempSync(join(tmpdir(), "unbreak-tar-"));
  assert.throws(() => extractTgz(tgz([["package/../../evil.txt", "x"]]), dir), /outside/);
});
