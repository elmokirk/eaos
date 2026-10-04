/**
 * Pi extension. Records every tool call of a session, including the ones that never ran: Pi emits
 * `tool_execution_start/end` for a call another extension blocked, but no `tool_result`.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { actor, append, close, logError, newRun, project, type Kind } from "./record.ts";

const text = (result: unknown): string =>
  ((result as { content?: { type: string; text?: string }[] } | null)?.content ?? [])
    .map((part) => (part.type === "text" ? part.text ?? "" : ""))
    .join("");

export default function eaos(pi: ExtensionAPI): void {
  let run = "";
  const executed = new Set<string>();
  let warned = false;

  /** Recording must never break the session: errors are logged, and shown once. */
  function guard(what: string, ctx: ExtensionContext | undefined, fn: () => void): void {
    try {
      fn();
    } catch (error) {
      logError(`pi ${what}`, error);
      if (warned || !ctx?.hasUI) return;
      warned = true;
      try {
        ctx.ui.notify(`eaos: recording failed, see ~/.eaos/errors.log (${String(error)})`, "warning");
      } catch (notifyError) {
        logError("pi notify", notifyError);
      }
    }
  }

  function start(reason: string, cwd: string): void {
    const id = newRun("pi");
    append(id, { kind: "start", agent: "pi", reason, cwd, project: project(cwd), actor: actor() });
    run = id; // only once the start entry exists, so a failed start is retried by the next event
    executed.clear();
  }

  function record(entry: { kind: Kind; [field: string]: unknown }, ctx: ExtensionContext): void {
    guard(entry.kind, ctx, () => {
      if (!run) start("implicit", ctx.cwd);
      append(run, { agent: "pi", ...entry });
    });
  }

  pi.on("session_start", (event, ctx) => guard("start", ctx, () => start(event.reason, ctx.cwd)));

  pi.on("tool_execution_start", (event, ctx) => {
    record({ kind: "call", id: event.toolCallId, tool: event.toolName, input: event.args }, ctx);
  });

  pi.on("tool_result", (event) => {
    executed.add(event.toolCallId);
  });

  pi.on("tool_execution_end", (event, ctx) => {
    const base = { id: event.toolCallId, tool: event.toolName };
    record(executed.delete(event.toolCallId)
      ? { kind: "result", ...base, ok: !event.isError, output: text(event.result) }
      : { kind: "refused", ...base, reason: text(event.result) }, ctx);
  });

  pi.on("session_shutdown", (event, ctx) => {
    if (!run) return;
    guard("end", ctx, () => close(run, "pi", event.reason));
    run = "";
  });
}
