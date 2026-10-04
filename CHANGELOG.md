# Changelog

## 3.1.0

- Official plugins: `claude plugin marketplace add elmokirk/eaos` and `codex plugin marketplace add elmokirk/eaos`.
  They bring their own copy of eaos; no CLI on PATH needed.
- `eaos report`: per project, the refused and failed calls and the files that changed. `--html` writes one
  self-contained page with filters by agent, project, outcome, time and text. `--json` for scripts.
- `eaos files`: files the agents changed, across all harnesses.
- Filters for `list`, `report` and `files`: `--since`, `--project`, `--agent`, `--refused`.
- `eaos anchor --git DIR` commits anchors to a repository you keep elsewhere.
- `dist/` is committed, so the plugins, `npx github:elmokirk/eaos` and `pi install git:github.com/elmokirk/eaos`
  work without a build step.

## 3.0.0

A rewrite down to one job: record what coding agents do, verifiably. MIT licensed.

- Records Claude Code and Codex (hooks, `eaos setup claude|codex`), OpenCode (plugin,
  `eaos setup opencode`) and Pi (extension, `pi install "$(npm root -g)/eaos"`) into one central store, one
  hash-chained JSONL file per session.
- Calls that never ran (blocked, denied, invalid) are recorded as `refused`.
- `eaos list`, `show`, `verify`, `anchor`, `verify --against` for detecting rewritten or deleted runs.
- Secrets redacted before hashing; safe for parallel writers.
- Removed everything else from 2.x: policy guards, HITL gate, sentinel, agent foundry, pipelines,
  registry, MCP servers, SQLite storage. Use a dedicated guard; eaos records what it does.
