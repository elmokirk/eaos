// A real Pi session (scripted model, real tools, real extension loader) recorded by src/pi.ts.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";

test("a real Pi session records executed and blocked calls in one valid chain", async () => {
  const home = mkdtempSync(join(tmpdir(), "eaos-pi-"));
  process.env["EAOS_HOME"] = join(home, "store");
  const { read, runs } = await import("../src/record.ts");
  const cwd = mkdtempSync(join(tmpdir(), "eaos-project-"));
  const agentDir = join(home, "agent");

  const faux = fauxProvider();
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("bash", { command: "echo hello" }), fauxToolCall("bash", { command: "rm -rf /" })], { stopReason: "toolUse" }),
    fauxAssistantMessage("done"),
  ]);

  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    noExtensions: true,
    additionalExtensionPaths: [join(import.meta.dirname, "../src/pi.ts")],
    extensionFactories: [
      (pi) => void pi.on("tool_call", (event) => (JSON.stringify(event.input).includes("rm -rf") ? { block: true, reason: "destructive command" } : undefined)),
    ],
  });
  await resourceLoader.reload();
  const modelRuntime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json") });
  modelRuntime.registerNativeProvider(faux.provider);
  await modelRuntime.setRuntimeApiKey(faux.provider.id, "test");
  const { session } = await createAgentSession({
    cwd,
    agentDir,
    model: faux.getModel(),
    modelRuntime,
    resourceLoader,
    tools: ["bash"],
    sessionManager: SessionManager.inMemory(cwd),
    settingsManager: SettingsManager.inMemory(),
  });
  await session.bindExtensions({});
  await session.prompt("go");
  await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }); // what the CLI runtime does on exit
  session.dispose();

  const [only] = runs();
  assert.ok(only, "one run recorded");
  const { status, entries } = read(only.run);
  const kinds = entries.map((e) => `${e.kind}${e.kind === "result" ? `:${String(e["ok"])}` : ""}`);
  assert.deepEqual(kinds.filter((k) => k !== "start" && k !== "end").sort(), ["call", "call", "refused", "result:true"]);
  assert.equal(entries.find((e) => e.kind === "refused")?.["reason"], "destructive command");
  assert.match(String(entries.find((e) => e.kind === "result")?.["output"]), /hello/);
  assert.equal(entries[0]?.kind, "start");
  assert.equal(status, "ok", "session_shutdown closed the run");
});
