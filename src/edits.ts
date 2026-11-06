// Applies text edits and produces readable unified diffs.
import type { Edit } from "./usages.ts";

export interface Placed {
  owner: number; // usage id
  oldStart: number;
  oldEnd: number;
  newStart: number;
  newEnd: number;
}

/** Applies non-overlapping edits. Returns the new text and where each edit landed. Overlapping edits are dropped (reported back). */
export function applyEdits(text: string, edits: Array<Edit & { owner: number }>): { text: string; placed: Placed[]; dropped: number[] } {
  const sorted = [...edits].sort((a, b) => a.start - b.start || a.end - b.end);
  const kept: typeof sorted = [];
  const dropped: number[] = [];
  for (const e of sorted) {
    const prev = kept[kept.length - 1];
    if (prev && e.start < prev.end) { dropped.push(e.owner); continue; }
    kept.push(e);
  }
  let out = "";
  let cursor = 0;
  let delta = 0;
  const placed: Placed[] = [];
  for (const e of kept) {
    out += text.slice(cursor, e.start) + e.text;
    placed.push({ owner: e.owner, oldStart: e.start, oldEnd: e.end, newStart: e.start + delta, newEnd: e.start + delta + e.text.length });
    delta += e.text.length - (e.end - e.start);
    cursor = e.end;
  }
  out += text.slice(cursor);
  return { text: out, placed, dropped: [...new Set(dropped)] };
}

/** Myers diff on lines; small and dependency-free. */
function diffLines(a: string[], b: string[]): Array<{ op: " " | "-" | "+"; line: string }> {
  const n = a.length, m = b.length, max = n + m;
  const v = new Map<number, number>([[1, 0]]);
  const trace: Map<number, number>[] = [];
  outer: for (let d = 0; d <= max; d++) {
    trace.push(new Map(v));
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && (v.get(k - 1) ?? -1) < (v.get(k + 1) ?? -1)) ? v.get(k + 1) ?? 0 : (v.get(k - 1) ?? 0) + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) { x++; y++; }
      v.set(k, x);
      if (x >= n && y >= m) break outer;
    }
  }
  const out: Array<{ op: " " | "-" | "+"; line: string }> = [];
  let x = n, y = m;
  for (let d = trace.length - 1; d >= 0 && (x > 0 || y > 0); d--) {
    const vv = trace[d];
    const k = x - y;
    const prevK = k === -d || (k !== d && (vv.get(k - 1) ?? -1) < (vv.get(k + 1) ?? -1)) ? k + 1 : k - 1;
    const prevX = vv.get(prevK) ?? 0;
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) { out.push({ op: " ", line: a[x - 1] }); x--; y--; }
    if (d > 0) {
      if (x === prevX) out.push({ op: "+", line: b[y - 1] }), y--;
      else out.push({ op: "-", line: a[x - 1] }), x--;
    }
  }
  return out.reverse();
}

export function unifiedDiff(file: string, before: string, after: string, context = 2): string {
  if (before === after) return "";
  const a = before.split("\n"), b = after.split("\n");
  const ops = diffLines(a, b);
  const lines: string[] = [`--- a/${file}`, `+++ b/${file}`];
  let i = 0;
  let aLine = 1, bLine = 1;
  const pos: Array<{ a: number; b: number }> = [];
  for (const o of ops) { pos.push({ a: aLine, b: bLine }); if (o.op !== "+") aLine++; if (o.op !== "-") bLine++; }
  while (i < ops.length) {
    if (ops[i].op === " ") { i++; continue; }
    let start = Math.max(0, i - context);
    let end = i;
    while (end < ops.length) {
      if (ops[end].op !== " ") { end++; continue; }
      let j = end;
      while (j < ops.length && ops[j].op === " ") j++;
      if (j < ops.length && j - end <= context * 2) { end = j; continue; }
      end = Math.min(ops.length, end + context);
      break;
    }
    const hunk = ops.slice(start, end);
    const aCount = hunk.filter((o) => o.op !== "+").length;
    const bCount = hunk.filter((o) => o.op !== "-").length;
    lines.push(`@@ -${pos[start].a},${aCount} +${pos[start].b},${bCount} @@`);
    for (const o of hunk) lines.push(o.op + o.line);
    i = end;
  }
  return lines.join("\n") + "\n";
}
