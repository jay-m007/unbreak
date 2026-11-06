import { test } from "node:test";
import assert from "node:assert/strict";
import { applyEdits, unifiedDiff } from "../src/edits.ts";

test("applies edits and reports where they landed", () => {
  const text = "a.bs(); a.bsNoun();";
  const r = applyEdits(text, [
    { start: 2, end: 4, text: "buzzPhrase", owner: 1 },
    { start: 10, end: 16, text: "buzzNoun", owner: 2 },
  ]);
  assert.equal(r.text, "a.buzzPhrase(); a.buzzNoun();");
  assert.deepEqual(r.placed.map((p) => r.text.slice(p.newStart, p.newEnd)), ["buzzPhrase", "buzzNoun"]);
  assert.deepEqual(r.dropped, []);
});

test("drops an edit that overlaps an earlier one", () => {
  const r = applyEdits("abcdef", [{ start: 0, end: 3, text: "X", owner: 1 }, { start: 2, end: 4, text: "Y", owner: 2 }]);
  assert.equal(r.text, "Xdef");
  assert.deepEqual(r.dropped, [2]);
});

test("unified diff shows only changed lines with context", () => {
  const before = ["one", "two", "three", "four", "five", "six", "seven"].join("\n");
  const after = before.replace("four", "FOUR");
  const d = unifiedDiff("x.ts", before, after, 1);
  assert.match(d, /^--- a\/x\.ts\n\+\+\+ b\/x\.ts\n@@ -3,3 \+3,3 @@\n three\n-four\n\+FOUR\n five\n$/);
});

test("no diff for identical text", () => {
  assert.equal(unifiedDiff("x.ts", "same", "same"), "");
});
