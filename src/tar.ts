// Minimal reader for the .tgz files npm produces (gzip + ustar/pax).
// Kept in-house so Unbreak does not depend on a system `tar` (Windows users included).
import { gunzipSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, normalize, sep } from "node:path";

export interface TarEntry {
  path: string;
  type: "file" | "dir" | "other";
  data: Buffer;
}

function readString(buf: Buffer, start: number, len: number): string {
  const end = buf.indexOf(0, start);
  return buf.toString("utf8", start, end === -1 || end > start + len ? start + len : end);
}

function readOctal(buf: Buffer, start: number, len: number): number {
  const s = readString(buf, start, len).trim();
  return s ? parseInt(s, 8) : 0;
}

/** Parses pax extended headers ("27 path=some/long/name\n"). */
function parsePax(data: Buffer): Record<string, string> {
  const out: Record<string, string> = {};
  let pos = 0;
  while (pos < data.length) {
    const space = data.indexOf(0x20, pos);
    if (space === -1) break;
    const len = parseInt(data.toString("utf8", pos, space), 10);
    if (!len) break;
    const record = data.toString("utf8", space + 1, pos + len - 1);
    const eq = record.indexOf("=");
    if (eq > 0) out[record.slice(0, eq)] = record.slice(eq + 1);
    pos += len;
  }
  return out;
}

export function readTgz(gz: Buffer): TarEntry[] {
  const buf = gunzipSync(gz);
  const entries: TarEntry[] = [];
  let pos = 0;
  let paxPath: string | undefined;
  let longName: string | undefined;
  while (pos + 512 <= buf.length) {
    const header = buf.subarray(pos, pos + 512);
    if (header.every((b) => b === 0)) break;
    const name = readString(header, 0, 100);
    const size = readOctal(header, 124, 12);
    const typeflag = String.fromCharCode(header[156] || 48);
    const prefix = header.toString("utf8", 257, 263).startsWith("ustar") ? readString(header, 345, 155) : "";
    const dataStart = pos + 512;
    const data = buf.subarray(dataStart, dataStart + size);
    pos = dataStart + Math.ceil(size / 512) * 512;
    if (typeflag === "x") { paxPath = parsePax(data).path; continue; }
    if (typeflag === "g") continue;
    if (typeflag === "L") { longName = readString(data, 0, data.length); continue; }
    const full = paxPath ?? longName ?? (prefix ? prefix + "/" + name : name);
    paxPath = undefined;
    longName = undefined;
    const type = typeflag === "0" || typeflag === "\0" || typeflag === "7" ? "file" : typeflag === "5" ? "dir" : "other";
    entries.push({ path: full, type, data: Buffer.from(data) });
  }
  return entries;
}

/** Extracts entries under `dest`, stripping the first path segment (npm's "package/"). Refuses paths that escape `dest`. */
export function extractTgz(gz: Buffer, dest: string): number {
  let count = 0;
  const root = normalize(dest + sep);
  for (const e of readTgz(gz)) {
    if (e.type !== "file") continue;
    const rel = e.path.split("/").slice(1).join("/");
    if (!rel) continue;
    const target = normalize(join(dest, rel));
    if (!target.startsWith(root)) throw new Error(`Refusing to extract outside the cache: ${e.path}`);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, e.data);
    count++;
  }
  return count;
}
