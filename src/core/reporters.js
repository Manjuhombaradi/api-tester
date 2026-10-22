"use strict";
// Reports for a RunResult (runner.runSuite): JSON, JUnit XML (CI systems), a self-contained HTML page and
// plain text for the terminal (CLI).

const MAX_HTML_BODY_CHARS = 20000; // response body preview per request in the HTML report
const MAX_JUNIT_OUT_CHARS = 4000;

// ------------------------------------------------------------------ helpers

function stats(run) {
    return { requests: 0, passed: 0, failed: 0, errors: 0, assertions: 0, assertionsPassed: 0, assertionsFailed: 0, avgResponseMs: 0, ...((run && run.stats) || {}) };
}

function results(run) {
    return run && Array.isArray(run.results) ? run.results : [];
}

function fmtMs(ms) {
    const n = Number(ms);
    if (!Number.isFinite(n)) return "-";
    if (n < 1000) return `${Math.round(n)} ms`;
    if (n < 60000) return `${(n / 1000).toFixed(n < 10000 ? 2 : 1)} s`;
    const m = Math.floor(n / 60000);
    return `${m} min ${Math.round((n % 60000) / 1000)} s`;
}

function fmtBytes(n) {
    const v = Number(n);
    if (!Number.isFinite(v)) return "-";
    if (v < 1024) return `${v} B`;
    if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)} KB`;
    return `${(v / 1024 / 1024).toFixed(1)} MB`;
}

function statusOf(r) {
    const res = r && r.response;
    return res && Number(res.status) > 0 ? Number(res.status) : 0;
}

function timeOf(r) {
    const t = r && r.response && r.response.timings ? r.response.timings.total : null;
    return typeof t === "number" ? t : r ? r.durationMs : null;
}

function outcome(r) {
    if (r.error) return "error";
    return r.passed ? "passed" : "failed";
}

function checked(r) {
    return (r.assertions || []).filter((a) => !a.skipped);
}

function failedAssertions(r) {
    return checked(r).filter((a) => !a.passed);
}

function folderPath(r) {
    return Array.isArray(r.path) ? r.path.filter(Boolean) : [];
}

// ------------------------------------------------------------------ JSON

/** The RunResult as pretty JSON (base64 image previews left out to keep the file small). */
function toJson(run) {
    const copy = {
        format: "api-tester-run",
        version: 1,
        ...run,
        results: results(run).map((r) => {
            if (!r || !r.response || !r.response.bodyBase64) return r;
            const { bodyBase64, ...response } = r.response;
            return { ...r, response };
        })
    };
    return `${JSON.stringify(copy, null, 2)}\n`;
}

// ------------------------------------------------------------------ JUnit XML

// Characters XML 1.0 does not allow at all (control characters, lone surrogates, U+FFFE / U+FFFF).
// eslint-disable-next-line no-control-regex
const XML_INVALID = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

function xml(text) {
    return String(text ?? "")
        .replace(XML_INVALID, "�")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&apos;");
}

function seconds(ms) {
    const n = Number(ms);
    return Number.isFinite(n) ? (n / 1000).toFixed(3) : "0.000";
}

function assertionLine(a) {
    if (a.passed) return `[PASS] ${a.label}`;
    return `[FAIL] ${a.label}${a.message ? ` - ${a.message}` : ""}`;
}

/**
 * JUnit XML: one <testsuite> per iteration + folder path, one <testcase> per request. Failed assertions give a
 * <failure>, request errors (no response, script errors) an <error>.
 */
function toJUnit(run) {
    const suiteName = (run && run.suiteName) || "API Tester";
    const groups = new Map();
    const multipleIterations = Number(run && run.iterations) > 1;
    for (const r of results(run)) {
        const path = folderPath(r);
        const name = [suiteName, ...path].join(" / ") + (multipleIterations ? ` (iteration ${r.iteration || 1})` : "");
        if (!groups.has(name)) groups.set(name, { name, classname: [suiteName, ...path].join("."), cases: [], startedAt: r.startedAt });
        groups.get(name).cases.push(r);
    }
    const s = stats(run);
    const out = ["<?xml version=\"1.0\" encoding=\"UTF-8\"?>"];
    out.push(`<testsuites name="${xml(suiteName)}" tests="${s.requests}" failures="${s.failed}" errors="${s.errors}" time="${seconds(run && run.durationMs)}"${run && run.startedAt ? ` timestamp="${xml(run.startedAt)}"` : ""}>`);
    let id = 0;
    for (const g of groups.values()) {
        const failures = g.cases.filter((r) => outcome(r) === "failed").length;
        const errors = g.cases.filter((r) => outcome(r) === "error").length;
        const time = g.cases.reduce((n, r) => n + (Number(r.durationMs) || 0), 0);
        out.push(`  <testsuite id="${id++}" name="${xml(g.name)}" tests="${g.cases.length}" failures="${failures}" errors="${errors}" skipped="0" time="${seconds(time)}"${g.startedAt ? ` timestamp="${xml(String(g.startedAt).replace(/Z$/, ""))}"` : ""}>`);
        if (run && run.environmentName) {
            out.push("    <properties>");
            out.push(`      <property name="environment" value="${xml(run.environmentName)}"/>`);
            out.push("    </properties>");
        }
        for (const r of g.cases) {
            const caseName = `${r.method || "GET"} ${r.name || "Request"}`;
            const lines = [`${r.method || "GET"} ${r.url || ""}`, `Status: ${statusOf(r) || "no response"}  Time: ${fmtMs(timeOf(r))}`];
            for (const a of checked(r)) lines.push(assertionLine(a));
            for (const c of r.captures || []) lines.push(`${c.ok ? "[CAPTURE]" : "[CAPTURE FAILED]"} {{${c.variable}}} ${c.ok ? `= ${c.value}` : c.message}`);
            for (const l of r.logs || []) lines.push(`[${String(l.level || "log").toUpperCase()}] ${l.message}`);
            let systemOut = lines.join("\n");
            if (systemOut.length > MAX_JUNIT_OUT_CHARS) systemOut = `${systemOut.slice(0, MAX_JUNIT_OUT_CHARS)}\n…`;
            out.push(`    <testcase name="${xml(caseName)}" classname="${xml(g.classname)}" time="${seconds(r.durationMs)}">`);
            const failed = failedAssertions(r);
            if (r.error) {
                out.push(`      <error message="${xml(r.error)}" type="RequestError">${xml(r.error)}</error>`);
            } else if (failed.length) {
                const first = failed[0];
                const message = failed.length === 1 ? `${first.label}: ${first.message}` : `${failed.length} of ${checked(r).length} checks failed. First: ${first.label}: ${first.message}`;
                const detail = failed.map((a) => `${a.label}\n  expected: ${a.expected || "-"}\n  actual:   ${a.actual || "-"}\n  ${a.message}`).join("\n");
                out.push(`      <failure message="${xml(message)}" type="AssertionFailure">${xml(detail)}</failure>`);
            }
            out.push(`      <system-out>${xml(systemOut)}</system-out>`);
            out.push("    </testcase>");
        }
        out.push("  </testsuite>");
    }
    out.push("</testsuites>");
    return `${out.join("\n")}\n`;
}

// ------------------------------------------------------------------ HTML

function esc(text) {
    return String(text ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

function prettyBody(r) {
    const res = r.response || {};
    let text = typeof res.bodyText === "string" ? res.bodyText : "";
    if (!text) return res.bodyBase64 ? "(binary data)" : "";
    if (/json/i.test(String(res.contentType || "")) || /^\s*[[{]/.test(text)) {
        try {
            if (text.length < 2 * 1024 * 1024) text = JSON.stringify(JSON.parse(text), null, 2);
        } catch {
            // not JSON after all: show as is
        }
    }
    return text.length > MAX_HTML_BODY_CHARS ? `${text.slice(0, MAX_HTML_BODY_CHARS)}\n… (${fmtBytes(text.length)} in total, cut)` : text;
}

function headerRows(headers) {
    const list = Array.isArray(headers) ? headers : Object.entries(headers || {});
    if (!list.length) return "<p class=\"muted\">None</p>";
    return `<table class="kv">${list.map(([k, v]) => `<tr><th>${esc(k)}</th><td>${esc(v)}</td></tr>`).join("")}</table>`;
}

function statusClass(status) {
    if (!status) return "error";
    if (status < 300) return "ok";
    if (status < 400) return "redirect";
    if (status < 500) return "client";
    return "server";
}

function requestSection(r, index) {
    const state = outcome(r);
    const status = statusOf(r);
    const res = r.response || {};
    const assertions = checked(r);
    const passedCount = assertions.filter((a) => a.passed).length;
    const path = folderPath(r);
    const parts = [];
    parts.push(`<details class="req ${state}"${state !== "passed" ? " open" : ""} id="r${index + 1}">`);
    parts.push("<summary>");
    parts.push(`<span class="mark ${state}">${state === "passed" ? "&#10003;" : state === "error" ? "!" : "&#10007;"}</span>`);
    parts.push(`<span class="method m-${esc(String(r.method || "GET").toLowerCase())}">${esc(r.method || "GET")}</span>`);
    parts.push(`<span class="name">${path.length ? `<span class="muted">${esc(path.join(" / "))} / </span>` : ""}${esc(r.name || "Request")}</span>`);
    parts.push(`<span class="pill ${statusClass(status)}">${status ? esc(`${status} ${res.statusText || ""}`.trim()) : "No response"}</span>`);
    parts.push(`<span class="num">${esc(fmtMs(timeOf(r)))}</span>`);
    parts.push(`<span class="num">${assertions.length ? `${passedCount}/${assertions.length}` : "-"}</span>`);
    parts.push("</summary>");
    parts.push("<div class=\"body\">");
    parts.push(`<p class="url"><b>${esc(r.method || "GET")}</b> ${esc(r.url || "")}</p>`);
    const meta = [`Iteration ${esc(r.iteration || 1)}`, `Started ${esc(r.startedAt || "")}`];
    if (res.size && typeof res.size.body === "number") meta.push(`Size ${esc(fmtBytes(res.size.body))}`);
    if (r.prepared && r.prepared.authInfo) meta.push(`Auth: ${esc(r.prepared.authInfo)}`);
    parts.push(`<p class="muted">${meta.join(" &middot; ")}</p>`);
    if (r.error) parts.push(`<p class="errbox">${esc(r.error)}</p>`);
    if (assertions.length) {
        parts.push("<h4>Checks</h4><table class=\"checks\"><thead><tr><th></th><th>Check</th><th>Expected</th><th>Actual</th><th>Message</th></tr></thead><tbody>");
        for (const a of assertions) {
            parts.push(`<tr class="${a.passed ? "passed" : "failed"}"><td class="mark ${a.passed ? "passed" : "failed"}">${a.passed ? "&#10003;" : "&#10007;"}</td>`
                + `<td>${esc(a.label)}${a.source === "script" ? " <span class=\"tag\">script</span>" : ""}</td><td><code>${esc(a.expected)}</code></td>`
                + `<td><code>${esc(a.actual)}</code></td><td>${esc(a.message)}</td></tr>`);
        }
        parts.push("</tbody></table>");
    }
    if (Array.isArray(r.captures) && r.captures.length) {
        parts.push("<h4>Captured values</h4><table class=\"kv\">");
        for (const c of r.captures) {
            parts.push(`<tr><th>{{${esc(c.variable)}}} <span class="tag">${esc(c.scope)}</span></th><td>${c.ok ? `<code>${esc(c.value)}</code>` : `<span class="bad">${esc(c.message)}</span>`}</td></tr>`);
        }
        parts.push("</table>");
    }
    if (Array.isArray(r.logs) && r.logs.length) {
        parts.push(`<h4>Console</h4><pre class="logs">${r.logs.map((l) => `<span class="lvl-${esc(l.level)}">[${esc(l.level)}]</span> ${esc(l.message)}`).join("\n")}</pre>`);
    }
    if (r.prepared) {
        parts.push("<details class=\"sub\"><summary>Request sent</summary>");
        parts.push(headerRows(r.prepared.headers));
        if (r.prepared.bodyText) parts.push(`<pre>${esc(String(r.prepared.bodyText).slice(0, MAX_HTML_BODY_CHARS))}</pre>`);
        parts.push("</details>");
    }
    if (r.response && status) {
        parts.push("<details class=\"sub\"><summary>Response headers</summary>");
        parts.push(headerRows(res.headers));
        parts.push("</details>");
        const body = prettyBody(r);
        if (body) parts.push(`<details class="sub"${state !== "passed" ? " open" : ""}><summary>Response body</summary><pre>${esc(body)}</pre></details>`);
    }
    parts.push("</div></details>");
    return parts.join("");
}

const HTML_STYLE = `
:root { color-scheme: light; --bg: #f6f7f9; --card: #fff; --text: #1d2330; --muted: #6b7385; --line: #e2e5ea;
  --ok: #1a7f37; --ok-bg: #e6f4ea; --bad: #c62828; --bad-bg: #fdecea; --warn: #9a6700; --warn-bg: #fff4d6; --info: #0b5cad; --info-bg: #e7f0fb; }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); font: 14px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
main { max-width: 1100px; margin: 0 auto; padding: 24px 16px 48px; }
h1 { font-size: 22px; margin: 0 0 4px; } h4 { margin: 14px 0 6px; font-size: 13px; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); }
.muted { color: var(--muted); } .bad { color: var(--bad); }
.cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 10px; margin: 18px 0; }
.card { background: var(--card); border: 1px solid var(--line); border-radius: 8px; padding: 12px 14px; }
.card .v { font-size: 22px; font-weight: 600; } .card .l { color: var(--muted); font-size: 12px; }
.card.passed .v { color: var(--ok); } .card.failed .v, .card.error .v { color: var(--bad); }
.banner { padding: 10px 14px; border-radius: 8px; font-weight: 600; margin: 12px 0; }
.banner.passed { background: var(--ok-bg); color: var(--ok); } .banner.failed { background: var(--bad-bg); color: var(--bad); }
.banner.stopped { background: var(--warn-bg); color: var(--warn); }
.filter { margin: 8px 0 12px; user-select: none; }
#only-failed:checked ~ .list .req.passed { display: none; }
.req { background: var(--card); border: 1px solid var(--line); border-radius: 8px; margin: 6px 0; }
.req.failed { border-left: 4px solid var(--bad); } .req.error { border-left: 4px solid var(--warn); } .req.passed { border-left: 4px solid var(--ok); }
.req > summary { display: flex; gap: 10px; align-items: center; padding: 9px 12px; cursor: pointer; list-style: none; }
.req > summary::-webkit-details-marker { display: none; }
.req .name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.num { color: var(--muted); font-variant-numeric: tabular-nums; min-width: 64px; text-align: right; }
.mark { font-weight: 700; width: 16px; text-align: center; } .mark.passed { color: var(--ok); } .mark.failed { color: var(--bad); } .mark.error { color: var(--warn); }
.method { font: 600 11px/1 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; padding: 4px 6px; border-radius: 4px; background: #eef0f3; min-width: 52px; text-align: center; }
.m-get { color: #1a7f37; } .m-post { color: #9a6700; } .m-put { color: #0b5cad; } .m-patch { color: #6f42c1; } .m-delete { color: #c62828; }
.pill { font-size: 12px; padding: 2px 8px; border-radius: 10px; white-space: nowrap; }
.pill.ok { background: var(--ok-bg); color: var(--ok); } .pill.redirect { background: var(--info-bg); color: var(--info); }
.pill.client { background: var(--warn-bg); color: var(--warn); } .pill.server, .pill.error { background: var(--bad-bg); color: var(--bad); }
.req .body { padding: 0 14px 14px; border-top: 1px solid var(--line); }
.url { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; word-break: break-all; margin: 10px 0 4px; }
.errbox { background: var(--bad-bg); color: var(--bad); padding: 8px 10px; border-radius: 6px; }
table { border-collapse: collapse; width: 100%; } th, td { text-align: left; vertical-align: top; padding: 5px 8px; border-bottom: 1px solid var(--line); }
table.kv th { width: 32%; font-weight: 500; color: var(--muted); word-break: break-all; } table.kv td { word-break: break-all; }
table.checks th { font-size: 12px; color: var(--muted); font-weight: 500; } table.checks tr.failed td { background: #fff8f7; }
code, pre { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; }
code { word-break: break-all; }
pre { background: #f3f4f6; border-radius: 6px; padding: 10px; overflow: auto; max-height: 420px; white-space: pre-wrap; word-break: break-all; margin: 6px 0; }
.sub { margin-top: 8px; } .sub > summary { cursor: pointer; color: var(--info); }
.tag { font-size: 11px; color: var(--muted); border: 1px solid var(--line); border-radius: 4px; padding: 0 4px; }
.lvl-warn { color: var(--warn); } .lvl-error { color: var(--bad); }
footer { margin-top: 24px; color: var(--muted); font-size: 12px; }
@media print { .filter { display: none; } details { break-inside: avoid; } }
`;

/** A single self-contained HTML page (inline CSS, no scripts or external resources). */
function toHtml(run) {
    const s = stats(run);
    const list = results(run);
    const title = `${(run && run.suiteName) || "API Tester"} - test report`;
    const allPassed = s.requests > 0 && s.passed === s.requests;
    const banner = run && run.stopped
        ? `<div class="banner stopped">Run stopped${run.stopReason === "failure" ? " after the first failure" : run.stopReason === "cancelled" ? " by the user" : ""}${run.error ? `: ${esc(run.error)}` : ""} - ${s.requests} of ${esc(run.total ?? s.requests)} requests ran</div>`
        : `<div class="banner ${allPassed ? "passed" : "failed"}">${allPassed ? "All requests passed" : s.requests === 0 ? "No requests ran" : `${s.failed + s.errors} of ${s.requests} requests did not pass`}</div>`;
    const card = (value, label, cls = "") => `<div class="card ${cls}"><div class="v">${esc(value)}</div><div class="l">${esc(label)}</div></div>`;
    const html = [];
    html.push("<!doctype html>");
    html.push("<html lang=\"en\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">");
    html.push("<meta name=\"generator\" content=\"API Tester\">");
    html.push(`<title>${esc(title)}</title><style>${HTML_STYLE}</style></head><body><main>`);
    html.push(`<h1>${esc((run && run.suiteName) || "API Tester run")}</h1>`);
    const meta = [];
    if (run && run.environmentName) meta.push(`Environment: <b>${esc(run.environmentName)}</b>`);
    else meta.push("No environment");
    if (run && run.startedAt) meta.push(`Started ${esc(new Date(run.startedAt).toLocaleString("en-GB", { timeZoneName: "short" }))}`);
    meta.push(`Duration ${esc(fmtMs(run && run.durationMs))}`);
    meta.push(`${esc((run && run.iterations) || 1)} iteration${Number(run && run.iterations) === 1 ? "" : "s"}`);
    html.push(`<p class="muted">${meta.join(" &middot; ")}</p>`);
    html.push(banner);
    html.push("<div class=\"cards\">");
    html.push(card(s.requests, "Requests"));
    html.push(card(s.passed, "Passed", "passed"));
    html.push(card(s.failed, "Failed", s.failed ? "failed" : ""));
    html.push(card(s.errors, "Errors", s.errors ? "error" : ""));
    html.push(card(`${s.assertionsPassed}/${s.assertions}`, "Checks passed", s.assertionsFailed ? "failed" : "passed"));
    html.push(card(fmtMs(s.avgResponseMs), "Avg response time"));
    html.push("</div>");
    // CSS-only filter: the checkbox must be a sibling before .list
    html.push("<input type=\"checkbox\" id=\"only-failed\" class=\"filter\"> <label class=\"filter\" for=\"only-failed\">Show only requests that did not pass</label>");
    html.push("<div class=\"list\">");
    if (!list.length) html.push("<p class=\"muted\">No requests ran.</p>");
    let lastIteration = null;
    const many = Number(run && run.iterations) > 1;
    list.forEach((r, i) => {
        if (many && r.iteration !== lastIteration) {
            html.push(`<h4>Iteration ${esc(r.iteration)}</h4>`);
            lastIteration = r.iteration;
        }
        html.push(requestSection(r, i));
    });
    html.push("</div>");
    html.push(`<footer>Generated by API Tester${run && run.finishedAt ? ` on ${esc(run.finishedAt)}` : ""}.</footer>`);
    html.push("</main></body></html>");
    return `${html.join("\n")}\n`;
}

// ------------------------------------------------------------------ terminal

const ANSI = { reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m", red: "\x1b[31m", green: "\x1b[32m", yellow: "\x1b[33m", cyan: "\x1b[36m" };

// Control characters (incl. ESC) from names / responses must not reach the terminal as escape sequences.
// eslint-disable-next-line no-control-regex
const TERMINAL_UNSAFE = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g;

function clean(text) {
    return String(text ?? "").replace(TERMINAL_UNSAFE, "?");
}

function painter(color) {
    const paint = (code, text) => (color ? `${ANSI[code]}${text}${ANSI.reset}` : String(text));
    return {
        bold: (t) => paint("bold", t), dim: (t) => paint("dim", t), red: (t) => paint("red", t),
        green: (t) => paint("green", t), yellow: (t) => paint("yellow", t), cyan: (t) => paint("cyan", t)
    };
}

/** One line per request (used for live progress by the CLI and in toCliText). */
function formatResultLine(r, { color = false } = {}) {
    const p = painter(color);
    const state = outcome(r);
    const mark = state === "passed" ? p.green("✓") : state === "error" ? p.yellow("!") : p.red("✗");
    const status = statusOf(r);
    const statusText = status ? `${status}${r.response && r.response.statusText ? ` ${clean(r.response.statusText)}` : ""}` : "no response";
    const statusPainted = !status ? p.yellow(statusText) : status < 400 ? p.green(statusText) : p.red(statusText);
    const assertions = checked(r);
    const passed = assertions.filter((a) => a.passed).length;
    const counts = assertions.length ? (passed === assertions.length ? p.dim(`${passed}/${assertions.length}`) : p.red(`${passed}/${assertions.length}`)) : "";
    const path = folderPath(r);
    const name = `${path.length ? p.dim(`${clean(path.join(" / "))} / `) : ""}${clean(r.name || "Request")}`;
    return `${mark} ${p.bold(clean(r.method || "GET").padEnd(6))} ${name}  ${statusPainted}  ${p.dim(fmtMs(timeOf(r)))}${counts ? `  ${counts}` : ""}`;
}

/** Details printed under a request that did not pass. */
function formatResultDetails(r, { color = false, indent = "    " } = {}) {
    const p = painter(color);
    const lines = [];
    if (r.error) lines.push(`${indent}${p.yellow(clean(r.error))}`);
    for (const a of failedAssertions(r)) {
        lines.push(`${indent}${p.red("✗")} ${clean(a.label)}${a.message ? p.dim(` - ${clean(a.message)}`) : ""}`);
    }
    for (const c of r.captures || []) if (!c.ok) lines.push(`${indent}${p.yellow("!")} capture {{${clean(c.variable)}}}: ${clean(c.message)}`);
    return lines;
}

/** Summary for the terminal: every request (grouped by iteration), failure details and totals. */
function toCliText(run, { color = false } = {}) {
    const p = painter(color);
    const s = stats(run);
    const lines = [];
    const header = [p.bold(clean((run && run.suiteName) || "API Tester run"))];
    header.push(run && run.environmentName ? `environment "${clean(run.environmentName)}"` : "no environment");
    if (Number(run && run.iterations) > 1) header.push(`${run.iterations} iterations`);
    lines.push(header.join(p.dim(" · ")));
    let lastIteration = null;
    const many = Number(run && run.iterations) > 1;
    for (const r of results(run)) {
        if (many && r.iteration !== lastIteration) {
            lines.push("", p.cyan(`Iteration ${r.iteration}`));
            lastIteration = r.iteration;
        }
        lines.push(`  ${formatResultLine(r, { color })}`);
        if (outcome(r) !== "passed") lines.push(...formatResultDetails(r, { color, indent: "      " }));
    }
    lines.push("");
    const requestParts = [`${s.passed} passed`];
    if (s.failed) requestParts.push(p.red(`${s.failed} failed`));
    if (s.errors) requestParts.push(p.yellow(`${s.errors} ${s.errors === 1 ? "error" : "errors"}`));
    lines.push(`${p.bold("Requests:  ")}${s.requests} (${requestParts.join(", ")})`);
    lines.push(`${p.bold("Checks:    ")}${s.assertions} (${s.assertionsPassed} passed${s.assertionsFailed ? `, ${p.red(`${s.assertionsFailed} failed`)}` : ""})`);
    lines.push(`${p.bold("Time:      ")}${fmtMs(run && run.durationMs)} total, ${fmtMs(s.avgResponseMs)} average response`);
    if (run && run.stopped) {
        const why = run.stopReason === "failure" ? "after the first failure" : run.stopReason === "cancelled" ? "by the user" : "early";
        lines.push(p.yellow(`Stopped ${why}${run.error ? `: ${clean(run.error)}` : ""} (${s.requests} of ${run.total ?? s.requests} requests ran)`));
    }
    const ok = s.requests > 0 && s.passed === s.requests && !(run && run.stopped);
    lines.push(ok ? p.green(p.bold("All requests passed")) : s.requests === 0 ? p.yellow("No requests ran") : p.red(p.bold(`${s.failed + s.errors} of ${s.requests} requests did not pass`)));
    return `${lines.join("\n")}\n`;
}

module.exports = { toJson, toJUnit, toHtml, toCliText, formatResultLine, formatResultDetails };
