"use strict";
/*
 * Response panel of a request tab: status / time / size / tests summary and the tabs Body (pretty JSON tree,
 * raw, preview, search), Headers, Cookies, Tests, Timeline and Console. Reads tab.result (RequestResult).
 * hooks: onAssert({source, property, operator, expected}), onCapture({source, property, suggestedName}),
 *        onSend(), onToggleLayout(), onAddSuggested()
 */

const RAW_DISPLAY_LIMIT = 200 * 1024; // characters shown before "Show all"
const MAX_MARKS = 2000;

const ResponseView = {
    create(tab, hooks = {}) { return createResponseView(tab, hooks); }
};

function createResponseView(tab, hooks) {
    const el = h("div", { class: "resp" });
    let timer = null;
    let jsonView = null;
    let searchTerm = "";
    let showAllRaw = false;
    let wrap = true;
    let testFilter = "all";
    let lastResult = null;
    const view = () => tab.respView || (tab.respView = { tab: "body", body: "pretty" });

    function render() {
        clearInterval(timer);
        timer = null;
        clear(el);
        jsonView = null;
        if (tab.result !== lastResult) { showAllRaw = false; lastResult = tab.result; }
        if (tab.sending) return renderSending();
        const r = tab.result;
        if (!r) return renderEmpty();
        el.appendChild(renderHead(r));
        const resp = r.response || null;
        const tests = allTests(r);
        const consoleLines = buildConsole(r);
        const headers = resp?.headers || [];
        const cookies = resp?.cookies || [];
        const failed = tests.filter((t) => !t.passed && !t.skipped).length;
        const passedCount = tests.filter((t) => t.passed).length;
        const v = view();
        const strip = tabStrip([
            { id: "body", label: "Body" },
            { id: "headers", label: "Headers", count: headers.length || null },
            { id: "cookies", label: "Cookies", count: cookies.length || null },
            { id: "tests", label: "Tests", count: tests.length ? `${passedCount}/${tests.length}` : null, countClass: !tests.length ? "" : failed ? "bad" : passedCount === tests.length ? "good" : "" },
            { id: "timeline", label: "Timeline" },
            { id: "console", label: "Console", count: consoleLines.length || null, countClass: consoleLines.some((l) => l.level === "error") ? "bad" : "" }
        ], v.tab, (id) => { v.tab = id; renderTab(); }, "resp-tabs small");
        const body = h("div", { class: "resp-body" });
        put(el, strip.el, body);
        const renderTab = () => {
            clear(body);
            body.className = "resp-body";
            jsonView = null;
            try {
                if (v.tab === "body") renderBody(body, r);
                else if (v.tab === "headers") renderHeaders(body, headers);
                else if (v.tab === "cookies") renderCookies(body, cookies);
                else if (v.tab === "tests") renderTests(body, r, tests);
                else if (v.tab === "timeline") renderTimeline(body, r);
                else if (v.tab === "console") renderConsole(body, consoleLines);
            } catch (err) {
                console.error(err);
                body.appendChild(h("div", { class: "callout bad", style: { margin: "12px" } }, icon("alert"), `Could not show this: ${err.message}`));
            }
        };
        el._selectTab = (id) => { v.tab = id; strip.setActive(id); renderTab(); };
        renderTab();
    }

    // ------------------------------------------------------------ states
    function renderEmpty() {
        el.appendChild(h("div", { class: "resp-empty" },
            h("div", { class: "big" }, icon("send")),
            h("h3", null, "No response yet"),
            h("div", null, "Send the request to see the response here."),
            h("div", { class: "shortcut" }, h("kbd", null, App.mac ? "⌘" : "Ctrl"), " + ", h("kbd", null, "Enter")),
            h("div", { class: "btn-group" },
                h("button", { class: "btn primary", type: "button", onclick: () => hooks.onSend && hooks.onSend() }, icon("send"), "Send"),
                h("button", { class: "btn ghost", type: "button", title: "Show the response beside or below the editor", onclick: () => hooks.onToggleLayout && hooks.onToggleLayout() },
                    icon(App.state.ui.responseLayout === "horizontal" ? "layoutRows" : "layoutCols"), "Layout"))));
    }

    function renderSending() {
        const started = Date.now();
        const elapsed = h("span", null, "0 ms");
        el.appendChild(h("div", { class: "resp-empty" },
            h("span", { class: "spinner big" }),
            h("h3", null, "Sending request…"),
            elapsed,
            h("button", { class: "btn", type: "button", onclick: () => tab.view && tab.view.cancel() }, icon("stop"), "Cancel")));
        timer = setInterval(() => { elapsed.textContent = fmtMs(Date.now() - started); }, 100);
    }

    // ------------------------------------------------------------ header line
    function renderHead(r) {
        const resp = r.response;
        const head = h("div", { class: "resp-head" });
        const status = resp && resp.status ? resp.status : 0;
        const pill = statusPill(status, status ? resp.statusText : (r.cancelled ? "Cancelled" : "Error"));
        if (!status) pill.textContent = r.cancelled || resp?.error?.code === "ABORTED" ? "Cancelled" : "Error";
        if (status) {
            pill.style.cursor = "pointer";
            pill.title = "Click to assert this status";
            pill.addEventListener("click", () => contextMenu(pill, [
                { label: `Assert status equals ${status}`, icon: "target", onClick: () => hooks.onAssert({ source: "status", operator: "equals", expected: String(status) }) },
                { label: "Capture status as variable…", icon: "capture", onClick: () => hooks.onCapture({ source: "status", property: "", suggestedName: "status" }) }
            ]));
        }
        head.appendChild(pill);
        const total = resp?.timings?.total ?? r.durationMs;
        if (total !== undefined && total !== null) {
            const m = h("span", { class: "metric", title: "Total time (click to assert)" }, icon("clock"), h("b", null, fmtMs(total)));
            if (status) {
                m.style.cursor = "pointer";
                m.addEventListener("click", () => {
                    const limit = Math.max(200, Math.ceil((total * 2) / 100) * 100);
                    contextMenu(m, [{ label: `Assert response time below ${limit} ms`, icon: "target", onClick: () => hooks.onAssert({ source: "responseTime", operator: "lt", expected: String(limit) }) }]);
                });
            }
            head.appendChild(m);
        }
        if (resp && resp.size && status) head.appendChild(h("span", { class: "metric", title: `Body ${fmtBytes(resp.size.body)} · headers ${fmtBytes(resp.size.headers)}` }, icon("download"), h("b", null, fmtBytes(resp.size.body))));
        const tests = allTests(r);
        if (tests.length) {
            const failed = tests.filter((t) => !t.passed && !t.skipped).length;
            const passed = tests.filter((t) => t.passed).length;
            const skipped = tests.length - failed - passed;
            const allSkipped = skipped === tests.length;
            const chip = h("button", { class: `badge tests-chip ${failed ? "bad" : allSkipped ? "" : "good"}`, type: "button", title: "Show test results" },
                icon(failed ? "x" : allSkipped ? "minus" : "check"), allSkipped ? `${skipped} not checked` : `${passed}/${tests.length} passed`);
            chip.addEventListener("click", () => el._selectTab && el._selectTab("tests"));
            head.appendChild(chip);
        }
        if (r.prepared && r.prepared.unresolved && r.prepared.unresolved.length) {
            const warn = h("button", { class: "badge warn tests-chip", type: "button", title: `Unknown variables: ${r.prepared.unresolved.join(", ")}` }, icon("alert"), `${r.prepared.unresolved.length} unknown variable${r.prepared.unresolved.length === 1 ? "" : "s"}`);
            warn.addEventListener("click", () => el._selectTab && el._selectTab("console"));
            head.appendChild(warn);
        }
        head.appendChild(h("span", { class: "spacer" }));
        if (resp && resp.bodyText) {
            head.appendChild(iconButton("copy", "Copy the response body", () => copyText(resp.bodyText, "response body")));
        }
        if (resp && (resp.bodyText || resp.bodyBase64)) head.appendChild(iconButton("download", "Save the response body to a file", () => saveBody(resp)));
        head.appendChild(iconButton(App.state.ui.responseLayout === "horizontal" ? "layoutRows" : "layoutCols", "Response below / beside the editor", () => hooks.onToggleLayout && hooks.onToggleLayout()));
        return head;
    }

    function saveBody(resp) {
        const ct = (resp.contentType || "").toLowerCase();
        let name = "response";
        try { const p = new URL(resp.url || tab.result?.url || "").pathname.split("/").filter(Boolean).pop(); if (p) name = p.replace(/[^\w.\-]/g, "_"); } catch (_) { /* keep default */ }
        const ext = ct.includes("json") ? ".json" : ct.includes("xml") ? ".xml" : ct.includes("html") ? ".html" : ct.includes("png") ? ".png" : ct.includes("jpeg") ? ".jpg" : ct.includes("gif") ? ".gif" : ct.includes("svg") ? ".svg" : ".txt";
        if (!/\.[a-z0-9]{2,5}$/i.test(name)) name += ext;
        if (resp.bodyBase64 && !resp.bodyText) saveTextAs(name, resp.bodyBase64, resp.contentType || "application/octet-stream", true);
        else saveTextAs(name, resp.bodyText || "", resp.contentType || "text/plain");
    }

    // ------------------------------------------------------------ body
    function renderBody(body, r) {
        const resp = r.response;
        if (!resp || !resp.status) return renderError(body, r);
        body.className = "resp-body fill";
        const v = view();
        const ct = (resp.contentType || resp.headersMap?.["content-type"] || "").toLowerCase();
        const text = resp.bodyText || "";
        const json = /json/.test(ct) || (text && /^\s*[[{]/.test(text)) ? responseJson(resp) : undefined;
        const isJson = json !== undefined && typeof json === "object" && json !== null;
        const isImage = /^image\//.test(ct) && !!resp.bodyBase64;
        const isHtml = /html/.test(ct);
        const isXml = /xml/.test(ct) && !isHtml;
        const modes = [{ id: "pretty", label: "Pretty" }, { id: "raw", label: "Raw" }];
        if (isImage || isHtml) modes.push({ id: "preview", label: "Preview" });
        let mode = v.body;
        if (isImage && !text) mode = "preview";
        if (!modes.some((m) => m.id === mode)) mode = "pretty";
        const seg = h("div", { class: "segmented" }, modes.map((m) => {
            const b = h("button", { type: "button", class: m.id === mode ? "active" : "" }, m.label);
            b.addEventListener("click", () => { v.body = m.id; renderBodyAgain(); });
            return b;
        }));
        const toolbar = h("div", { class: "body-toolbar" }, seg);
        const content = h("div", { class: "body-view" });
        put(body, toolbar);
        if (resp.bodyTextTruncated || resp.bodyTrimmed) body.appendChild(h("div", { class: "truncate-note" }, icon("info"), "Only the first part of this large body is shown here. Save it to a file to see everything that was received."));
        if (resp.truncated) body.appendChild(h("div", { class: "truncate-note" }, icon("alert"), `The response was larger than the limit (${App.effectiveSettings().maxResponseMB} MB) and was cut. Raise "Max response size" in Settings to see all of it.`));
        body.appendChild(content);
        function renderBodyAgain() { clear(body); renderBody(body, r); }

        if (!text && !resp.bodyBase64) {
            content.appendChild(h("div", { class: "resp-empty" }, h("div", null, resp.status === 204 || resp.size?.body === 0 ? "The response has no body." : "No text body."),
                h("div", { class: "muted small" }, ct || "no content type")));
            return;
        }
        if (mode === "preview") {
            if (isImage) content.appendChild(h("div", { class: "preview-img" }, h("img", { src: `data:${ct.split(";")[0]};base64,${resp.bodyBase64}`, alt: "Response image" })));
            else {
                // scripts are not allowed to run in the preview (no allow-scripts)
                const frame = h("iframe", { class: "preview-frame", sandbox: "", title: "HTML preview" });
                frame.srcdoc = text;
                content.style.overflow = "hidden";
                content.appendChild(frame);
                toolbar.appendChild(h("span", { class: "hint" }, "Preview without scripts or external resources."));
            }
            return;
        }
        // search box (pretty JSON tree or raw text)
        const search = h("input", { type: "search", placeholder: "Find in body", value: searchTerm, spellcheck: "false" });
        const count = h("span", { class: "match-count" });
        const prevBtn = iconButton("chevronUp", "Previous match (Shift+Enter)", () => step(-1));
        const nextBtn = iconButton("chevronDown", "Next match (Enter)", () => step(1));
        put(toolbar, h("div", { class: "input-icon search-box" }, icon("search"), search), count, prevBtn, nextBtn, h("span", { class: "spacer" }));
        let marks = [];
        let markIndex = -1;
        const step = (dir) => {
            if (jsonView) {
                const n = dir > 0 ? jsonView.next() : jsonView.prev();
                if (n) count.textContent = `${n} of ${jsonView.matchCount()}`;
                return;
            }
            if (!marks.length) return;
            marks[markIndex]?.classList.remove("current");
            markIndex = (markIndex + dir + marks.length) % marks.length;
            marks[markIndex].classList.add("current");
            marks[markIndex].scrollIntoView({ block: "center" });
            count.textContent = `${markIndex + 1} of ${marks.length}`;
        };
        search.addEventListener("keydown", (e) => {
            if (e.key === "Enter") { e.preventDefault(); step(e.shiftKey ? -1 : 1); }
            else if (e.key === "Escape" && search.value) { e.stopPropagation(); search.value = ""; runSearch(); }
        });

        let runSearch;
        if (mode === "pretty" && isJson) {
            jsonView = JsonView.create(json, {
                onAction: (action, info) => {
                    if (action === "assert") hooks.onAssert({ source: "jsonpath", property: info.path, operator: info.operator, expected: info.expected });
                    else if (action === "capture") hooks.onCapture({ source: "jsonpath", property: info.path, suggestedName: captureName(info) });
                }
            });
            put(toolbar, 
                iconButton("expand", "Expand all", () => jsonView.expandAll()),
                iconButton("collapse", "Collapse all", () => jsonView.collapseAll()),
                h("span", { class: "hint" }, "Click a value to assert or capture it"));
            content.appendChild(jsonView.el);
            runSearch = () => {
                searchTerm = search.value;
                const n = jsonView.search(searchTerm);
                count.textContent = searchTerm ? (n ? `1 of ${jsonView.matchCount()}${n >= 1000 ? "+" : ""}` : "No matches") : "";
            };
            if (searchTerm) runSearch();
        } else {
            let shown = mode === "pretty" && isXml ? formatXml(text) : mode === "pretty" && isJson === false && json !== undefined ? JSON.stringify(json, null, 4) : text;
            const tooBig = shown.length > RAW_DISPLAY_LIMIT && !showAllRaw;
            const pre = h("pre", { class: `raw-view ${wrap ? "wrap" : ""}` });
            const wrapBtn = iconButton("wrap", "Wrap long lines", () => { wrap = !wrap; pre.classList.toggle("wrap", wrap); wrapBtn.classList.toggle("active", wrap); });
            wrapBtn.classList.toggle("active", wrap);
            toolbar.appendChild(wrapBtn);
            const fill = () => {
                const visible = tooBig ? shown.slice(0, RAW_DISPLAY_LIMIT) : shown;
                clear(pre);
                marks = [];
                markIndex = -1;
                const term = searchTerm;
                if (!term) { pre.textContent = visible; return 0; }
                const lower = visible.toLowerCase();
                const t = term.toLowerCase();
                let i = 0;
                const frag = document.createDocumentFragment();
                for (let at; (at = lower.indexOf(t, i)) !== -1 && marks.length < MAX_MARKS;) {
                    frag.appendChild(document.createTextNode(visible.slice(i, at)));
                    const m = h("mark", null, visible.slice(at, at + t.length));
                    marks.push(m);
                    frag.appendChild(m);
                    i = at + t.length;
                }
                frag.appendChild(document.createTextNode(visible.slice(i)));
                pre.appendChild(frag);
                return marks.length;
            };
            runSearch = () => {
                searchTerm = search.value;
                const n = fill();
                count.textContent = searchTerm ? (n ? `${n}${n >= MAX_MARKS ? "+" : ""} matches` : "No matches") : "";
                if (n) step(1);
            };
            fill();
            if (searchTerm) runSearch();
            if (tooBig) {
                content.appendChild(h("div", { class: "truncate-note" }, icon("info"), `Showing the first ${fmtBytes(RAW_DISPLAY_LIMIT)} of ${fmtBytes(shown.length)}.`,
                    h("button", { class: "btn small", type: "button", onclick: () => { showAllRaw = true; renderBodyAgain(); } }, "Show all")));
            }
            content.appendChild(pre);
            if (!text && resp.bodyBase64) pre.textContent = `Binary content (${fmtBytes(resp.size?.body)}). Use Preview or save it to a file.`;
        }
        search.addEventListener("input", debounce(() => runSearch(), 200));
    }

    function captureName(info) {
        if (typeof info.key === "string" && /^[\w.\-]+$/.test(info.key)) return info.key;
        const m = /([A-Za-z_][\w]*)(?:\[\d+\])*$/.exec(info.path.replace(/\['([^']*)'\]/g, ".$1"));
        return m ? m[1] : "value";
    }

    function renderError(body, r) {
        if (r.errorCode === "FILE_NOT_APPROVED" || r.needsFileApproval) return renderNotApproved(body, r);
        const resp = r.response || {};
        const code = resp.error?.code || "";
        const message = resp.error?.message || r.error || "The request could not be sent.";
        const url = r.url || r.prepared?.url || "";
        let host = "";
        try { host = new URL(url).host; } catch (_) { host = url; }
        const tips = errorTips(code, message, host);
        body.classList.add("pad");
        const cancelled = r.cancelled || code === "ABORTED";
        body.appendChild(h("div", { class: "resp-error" },
            h("div", { class: "err-title" }, icon(cancelled ? "stop" : "alert"), cancelled ? "Request cancelled" : errorTitle(code)),
            cancelled ? null : h("div", { class: "err-msg" }, code ? `${code}: ${message}` : message),
            tips.length ? h("div", null, h("div", { class: "strong", style: { marginTop: "10px" } }, "What you can check"), h("ul", null, tips.map((t) => h("li", null, t)))) : null,
            h("div", { class: "btn-group", style: { marginTop: "10px" } },
                h("button", { class: "btn primary", type: "button", onclick: () => hooks.onSend && hooks.onSend() }, icon("refresh"), "Try again"),
                code === "ECONNREFUSED" && /127\.0\.0\.1|localhost/.test(host) && !App.state.info.echoServer?.running
                    ? h("button", { class: "btn", type: "button", onclick: () => App.startEchoServer().then((s) => toast(s.running ? `Echo server started at ${s.url || `http://127.0.0.1:${s.port}`}` : s.error, s.running ? "success" : "error")) }, icon("play"), "Start the echo server") : null,
                /CERT|SELF_SIGNED|UNABLE_TO_VERIFY|TLS|SSL/i.test(code + message)
                    ? h("button", { class: "btn", type: "button", onclick: () => { if (tab.view) tab.view.selectTab("settings"); } }, icon("lock"), "TLS settings of this request") : null)));
    }

    /** Not sent: the request uploads a local file the user has not allowed (yet). */
    function renderNotApproved(body, r) {
        const files = (r.needsFileApproval && r.needsFileApproval.files) || (r.fileApproval && r.fileApproval.filePath ? [{ path: r.fileApproval.filePath }] : []);
        body.classList.add("pad");
        body.appendChild(h("div", { class: "resp-error" },
            h("div", { class: "err-title" }, icon("lock"), "Not sent: a local file needs your OK"),
            h("div", { class: "err-msg" }, r.error || "This request uploads a file from this computer that is not allowed yet."),
            files.length > 1 ? h("ul", null, files.map((f) => h("li", null, h("code", null, f.path), f.origin ? ` → ${f.origin}` : ""))) : null,
            h("div", { class: "hint" }, "Nothing was sent. Requests from imported or shared suites can name any file on your computer, so API Tester asks before it uploads one. ",
                "Files you choose yourself in the Body tab are allowed automatically."),
            h("div", { class: "btn-group", style: { marginTop: "10px" } },
                h("button", { class: "btn primary", type: "button", onclick: () => hooks.onSend && hooks.onSend() }, icon("send"), "Review and send…"),
                h("button", { class: "btn", type: "button", onclick: () => { if (tab.view) tab.view.selectTab("body"); } }, icon("file"), "Show the Body tab"))));
    }

    // ------------------------------------------------------------ headers / cookies
    function renderHeaders(body, headers) {
        if (!headers.length) { body.appendChild(h("div", { class: "resp-empty" }, "No response headers.")); return; }
        const tbody = h("tbody");
        for (const [name, value] of headers) {
            const tr = h("tr", null, h("td", { class: "name" }, name), h("td", null, value),
                h("td", { class: "row-acts" },
                    iconButton("target", "Assert this header", () => hooks.onAssert({ source: "header", property: name, operator: "equals", expected: value })),
                    iconButton("capture", "Capture as variable", () => hooks.onCapture({ source: "header", property: name, suggestedName: name.replace(/[^\w]+/g, "_").replace(/^_+|_+$/g, "") || "header" })),
                    iconButton("copy", "Copy value", () => copyText(value))));
            tbody.appendChild(tr);
        }
        body.appendChild(h("table", { class: "resp-table" }, h("thead", null, h("tr", null, h("th", null, "Name"), h("th", null, "Value"), h("th"))), tbody));
    }

    function renderCookies(body, cookies) {
        if (!cookies.length) {
            body.appendChild(h("div", { class: "resp-empty" }, h("div", null, "The response set no cookies."),
                h("div", { class: "muted small" }, "Cookies are kept per suite and sent with later requests. See Environments > Runtime.")));
            return;
        }
        const tbody = h("tbody");
        for (const c of cookies) {
            const flags = [c.httpOnly ? "HttpOnly" : null, c.secure ? "Secure" : null].filter(Boolean).join(", ");
            tbody.appendChild(h("tr", null, h("td", { class: "name" }, c.name), h("td", null, c.value), h("td", null, c.domain || ""), h("td", null, c.path || ""),
                h("td", null, c.expires && c.expires !== "Infinity" ? fmtTime(c.expires, true) : "Session"), h("td", null, flags),
                h("td", { class: "row-acts" }, iconButton("capture", "Capture as variable", () => hooks.onCapture({ source: "cookie", property: c.name, suggestedName: c.name })),
                    iconButton("copy", "Copy value", () => copyText(c.value)))));
        }
        body.appendChild(h("table", { class: "resp-table" }, h("thead", null, h("tr", null, h("th", null, "Name"), h("th", null, "Value"), h("th", null, "Domain"), h("th", null, "Path"), h("th", null, "Expires"), h("th", null, "Flags"), h("th"))), tbody));
    }

    // ------------------------------------------------------------ tests
    function allTests(r) {
        const list = Array.isArray(r.assertions) ? [...r.assertions] : [];
        // script tests may also arrive only in the script results
        const ids = new Set(list.map((a) => a.id));
        for (const phase of ["pre", "post"]) {
            for (const t of r.scripts?.[phase]?.tests || []) {
                const id = `script:${phase}:${t.name}`;
                if (list.some((a) => (a.source === "script" || String(a.id).startsWith("script")) && a.label === t.name)) continue;
                if (!ids.has(id)) list.push({ id, source: "script", label: t.name, passed: !!t.passed, message: t.error || "" });
            }
        }
        return list;
    }

    function renderTests(body, r, tests) {
        const scriptErrors = ["pre", "post"].map((p) => (r.scripts?.[p]?.error ? { phase: p, error: r.scripts[p].error } : null)).filter(Boolean);
        if (!tests.length && !scriptErrors.length) {
            body.appendChild(h("div", { class: "resp-empty" },
                h("div", { class: "big" }, icon("target")),
                h("h3", null, "No tests for this request"),
                h("div", null, "Add assertions to check the response automatically, or click a value in the body."),
                h("div", { class: "btn-group" },
                    r.response?.status ? h("button", { class: "btn primary", type: "button", onclick: () => hooks.onAddSuggested && hooks.onAddSuggested() }, icon("sparkles"), "Add suggested assertions") : null)));
            return;
        }
        const failed = tests.filter((t) => !t.passed && !t.skipped).length;
        const passed = tests.filter((t) => t.passed).length;
        const pct = tests.length ? Math.round((passed / tests.length) * 100) : 0;
        const filters = h("div", { class: "segmented" }, [["all", `All ${tests.length}`], ["failed", `Failed ${failed}`], ["passed", `Passed ${passed}`]].map(([id, label]) => {
            const b = h("button", { type: "button", class: testFilter === id ? "active" : "" }, label);
            b.addEventListener("click", () => { testFilter = id; clear(body); renderTests(body, r, tests); });
            return b;
        }));
        const skipped = tests.length - failed - passed;
        const summary = failed ? `${failed} failed` : passed === tests.length ? "All passed" : passed ? `${passed} passed, ${skipped} not checked` : "Not checked: the request failed";
        body.appendChild(h("div", { class: "tests-summary" },
            h("span", { class: failed ? "fail strong" : passed === tests.length ? "pass strong" : "skip strong" }, summary),
            h("div", { class: "tests-bar" }, h("div", { style: { width: `${pct}%` } })),
            h("span", { class: "spacer" }), filters));
        const list = h("div", { class: "test-list" });
        for (const e of scriptErrors) {
            list.appendChild(h("div", { class: "test-item failed" }, h("span", { class: "t-icon" }, icon("alert")),
                h("div", null, h("span", { class: "t-label" }, `${e.phase === "pre" ? "Pre-request" : "Post-response"} script error`)),
                h("div", { class: "t-msg" }, e.error)));
        }
        const shown = tests.filter((t) => testFilter === "all" || (testFilter === "failed" ? !t.passed && !t.skipped : t.passed));
        for (const t of shown) {
            const cls = t.skipped ? "skipped" : t.passed ? "passed" : "failed";
            const isScript = t.source === "script" || String(t.id || "").startsWith("script");
            const detail = [];
            if (!isScript && t.actual !== undefined && t.actual !== null && t.actual !== "") detail.push(h("span", null, "Actual ", h("code", null, String(t.actual))));
            if (!isScript && !t.passed && t.expected !== undefined && t.expected !== "" && t.expected !== null) detail.push(h("span", null, "Expected ", h("code", null, String(t.expected))));
            list.appendChild(h("div", { class: `test-item ${cls}` },
                h("span", { class: "t-icon" }, icon(t.skipped ? "minus" : t.passed ? "check" : "x")),
                h("div", null, h("span", { class: "t-label" }, t.label || t.name || "Test"), h("span", { class: "t-kind" }, isScript ? "script" : t.skipped ? "skipped" : "")),
                detail.length ? h("div", { class: "t-detail" }, detail) : null,
                !t.passed && t.message ? h("div", { class: "t-msg" }, t.message) : null));
        }
        if (!shown.length) list.appendChild(h("div", { class: "empty small" }, "Nothing to show for this filter."));
        body.appendChild(list);
    }

    // ------------------------------------------------------------ timeline
    /** Timing phases as bars: http.js reports each phase as a duration in ms (null when it did not happen). */
    function phases(t) {
        if (!t) return [];
        const names = [["redirect", "Redirects", "tl-total"], ["dns", "DNS lookup", "tl-dns"], ["connect", "TCP connect", "tl-connect"],
            ["tls", "TLS handshake", "tl-tls"], ["firstByte", "Waiting (TTFB)", "tl-wait"], ["download", "Download", "tl-download"]];
        const out = [];
        let offset = 0;
        for (const [key, label, cls] of names) {
            if (typeof t[key] !== "number") continue;
            out.push({ key, label, cls, dur: t[key], start: offset });
            offset += t[key];
        }
        return out;
    }

    function renderTimeline(body, r) {
        const resp = r.response || {};
        const t = resp.timings || null;
        const total = t?.total ?? r.durationMs ?? 0;
        const wrapEl = h("div", { class: "timeline" });
        const ph = phases(t);
        if (ph.length || total) {
            const rows = h("div", { class: "tl-rows" });
            const scale = Math.max(total, ph.reduce((a, p) => Math.max(a, p.start + p.dur), 0), 1);
            for (const p of ph) {
                put(rows, h("span", { class: "tl-label" }, p.label),
                    h("div", { class: "tl-track" }, h("div", { class: `tl-bar ${p.cls}`, style: { left: `${(p.start / scale) * 100}%`, width: `${Math.max(.4, (p.dur / scale) * 100)}%` } })),
                    h("span", { class: "tl-val" }, fmtMs(p.dur)));
            }
            put(rows, h("span", { class: "tl-label tl-total-row" }, "Total"),
                h("div", { class: "tl-track" }, h("div", { class: "tl-bar tl-total", style: { left: "0", width: "100%" } })),
                h("span", { class: "tl-val tl-total-row" }, fmtMs(total)));
            wrapEl.appendChild(h("div", { class: "tl-section" }, h("h4", null, "Timing"), rows,
                ph.some((p) => p.key === "dns" && p.dur === 0) ? h("div", { class: "hint", style: { marginTop: "6px" } }, "0 ms phases were skipped (reused connection, IP address or cached lookup).") : null));
        }
        const p = r.prepared || {};
        if (p.method || p.url) {
            const reqHeaders = Array.isArray(p.headers) ? p.headers : Object.entries(p.headers || {});
            wrapEl.appendChild(h("div", { class: "tl-section" },
                h("h4", null, "Request sent", iconButton("copy", "Copy as cURL", async () => {
                    const pv = await attempt(() => api.call("request.preview", { suiteId: tab.suiteId || null, requestId: tab.temp ? null : tab.itemId, request: deepClone(tab.draft), environmentId: App.activeEnvironmentId(tab.suiteId) }));
                    if (pv && pv.curl) copyText(pv.curl, "cURL command");
                })),
                h("div", { class: "tl-request-line" }, h("span", { class: `method m-${String(p.method || "").toLowerCase()}` }, p.method), " ", p.url),
                p.authInfo ? h("div", { class: "hint", style: { margin: "6px 0" } }, `Auth: ${p.authInfo}`) : null,
                reqHeaders.length ? h("table", { class: "resp-table compact", style: { marginTop: "6px" } },
                    h("tbody", null, reqHeaders.map(([k, v]) => h("tr", null, h("td", { class: "name" }, k), h("td", null, v))))) : null,
                p.bodyText ? h("div", { style: { marginTop: "8px" } }, h("div", { class: "label", style: { marginBottom: "4px" } }, "Body"),
                    h("pre", { class: "code-block", style: { maxHeight: "260px" } }, p.bodyText.length > 100000 ? p.bodyText.slice(0, 100000) + "\n…" : p.bodyText)) : null));
        }
        if (resp.status) {
            const kv = h("div", { class: "kv" });
            const add = (k, v) => { if (v !== undefined && v !== null && v !== "") put(kv, h("div", null, k), h("div", null, String(v))); };
            add("Status", `${resp.status} ${resp.statusText || ""}`);
            add("HTTP version", resp.httpVersion);
            add("Final URL", resp.url);
            add("Remote address", resp.remoteAddress);
            add("Content type", resp.contentType);
            add("Body size", resp.size ? fmtBytes(resp.size.body) : null);
            add("Headers size", resp.size ? fmtBytes(resp.size.headers) : null);
            if (resp.tls) {
                add("TLS", [resp.tls.protocol, resp.tls.cipher].filter(Boolean).join(" · "));
                add("Certificate", resp.tls.authorized ? "Trusted" : `Not trusted${resp.tls.authorizationError ? `: ${resp.tls.authorizationError}` : ""}`);
                add("Subject", typeof resp.tls.subject === "object" ? JSON.stringify(resp.tls.subject) : resp.tls.subject);
                add("Issuer", typeof resp.tls.issuer === "object" ? JSON.stringify(resp.tls.issuer) : resp.tls.issuer);
                add("Valid until", resp.tls.validTo);
            }
            wrapEl.appendChild(h("div", { class: "tl-section" }, h("h4", null, "Response"), kv));
        }
        if (Array.isArray(resp.redirects) && resp.redirects.length) {
            wrapEl.appendChild(h("div", { class: "tl-section" }, h("h4", null, `Redirects (${resp.redirects.length})`),
                h("table", { class: "resp-table compact" }, h("tbody", null, resp.redirects.map((rd) => h("tr", null,
                    h("td", { class: `name txt-${statusClass(rd.status)}`, style: { width: "60px" } }, String(rd.status)), h("td", null, rd.url)))))));
        }
        if (!wrapEl.childElementCount) wrapEl.appendChild(h("div", { class: "resp-empty" }, "No timing information."));
        body.appendChild(wrapEl);
    }

    // ------------------------------------------------------------ console
    function buildConsole(r) {
        const lines = [];
        const p = r.prepared || {};
        const srcLabel = (s) => ({ pre: "pre-script", post: "post-script", runner: "request", capture: "capture" }[s] || s || "log");
        if (p.authInfo && !/^no auth/i.test(p.authInfo)) lines.push({ src: "auth", level: "info", message: p.authInfo });
        if (Array.isArray(r.logs)) {
            // the runner already logs script output, unknown variables, failed captures and errors
            for (const l of r.logs) lines.push({ src: srcLabel(l.source || l.phase), level: l.level || "log", message: l.message ?? String(l) });
            for (const c of r.captures || []) {
                if (c.ok) lines.push({ src: "capture", level: "ok", message: `{{${c.variable}}} = ${truncate(String(c.value ?? ""), 300)}  (${c.scope})` });
            }
        } else {
            for (const name of p.unresolved || []) lines.push({ src: "variables", level: "warn", message: `{{${name}}} is not defined and was sent as written.` });
            for (const phase of ["pre", "post"]) {
                const s = r.scripts?.[phase];
                if (!s) continue;
                for (const l of s.logs || []) lines.push({ src: srcLabel(phase), level: l.level || "log", message: l.message });
                if (s.error) lines.push({ src: srcLabel(phase), level: "error", message: s.error });
            }
            for (const c of r.captures || []) {
                lines.push(c.ok ? { src: "capture", level: "ok", message: `{{${c.variable}}} = ${truncate(String(c.value ?? ""), 300)}  (${c.scope})` }
                    : { src: "capture", level: "warn", message: `{{${c.variable}}} not captured: ${c.message || "no value"}` });
            }
            if (r.error) lines.push({ src: "request", level: "error", message: r.error });
        }
        return lines;
    }

    function renderConsole(body, lines) {
        if (!lines.length) {
            body.appendChild(h("div", { class: "resp-empty" }, h("div", null, "Nothing logged."),
                h("div", { class: "muted small" }, "Script console.log output, captured values and variable warnings appear here.")));
            return;
        }
        const box = h("div", { class: "console" });
        for (const l of lines) {
            const lv = l.level === "warning" ? "warn" : l.level;
            box.appendChild(h("div", { class: `console-line ${lv}` }, h("span", { class: "c-src" }, l.src), h("span", { class: `c-lv lv-${lv}` }, lv === "ok" ? "set" : lv), h("span", { class: "c-msg" }, l.message)));
        }
        body.appendChild(box);
    }

    render();
    return {
        el,
        render,
        destroy() { clearInterval(timer); }
    };
}

function truncate(s, n) { return s.length > n ? `${s.slice(0, n)}…` : s; }

function errorTitle(code) {
    return {
        ECONNREFUSED: "Connection refused", ENOTFOUND: "Host not found", EAI_AGAIN: "Host not found (DNS)", TIMEOUT: "The request timed out",
        ETIMEDOUT: "The connection timed out", ECONNRESET: "The connection was reset", EHOSTUNREACH: "Host unreachable", ENETUNREACH: "Network unreachable",
        DEPTH_ZERO_SELF_SIGNED_CERT: "Self-signed certificate", SELF_SIGNED_CERT_IN_CHAIN: "Self-signed certificate in chain",
        UNABLE_TO_VERIFY_LEAF_SIGNATURE: "Certificate could not be verified", CERT_HAS_EXPIRED: "Certificate expired", ERR_TLS_CERT_ALTNAME_INVALID: "Certificate does not match the host",
        INVALID_URL: "Invalid URL", ERR_INVALID_URL: "Invalid URL", TOO_MANY_REDIRECTS: "Too many redirects", PROXY_ERROR: "Proxy error"
    }[code] || "The request failed";
}

function errorTips(code, message, host) {
    const tips = [];
    if (code === "ECONNREFUSED") {
        tips.push("Check that the server is running and that host and port in the URL (or {{baseUrl}}) are right.");
        if (/127\.0\.0\.1|localhost/.test(host)) tips.push("For the sample suite, the local echo server must be running (status bar, bottom left).");
    } else if (code === "ENOTFOUND" || code === "EAI_AGAIN") {
        tips.push("Check the spelling of the host name in the URL.");
        tips.push("If the URL uses {{baseUrl}}, check the active environment in the top bar.");
        tips.push("Check your network connection or VPN.");
    } else if (code === "TIMEOUT" || code === "ETIMEDOUT") {
        tips.push("The server did not answer in time. Increase the timeout in this request's Settings tab or in Settings.");
    } else if (/CERT|SELF_SIGNED|UNABLE_TO_VERIFY|ALTNAME/i.test(code + message)) {
        if (App.effectiveSettings().enforceTlsVerification) {
            tips.push("The server's certificate is not trusted, and Settings → Enforce TLS verification is on, so it cannot be skipped. If your company signs its own certificates (internal servers, TLS-inspecting proxy), add its root certificate in Settings → Trusted CA certificates (API Tester does not use the system's certificate store). Otherwise ask for a certificate signed by a public authority.");
        } else {
            tips.push("The server's certificate is not trusted. If your company signs its own certificates, add its root certificate in Settings → Trusted CA certificates (API Tester does not use the system's certificate store).");
            tips.push("For test servers only: turn off certificate verification in this request's Settings tab (or for all requests in Settings).");
        }
    } else if (/INVALID_URL/i.test(code) || /Invalid URL/i.test(message)) {
        tips.push("The URL could not be read. Look for unknown {{variables}} and spaces.");
    } else if (/proxy/i.test(code + message)) {
        tips.push("Check the proxy settings (Settings > Proxy) or turn the proxy off.");
    }
    return tips;
}
