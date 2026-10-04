import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

test("the OpenCode plugin records results, failures, denials and calls that never finished", async () => {
  process.env["EAOS_HOME"] = mkdtempSync(join(tmpdir(), "eaos-oc-"));
  const { EaosRecorder } = await import("../src/opencode.ts");
  const { read } = await import("../src/record.ts");
  const p = await EaosRecorder({ directory: process.cwd() });
  const call = (id: string, tool = "bash") => p["tool.execute.before"]({ tool, sessionID: "ses_1", callID: id }, { args: { command: id } });
  const errored = (id: string, error: string) => p.event({ event: { type: "message.part.updated", properties: { part: { type: "tool", sessionID: "ses_1", callID: id, tool: "bash", state: { status: "error", error } } } } });

  await call("ok");
  await p["tool.execute.after"]({ tool: "bash", sessionID: "ses_1", callID: "ok" }, { output: "done" });
  await call("fails");
  await errored("fails", "exit code 1");
  await call("denied");
  await errored("denied", "The user rejected permission to use this specific tool call.");
  await errored("denied", "The user rejected permission to use this specific tool call."); // re-emitted update
  await call("hangs");
  await p.event({ event: { type: "session.idle", properties: { sessionID: "ses_1" } } });
  await p.event({ event: { type: "session.deleted", properties: { info: { id: "ses_1" } } } });

  const { status, entries } = read("opencode-ses_1");
  assert.equal(status, "ok");
  const outcome = (id: string) => entries.filter((e) => e["id"] === id && e.kind !== "call").map((e) => `${e.kind}${e.kind === "result" ? `:${String(e["ok"])}` : ""}`);
  assert.deepEqual(outcome("ok"), ["result:true"]);
  assert.deepEqual(outcome("fails"), ["result:false"]);
  assert.deepEqual(outcome("denied"), ["refused"]);
  assert.deepEqual(outcome("hangs"), ["refused"]);
  assert.equal(entries[0]?.["agent"], "opencode");
});
