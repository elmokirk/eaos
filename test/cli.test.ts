import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { append, type Sealed } from "../src/record.ts";

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const home = mkdtempSync(join(tmpdir(), "eaos-cli-"));
const env = { ...process.env, EAOS_HOME: home, EAOS_ACTOR: "tester" };

function eaos(args: string[], input?: unknown) {
  const r = spawnSync(process.execPath, [CLI, ...args], { env, encoding: "utf8", input: input === undefined ? undefined : JSON.stringify(input) });
  return { code: r.status, out: r.stdout + r.stderr };
}

const session = { session_id: "s1", cwd: process.cwd() };
const hook = (event: string, extra: Record<string, unknown> = {}) => eaos(["hook"], { ...session, hook_event_name: event, ...extra });

test("a Claude Code session is recorded, including denied and blocked calls", () => {
  hook("SessionStart", { source: "startup" });
  hook("PreToolUse", { tool_name: "Bash", tool_use_id: "t1", tool_input: { command: "ls" } });
  hook("PostToolUse", { tool_name: "Bash", tool_use_id: "t1", tool_response: { stdout: "README.md" } });
  hook("PreToolUse", { tool_name: "Bash", tool_use_id: "t2", tool_input: { command: "rm -rf /" } });
  hook("PermissionDenied", { tool_name: "Bash", tool_use_id: "t2", reason: "denied by user" });
  hook("PreToolUse", { tool_name: "Write", tool_use_id: "t3", tool_input: { file_path: ".env" } }); // blocked by another hook: no outcome
  hook("Stop");
  assert.equal(hook("SessionEnd", { reason: "prompt_input_exit" }).code, 0);

  const shown = eaos(["show", "s1"]);
  assert.equal(shown.code, 0, shown.out);
  assert.match(shown.out, /claude-s1 .* tester {2}ok/);
  assert.match(shown.out, /REFUSED {2}Bash {2}denied by user/);
  assert.match(shown.out, /REFUSED {2}Write {2}no result recorded/);
  assert.match(eaos(["list"]).out, /ok\s+claude-s1\s+.*\s+3\s+2\s/);
  assert.equal(eaos(["verify"]).code, 0);
});

test("verify fails on an edited line, and anchors catch a rewritten file", () => {
  const anchors = join(home, "anchors.txt");
  writeFileSync(anchors, eaos(["anchor"]).out);
  assert.equal(eaos(["verify", "--against", anchors]).code, 0);

  const file = join(home, "traces", "claude-s1.jsonl");
  const original = readFileSync(file, "utf8");
  writeFileSync(file, original.replace("rm -rf /", "ls -la /"));
  assert.match(eaos(["verify"]).out, /BROKEN at line \d+: altered/);

  // A forger drops the denied call and re-seals every line: the chain is valid again, the anchor is not.
  rmSync(file);
  for (const line of original.trim().split("\n")) {
    const { hash: _h, seq: _s, prev: _p, ts: _t, ...entry } = JSON.parse(line) as Sealed;
    if (entry.kind !== "refused" || entry["id"] !== "t2") append("claude-s1", entry, env);
  }
  assert.equal(eaos(["verify"]).code, 0, "the forged chain is internally valid");
  assert.match(eaos(["verify", "--against", anchors]).out, /ANCHOR {2}claude-s1 .* rewritten/);
  writeFileSync(file, original);
});

test("the hook never fails its host, and logs what went wrong", () => {
  const r = spawnSync(process.execPath, [CLI, "hook"], { env, input: "not json", encoding: "utf8" });
  assert.equal(r.status, 0);
  assert.match(readFileSync(join(home, "errors.log"), "utf8"), /claude hook unknown/);
});

test("setup claude adds the hooks once and keeps a backup", () => {
  const settings = join(home, "settings.json");
  writeFileSync(settings, JSON.stringify({ model: "opus", hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "guard" }] }] } }));
  assert.match(eaos(["setup", "claude", "--settings", settings]).out, /Added eaos hooks/);
  assert.match(eaos(["setup", "claude", "--settings", settings]).out, /already records/);
  const written = JSON.parse(readFileSync(settings, "utf8"));
  assert.equal(written.model, "opus");
  assert.equal(written.hooks.PreToolUse.length, 2, "existing hooks are kept");
  assert.equal(written.hooks.SessionEnd[0].hooks[0].command, "eaos hook");
  assert.ok(existsSync(`${settings}.eaos-backup`));
});

test("usage errors exit 2, unknown runs exit 1", () => {
  assert.equal(eaos(["frobnicate"]).code, 2);
  assert.equal(eaos(["show", "does-not-exist"]).code, 1);
});

