/** Filtering, the morning-after report, touched files, and a self-contained HTML view. */

import { read, runs, stable, type Sealed, type Verdict } from "./record.ts";

export interface Filter {
  since?: number;
  project?: string;
  agent?: string;
  refused?: boolean;
}

export interface Run {
  run: string;
  agent: string;
  project: string;
  actor: string;
  verdict: Verdict;
  entries: Sealed[];
}

/** `30m`, `12h`, `7d` back from now, or anything `Date` parses. */
export function parseSince(value: string, now = Date.now()): number {
  const rel = /^(\d+)([mhd])$/.exec(value);
  const at = rel ? now - Number(rel[1]) * { m: 6e4, h: 36e5, d: 864e5 }[rel[2] as "m" | "h" | "d"] : Date.parse(value);
  if (Number.isNaN(at)) throw new Error(`--since needs 30m, 12h, 7d or a date, got ${value}`);
  return at;
}

/** Runs matching the filter, newest first, with entries cut to the time window (and to refusals, if asked). */
export function select(f: Filter, env = process.env): Run[] {
  const has = (value: unknown, part?: string) => !part || String(value).toLowerCase().includes(part.toLowerCase());
  return runs(env)
    .filter((r) => f.since === undefined || r.mtime >= f.since)
    .map(({ run }) => {
      const verdict = read(run, env);
      const start = verdict.entries.find((e) => e.kind === "start");
      const entries = verdict.entries.filter((e) => (f.since === undefined || Date.parse(e.ts) >= f.since) && (!f.refused || e.kind === "refused"));
      return { run, agent: String(start?.agent ?? verdict.entries[0]?.agent ?? "?"), project: String(start?.["project"] ?? "?"), actor: String(start?.["actor"] ?? "?"), verdict, entries };
    })
    .filter((r) => has(r.project, f.project) && has(r.agent, f.agent) && (!f.refused || r.entries.length > 0));
}

const WRITES = /write|edit|patch|create|replace|notebook/i;

/** Files a call changed: path-like arguments of write tools, plus the targets of an apply_patch body. */
export function filesOf(call: Sealed): string[] {
  const input = call["input"];
  if (!WRITES.test(String(call["tool"])) || typeof input !== "object" || input === null) return [];
  const fields = input as Record<string, unknown>;
  const direct = ["file_path", "filePath", "path", "notebook_path"].map((k) => fields[k]).filter((v): v is string => typeof v === "string");
  const patched = Object.values(fields).filter((v): v is string => typeof v === "string")
    .flatMap((text) => [...text.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)].map((m) => (m[1] as string).trim()));
  return [...new Set([...direct, ...patched])];
}

/** Files changed by calls that completed successfully, with how often and when last. */
export function files(selected: Run[]): { file: string; project: string; times: number; last: string }[] {
  const seen = new Map<string, { file: string; project: string; times: number; last: string }>();
  for (const r of selected) {
    const ok = new Set(r.verdict.entries.filter((e) => e.kind === "result" && e["ok"]).map((e) => e["id"]));
    for (const call of r.entries.filter((e) => e.kind === "call" && ok.has(e["id"]))) {
      for (const file of filesOf(call)) {
        const key = `${r.project}\0${file}`;
        const hit = seen.get(key) ?? { file, project: r.project, times: 0, last: "" };
        seen.set(key, { ...hit, times: hit.times + 1, last: call.ts > hit.last ? call.ts : hit.last });
      }
    }
  }
  return [...seen.values()].sort((a, b) => b.last.localeCompare(a.last));
}

