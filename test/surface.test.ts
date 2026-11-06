import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { FIXTURES } from "./helpers.ts";
import { buildSurface } from "../src/surface.ts";
import { deriveRules } from "../src/rules.ts";

const v1 = () => buildSurface(join(FIXTURES, "demo-app/node_modules/demo-lib"), "demo-lib", "1.4.0");
const v2 = () => buildSurface(join(FIXTURES, "cache/packages/demo-lib@2.0.0"), "demo-lib", "2.0.0");

test("lists exports, instance members and option fields", () => {
  const s = v1();
  for (const p of ["createClient", "makeClient", "Client", "Client#getUser", "Client#users.get", "Client#format(options).upper"]) {
    assert.ok(s.entries.has(p), `missing ${p}`);
  }
});

test("keeps @deprecated notes on members and on single overloads", () => {
  const s = v1();
  assert.equal(s.entries.get("Client#getUser")?.deprecated, "Use `client.users.get()` instead.");
  const send = s.entries.get("Client#send")!;
  assert.equal(send.deprecated, undefined, "only one overload is deprecated");
  assert.equal(send.signatures.filter((x) => x.deprecated).length, 1);
});

test("maps declarations back to their path", () => {
  const s = v1();
  const key = s.entries.get("Client#total")!.declKeys[0];
  assert.equal(s.byDecl.get(key), "Client#total");
});

test("derives one rule of each kind from the two versions", () => {
  const rules = deriveRules(v1(), v2());
  const find = (pred: (r: (typeof rules)[number]) => boolean) => rules.find(pred);
  const make = find((r) => r.kind === "rename" && r.from === "makeClient");
  assert.ok(make && make.kind === "rename" && make.to === "createClient" && make.source === "deprecation");
  assert.equal(find((r) => r.kind === "rename" && r.from === "Client#getUser")?.kind === "rename" && (find((r) => r.kind === "rename" && r.from === "Client#getUser") as { to: string }).to, "Client#users.get");
  assert.ok(find((r) => r.kind === "toObject" && r.path === "Client#send" && r.names.join() === "to,body"));
  assert.ok(find((r) => r.kind === "renameOption" && r.to === "uppercase"));
  assert.ok(find((r) => r.kind === "rename" && r.from === "Client#closeConnection" && r.to === "Client#disconnect" && r.source === "signature-match"));
  assert.ok(find((r) => r.kind === "removed" && r.path === "Client#legacy"));
});

test("same-signature renames need similar names", async () => {
  const { similarNames } = await import("../src/rules.ts");
  assert.equal(similarNames("closeConnection", "disconnect"), true);
  assert.equal(similarNames("avatar", "jwtAlgorithm"), false, "two unrelated () => string methods must not match");
});