test("setup claude refuses a settings file it does not understand, and leaves it alone", () => {
  const settings = join(home, "bad.json");
  writeFileSync(settings, '{"hooks": "nope"}');
  assert.equal(eaos(["setup", "claude", "--settings", settings]).code, 1);
  assert.equal(readFileSync(settings, "utf8"), '{"hooks": "nope"}');
});

test("terminal escapes in recorded output cannot repaint the screen", () => {
  hook("PreToolUse", { session_id: "esc", tool_name: "Bash", tool_use_id: "e1", tool_input: { command: "\u001b[2J\u001b[1Aok" } });
  assert.ok(!eaos(["show", "esc"]).out.includes("\u001b"));
});

test("Codex speaks the same hook protocol and lands in the same store", () => {
  const codex = (event: string, extra: Record<string, unknown> = {}) =>
    eaos(["hook", "--agent", "codex"], { session_id: "cx1", cwd: process.cwd(), hook_event_name: event, ...extra });
  codex("SessionStart", { source: "startup" });
  codex("PreToolUse", { tool_name: "Bash", tool_use_id: "c1", tool_input: { command: "git push --force" } });
  codex("Stop");
  const shown = eaos(["show", "codex-cx1"]).out;
  assert.match(shown, /start {4}codex/);
  assert.match(shown, /REFUSED {2}Bash/);
});

test("setup codex writes hooks.json with tool matchers", () => {
  const file = join(home, "codex-hooks.json");
  eaos(["setup", "codex", "--settings", file]);
  const written = JSON.parse(readFileSync(file, "utf8"));
  assert.deepEqual(written.hooks.PreToolUse, [{ matcher: ".*", hooks: [{ type: "command", command: "eaos hook --agent codex" }] }]);
  assert.equal(written.hooks.Stop[0].matcher, undefined);
});

test("setup opencode writes a plugin shim that loads the recorder", async () => {
  const dir = join(home, "opencode-plugins");
  eaos(["setup", "opencode", "--dir", dir]);
  const shim = await import(pathToFileURL(join(dir, "eaos.js")).href);
  assert.equal(typeof shim.EaosRecorder, "function");
});

test("report, files and filters answer the morning-after question", () => {
  const rep = (extra: Record<string, unknown>) => eaos(["hook"], { session_id: "rep1", cwd: process.cwd(), ...extra });
  rep({ hook_event_name: "PreToolUse", tool_name: "Write", tool_use_id: "w1", tool_input: { file_path: "src/app.ts", content: "x" } });
  rep({ hook_event_name: "PostToolUse", tool_name: "Write", tool_use_id: "w1", tool_response: { ok: true } });
  rep({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "b1", tool_input: { command: "</script><img src=x onerror=alert(1)>" } });
  rep({ hook_event_name: "Stop" });

  const text = eaos(["report", "--since", "1h"]).out;
  assert.match(text, /eaos report · since .* refused/);
  assert.match(text, /REFUSED .* Bash/);
  assert.match(text, /files {4}.*src\/app\.ts/);
  assert.match(eaos(["files", "--since", "1h"]).out, /1× .* src\/app\.ts/);

  assert.doesNotMatch(eaos(["list", "--agent", "codex"]).out, /claude-/);
  assert.match(eaos(["list", "--agent", "codex"]).out, /codex-cx1/);
  assert.doesNotMatch(eaos(["report", "--refused", "--json"]).out, /"outcome":"ok"/);
  assert.match(eaos(["list", "--since", "2099-01-01"]).out, /No runs match/);
  assert.equal(eaos(["list", "--since", "soon"]).code, 1);

  const page = join(home, "report.html");
  assert.match(eaos(["report", "--html", page]).out, /Wrote .*report\.html/);
  const doc = readFileSync(page, "utf8");
  assert.ok(doc.includes("src/app.ts") || doc.includes("Write"), "data is inlined");
  assert.equal(doc.split("</script>").length, 2, "recorded text cannot close the script tag");
  assert.ok(!doc.includes("<img src=x"), "recorded markup stays escaped");
});

test("anchor --git commits anchors to a separate repository", () => {
  const repo = join(home, "anchors-repo");
  spawnSync("git", ["init", "-q", repo]);
  spawnSync("git", ["-C", repo, "config", "user.email", "t@example.invalid"]);
  spawnSync("git", ["-C", repo, "config", "user.name", "t"]);
  assert.match(eaos(["anchor", "--git", repo]).out, /Committed \d+ anchors/);
  assert.match(spawnSync("git", ["-C", repo, "log", "--oneline"], { encoding: "utf8" }).stdout, /eaos anchors/);
  assert.equal(eaos(["verify", "--against", join(repo, "eaos-anchors.txt")]).code, 0, "comment lines are skipped");
});
