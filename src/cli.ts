#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { append, begin, close, eaosHome, logError, read, runFile, runs, stable, tracesDir, type Sealed, type Verdict } from "./record.ts";
import { files, html, parseSince, rows, select, type Filter } from "./report.ts";

const HELP = `eaos — a tamper-evident flight recorder for coding agents

  eaos list [--all]                     recent runs: status, project, calls, refused
  eaos report [--html [FILE]] [--json]  what ran, what was refused or failed, which files changed
  eaos files                            files the agents changed
  eaos show [run] [--json]              one run's timeline (default: newest)
  eaos verify [run] [--against FILE]    check hash chains, and against saved anchors
  eaos anchor [--git DIR]               print anchors, or commit them to a git repo you keep elsewhere

  Filters for list, report, files: --since 12h|7d|DATE  --project TEXT  --agent TEXT  --refused
  eaos setup claude|codex|opencode      start recording that agent (--settings FILE / --dir DIR)
  eaos hook [--agent claude|codex]      the hook the agent calls (reads JSON on stdin)

Record Pi with: pi install git:github.com/elmokirk/eaos   Store: $EAOS_HOME, default ~/.eaos`;

/** Agents that call `eaos hook` with Claude Code's hook protocol. Codex adopted the same payload. */
const HOOK_AGENTS = {
  claude: {
    name: "claude-code",
    file: () => join(homedir(), ".claude", "settings.json"),
    events: ["SessionStart", "PreToolUse", "PostToolUse", "PostToolUseFailure", "PermissionDenied", "Stop", "SessionEnd"],
    matcher: undefined,
    after: "New Claude Code sessions are recorded.",
  },
  codex: {
    name: "codex",
    file: () => join(process.env["CODEX_HOME"] || join(homedir(), ".codex"), "hooks.json"),
    events: ["SessionStart", "PreToolUse", "PostToolUse", "Stop", "SessionEnd"],
    matcher: ".*",
    after: "Approve the new hooks once in Codex with /hooks; then every session is recorded.",
  },
} as const;
type HookAgent = keyof typeof HOOK_AGENTS;

const [command, ...args] = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? args.splice(i, 2)[1] ?? fail(`${name} needs a value`) : undefined;
};
const has = (name: string): boolean => {
  const i = args.indexOf(name);
  return i >= 0 && args.splice(i, 1).length > 0;
};

function fail(message: string, code = 1): never {
  process.stderr.write(`eaos: ${message}\n`);
  process.exit(code);
}

const filters = (): Filter => {
  const since = flag("--since");
  const project = flag("--project");
  const agent = flag("--agent");
  return { ...(since && { since: parseSince(since) }), ...(project && { project }), ...(agent && { agent }), refused: has("--refused") };
};

/** Newest run, an exact id, or a unique fragment of one. */
function pick(fragment: string | undefined): string {
  const ids = runs().map((r) => r.run);
  if (ids.length === 0) fail(`no runs recorded yet in ${tracesDir()}`);
  if (fragment === undefined) return ids[0] as string;
  if (ids.includes(fragment)) return fragment;
  const hits = ids.filter((id) => id.includes(fragment));
  if (hits.length === 1) return hits[0] as string;
  return fail(hits.length === 0 ? `no run matches ${fragment}` : `${fragment} matches ${hits.length} runs, be more specific`);
}

const time = (ts: unknown): string => String(ts).slice(11, 19);
/** One terminal-safe line: recorded text is agent output, and an escape sequence must not repaint the verdict. */
const oneLine = (value: unknown, width = 100): string => {
  // eslint-disable-next-line no-control-regex
  const s = (typeof value === "string" ? value : stable(value)).replace(/[\s\x00-\x1f\x7f-\x9f]+/g, " ").trim();
  return s.length > width ? `${s.slice(0, width - 1)}…` : s;
};
const summary = (v: Verdict) => {
  const start = v.entries.find((e) => e.kind === "start");
  return {
    project: oneLine(start?.["project"] ?? "?", 28),
    actor: oneLine(start?.["actor"] ?? "?", 40),
    calls: v.entries.filter((e) => e.kind === "call").length,
    refused: v.entries.filter((e) => e.kind === "refused").length,
  };
};

