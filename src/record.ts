/**
 * The record: one append-only JSONL file per run under `$EAOS_HOME/traces`, every line sealed with
 * its sequence number, the previous line's hash and its own. Editing, deleting or reordering a line
 * breaks the chain; `anchor` + `verify --against` catch a rewrite of the whole file.
 */

import { createHash, randomBytes } from "node:crypto";
import {
  appendFileSync, closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, rmSync, statSync, writeFileSync,
} from "node:fs";
import { homedir, hostname, userInfo } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

export type Kind = "start" | "call" | "result" | "refused" | "end";

export interface Entry {
  kind: Kind;
  agent: string;
  [field: string]: unknown;
}

export interface Sealed extends Entry {
  ts: string;
  seq: number;
  prev: string | null;
  hash: string;
}

export interface Verdict {
  status: "ok" | "open" | "broken";
  entries: Sealed[];
  error?: string;
}

const MAX_STRING = 2000;
const MAX_ITEMS = 200;
const REDACTED = "[REDACTED]";
// Bounded repetitions throughout: these run on agent output, and an unbounded `[\w.-]*` backtracks quadratically.
const SECRET_NAME = String.raw`[\w.-]{0,40}(?:token|secret|password|passwd|api[_-]?key|apikey|access[_-]?key|private[_-]?key|client[_-]?secret|authorization|credential|passphrase)[\w.-]{0,40}`;
const SECRET_KEY = new RegExp(`^${SECRET_NAME}$`, "i");
const SECRETS: [RegExp, string][] = [
  [/-----BEGIN [A-Z ]{0,20}PRIVATE KEY-----[\s\S]{0,10000}?(?:-----END [A-Z ]{0,20}PRIVATE KEY-----|$)/g, REDACTED],
  [/\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_\w{20,}|A[KS]IA[0-9A-Z]{16}|AIza[\w-]{30,}|xox[abprs]-[A-Za-z0-9-]{10,}|glpat-[\w-]{20,}|npm_[A-Za-z0-9]{36})/g, REDACTED],
  [/\bey[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}/g, REDACTED],
  [/\b(Bearer|Basic)\s+[\w.~+/=-]{16,}/gi, `$1 ${REDACTED}`],
  [new RegExp(String.raw`\b(${SECRET_NAME}["']?\s*[:=]\s*)(?:"[^"\n]{0,500}"|'[^'\n]{0,500}'|[^\s"',;&]{3,})`, "gi"), `$1${REDACTED}`],
  [/\b([a-z][a-z0-9+.-]*:\/\/[^\s:/?#@]+:)[^\s/?#@]+@/gi, `$1${REDACTED}@`],
];

export const eaosHome = (env = process.env): string => resolve(env["EAOS_HOME"] || join(homedir(), ".eaos"));
export const tracesDir = (env = process.env): string => join(eaosHome(env), "traces");

/** `$EAOS_ACTOR`, else `user@host`. Names an account, not a person, and is not authenticated. */
export function actor(env = process.env): string {
  if (env["EAOS_ACTOR"]) return env["EAOS_ACTOR"];
  let user = env["USER"] ?? env["USERNAME"] ?? "unknown";
  try {
    user = userInfo().username;
  } catch {
    // No passwd entry (containers with an arbitrary uid): the environment's name stands.
  }
  return `${user}@${hostname()}`;
}

/** `$EAOS_PROJECT`, else the git origin as `owner/repo`, else the repository or directory name. */
export function project(cwd: string, env = process.env): string {
  if (env["EAOS_PROJECT"]) return env["EAOS_PROJECT"];
  for (let dir = resolve(cwd); ; dir = dirname(dir)) {
    const git = join(dir, ".git");
    const stat = statSync(git, { throwIfNoEntry: false });
    if (stat) return originSlug(dir, git, stat.isFile()) ?? basename(dir);
    if (dirname(dir) === dir) return basename(resolve(cwd)) || "unknown";
  }
}

function originSlug(dir: string, git: string, isWorktree: boolean): string | null {
  try {
    // A worktree's `.git` is a file pointing at `<main>/.git/worktrees/<name>`; config lives in `<main>/.git`.
    const gitDir = isWorktree ? resolve(dir, readFileSync(git, "utf8").replace(/^gitdir:\s*/, "").trim(), "../..") : git;
    const url = /\[remote "origin"\][^[]*?url\s*=\s*(\S+)/.exec(readFileSync(join(gitDir, "config"), "utf8"))?.[1];
    return url?.replace(/\.git$/, "").match(/[^/:]+\/[^/:]+$/)?.[0] ?? null;
  } catch {
    // Unreadable or unusual git layout: the caller falls back to the directory name.
    return null;
  }
}

export const newRun = (agent: string): string =>
  `${agent}-${new Date().toISOString().replace(/\D/g, "").slice(0, 14)}-${randomBytes(3).toString("hex")}`;

/** Run ids become file names, so anything outside this alphabet is refused. */
const RUN_FILE = /^[\w-][\w.-]{0,127}\.jsonl$/;

export function runFile(run: string, env = process.env): string {
  if (!RUN_FILE.test(`${run}.jsonl`)) throw new Error(`not a valid run id: ${run}`);
  return join(tracesDir(env), `${run}.jsonl`);
}

/** Secrets replaced and size bounded (string length, array length, depth) before anything is hashed or written. */
export function redact(value: unknown, depth = 0): unknown {
  if (typeof value === "string") {
    // Cut first: the patterns never see more than a bounded string.
    const clean = SECRETS.reduce((text, [pattern, by]) => text.replace(pattern, by), value.slice(0, MAX_STRING + 256));
    return value.length > MAX_STRING ? `${clean.slice(0, MAX_STRING)}…[+${value.length - MAX_STRING} chars]` : clean;
  }
  if (value === null || typeof value !== "object") return value;
  if (depth > 12) return "[too deep]";
  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_ITEMS).map((item) => redact(item, depth + 1));
    return value.length > MAX_ITEMS ? [...items, `[+${value.length - MAX_ITEMS} more]`] : items;
  }
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, SECRET_KEY.test(k) && typeof v === "string" ? REDACTED : redact(v, depth + 1)]));
}

