import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { copyFixture } from "./helpers.ts";
import { migrate, writeResult } from "../src/migrate.ts";

test("fixes what the upgrade breaks and leaves the rest for a person", () => {
  const dir = copyFixture("demo-app");
  const r = migrate({ projectDir: dir, pkg: "demo-lib", to: "2.0.0" });
  assert.equal(r.from, "1.4.0");
  assert.equal(r.fixed.length, 6);
  assert.deepEqual(r.fixed.map((f) => f.usage.summary).sort(), [
    "Client#closeConnection → Client#disconnect",
    "Client#getUser → Client#users.get",
    "Client#send(to, body) → Client#send({ to, body })",
    "import makeClient → createClient",
    "option upper → uppercase",
    "option upper → uppercase",
  ]);
  // total() → count() returns a string in 2.0, so the compiler rejects it and it is undone.
  assert.equal(r.rejected.length, 1);
  assert.match(r.rejected[0].reason, /string' is not assignable to type 'number'/);
  assert.deepEqual(r.remaining.map((d) => d.line + 1), [12, 13]);
  // Dry run: nothing written.
  assert.match(readFileSync(join(dir, "src/app.ts"), "utf8"), /getUser/);
});

test("--apply writes the fixes and bumps package.json, keeping the range style", () => {
  const dir = copyFixture("demo-app");
  const r = migrate({ projectDir: dir, pkg: "demo-lib", to: "2.0.0" });
  const written = writeResult(r);
  assert.deepEqual(written.sort(), ["package.json", "src/app.ts"]);
  const app = readFileSync(join(dir, "src/app.ts"), "utf8");
  assert.match(app, /import \{ createClient as makeClient \} from "demo-lib";/);
  assert.match(app, /client\.users\.get\("42"\)/);
  assert.match(app, /client\.send\(\{ to: "ana@example\.com", body: "hi" \}\)/);
  assert.match(app, /\{ uppercase: true \}/);
  assert.match(app, /\{ uppercase: upper \}/);
  assert.match(app, /client\.disconnect\(true\)/);
  assert.match(app, /client\.total\(\)/, "the rejected change is not written");
  assert.equal(JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).dependencies["demo-lib"], "^2.0.0");
});

test("the CLI exits 2 when something still needs a person, and prints JSON", () => {
  const dir = copyFixture("demo-app");
  let out = "";
  let code = 0;
  try {
    out = execFileSync(process.execPath, [join(import.meta.dirname, "../src/cli.ts"), "demo-lib@2.0.0", "--project", dir, "--json"], { encoding: "utf8", env: process.env });
  } catch (e) {
    const err = e as { status: number; stdout: string };
    code = err.status;
    out = err.stdout;
  }
  assert.equal(code, 2);
  const json = JSON.parse(out);
  assert.equal(json.fixed, 6);
  assert.equal(json.remaining, 2);
});