function list(): void {
  const showAll = has("--all");
  const all = select(filters());
  if (all.length === 0) {
    if (runs().length > 0) return console.log("No runs match these filters.");
    console.log(`No runs yet in ${tracesDir()}.\nStart recording: see https://github.com/elmokirk/eaos#install (plugins for Claude Code and Codex, eaos setup opencode, Pi)`);
    return;
  }
  const shown = showAll ? all : all.slice(0, 20);
  console.log(["STATUS", "RUN".padEnd(34), "PROJECT".padEnd(28), "CALLS", "REFUSED", "LAST"].join("  "));
  for (const { run, verdict } of shown) {
    const s = summary(verdict);
    const last = String(verdict.entries.at(-1)?.ts ?? "").slice(0, 16).replace("T", " ");
    console.log([verdict.status.padEnd(6), run.padEnd(34), s.project.padEnd(28), String(s.calls).padStart(5), String(s.refused).padStart(7), last].join("  "));
  }
  if (shown.length < all.length) console.log(`… ${all.length - shown.length} older runs, --all shows them`);
  const errors = join(eaosHome(), "errors.log");
  if (existsSync(errors) && statSync(errors).size > 0) console.log(`\nRecording errors were logged: ${errors}`);
}

function show(): void {
  const json = has("--json");
  const run = pick(args[0]);
  const v = read(run);
  if (json) {
    for (const e of v.entries) console.log(JSON.stringify(e));
    if (v.error) fail(`chain broken at ${v.error}`);
    return;
  }
  const s = summary(v);
  console.log(`${run}  ${s.project}  ${s.actor}  ${v.status}${v.error ? ` (${v.error})` : ""}\n`);
  for (const e of v.entries) console.log(`${time(e.ts)}  ${line(e)}`);
  if (v.status === "broken") process.exitCode = 1;
}

function line(e: Sealed): string {
  const tool = String(e["tool"] ?? "");
  switch (e.kind) {
    case "start": return `start    ${e.agent} (${oneLine(e["reason"])}) in ${oneLine(e["cwd"], 200)}`;
    case "call": return `call     ${tool}  ${oneLine(e["input"])}`;
    case "result": return `${e["ok"] ? "ok      " : "error   "} ${tool}  ${oneLine((e["output"] as { stdout?: unknown } | null)?.stdout ?? e["output"], 80)}`;
    case "refused": return `REFUSED  ${tool}  ${oneLine(e["reason"])}`;
    case "end": return `end      ${oneLine(e["reason"])}`;
  }
}

function verifyCommand(): void {
  const against = flag("--against");
  const targets = args[0] ? [pick(args[0])] : runs().map((r) => r.run);
  let bad = 0;
  for (const run of targets) {
    const v = read(run);
    if (v.status === "broken") bad++;
    console.log(`${v.status.padEnd(6)}  ${run}  ${v.entries.length} entries${v.error ? `  BROKEN at ${v.error}` : ""}`);
  }
  if (against !== undefined) {
    for (const anchor of readFileSync(against, "utf8").split("\n").filter((l) => l.trim())) {
      if (anchor.startsWith("#")) continue;
      const [run = "", seq = "", hash = ""] = anchor.trim().split(/\s+/);
      if (args[0] && run !== targets[0]) continue;
      const v = existsSync(runFile(run)) ? read(run) : null;
      if (v?.entries[Number(seq)]?.hash === hash) continue;
      bad++;
      console.log(`ANCHOR  ${run}  entry ${seq} ${v ? "no longer matches its anchor: the file was rewritten" : "is gone: the run was deleted"}`);
    }
  }
  if (targets.length === 0) console.log(`No runs in ${tracesDir()}.`);
  if (bad > 0) fail(`${bad} problem(s) found`);
}

