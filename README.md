# eaos

**The flight recorder for coding agents.** Every tool call of every harness you run (Claude
Code, Codex, OpenCode, [Pi](https://pi.dev)), including the calls that were blocked or
denied, lands in one central, tamper-evident log. One command per agent to set up, zero
dependencies, nothing leaves your machine.

[Is it worth it?](#is-it-worth-it-for-you) · [Install](#install) · [Use](#use) · [What is recorded](#what-is-recorded) · [Limits](#limits) · [Releases](https://github.com/elmokirk/eaos/releases)

```bash
claude plugin marketplace add elmokirk/eaos && claude plugin install eaos@eaos
# …let your agents work overnight…
npx github:elmokirk/eaos report --since 12h   # what ran, what was refused, which files changed
```

## Why

- **You let an agent run unattended, and an hour later you need to know what it did.** Which
  commands ran, which files it touched, what it tried that was stopped. The chat transcript
  does not tell you that.
- **The refusals matter most.** Guards, permission prompts and deny rules show you what they
  stop only at the moment they stop it. eaos keeps every refused call next to the ones that
  ran, so you can see whether your guardrails ever fire.
- **The log has to be trustworthy.** Each line seals the line before it, so `eaos verify`
  detects any edited, reordered or deleted line. Anchors detect even a rewrite of the whole
  file.

**eaos records. It does not block.** Keep the guard you already use: Claude Code
permissions, `pi-permission-system`, `destructive_command_guard`, or your own hook. eaos
shows you what that guard let through and what it stopped.

## Is it worth it for you?

The more your agents act without you watching, the more eaos is worth. If you approve every call
by hand, you already saw everything it would record.

| Your situation | Without eaos | With eaos | Value |
|---|---|---|---|
| Agents run unattended: overnight, CI, `claude -p` loops, auto-approve or bypass modes | A chat transcript, if you kept it | `eaos report --since 12h`: what ran, what was refused, which files changed | **High** |
| You use two or more harnesses | One log format per tool, or none | One store, one timeline, filter by `--agent` | **High** |
| You work in client repositories | "Trust me" | Per-project record you can hand over, verifiable with `eaos verify` | **High** |
| You run a guard or deny rules and want to know if they work | You notice only when a block hits you | Every refusal is recorded; `--refused` lists each one with its reason, where the agent reports one | **High** |
| Something broke and you need to know which call did it | Guesswork from the transcript | `eaos files` and `show` point to the call, its input and its output | **High** |
| Someone may later ask what the AI did (client, auditor, your team) | A chat export anyone could edit | A hash-chained log, plus anchors in a repo the agent cannot touch | **Medium.** It is evidence, not a compliance product |
| You pair-program and approve every call yourself | You saw it happen | The same, written down | **Low** |
| You need to stop dangerous commands | | eaos does not block. Use a guard; eaos records what it did | **Not the tool** |
| You need a team-wide server with authenticated users | | Not built: the store is local and `actor` is not authenticated | **Not yet** |

**Rule of thumb.** Install it if at least one of the first five rows describes you. The plugins take
one command, and you can remove them as quickly.

## Use cases

- **The morning after.** You start a long refactor in Codex or `claude -p` before leaving. In the
  morning, `eaos report --since 12h` lists per project the refused and failed calls and the changed
  files. Then `eaos show` replays any run you want to see in full.
- **Guardrail check.** You added deny rules or a guard like `destructive_command_guard`. After a week
  `eaos report --refused --since 7d` shows whether they fired, and on what. A rule that never fired
  is a rule you have not tested.
- **Client handover.** At the end of an engagement, `eaos report --project client/repo --html`
  writes one page you can attach, and `eaos anchor --git` proves the record was not edited later.
- **Incident forensics.** A config file vanished. `eaos files --since 1d` shows which agent wrote
  it, and `eaos show <run>` the exact call and what came back.
- **One view across tools.** Claude Code for features, Codex for reviews, OpenCode for experiments:
  `eaos list` puts them on one timeline, and `--agent` splits them again.

## Install

Recording runs inside your agents. Install it for each harness you use; all of them write to the
same store, `~/.eaos`.

| Agent | Install | Notes |
|---|---|---|
| Claude Code | `claude plugin marketplace add elmokirk/eaos`<br>`claude plugin install eaos@eaos` | Official plugin. Restart Claude Code or run `/reload-plugins` |
| Codex | `codex plugin marketplace add elmokirk/eaos`<br>`codex plugin add eaos@eaos` | Official plugin. Trust its hooks once with `/hooks` |
| OpenCode | `eaos setup opencode` | Writes `~/.config/opencode/plugins/eaos.js` |
| Pi | `pi install git:github.com/elmokirk/eaos` | Pi extension for every project |

The CLI reads the records. Install it once, or run it without installing through `npx github:elmokirk/eaos`:

```bash
npm install -g https://github.com/elmokirk/eaos/releases/latest/download/eaos.tgz
```

Requires Node 20 or newer. The Claude Code and Codex plugins bring their own copy of eaos, so they
work without the CLI on your PATH. Without plugins you can also wire the hooks directly with
`eaos setup claude` or `eaos setup codex`; use one way per agent, not both, or calls are recorded
twice. To remove eaos, uninstall the plugins (`claude plugin uninstall eaos`, `codex plugin remove
eaos`), delete `~/.config/opencode/plugins/eaos.js`, and run `pi remove` and `npm uninstall -g
eaos`. Your records stay in `~/.eaos`.

Nothing runs in the background. Claude Code and Codex start the hook for each tool call (about
80 ms); OpenCode and Pi run eaos inside their own process. When no agent runs, eaos does not run.

## Use

```bash
eaos report --since 12h          # per project: refused and failed calls, files changed
eaos report --html               # eaos-report.html: one file, filters by agent, project, outcome, time, text
eaos files --since 7d            # files the agents changed
eaos list                        # recent runs: status, project, calls, refused
eaos show [run]                  # one run's timeline, newest by default; any unique part of the id works
eaos show [run] --json           # the raw entries, for jq or your SIEM
eaos verify                      # check every run's chain; exit 1 if any was tampered with
eaos anchor --git ~/audit        # commit every run's current head to a repo you keep elsewhere…
eaos verify --against ~/audit/eaos-anchors.txt   # …and later prove nothing before it was rewritten
```

`list`, `report` and `files` take the same filters: `--since 30m|12h|7d|2026-10-01`, `--project
TEXT`, `--agent claude|codex|opencode|pi`, and `--refused` to see only calls that never ran.

```text
$ eaos report --since 12h
eaos report · since 2026-10-04 04:25 · 2 runs · 4 calls · 2 refused · 0 errors

you/your-repo · codex, claude-code · 4 calls
  REFUSED  10-04 16:25  Bash  {"command":"git push --force"}  (no result recorded: denied, blocked or interrupted)
  REFUSED  10-04 16:25  Bash  {"command":"rm -rf ./build"}  (denied by user)
  files    src/index.ts
```

This is the output of a real Claude Code session:

```text
$ eaos show
claude-c9794d24  you/your-repo  you@laptop  ok

11:41:42  start    claude-code (startup) in /home/you/your-repo
11:41:52  call     Bash  {"command":"echo hello","description":"Echo hello to stdout"}
11:41:56  ok       Bash  hello
11:41:59  call     Bash  {"command":"rm -rf ./build-cache","description":"Delete the build-cache directory"}
11:42:04  REFUSED  Bash  no result recorded: denied, blocked or interrupted
11:42:04  end      other
```

A run's status is one of three values:

- `ok`: the chain is intact and the session closed.
- `open`: the chain is intact and the session is still running, or crashed before it closed.
- `broken`: a line was altered, removed or reordered. `verify` names the first bad line.

## What is recorded

One file per session in `~/.eaos/traces/`. Each file has these entries:

| Entry | Content |
|---|---|
| `start` | Agent, working directory, project (git `owner/repo`), actor (`user@host`) |
| `call` | Tool name and input |
| `result` | Success or error, and the output |
| `refused` | A call that never ran: blocked by an extension or hook, denied by you, or invalid. Includes the reason when the agent gives one |
| `end` | Why the session ended |

Secrets are redacted before anything is written or hashed: API keys, tokens, bearer headers,
private keys, passwords in URLs, and `*_KEY=`/`*_TOKEN=`-style assignments. Strings longer than
2,000 characters are cut. Files are created owner-only. Nothing leaves your machine.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `EAOS_HOME` | `~/.eaos` | Where the store lives |
| `EAOS_ACTOR` | `user@host` | Who is acting. Set it to an email or ID when several people share one store |
| `EAOS_PROJECT` | git origin, else the folder name | Override the project name |

Recording never interrupts the agent. If a write fails, the error goes to
`~/.eaos/errors.log`, and `eaos list` tells you about it.

## Limits

- **Tamper-evident, not tamper-proof.** Anyone who can write the file can rewrite the whole
  chain consistently. That is what anchors are for. Store `eaos anchor` output somewhere the
  agent's account cannot change: a commit in another repository, a ticket, a chat message.
- **`actor` is not authenticated.** It names an account on a machine, not a verified person.
- **Claude Code** reports a call blocked by another hook as a call without a result. eaos
  marks it `refused` at the end of the turn. The exact reason is known only for permission
  denials. `claude -p` can exit without sending its session-end hook, so those runs stay
  `open`.
- **Codex** hooks see every call, but not the user's answer to an approval prompt. A declined
  approval shows up as a call without a result, and eaos marks it `refused` at the end of the
  turn. Hosted tools such as web search are not hooked.
- **OpenCode** reports denied and failed calls the same way. eaos tells them apart by the error
  message.
- A crash before the session ends leaves the run `open`, the same status as a run whose tail
  was cut off. Anchors tell the two apart.

## Development

```bash
npm install
npm run verify      # typecheck, tests (including a real Pi session), build
```

The source is five files:

- `src/record.ts`: the store
- `src/report.ts`: filters, report, files, the HTML view
- `src/cli.ts`: the CLI, plus the hook that Claude Code and Codex call
- `src/pi.ts`: the Pi extension
- `src/opencode.ts`: the OpenCode plugin

`dist/` is committed so that plugins and git installs work without a build step; CI fails if it is
stale. Plugin manifests live in `.claude-plugin/`, `.codex-plugin/`, `.agents/plugins/` and `hooks/`.

## License

[MIT](LICENSE). Security reports go through [SECURITY.md](SECURITY.md).