/** One flat, display-ready row per call outcome: what the report and the HTML view are made of. */
export function rows(selected: Run[]): Record<string, string>[] {
  return selected.flatMap((r) => {
    const calls = new Map(r.verdict.entries.filter((e) => e.kind === "call").map((e) => [e["id"], e]));
    return r.entries
      .filter((e) => e.kind === "result" || e.kind === "refused")
      .map((e) => ({
        ts: e.ts,
        run: r.run,
        agent: r.agent,
        project: r.project,
        outcome: e.kind === "refused" ? "refused" : e["ok"] ? "ok" : "error",
        tool: String(e["tool"] ?? ""),
        input: short(calls.get(e["id"])?.["input"]),
        detail: short(e.kind === "refused" ? e["reason"] : ((e["output"] as { stdout?: unknown } | null)?.stdout ?? e["output"])),
      }));
  }).sort((a, b) => b.ts.localeCompare(a.ts));
}

const short = (value: unknown, max = 240): string => {
  const s = (value === undefined ? "" : typeof value === "string" ? value : stable(value)).replace(/\s+/g, " ").trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
};

/** A single file, no network: data inlined as JSON, rendered with textContent only (agent output is untrusted). */
export function html(data: Record<string, string>[], title: string): string {
  const json = JSON.stringify(data).replace(/</g, "\\u003c");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title.replace(/[<&"]/g, "")}</title>
<style>
body{font:14px/1.45 system-ui,sans-serif;margin:24px;background:#0b0d10;color:#e6e9ee}
h1{font-size:20px;margin:0 0 12px}.bar{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:12px}
select,input{background:#151a21;color:inherit;border:1px solid #2a313b;border-radius:6px;padding:6px 8px}
.stats{color:#8b95a3;margin-bottom:10px}table{border-collapse:collapse;width:100%}
th,td{text-align:left;padding:6px 8px;border-bottom:1px solid #1d232c;vertical-align:top}
th{color:#8b95a3;font-weight:600}td.m{font-family:ui-monospace,Consolas,monospace;font-size:12px;word-break:break-all}
tr.refused td{background:#2a1015}tr.refused .o{color:#ff5d6c;font-weight:700}tr.error .o{color:#f5c542}.o,td:first-child{white-space:nowrap}
</style></head><body><h1>${title.replace(/[<&"]/g, "")}</h1>
<div class="bar"><input id="q" placeholder="search tool, input, detail"><select id="agent"></select><select id="project"></select>
<select id="outcome"><option value="">all outcomes</option><option>refused</option><option>error</option><option>ok</option></select>
<input id="since" type="datetime-local" title="since"></div><div class="stats" id="stats"></div>
<table><thead><tr><th>time</th><th>agent</th><th>project</th><th>outcome</th><th>tool</th><th>input</th><th>detail</th></tr></thead><tbody id="rows"></tbody></table>
<script>
const data=${json};const $=(id)=>document.getElementById(id);
for(const key of ["agent","project"]){const s=$(key);s.add(new Option("all "+key+"s",""));for(const v of [...new Set(data.map(r=>r[key]))].sort())s.add(new Option(v,v));}
function render(){const q=$("q").value.toLowerCase(),since=$("since").value?new Date($("since").value).toISOString():"";
const shown=data.filter(r=>(!$("agent").value||r.agent===$("agent").value)&&(!$("project").value||r.project===$("project").value)&&(!$("outcome").value||r.outcome===$("outcome").value)&&(!since||r.ts>=since)&&(!q||(r.tool+" "+r.input+" "+r.detail).toLowerCase().includes(q)));
const body=$("rows");body.replaceChildren();for(const r of shown){const tr=body.insertRow();tr.className=r.outcome;
for(const [k,v] of [["",r.ts.slice(0,19).replace("T"," ")],["",r.agent],["",r.project],["o",r.outcome],["",r.tool],["m",r.input],["m",r.detail]]){const td=tr.insertCell();td.className=k;td.textContent=v;}}
const n=(o)=>shown.filter(r=>r.outcome===o).length;$("stats").textContent=shown.length+" calls · "+n("refused")+" refused · "+n("error")+" errors · "+new Set(shown.map(r=>r.run)).size+" runs";}
for(const id of ["q","agent","project","outcome","since"])$(id).addEventListener("input",render);render();
</script></body></html>
`;
}