function anchor(): void {
  const repo = flag("--git");
  const lines: string[] = [];
  for (const { run } of runs()) {
    const v = read(run);
    const last = v.entries.at(-1);
    if (v.status === "broken" || !last) process.stderr.write(`eaos: skipping ${run}, its chain is broken\n`);
    else lines.push(`${run} ${last.seq} ${last.hash}`);
  }
  if (!repo) return void lines.forEach((l) => console.log(l));
  // A repository the agent's account cannot rewrite is the point; eaos only appends and commits.
  const stamp = new Date().toISOString();
  appendFileSync(join(repo, "eaos-anchors.txt"), `# ${stamp}\n${lines.join("\n")}\n`);
  execFileSync("git", ["-C", repo, "add", "eaos-anchors.txt"], { stdio: "ignore" });
  execFileSync("git", ["-C", repo, "commit", "-q", "-m", `eaos anchors ${stamp}`], { stdio: "ignore" });
  console.log(`Committed ${lines.length} anchors to ${join(repo, "eaos-anchors.txt")}. Push it somewhere the agent cannot write.`);
}

function report(): void {
  const htmlFlag = args.indexOf("--html");
  const target = htmlFlag >= 0 ? (args[htmlFlag + 1]?.startsWith("--") === false ? args.splice(htmlFlag, 2)[1] : (args.splice(htmlFlag, 1), "eaos-report.html")) : null;
  const json = has("--json");
  const f = filters();
  const selected = select(f);
  const data = rows(selected);
  if (json) return void data.forEach((r) => console.log(JSON.stringify(r)));
  if (target) {
    writeFileSync(target, html(data, `eaos report · ${new Date().toISOString().slice(0, 16).replace("T", " ")}`));
    return console.log(`Wrote ${resolve(target)} (${data.length} calls). Open it in a browser; filters run locally.`);
  }
  const count = (o: string, of = data) => of.filter((r) => r.outcome === o).length;
  const since = f.since === undefined ? "all time" : `since ${new Date(f.since).toISOString().slice(0, 16).replace("T", " ")}`;
  console.log(`eaos report · ${since} · ${selected.length} runs · ${data.length} calls · ${count("refused")} refused · ${count("error")} errors`);
  const changed = files(selected);
  for (const project of [...new Set(selected.map((r) => r.project))]) {
    const mine = data.filter((r) => r.project === project);
    const agents = [...new Set(selected.filter((r) => r.project === project).map((r) => r.agent))].join(", ");
    console.log(`\n${oneLine(project, 60)} · ${agents} · ${mine.length} calls`);
    for (const r of mine.filter((r) => r.outcome !== "ok")) {
      console.log(`  ${r.outcome === "refused" ? "REFUSED" : "error  "}  ${String(r.ts).slice(5, 16).replace("T", " ")}  ${r.tool}  ${oneLine(r.input, 70)}  (${oneLine(r.detail, 60)})`);
    }
    const touched = changed.filter((c) => c.project === project).map((c) => c.file);
    if (touched.length) console.log(`  files    ${touched.slice(0, 8).map((t) => oneLine(t, 60)).join(", ")}${touched.length > 8 ? `, +${touched.length - 8} more` : ""}`);
  }
}

function filesCommand(): void {
  const changed = files(select(filters()));
  if (changed.length === 0) return console.log("No changed files in the selected runs.");
  for (const c of changed) console.log(`${c.last.slice(0, 16).replace("T", " ")}  ${String(c.times).padStart(3)}×  ${oneLine(c.project, 28).padEnd(28)}  ${oneLine(c.file, 120)}`);
}

/** The hook itself. Never fails the host: errors go to errors.log, the exit code is always 0. */
function hook(): void {
  const key = (flag("--agent") ?? "claude") as HookAgent;
  let event = "unknown";
  try {
    const spec = HOOK_AGENTS[key];
    if (!spec) throw new Error(`unknown --agent ${key}`);
    const h = JSON.parse(readFileSync(0, "utf8")) as Record<string, unknown>;
    event = String(h["hook_event_name"]);
    if (typeof h["session_id"] !== "string" || !h["session_id"]) throw new Error("hook input has no session_id");
    const run = `${key}-${h["session_id"].replace(/[^\w-]/g, "_").slice(0, 12)}`;
    const cwd = String(h["cwd"] ?? process.cwd());
    const base = { agent: spec.name, id: h["tool_use_id"], tool: h["tool_name"], subagent: h["agent_type"] };
    if (event === "SessionStart") return begin(run, spec.name, cwd, h["source"]);
    // Stop ends a turn, so every call of it is settled by now. SessionEnd is not reliable under `claude -p`.
    if (event === "Stop" || event === "SessionEnd") {
      return existsSync(runFile(run)) ? close(run, spec.name, event === "Stop" ? null : String(h["reason"])) : undefined;
    }
    begin(run, spec.name, cwd, "hooks installed mid-session");
    if (event === "PreToolUse") append(run, { ...base, kind: "call", input: h["tool_input"] });
    else if (event === "PostToolUse") append(run, { ...base, kind: "result", ok: true, output: h["tool_response"] });
    else if (event === "PostToolUseFailure") append(run, { ...base, kind: "result", ok: false, output: h["error"] });
    else if (event === "PermissionDenied") append(run, { ...base, kind: "refused", reason: h["reason"] });
  } catch (error) {
    logError(`${key} hook ${event}`, error);
  }
}

