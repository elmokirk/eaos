/**
 * Pi extension. Records every tool call of a session, including the ones that never ran: Pi emits
 * `tool_execution_start/end` for a call another extension blocked, but no `tool_result`.
 */
import { actor, append, close, logError, newRun, project } from "./record.js";
const text = (result) => (result?.content ?? [])
    .map((part) => (part.type === "text" ? part.text ?? "" : ""))
    .join("");
export default function eaos(pi) {
    let run = "";
    const executed = new Set();
    let warned = false;
    /** Recording must never break the session: errors are logged, and shown once. */
    function guard(what, ctx, fn) {
        try {
            fn();
        }
        catch (error) {
            logError(`pi ${what}`, error);
            if (warned || !ctx?.hasUI)
                return;
            warned = true;
            try {
                ctx.ui.notify(`eaos: recording failed, see ~/.eaos/errors.log (${String(error)})`, "warning");
            }
            catch (notifyError) {
                logError("pi notify", notifyError);
            }
        }
    }
    function start(reason, cwd) {
        const id = newRun("pi");
        append(id, { kind: "start", agent: "pi", reason, cwd, project: project(cwd), actor: actor() });
        run = id; // only once the start entry exists, so a failed start is retried by the next event
        executed.clear();
    }
    function record(entry, ctx) {
        guard(entry.kind, ctx, () => {
            if (!run)
                start("implicit", ctx.cwd);
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
        if (!run)
            return;
        guard("end", ctx, () => close(run, "pi", event.reason));
        run = "";
    });
}