/** JSON with keys sorted at every level, so a hash never depends on insertion order. */
export function stable(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  return `{${Object.entries(value)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`)
    .join(",")}}`;
}

const digest = (body: unknown): string => createHash("sha256").update(stable(body)).digest("hex");

/** Append one entry. Safe across processes: Claude Code runs a separate hook process per tool call. */
export function append(run: string, entry: Entry, env = process.env): Sealed {
  const file = runFile(run, env);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  return locked(file, () => {
    const tail = lastLine(file);
    let last: Sealed | null = null;
    try {
      last = tail === null ? null : (JSON.parse(tail) as Sealed);
    } catch (error) {
      // A torn last line (crash mid-write, full disk). Keep recording on a fresh line; `verify` reports the tear.
      logError(`${run}: last line is damaged, continuing after it`, error, env);
    }
    const body = { ...(redact(entry) as Entry), run, ts: new Date().toISOString(), seq: last ? last.seq + 1 : 0, prev: last?.hash ?? null };
    const sealed: Sealed = { ...body, hash: digest(body) };
    appendFileSync(file, `${tail !== null && last === null ? "\n" : ""}${JSON.stringify(sealed)}\n`, { mode: 0o600 });
    return sealed;
  });
}

/** Write the `start` entry of a run recorded by a hook or plugin, unless the run already has one on disk. */
export function begin(run: string, agent: string, cwd: string, reason: unknown, env = process.env): void {
  if (!existsSync(runFile(run, env))) append(run, { kind: "start", agent, reason, cwd, project: project(cwd, env), actor: actor(env) }, env);
}

/** Every call without an outcome becomes `refused` (it never ran); then `end`, unless `reason` is null (a turn ended, not the session). */
export function close(run: string, agent: string, reason: string | null, env = process.env): void {
  const { entries } = read(run, env);
  const settled = new Set(entries.filter((e) => e.kind === "result" || e.kind === "refused").map((e) => e.id));
  for (const call of entries.filter((e) => e.kind === "call" && !settled.has(e.id))) {
    append(run, { kind: "refused", agent, id: call.id, tool: call.tool, reason: "no result recorded: denied, blocked or interrupted" }, env);
  }
  if (reason !== null) append(run, { kind: "end", agent, reason }, env);
}

export function read(run: string, env = process.env): Verdict {
  return verify(readFileSync(runFile(run, env), "utf8").split("\n").filter(Boolean), run);
}

/** `run` binds the chain to its file: a valid chain copied under another name does not verify. */
export function verify(lines: string[], run?: string): Verdict {
  const entries: Sealed[] = [];
  const broken = (error: string): Verdict => ({ status: "broken", entries, error: `line ${entries.length + 1}: ${error}` });
  for (const line of lines) {
    let entry: Sealed;
    try {
      entry = JSON.parse(line) as Sealed;
    } catch (error) {
      return broken(`not JSON (${(error as Error).message})`);
    }
    if (typeof entry !== "object" || entry === null) return broken("not an entry");
    const { hash, ...body } = entry;
    if (run !== undefined && body.run !== run) return broken(`belongs to run ${String(body.run)}`);
    if (body.seq !== entries.length) return broken(`seq ${String(body.seq)}, expected ${entries.length}`);
    if (body.prev !== (entries.at(-1)?.hash ?? null)) return broken("does not link to the line before");
    if (digest(body) !== hash) return broken("altered after it was written");
    entries.push(entry);
  }
  if (entries.length === 0) return { status: "broken", entries, error: "no entries" };
  return { status: entries.at(-1)?.kind === "end" ? "ok" : "open", entries };
}

/** Runs on disk, newest first. Files that are not run files are ignored. */
export function runs(env = process.env): { run: string; mtime: number }[] {
  const dir = tracesDir(env);
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isFile() && RUN_FILE.test(d.name))
    .map((d) => ({ run: d.name.slice(0, -6), mtime: statSync(join(dir, d.name)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
}

/** Where caught errors go when there is no terminal to show them: hooks and extensions must never crash their host. */
export function logError(where: string, error: unknown, env = process.env): void {
  const line = `${new Date().toISOString()} ${where}: ${error instanceof Error ? error.message : String(error)}\n`;
  try {
    mkdirSync(eaosHome(env), { recursive: true, mode: 0o700 });
    appendFileSync(join(eaosHome(env), "errors.log"), line, { mode: 0o600 });
  } catch {
    process.stderr.write(`eaos: ${line}`);
  }
}

function lastLine(file: string): string | null {
  let fd: number;
  try {
    fd = openSync(file, "r");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  try {
    const size = fstatSync(fd).size;
    if (size === 0) return null;
    // Read backwards in growing chunks: a long session must not cost a full read per append.
    for (let n = Math.min(size, 65536); ; n = Math.min(size, n * 4)) {
      const buf = Buffer.alloc(n);
      readSync(fd, buf, 0, n, size - n);
      const text = buf.toString("utf8").replace(/\n$/, "");
      const cut = text.lastIndexOf("\n");
      if (cut >= 0 || n === size) return text.slice(cut + 1);
    }
  } finally {
    closeSync(fd);
  }
}

const pause = new Int32Array(new SharedArrayBuffer(4));

/** True when the lock's holder is dead. A live holder is never robbed, however slow it is. */
function abandoned(lock: string): boolean {
  const age = Date.now() - (statSync(lock, { throwIfNoEntry: false })?.mtimeMs ?? Date.now());
  if (age < 2000) return false;
  let pid = 0;
  try {
    pid = Number(readFileSync(lock, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; // released while we looked
    throw error;
  }
  if (!pid) return age > 10_000; // died between creating the lock and writing its pid
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}

// ponytail: two waiters that detect the same dead holder at once can both proceed. The result is a
// fork that `verify` reports, never a silent one, and it needs a crash plus a race.
function locked<T>(file: string, fn: () => T): T {
  const lock = `${file}.lock`;
  const since = Date.now();
  for (;;) {
    try {
      writeFileSync(lock, String(process.pid), { flag: "wx" });
      break;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? "";
      // Windows reports EPERM/EACCES for a moment while another process's lock is being deleted.
      const transient = (code === "EPERM" || code === "EACCES" || code === "EBUSY") && Date.now() - since < 1000;
      if (code !== "EEXIST" && !transient) throw error;
      if (code === "EEXIST" && abandoned(lock)) rmSync(lock, { force: true });
      else if (Date.now() - since > 15_000) throw new Error(`${lock} is held by running process ${readFileSync(lock, "utf8")}`);
      else Atomics.wait(pause, 0, 0, 5);
    }
  }
  try {
    return fn();
  } finally {
    rmSync(lock, { force: true, maxRetries: 5 });
  }
}
