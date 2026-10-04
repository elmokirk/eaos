/**
 * OpenCode plugin (`"plugin": ["eaos"]` in opencode.json). OpenCode runs `tool.execute.after` only
 * for calls that succeeded; a denied, blocked or failed call surfaces only as an errored tool part.
 */
import { append, begin, close, logError } from "./record.js";
const AGENT = "opencode";
export const EaosRecorder = async ({ directory }) => {
    const failed = new Set(); // an errored part is re-emitted on every later update
    const run = (session) => `opencode-${session.replace(/[^\w-]/g, "_").slice(-16)}`;
    const record = (session, entry) => {
        try {
            begin(run(session), AGENT, directory, "first tool call");
            append(run(session), { agent: AGENT, ...entry });
        }
        catch (error) {
            logError(`opencode ${entry.kind}`, error);
        }
    };
    const settle = (session, reason) => {
        try {
            close(run(session), AGENT, reason);
        }
        catch (error) {
            if (error.code !== "ENOENT")
                logError("opencode settle", error);
        }
    };
    return {
        "tool.execute.before": async (i, o) => record(i.sessionID, { kind: "call", id: i.callID, tool: i.tool, input: o.args }),
        "tool.execute.after": async (i, o) => record(i.sessionID, { kind: "result", id: i.callID, tool: i.tool, ok: true, output: o.output }),
        event: async ({ event }) => {
            const props = event.properties ?? {};
            if (event.type === "message.part.updated") {
                const part = props["part"];
                if (part?.type !== "tool" || part.state?.status !== "error" || !part.sessionID || failed.has(String(part.callID)))
                    return;
                failed.add(String(part.callID));
                const reason = String(part.state.error ?? "");
                // ponytail: OpenCode's DeniedError/RejectedError carry no flag, only their message; refine if it changes.
                const refused = /denied|rejected|not allowed|permission/i.test(reason);
                record(part.sessionID, refused
                    ? { kind: "refused", id: part.callID, tool: part.tool, reason }
                    : { kind: "result", id: part.callID, tool: part.tool, ok: false, output: reason });
            }
            else if (event.type === "session.idle" && typeof props["sessionID"] === "string") {
                settle(props["sessionID"], null);
            }
            else if (event.type === "session.deleted") {
                const id = props["info"]?.id;
                if (typeof id === "string")
                    settle(id, "session deleted");
            }
        },
    };
};
