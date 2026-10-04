import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { appendFileSync, copyFileSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { append, close, read, redact, runFile, verify } from "../src/record.ts";

const store = () => ({ ...process.env, EAOS_HOME: mkdtempSync(join(tmpdir(), "eaos-")) });

function sample(env: NodeJS.ProcessEnv): string[] {
  append("r", { kind: "start", agent: "test" }, env);
  append("r", { kind: "call", agent: "test", id: "1", tool: "bash", input: { command: "ls" } }, env);
  append("r", { kind: "result", agent: "test", id: "1", tool: "bash", ok: true }, env);
  close("r", "test", "quit", env);
  return readFileSync(runFile("r", env), "utf8").trim().split("\n");
}

test("an untouched run verifies; every kind of tampering is named", () => {
  const lines = sample(store());
  assert.equal(verify(lines).status, "ok");
  assert.equal(verify(lines.slice(0, -1)).status, "open", "a missing tail is visible");
  assert.match(verify(lines.map((l, i) => (i === 1 ? l.replace('"ls"', '"rm"') : l))).error ?? "", /line 2: altered/);
  assert.match(verify([lines[0], lines[2], lines[3]] as string[]).error ?? "", /line 2: seq/);
  assert.match(verify([...lines.slice(0, 2), "{oops"]).error ?? "", /line 3: not JSON/);
  assert.match(verify(["null"]).error ?? "", /not an entry/);
  assert.equal(verify([]).status, "broken");
});

test("close turns a call that never got an outcome into refused", () => {
  const env = store();
  append("r", { kind: "call", agent: "test", id: "a", tool: "bash" }, env);
  append("r", { kind: "call", agent: "test", id: "b", tool: "bash" }, env);
  append("r", { kind: "result", agent: "test", id: "a", tool: "bash", ok: true }, env);
  close("r", "test", "quit", env);
  const { status, entries } = read("r", env);
  assert.equal(status, "ok");
  assert.deepEqual(entries.filter((e) => e.kind === "refused").map((e) => e["id"]), ["b"]);
});

test("secrets are redacted and long strings cut before anything is hashed", () => {
  const out = redact({
    command: "curl -H 'Authorization: Bearer abcdefghijklmnop1234' https://user:hunter22@example.com",
    env: "OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwx",
    key: "-----BEGIN RSA PRIVATE KEY-----\nMIIE\n-----END RSA PRIVATE KEY-----",
    big: "x".repeat(5000),
  }) as Record<string, string>;
  const text = JSON.stringify(out);
  for (const secret of ["abcdefghijklmnop1234", "hunter22", "sk-proj", "MIIE"]) assert.ok(!text.includes(secret), secret);
  assert.match(out["command"] ?? "", /https:\/\/user:\[REDACTED\]@example\.com/);
  assert.ok((out["big"] ?? "").length < 2100);
});

test("parallel writers from separate processes keep one valid chain", async () => {
  const env = store();
  const writer = `import { append } from ${JSON.stringify(new URL("../src/record.ts", import.meta.url).href)};
    for (let i = 0; i < 25; i++) append("p", { kind: "call", agent: "test", id: String(i) });`;
  await Promise.all(Array.from({ length: 8 }, () => new Promise<void>((done, fail) => {
    spawn(process.execPath, ["--input-type=module", "-e", writer], { env, stdio: "inherit" })
      .on("exit", (code) => (code === 0 ? done() : fail(new Error(`writer exited ${code}`))));
  })));
  const { status, entries } = read("p", env);
  assert.equal(status, "open");
  assert.equal(entries.length, 200);
});

test("run ids cannot escape the store", () => {
  assert.throws(() => runFile("../../etc/passwd"), /not a valid run id/);
});

test("secret-named keys and short or quoted values are redacted", () => {
  const out = JSON.stringify(redact({ api_key: "abc123", password: "hunter2", note: 'password="my pass" and token=xyz' }));
  for (const secret of ["abc123", "hunter2", "my pass", "xyz"]) assert.ok(!out.includes(secret), secret);
  assert.deepEqual(redact({ max_tokens: 4096 }), { max_tokens: 4096 }, "numbers are never secrets");
});

test("redaction stays fast on hostile input and bounds size", () => {
  const t = performance.now();
  redact("a.".repeat(500_000) + "-----BEGIN RSA PRIVATE KEY-----" + "x".repeat(100_000));
  assert.ok(performance.now() - t < 500, "no quadratic backtracking");
  const big = redact({ list: Array.from({ length: 1000 }, (_, i) => i) }) as { list: unknown[] };
  assert.equal(big.list.length, 201);
});

test("a chain copied under another run id does not verify", () => {
  const env = store();
  sample(env);
  copyFileSync(runFile("r", env), runFile("other", env));
  assert.match(read("other", env).error ?? "", /belongs to run r/);
});

test("a torn last line is reported, and recording continues after it", () => {
  const env = store();
  append("t", { kind: "start", agent: "test" }, env);
  appendFileSync(runFile("t", env), '{"kind":"call","ag');
  append("t", { kind: "call", agent: "test", id: "after" }, env);
  const lines = readFileSync(runFile("t", env), "utf8").trim().split("\n");
  assert.equal(lines.length, 3);
  assert.match(read("t", env).error ?? "", /line 2: not JSON/);
  assert.equal(JSON.parse(lines[2] as string).id, "after");
});
