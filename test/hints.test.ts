import { test } from "node:test";
import assert from "node:assert/strict";
import { parseHint } from "../src/rules.ts";

test("reads a plain replacement path", () => {
  assert.deepEqual(parseHint("Use `faker.string.numeric()` instead."), [{ path: "faker.string.numeric", objectArgs: undefined, bare: false }]);
});

test("reads the fields of an options-object replacement", () => {
  const [h] = parseHint("Use `faker.date.past({ years, refDate })` instead.");
  assert.equal(h.path, "faker.date.past");
  assert.deepEqual(h.objectArgs, ["years", "refDate"]);
});

test("keeps every alternative, in order", () => {
  assert.deepEqual(parseHint("Use `faker.lorem.word()` or `faker.word.sample()` instead.").map((h) => h.path), ["faker.lorem.word", "faker.word.sample"]);
});

test("a bare word is an option rename", () => {
  assert.deepEqual(parseHint("Use `abbreviated` instead."), [{ path: "abbreviated", objectArgs: undefined, bare: true }]);
});

test("works without backticks", () => {
  assert.equal(parseHint("Deprecated. Use client.users.get() instead.")[0].path, "client.users.get");
});

test("ignores notes with no replacement", () => {
  assert.deepEqual(parseHint("There is no replacement."), []);
  assert.deepEqual(parseHint("Use your own function to build complex arrays."), []);
});

test("a hint that names something outside the library finds no target", async () => {
  const { locate } = await import("../src/rules.ts");
  const [h] = parseHint("Use `value.replace(/#+/g, fn)` instead.");
  const empty = { name: "x", version: "2", dir: "", entries: new Map(), byDecl: new Map() };
  assert.equal(locate(h.path, "faker.helpers.replaceSymbolWithNumber", empty), undefined);
});