type Hooks = Record<string, { matcher?: string; hooks?: { type: string; command: string }[] }[]>;

/** Merge eaos into a hooks file (Claude Code settings.json, Codex hooks.json): idempotent, atomic, original backed up. */
function setupHooks(key: HookAgent): void {
  const spec = HOOK_AGENTS[key];
  const file = flag("--settings") ?? spec.file();
  const command = key === "claude" ? "eaos hook" : `eaos hook --agent ${key}`;
  const settings: unknown = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
  const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
  if (!isObject(settings) || (settings["hooks"] !== undefined && !isObject(settings["hooks"]))) fail(`${file} is not a settings object with a "hooks" object; left unchanged`);
  const hooks = (settings["hooks"] ??= {}) as Hooks;
  const added = spec.events.filter((name) => {
    const groups = (hooks[name] ??= []);
    if (!Array.isArray(groups)) fail(`${file}: hooks.${name} is not a list; left unchanged`);
    if (groups.some((g) => g.hooks?.some((h) => h.command === command))) return false;
    groups.push({ ...(spec.matcher && name.includes("ToolUse") ? { matcher: spec.matcher } : {}), hooks: [{ type: "command", command }] });
    return true;
  });
  if (added.length === 0) return console.log(`${spec.name} already records through eaos (${file}).`);
  // Keep the first backup: it is the user's original file, and a later run must not overwrite it.
  const backup = `${file}.eaos-backup`;
  if (existsSync(file) && !existsSync(backup)) copyFileSync(file, backup);
  writeAtomic(file, `${JSON.stringify(settings, null, 2)}\n`);
  console.log(`Added eaos hooks for ${added.join(", ")} to ${file}${existsSync(backup) ? ` (original kept as ${backup})` : ""}.`);
  console.log(`${spec.after} \`eaos\` must stay on PATH (installed with npm install -g).`);
}

/** OpenCode loads every module in its plugins directory; ours re-exports the installed plugin. */
function setupOpenCode(): void {
  const dir = flag("--dir") ?? join(process.env["XDG_CONFIG_HOME"] || join(homedir(), ".config"), "opencode", "plugins");
  const plugin = new URL(import.meta.url.endsWith(".ts") ? "./opencode.ts" : "./opencode.js", import.meta.url).href;
  const file = join(dir, "eaos.js");
  writeAtomic(file, `// Written by \`eaos setup opencode\`. Records every tool call into ~/.eaos.\nexport { EaosRecorder } from ${JSON.stringify(plugin)};\n`);
  console.log(`Wrote ${file}. New OpenCode sessions are recorded.`);
}

function writeAtomic(file: string, content: string): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(`${file}.eaos-tmp`, content);
  renameSync(`${file}.eaos-tmp`, file); // a crash leaves the old file or the new one, never half of one
}

const version = (): string => (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }).version;

try {
  switch (command) {
    case "list": list(); break;
    case "show": show(); break;
    case "verify": verifyCommand(); break;
    case "anchor": anchor(); break;
    case "report": report(); break;
    case "files": filesCommand(); break;
    case "hook": hook(); break;
    case "setup": {
      const target = args.shift();
      if (target === "claude" || target === "codex") setupHooks(target);
      else if (target === "opencode") setupOpenCode();
      else fail("usage: eaos setup claude|codex|opencode", 2);
      break;
    }
    case "--version": case "-v": console.log(version()); break;
    case undefined: case "help": case "--help": case "-h": console.log(HELP); break;
    default: fail(`unknown command ${command}\n\n${HELP}`, 2);
  }
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
