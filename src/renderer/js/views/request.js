"use strict";
/*
 * Request editor: method + URL bar ({{var}} highlighting, resolved preview, autocomplete, params sync,
 * cURL paste), sub tabs (Params, Headers, Body, Auth, Assertions, Capture, Scripts, Settings, Docs) and the
 * response panel below or beside it. One view per open request tab; the edited copy lives in tab.draft.
 */

const COMMON_HEADERS = [
    "Accept", "Accept-Encoding", "Accept-Language", "Authorization", "Cache-Control", "Connection", "Content-Disposition",
    "Content-Encoding", "Content-Length", "Content-Type", "Cookie", "DNT", "ETag", "Forwarded", "From", "Host", "If-Match",
    "If-Modified-Since", "If-None-Match", "If-Unmodified-Since", "Origin", "Pragma", "Prefer", "Range", "Referer", "TE",
    "User-Agent", "X-API-Key", "X-Correlation-ID", "X-CSRF-Token", "X-Forwarded-For", "X-Forwarded-Host", "X-Forwarded-Proto",
    "X-Request-ID", "X-Requested-With"
];

const BODY_MODE_LABELS = { none: "None", json: "JSON", xml: "XML", text: "Text", form: "Form URL-encoded", multipart: "Multipart form", binary: "Binary file", graphql: "GraphQL" };
const BODY_MODE_CT = { json: "application/json", xml: "application/xml", text: "text/plain", form: "application/x-www-form-urlencoded", multipart: "multipart/form-data", binary: "application/octet-stream", graphql: "application/json" };
const AUTH_LABELS = { inherit: "Inherit from parent", none: "No auth", basic: "Basic auth", bearer: "Bearer token", apikey: "API key", oauth2: "OAuth 2.0" };
const CAPTURE_SCOPES = [
    { value: "runtime", label: "Runtime", title: "Kept while the app runs (and during a run); not saved" },
    { value: "environment", label: "Environment", title: "Saved into the active environment" },
    { value: "global", label: "Global", title: "Saved into the workspace globals" }
];

const REQ_TABS = ["params", "headers", "body", "auth", "assertions", "capture", "scripts", "settings", "docs"];

const RequestView = {
    create(tab) { return createRequestView(tab); }
};

function createRequestView(tab) {
    const el = h("div", { class: "req-view" });
    const unsubs = [];
    let vars = null;          // Map of effective variables (for highlighting / preview)
    let varsStale = true;
    let destroyed = false;
    let currentTab = REQ_TABS.includes(tab.reqTab) ? tab.reqTab : "params";
    let cancelTimer = null;
    const draft = () => tab.draft;
    const meta = () => App.meta();
    const varOpts = { vars: () => vars, dynamic: () => App.dynamicVariables() };
    const varNames = () => varNamesFrom(varOpts);

    // ------------------------------------------------------------ header (breadcrumbs + name)
    const crumbPath = h("span", { class: "req-crumb-path" }); // rebuilt on changes; the name input is never detached (keeps focus)
    const crumbs = h("div", { class: "req-crumbs" });
    const nameInput = h("input", { class: "req-name", type: "text", spellcheck: "false", title: "Request name (click to rename)", "aria-label": "Request name" });
    nameInput.addEventListener("input", () => { draft().name = nameInput.value; changed({ counts: false }); });
    nameInput.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); urlInput.focus(); } });
    const statusBadge = h("span");
    const moreBtn = iconButton("more", "More: cURL, code, duplicate…", (e) => moreMenu(e.currentTarget));
    const topActions = h("div", { class: "req-top-actions" }, statusBadge, moreBtn);

    // ------------------------------------------------------------ URL bar
    const methodSel = select((meta().httpMethods || FALLBACK_META.httpMethods).map((m) => ({ value: m, label: m })), draft().method, { class: "method-select", "aria-label": "HTTP method" });
    methodSel.addEventListener("change", () => { draft().method = methodSel.value; colorMethod(); changed(); });
    const urlInput = h("input", { type: "text", class: "url-input", spellcheck: "false", autocomplete: "off", "aria-label": "URL",
        placeholder: "Enter a URL like {{baseUrl}}/users, or paste a cURL command" });
    const urlField = varInput(urlInput, varOpts);
    urlInput.addEventListener("input", () => { onUrlInput(); });
    urlInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && !e.metaKey && !e.ctrlKey && !document.querySelector(".ac-popup")) { e.preventDefault(); send(); }
    });
    urlInput.addEventListener("paste", (e) => {
        const text = e.clipboardData ? e.clipboardData.getData("text") : "";
        if (/^\s*curl\s/i.test(text)) { e.preventDefault(); importCurl(text); }
    });
    const sendBtn = h("button", { class: "btn primary send-btn", type: "button" });
    sendBtn.addEventListener("click", () => (tab.sending ? cancel() : send()));
    const saveBtn = h("button", { class: "btn save-btn", type: "button", title: `Save (${App.mac ? "⌘S" : "Ctrl+S"})` }, icon("save"), "Save");
    saveBtn.addEventListener("click", () => App.saveRequestTab(tab));
    const preview = h("div", { class: "url-preview" });
    const urlBar = h("div", { class: "url-bar" }, h("div", { class: "url-group" }, methodSel, urlField), sendBtn, saveBtn);

    // ------------------------------------------------------------ split: editor tabs + response
    const tabs = tabStrip([], currentTab, (id) => { currentTab = id; tab.reqTab = id; App.persistUi(); renderTabBody(); }, "req-tabs small");
    const tabBody = h("div", { class: "req-tab-body" });
    const editorPane = h("div", { class: "req-pane req-editor-pane" }, tabs.el, tabBody);
    const response = ResponseView.create(tab, {
        onAssert: (a) => addAssertion(a),
        onCapture: (x) => addCapture(x),
        onSend: () => send(),
        onToggleLayout: () => toggleLayout(),
        onAddSuggested: () => addSuggested()
    });
    const responsePane = h("div", { class: "req-pane req-response-pane" }, response.el);
    const splitter = h("div", { class: "resizer-y", title: "Drag to resize" });
    const split = h("div", { class: "req-split" }, editorPane, splitter, responsePane);

    put(el, h("div", { class: "req-top" }, h("div", { class: "req-crumbs-row row" }, crumbs, topActions), urlBar, preview), split);

    // ------------------------------------------------------------ layout
    function layout() { return App.state.ui.responseLayout === "horizontal" ? "horizontal" : "vertical"; }
    function applyLayout() {
        const l = layout();
        split.classList.toggle("horizontal", l === "horizontal");
        splitter.className = l === "horizontal" ? "resizer-x" : "resizer-y";
        const ratios = App.state.ui.editorRatio || {};
        const ratio = Math.max(.15, Math.min(.85, Number(ratios[l]) || (l === "horizontal" ? .5 : .45)));
        editorPane.style.flexBasis = `${ratio * 100}%`;
    }
    // drag the splitter (its axis depends on the layout, which can change while the view lives)
    splitter.addEventListener("mousedown", (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        const l = layout();
        const rect = split.getBoundingClientRect();
        const bodyClass = l === "horizontal" ? "resizing-x" : "resizing-y";
        document.body.classList.add(bodyClass);
        splitter.classList.add("active");
        const move = (ev) => {
            const ratio = l === "horizontal" ? (ev.clientX - rect.left) / rect.width : (ev.clientY - rect.top) / rect.height;
            editorPane.style.flexBasis = `${Math.max(.15, Math.min(.85, ratio)) * 100}%`;
        };
        const up = () => {
            document.removeEventListener("mousemove", move);
            document.removeEventListener("mouseup", up);
            document.body.classList.remove(bodyClass);
            splitter.classList.remove("active");
            const size = l === "horizontal" ? editorPane.getBoundingClientRect().width / rect.width : editorPane.getBoundingClientRect().height / rect.height;
            App.saveUi({ editorRatio: { ...(App.state.ui.editorRatio || {}), [l]: Math.round(size * 1000) / 1000 } });
        };
        document.addEventListener("mousemove", move);
        document.addEventListener("mouseup", up);
    });
    function toggleLayout() {
        App.saveUi({ responseLayout: layout() === "horizontal" ? "vertical" : "horizontal" });
        App.emit("layout-changed");
    }

    // ------------------------------------------------------------ state helpers
    function changed({ counts = true } = {}) {
        App.requestChanged(tab);
        refreshHeader();
        if (counts) updateTabs();
    }
    function colorMethod() {
        methodSel.className = `method-select m-${String(methodSel.value).toLowerCase()}`;
    }
    function suite() { return App.getSuite(tab.suiteId); }
    function parents() {
        if (tab.temp || !suite()) return [];
        const f = Model.findItem(suite(), tab.itemId);
        return f ? f.parents : [];
    }

    async function refreshVars() {
        varsStale = false;
        const map = await App.loadVars(tab.suiteId, tab.temp ? null : tab.itemId);
        if (destroyed) return;
        vars = map;
        urlField.refresh();
        for (const f of el.querySelectorAll(".var-field")) if (f.refresh) f.refresh();
        renderPreview();
    }

    // ------------------------------------------------------------ header rendering
    function refreshHeader() {
        clear(crumbPath);
        const s = suite();
        if (tab.temp) {
            put(crumbPath, h("span", { class: "temp-badge", title: "Not saved in a suite yet. Save to keep it." }, "Unsaved request"));
            if (s) put(crumbPath, h("span", { class: "sep" }, "·"), h("span", null, `uses ${s.name}`));
        } else if (s) {
            const crumb = (label, onClick, title) => h("button", { class: "crumb", type: "button", title, onclick: onClick }, label);
            put(crumbPath, icon("suite"), crumb(s.name, () => App.openItemSettings(s.id, null), "Suite settings"));
            for (const p of parents()) put(crumbPath, h("span", { class: "sep" }, "/"), crumb(p.name, () => App.openItemSettings(s.id, p.id), "Folder settings"));
            put(crumbPath, h("span", { class: "sep" }, "/"));
        }
        if (document.activeElement !== nameInput) nameInput.value = draft().name || "";
        if (!crumbs.childElementCount) put(crumbs, crumbPath, nameInput);
        clear(statusBadge);
        if (tab.dirty) statusBadge.appendChild(h("span", { class: "unsaved-badge", title: "Press Save to keep the changes" }, "Unsaved"));
        saveBtn.classList.toggle("dirty", !!tab.dirty || !!tab.temp);
        updateSendBtn();
    }

    function updateSendBtn() {
        clear(sendBtn);
        if (tab.sending) {
            sendBtn.classList.add("cancel");
            put(sendBtn, h("span", { class: "spinner" }), "Cancel");
            sendBtn.title = "Cancel the request";
        } else {
            sendBtn.classList.remove("cancel");
            put(sendBtn, icon("send"), "Send");
            sendBtn.title = `Send (${App.mac ? "⌘↵" : "Ctrl+Enter"})`;
        }
    }

    // ------------------------------------------------------------ URL <-> params
    function urlText() { return composeUrl(draft().url, draft().params); }
    function setUrlInput() {
        if (document.activeElement === urlInput) return;
        urlInput.value = urlText();
        urlField.refresh();
    }
    function onUrlInput() {
        const text = urlInput.value;
        const split = splitUrlQuery(text);
        const d = draft();
        d.url = split.base;
        // enabled params mirror the query string; disabled ones keep their place
        const parsed = split.params;
        const out = [];
        let i = 0;
        for (const p of d.params) {
            if (p.enabled === false) { out.push(p); continue; }
            if (i < parsed.length) { const n = parsed[i++]; out.push({ ...p, key: n.key, value: n.value }); }
        }
        while (i < parsed.length) out.push(parsed[i++]);
        d.params.splice(0, d.params.length, ...out);
        if (currentTab === "params") renderTabBody();
        renderPreview();
        changed();
    }
    function onParamsChanged() {
        setUrlInputForce();
        renderPreview();
        changed();
    }
    function setUrlInputForce() {
        const pos = urlInput.selectionStart;
        urlInput.value = urlText();
        if (document.activeElement === urlInput && pos !== null) urlInput.setSelectionRange(pos, pos);
        urlField.refresh();
    }

    function renderPreview() {
        clear(preview);
        const text = urlText();
        if (!text.trim()) {
            put(preview, h("span", null, "Tip: type ", h("kbd", null, "{{"), " to insert a variable. Press ", h("kbd", null, App.mac ? "⌘↵" : "Ctrl+Enter"), " to send."));
            return;
        }
        const env = App.activeEnvironment(tab.suiteId);
        const r = resolveVarsLocal(text, vars);
        const hasVars = /\{\{/.test(text);
        if (hasVars) {
            let shown = r.value;
            if (shown && !/^[a-z][a-z0-9+.-]*:\/\//i.test(shown) && !shown.startsWith("{{")) shown = `http://${shown}`;
            put(preview, icon("chevronRight"), h("span", { class: "resolved", title: shown }, shown));
        } else if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
            put(preview, h("span", { class: "muted" }, `No scheme: http://${text.split("/")[0]} will be used`));
        }
        if (r.unresolved.length) {
            put(preview, h("span", { class: "unresolved", title: "These variables are not defined for this request" }, icon("alert"),
                `Unknown: ${r.unresolved.slice(0, 4).join(", ")}${r.unresolved.length > 4 ? "…" : ""}`));
        }
        if (tab.suiteId) {
            put(preview, h("span", { class: "env-note" }, env ? `Environment: ${env.name}` : "No environment"));
        }
    }

    // ------------------------------------------------------------ sub tabs
    function enabledCount(list) { return (list || []).filter((x) => x.enabled !== false && (x.key || x.value || x.source)).length; }
    function updateTabs() {
        const d = draft();
        const results = tab.result && Array.isArray(tab.result.assertions) ? tab.result.assertions : null;
        const own = results ? results.filter((a) => d.assertions.some((x) => x.id === a.id)) : [];
        const failed = own.filter((a) => !a.passed && !a.skipped).length;
        const settingsSet = d.settings && (d.settings.timeoutMs != null || d.settings.followRedirects != null || d.settings.verifyTls != null);
        tabs.update([
            { id: "params", label: "Params", count: enabledCount(d.params) || null },
            { id: "headers", label: "Headers", count: enabledCount(d.headers) || null },
            { id: "body", label: "Body", dot: d.body.mode !== "none", title: BODY_MODE_LABELS[d.body.mode] },
            { id: "auth", label: "Auth", dot: d.auth.type !== "inherit" && d.auth.type !== "none", title: AUTH_LABELS[d.auth.type] },
            { id: "assertions", label: "Assertions", count: enabledCount(d.assertions) || null, countClass: own.length ? (failed ? "bad" : "good") : "" },
            { id: "capture", label: "Capture", count: enabledCount(d.extract) || null },
            { id: "scripts", label: "Scripts", dot: !!(d.scripts.pre.trim() || d.scripts.post.trim()) },
            { id: "settings", label: "Settings", dot: !!settingsSet },
            { id: "docs", label: "Docs", dot: !!(d.description || "").trim() }
        ]);
        tabs.setActive(currentTab);
    }
    function selectTab(id) { currentTab = id; tab.reqTab = id; tabs.setActive(id); renderTabBody(); }

    function renderTabBody() {
        clear(tabBody);
        tabBody.className = "req-tab-body";
        const render = { params: renderParams, headers: renderHeaders, body: renderBody, auth: renderAuth, assertions: renderAssertions,
            capture: renderCapture, scripts: renderScripts, settings: renderSettings, docs: renderDocs }[currentTab] || renderParams;
        try { render(); } catch (err) { console.error(err); tabBody.appendChild(h("div", { class: "callout bad" }, icon("alert"), err.message)); }
    }

    // Params
    function renderParams() {
        const table = kvTable(draft().params, {
            keyPlaceholder: "Add query parameter", valuePlaceholder: "Value", ...varOpts, onChange: onParamsChanged
        });
        put(tabBody, 
            h("div", { class: "sub-toolbar" }, h("span", { class: "section-title", style: { margin: 0 } }, "Query parameters"),
                h("span", { class: "hint" }, "Kept in sync with the URL. Untick a row to leave it out without deleting it.")),
            table);
    }

    // Headers
    function renderHeaders() {
        const table = kvTable(draft().headers, {
            keyPlaceholder: "Add header", valuePlaceholder: "Value", keySuggestions: COMMON_HEADERS, ...varOpts,
            onChange: () => { changed(); renderInherited(); }
        });
        const inherited = h("div");
        const renderInherited = () => { clear(inherited); inherited.appendChild(inheritedHeadersBlock()); };
        renderInherited();
        put(tabBody, 
            h("div", { class: "sub-toolbar" }, h("span", { class: "section-title", style: { margin: 0 } }, "Request headers"),
                h("span", { class: "hint" }, "A header here replaces an inherited one with the same name.")),
            table, inherited);
    }

    function inheritedHeadersBlock() {
        const s = suite();
        const d = draft();
        const own = new Set(d.headers.filter((x) => x.enabled !== false && x.key).map((x) => x.key.toLowerCase()));
        const levels = [];
        if (s) {
            levels.push({ label: "suite", list: s.headers || [], open: () => App.openItemSettings(s.id, null) });
            for (const p of parents()) levels.push({ label: `folder "${p.name}"`, list: p.headers || [], open: () => App.openItemSettings(s.id, p.id) });
        }
        const rows = [];
        levels.forEach((lvl, li) => {
            for (const hd of lvl.list) {
                if (hd.enabled === false || !hd.key) continue;
                const name = hd.key.toLowerCase();
                const overridden = own.has(name) || levels.slice(li + 1).some((l) => l.list.some((x) => x.enabled !== false && x.key && x.key.toLowerCase() === name));
                rows.push(h("div", { class: `inherited-row ${overridden ? "overridden" : ""}`, title: overridden ? "Replaced by a header set closer to the request" : "" },
                    h("span", null, hd.key), h("span", { class: "ellipsis" }, hd.value), h("button", { class: "link-btn src", type: "button", onclick: lvl.open }, `from ${lvl.label}`)));
            }
        });
        const auto = [];
        const has = (n) => own.has(n) || levels.some((l) => l.list.some((x) => x.enabled !== false && x.key && x.key.toLowerCase() === n));
        if (d.body.mode !== "none" && !has("content-type")) auto.push(["Content-Type", BODY_MODE_CT[d.body.mode] + (d.body.mode === "multipart" ? "; boundary=…" : ""), "from Body"]);
        const authType = effectiveAuth().auth?.type;
        if (authType && authType !== "none" && !(authType === "apikey" && effectiveAuth().auth.apikey.in === "query")) {
            const name = authType === "apikey" ? effectiveAuth().auth.apikey.key || "X-API-Key" : "Authorization";
            if (!has(name.toLowerCase())) auto.push([name, authType === "basic" ? "Basic …" : authType === "apikey" ? "…" : "Bearer …", "from Auth"]);
        }
        if (!has("user-agent")) auto.push(["User-Agent", `API-Tester/${App.state.info.version || ""}`.replace(/\/$/, ""), "default"]);
        if (!has("accept")) auto.push(["Accept", "*/*", "default"]);
        return h("div", { class: "inherited-block" },
            rows.length ? h("div", null, h("div", { class: "section-title" }, "Inherited"), h("div", { class: "inherited-list" }, rows)) : null,
            h("div", { class: "section-title", style: { marginTop: "12px" } }, "Added automatically when sent"),
            h("div", { class: "inherited-list" }, auto.map(([k, v, src]) => h("div", { class: "inherited-row" }, h("span", null, k), h("span", { class: "ellipsis" }, v), h("span", { class: "src" }, src)))));
    }

    // Body
    function renderBody() {
        const d = draft();
        const body = d.body;
        const seg = h("div", { class: "segmented", role: "radiogroup", "aria-label": "Body type" });
        for (const mode of meta().bodyModes || FALLBACK_META.bodyModes) {
            const b = h("button", { type: "button", class: body.mode === mode ? "active" : "", title: BODY_MODE_CT[mode] || "No body" }, BODY_MODE_LABELS[mode] || mode);
            b.addEventListener("click", () => {
                if (body.mode === mode) return;
                body.mode = mode;
                changed();
                renderTabBody();
            });
            seg.appendChild(b);
        }
        tabBody.className = "req-tab-body fill";
        const top = h("div", { class: "sub-toolbar" }, seg);
        tabBody.appendChild(top);
        const ctOwn = d.headers.find((x) => x.enabled !== false && x.key && x.key.toLowerCase() === "content-type");
        const ctNote = () => (body.mode !== "none" && body.mode !== "multipart"
            ? h("div", { class: "body-note" }, ctOwn ? `Content-Type from Headers: ${ctOwn.value}` : `Content-Type: ${BODY_MODE_CT[body.mode]} is added unless you set one in Headers.`)
            : null);

        if (body.mode === "none") {
            tabBody.appendChild(h("div", { class: "empty" }, h("p", null, "This request has no body."), h("div", { class: "hint" }, "Choose JSON, a form or another type above to send data.")));
        } else if (body.mode === "json" || body.mode === "xml" || body.mode === "text") {
            const ta = codeEditor(body.raw, (v) => { body.raw = v; changed(); check(); }, {
                placeholder: body.mode === "json" ? "{\n    \"name\": \"{{name}}\",\n    \"email\": \"{{$randomEmail}}\"\n}" : body.mode === "xml" ? "<user>\n    <name>{{name}}</name>\n</user>" : "Text to send"
            });
            const state = h("span", { class: "json-state" });
            const check = () => {
                if (body.mode !== "json") return;
                clear(state);
                if (!body.raw.trim()) { state.className = "json-state"; return; }
                const r = checkJson(body.raw);
                state.className = `json-state ${r.ok ? "ok" : "bad"}`;
                put(state, icon(r.ok ? "check" : "alert"), r.ok ? "Valid JSON" : r.message);
            };
            if (body.mode === "json") {
                put(top, 
                    h("button", { class: "btn small", type: "button", title: "Pretty-print the JSON ({{variables}} are kept)", onclick: () => {
                        const r = formatJson(body.raw);
                        if (r.error) return toast(`Cannot format: ${r.error}`, "error");
                        ta.value = r.text; body.raw = r.text; changed(); check();
                    } }, icon("braces"), "Format"),
                    h("button", { class: "btn small", type: "button", title: "Check the JSON", onclick: () => {
                        const r = checkJson(body.raw);
                        check();
                        toast(r.ok ? "The JSON is valid" : r.message, r.ok ? "success" : "error");
                    } }, icon("check"), "Validate"),
                    state);
                check();
            } else if (body.mode === "xml") {
                put(top, h("button", { class: "btn small", type: "button", onclick: () => {
                    const text = formatXml(body.raw);
                    ta.value = text; body.raw = text; changed();
                } }, icon("braces"), "Format"));
            }
            put(tabBody, h("div", { class: "editor-area" }, ta), ctNote());
        } else if (body.mode === "form") {
            put(tabBody, kvTable(body.form, { keyPlaceholder: "Add field", ...varOpts, onChange: () => changed() }), ctNote());
        } else if (body.mode === "multipart") {
            put(tabBody, multipartTable(body), h("div", { class: "body-note" }, "Sent as multipart/form-data. Choose File to upload a file from this computer."));
        } else if (body.mode === "binary") {
            const nameEl = h("span", { class: `file-name ${body.binaryPath ? "" : "none"}` }, body.binaryPath || "No file chosen");
            put(tabBody, 
                h("div", { class: "card" }, h("div", { class: "card-body row" },
                    icon("file"), nameEl,
                    h("button", { class: "btn small", type: "button", onclick: async () => {
                        const p = await attempt(() => api.call("files.pickFile", { title: "Choose the file to send" }));
                        if (p) { body.binaryPath = p; changed(); renderTabBody(); }
                    } }, "Choose file…"),
                    body.binaryPath ? h("button", { class: "btn small ghost", type: "button", onclick: () => { body.binaryPath = ""; changed(); renderTabBody(); } }, "Remove") : null)),
                ctNote());
        } else if (body.mode === "graphql") {
            const q = codeEditor(body.graphql.query, (v) => { body.graphql.query = v; changed(); }, { placeholder: "query {\n    user(id: \"{{userId}}\") {\n        id\n        name\n    }\n}" });
            const vEd = codeEditor(body.graphql.variables, (v) => { body.graphql.variables = v; changed(); vcheck(); }, { placeholder: "{\n    \"limit\": 10\n}" });
            const vstate = h("span", { class: "json-state" });
            const vcheck = () => {
                clear(vstate);
                if (!body.graphql.variables.trim()) return;
                const r = checkJson(body.graphql.variables);
                vstate.className = `json-state ${r.ok ? "ok" : "bad"}`;
                put(vstate, icon(r.ok ? "check" : "alert"), r.ok ? "Valid JSON" : r.message);
            };
            vcheck();
            put(tabBody, h("div", { class: "grid-2 graphql-grid" },
                h("div", { class: "editor-area" }, h("div", { class: "label", style: { marginBottom: "4px" } }, "Query"), q),
                h("div", { class: "editor-area" }, h("div", { class: "row", style: { marginBottom: "4px" } }, h("span", { class: "label" }, "Variables (JSON)"), vstate), vEd)),
            h("div", { class: "body-note" }, "Sent as JSON: { \"query\": …, \"variables\": … }"));
        }
    }

    function codeEditor(value, onInput, { placeholder = "", wrap = false } = {}) {
        const ta = h("textarea", { class: `code-editor ${wrap ? "wrap" : ""}`, spellcheck: "false", placeholder, autocomplete: "off" });
        ta.value = value || "";
        ta.addEventListener("input", () => onInput(ta.value));
        ta.addEventListener("keydown", (e) => editorKeys(e, ta));
        attachVarAutocomplete(ta, { names: varNames });
        return ta;
    }

    function multipartTable(body) {
        const newRow = () => ({ key: "", type: "text", value: "", filePath: "", contentType: "", enabled: true });
        let table;
        const columns = [
            "enabled",
            "key",
            { name: "type", label: "Type", width: "90px", render: (row, done) => {
                const sel = select([{ value: "text", label: "Text" }, { value: "file", label: "File" }], row.type || "text");
                sel.addEventListener("change", () => { row.type = sel.value; done(); table.refresh(); });
                return sel;
            } },
            { name: "value", label: "Value", render: (row, done) => {
                if (row.type === "file") {
                    const nm = h("span", { class: `file-name ${row.filePath ? "" : "none"}`, title: row.filePath }, row.filePath ? row.filePath.split(/[\\/]/).pop() : "No file chosen");
                    return h("div", { class: "file-pick" }, nm, h("button", { class: "btn small", type: "button", onclick: async () => {
                        const p = await attempt(() => api.call("files.pickFile", { title: "Choose a file to upload" }));
                        if (p) { row.filePath = p; done(); table.refresh(); }
                    } }, "Choose…"));
                }
                const input = h("input", { type: "text", value: row.value || "", spellcheck: "false", placeholder: "Value" });
                input.addEventListener("input", () => { row.value = input.value; done(); });
                return varInput(input, varOpts);
            } },
            { name: "contentType", label: "Content type", width: "150px", render: (row, done) => {
                const input = h("input", { type: "text", value: row.contentType || "", spellcheck: "false", placeholder: "auto" });
                input.addEventListener("input", () => { row.contentType = input.value; done(); });
                return input;
            } }
        ];
        table = kvTable(body.multipart, { columns, newRow, keyPlaceholder: "Add field", onChange: () => changed() });
        return table;
    }

    // Auth
    function effectiveAuth() {
        const s = suite();
        if (draft().auth.type !== "inherit") return { auth: draft().auth, from: "request" };
        const ps = parents();
        for (let i = ps.length - 1; i >= 0; i--) if (ps[i].auth && ps[i].auth.type !== "inherit") return { auth: ps[i].auth, from: `folder "${ps[i].name}"`, open: () => App.openItemSettings(s.id, ps[i].id) };
        if (s) return { auth: s.auth || { type: "none" }, from: "suite", open: () => App.openItemSettings(s.id, null) };
        return { auth: { type: "none" }, from: null };
    }

    function renderAuth() {
        const auth = draft().auth;
        const types = (meta().authTypes || FALLBACK_META.authTypes).map((t) => ({ value: t, label: AUTH_LABELS[t] || t }));
        const typeSel = select(types, auth.type);
        typeSel.addEventListener("change", () => { auth.type = typeSel.value; changed(); renderTabBody(); });
        const form = h("div", { class: "stack auth-form" }, h("div", { class: "form-grid two" }, field("Type", typeSel)));
        const vfield = (label, obj, key, { placeholder = "", secret = false, hint } = {}) => {
            const input = h("input", { type: secret ? "password" : "text", value: obj[key] || "", placeholder, spellcheck: "false", autocomplete: "off" });
            input.addEventListener("input", () => { obj[key] = input.value; changed({ counts: false }); });
            let control;
            if (secret) {
                attachVarAutocomplete(input, { names: varNames });
                const eye = h("button", { class: "btn ghost icon eye-toggle", type: "button", title: "Show / hide", tabindex: "-1" }, icon("eye"));
                eye.addEventListener("click", () => { const show = input.type === "password"; input.type = show ? "text" : "password"; clear(eye).appendChild(icon(show ? "eyeOff" : "eye")); });
                control = h("div", { class: "secret-input" }, input, eye);
            } else control = varInput(input, varOpts);
            return field(label, control, hint);
        };
        if (auth.type === "inherit") {
            const eff = effectiveAuth();
            const label = AUTH_LABELS[eff.auth.type] || eff.auth.type;
            form.appendChild(h("div", { class: "auth-inherit" }, icon("lock"),
                eff.from ? h("span", null, "Uses ", h("b", null, label), ` from the ${eff.from}. `,
                    eff.open ? h("button", { class: "link-btn", type: "button", onclick: eff.open }, "Change it there") : null)
                    : h("span", null, "There is no parent, so no auth is sent.")));
        } else if (auth.type === "none") {
            form.appendChild(h("div", { class: "hint" }, "No Authorization header is added, even if a parent folder or the suite defines one."));
        } else if (auth.type === "basic") {
            form.appendChild(h("div", { class: "form-grid two" },
                vfield("Username", auth.basic, "username", { placeholder: "{{username}}" }),
                vfield("Password", auth.basic, "password", { secret: true, placeholder: "{{password}}" })));
            form.appendChild(h("div", { class: "hint" }, "Sends Authorization: Basic base64(username:password)."));
        } else if (auth.type === "bearer") {
            form.appendChild(vfield("Token", auth.bearer, "token", { placeholder: "{{token}}", hint: "Sends Authorization: Bearer <token>. Tip: capture the token from a login response into {{token}}." }));
        } else if (auth.type === "apikey") {
            const inSel = select([{ value: "header", label: "Header" }, { value: "query", label: "Query parameter" }], auth.apikey.in || "header");
            inSel.addEventListener("change", () => { auth.apikey.in = inSel.value; changed({ counts: false }); });
            form.appendChild(h("div", { class: "form-grid three" },
                vfield("Name", auth.apikey, "key", { placeholder: "X-API-Key" }),
                vfield("Value", auth.apikey, "value", { secret: true, placeholder: "{{apiKey}}" }),
                field("Add to", inSel)));
        } else if (auth.type === "oauth2") {
            const o = auth.oauth2;
            const grant = select([{ value: "client_credentials", label: "Client credentials" }, { value: "password", label: "Password" }], o.grantType || "client_credentials");
            grant.addEventListener("change", () => { o.grantType = grant.value; changed({ counts: false }); renderTabBody(); });
            const clientAuth = select([{ value: "body", label: "In the request body" }, { value: "basic", label: "As Basic auth header" }], o.clientAuth || "body");
            clientAuth.addEventListener("change", () => { o.clientAuth = clientAuth.value; changed({ counts: false }); });
            form.appendChild(h("div", { class: "form-grid two" },
                field("Grant type", grant),
                vfield("Token URL", o, "tokenUrl", { placeholder: "{{baseUrl}}/oauth/token" }),
                vfield("Client ID", o, "clientId", { placeholder: "{{clientId}}" }),
                vfield("Client secret", o, "clientSecret", { secret: true, placeholder: "{{clientSecret}}" }),
                o.grantType === "password" ? vfield("Username", o, "username") : null,
                o.grantType === "password" ? vfield("Password", o, "password", { secret: true }) : null,
                vfield("Scope", o, "scope", { placeholder: "read write" }),
                vfield("Audience", o, "audience", { placeholder: "optional" }),
                field("Send client credentials", clientAuth)));
            form.appendChild(h("div", { class: "callout" }, icon("info"),
                h("div", null, "The token is fetched automatically before the request is sent and reused until it expires. ",
                    "It is sent as Authorization: Bearer <token>.")));
        }
        tabBody.appendChild(form);
    }

    // Assertions
    function sourceMeta(list, value) { return (list || []).find((s) => s.value === value) || { value, label: value, needsProperty: false }; }
    function operatorsFor(source) {
        const all = meta().assertionOperators || FALLBACK_META.assertionOperators;
        const src = sourceMeta(meta().assertionSources, source);
        const byMeta = (meta().operatorsBySource || {})[source];
        const allowed = Array.isArray(src.operators) && src.operators.length ? src.operators : Array.isArray(byMeta) && byMeta.length ? byMeta : null;
        if (allowed) return all.filter((o) => allowed.includes(o.value));
        if (source === "schema") return all.filter((o) => o.value === "validSchema");
        return all.filter((o) => o.value !== "validSchema");
    }
    function opMeta(value) { return (meta().assertionOperators || FALLBACK_META.assertionOperators).find((o) => o.value === value) || { value, label: value, needsExpected: true }; }
    const ASSERT_DEFAULTS = {
        status: ["equals", "200"], statusText: ["equals", "OK"], responseTime: ["lt", "1000"], size: ["lt", "100000"],
        header: ["exists", ""], contentType: ["contains", "json"], body: ["contains", ""], jsonpath: ["exists", ""],
        schema: ["validSchema", "{\n    \"type\": \"object\",\n    \"required\": [\"id\"]\n}"]
    };

    function resultFor(id) {
        const list = tab.result && Array.isArray(tab.result.assertions) ? tab.result.assertions : [];
        return list.find((a) => a.id === id) || null;
    }

    function renderAssertions() {
        const d = draft();
        const sources = (meta().assertionSources || FALLBACK_META.assertionSources).filter((s) => s.value !== "script");
        const addBtn = h("button", { class: "btn small", type: "button", onclick: () => {
            d.assertions.push({ id: uid("a"), enabled: true, source: "status", property: "", operator: "equals", expected: "200" });
            changed(); renderTabBody();
            const rows = tabBody.querySelectorAll("tbody tr");
            rows[rows.length - 1]?.querySelector("select")?.focus();
        } }, icon("plus"), "Add assertion");
        const suggestBtn = h("button", { class: "btn small", type: "button", disabled: !(tab.result && tab.result.response && tab.result.response.status),
            title: tab.result && tab.result.response ? "Add a few checks based on the last response" : "Send the request first", onclick: () => addSuggested() }, icon("sparkles"), "Add suggested");
        tabBody.appendChild(h("div", { class: "sub-toolbar" }, addBtn, suggestBtn,
            h("span", { class: "hint" }, "Tip: click any value in the response body to assert it.")));
        if (!d.assertions.length) {
            tabBody.appendChild(h("div", { class: "empty-rules" },
                h("div", { class: "big" }, icon("target")),
                h("div", { class: "strong" }, "No assertions yet"),
                h("p", null, "Assertions check the response: status code, a JSON value, a header, response time and more. Failed ones are shown in red in Tests and in runner reports."),
                h("div", { class: "btn-group", style: { justifyContent: "center" } },
                    h("button", { class: "btn small primary", type: "button", onclick: () => addBtn.click() }, icon("plus"), "Add assertion"),
                    suggestBtn.disabled ? null : h("button", { class: "btn small", type: "button", onclick: () => addSuggested() }, icon("sparkles"), "Add suggested"))));
            return;
        }
        const tbody = h("tbody");
        // narrow editor panes show each row on two lines (styles.css); data-label names the fields then
        const table = h("table", { class: "rules-table assert-table" },
            h("thead", null, h("tr", null, h("th", { class: "c-on" }), h("th", { class: "c-src" }, "Check"), h("th", { class: "c-prop" }, "Property"),
                h("th", { class: "c-op" }, "Operator"), h("th", { class: "c-exp" }, "Expected"), h("th", { class: "c-res", title: "Result of the last send" }, ""), h("th", { class: "c-del" }))),
            tbody);
        for (const a of d.assertions) tbody.appendChild(assertionRow(a, sources));
        tabBody.appendChild(table);
        const scriptTests = (tab.result?.assertions || []).filter((x) => x.source === "script" || String(x.id || "").startsWith("script"));
        if (scriptTests.length) tabBody.appendChild(h("div", { class: "hint", style: { marginTop: "8px" } }, `${scriptTests.length} test(s) from the post-response script are shown in the response Tests tab.`));
    }

    function assertionRow(a, sources) {
        const d = draft();
        const tr = h("tr", { class: a.enabled === false ? "disabled" : "" });
        const on = h("input", { type: "checkbox", checked: a.enabled !== false, title: "Enabled" });
        on.addEventListener("change", () => { a.enabled = on.checked; tr.classList.toggle("disabled", !on.checked); changed(); });
        const srcSel = select(sources.map((s) => ({ value: s.value, label: s.label, title: s.hint })), a.source);
        const src = sourceMeta(sources, a.source);
        const prop = h("input", { type: "text", class: "mono", value: a.property || "", spellcheck: "false", placeholder: src.needsProperty ? (src.propertyPlaceholder || "") : "—", disabled: !src.needsProperty, title: src.hint || "" });
        prop.addEventListener("input", () => { a.property = prop.value; changed({ counts: false }); });
        const ops = operatorsFor(a.source);
        if (!ops.some((o) => o.value === a.operator) && ops[0]) a.operator = ops[0].value;
        const opSel = select(ops.map((o) => ({ value: o.value, label: o.label })), a.operator);
        const expCell = h("td", { class: "c-exp", dataset: { label: "Expected" } });
        const renderExpected = () => {
            clear(expCell);
            const op = opMeta(a.operator);
            if (op.needsExpected === false) { expCell.appendChild(h("span", { class: "na" }, "—")); return; }
            if (a.operator === "validSchema") {
                expCell.appendChild(h("button", { class: "btn small", type: "button", title: "Edit the JSON schema", onclick: () => editSchema(a) }, icon("edit"),
                    a.expected && a.expected.trim() ? "Edit schema" : "Add schema"));
                return;
            }
            const placeholder = op.expectedPlaceholder || (a.operator === "isType" ? "string, number, boolean, object, array, null" : a.operator === "in" || a.operator === "notIn" ? "a, b, c" : a.operator === "matches" ? "/^ok$/i" : "");
            const input = h("input", { type: "text", class: "mono", value: a.expected ?? "", spellcheck: "false", placeholder });
            input.addEventListener("input", () => { a.expected = input.value; changed({ counts: false }); });
            expCell.appendChild(varInput(input, varOpts));
        };
        renderExpected();
        srcSel.addEventListener("change", () => {
            a.source = srcSel.value;
            const def = ASSERT_DEFAULTS[a.source];
            const newOps = operatorsFor(a.source);
            if (def && newOps.some((o) => o.value === def[0])) { a.operator = def[0]; a.expected = def[1]; }
            else if (!newOps.some((o) => o.value === a.operator)) a.operator = newOps[0]?.value || "equals";
            const sm = sourceMeta(sources, a.source);
            if (!sm.needsProperty) a.property = "";
            else if (!a.property && a.source === "header") a.property = "Content-Type";
            changed();
            tr.replaceWith(assertionRow(a, sources));
        });
        opSel.addEventListener("change", () => { a.operator = opSel.value; changed({ counts: false }); renderExpected(); });
        const res = resultFor(a.id);
        const resCell = h("td", { class: "c-res" });
        if (res) {
            const cls = res.skipped ? "skip" : res.passed ? "pass" : "fail";
            resCell.appendChild(h("span", { class: `res-icon ${cls}`, title: res.passed ? `Passed: ${res.label}` : `${res.label}\nActual: ${res.actual ?? ""}\n${res.message || ""}` },
                icon(res.passed ? "check" : res.skipped ? "minus" : "x")));
        }
        const del = h("button", { class: "btn ghost icon row-delete", type: "button", title: "Delete assertion" }, icon("trash"));
        del.addEventListener("click", () => {
            d.assertions.splice(d.assertions.indexOf(a), 1);
            changed();
            renderTabBody();
        });
        put(tr, h("td", { class: "c-on" }, on), h("td", { class: "c-src" }, srcSel), h("td", { class: "c-prop", dataset: { label: "Property" } }, prop),
            h("td", { class: "c-op" }, opSel), expCell, resCell, h("td", { class: "c-del" }, del));
        return tr;
    }

    async function editSchema(a) {
        const ta = h("textarea", { class: "code-editor", spellcheck: "false", rows: 18, style: { width: "100%", minHeight: "320px" } });
        ta.value = a.expected || ASSERT_DEFAULTS.schema[1];
        ta.addEventListener("keydown", (e) => editorKeys(e, ta));
        const fromResponse = tab.result?.response?.json !== undefined || looksJson(tab.result?.response);
        const r = await modal({
            title: "JSON schema",
            size: "wide",
            body: h("div", { class: "stack tight" },
                h("div", { class: "hint" }, "The whole JSON body must match this JSON Schema (draft 2020-12 / 07). Formats like email, date-time and uuid are checked."),
                ta),
            buttons: [
                fromResponse ? { label: "Generate from last response", onClick: () => { ta.value = JSON.stringify(schemaFromValue(responseJson(tab.result.response)), null, 4); return false; } } : null,
                { spacer: true },
                { label: "Cancel", value: null },
                { label: "Apply", class: "primary", onClick: () => {
                    const c = checkJson(ta.value);
                    if (!c.ok) { toast(`The schema is not valid JSON: ${c.message}`, "error"); return false; }
                    return ta.value;
                } }
            ]
        });
        if (r === null) return;
        a.expected = r;
        changed();
        renderTabBody();
    }

    function addAssertion({ source, property = "", operator = "equals", expected = "" }) {
        const d = draft();
        const dup = d.assertions.find((a) => a.source === source && (a.property || "") === property && a.operator === operator && String(a.expected) === String(expected));
        if (dup) { toast("That assertion already exists", "info", 1800); selectTab("assertions"); return; }
        d.assertions.push({ id: uid("a"), enabled: true, source, property, operator, expected: String(expected ?? "") });
        changed();
        selectTab("assertions");
        flashLastRow();
        toast("Assertion added. Send again to check it.", "success", 2200);
    }

    function addSuggested() {
        const resp = tab.result && tab.result.response;
        if (!resp || !resp.status) return toast("Send the request first, then suggestions come from its response", "warn");
        const d = draft();
        let added = 0;
        for (const s of suggestAssertionsLocal(resp)) {
            const exists = d.assertions.some((a) => a.source === s.source && (a.property || "") === (s.property || "") && a.operator === s.operator);
            if (exists) continue;
            d.assertions.push({ id: uid("a"), enabled: true, property: "", ...s });
            added++;
        }
        changed();
        selectTab("assertions");
        toast(added ? `Added ${added} assertion${added === 1 ? "" : "s"}` : "The suggested assertions are already there", added ? "success" : "info", 2200);
    }

    // Capture
    function renderCapture() {
        const d = draft();
        const sources = meta().extractSources || FALLBACK_META.extractSources;
        const addBtn = h("button", { class: "btn small", type: "button", onclick: () => {
            d.extract.push({ id: uid("x"), enabled: true, source: "jsonpath", property: "", variable: "", scope: "runtime" });
            changed(); renderTabBody();
            const rows = tabBody.querySelectorAll("tbody tr");
            rows[rows.length - 1]?.querySelector("td:nth-child(3) input")?.focus();
        } }, icon("plus"), "Add capture");
        tabBody.appendChild(h("div", { class: "sub-toolbar" }, addBtn,
            h("span", { class: "hint" }, "Captured values become variables, e.g. {{token}}, for the next requests.")));
        if (!d.extract.length) {
            tabBody.appendChild(h("div", { class: "empty-rules" },
                h("div", { class: "big" }, icon("capture")),
                h("div", { class: "strong" }, "Nothing captured yet"),
                h("p", null, "Take a value from the response (JSON value, header, cookie, regex) and store it in a variable. Use it in later requests as {{name}} to chain them, e.g. log in, capture the token, call a protected endpoint."),
                h("div", { class: "btn-group", style: { justifyContent: "center" } }, h("button", { class: "btn small primary", type: "button", onclick: () => addBtn.click() }, icon("plus"), "Add capture"))));
            return;
        }
        const tbody = h("tbody");
        tabBody.appendChild(h("table", { class: "rules-table capture-table" },
            h("thead", null, h("tr", null, h("th", { class: "c-on" }), h("th", { class: "c-src" }, "From"), h("th", { class: "c-prop" }, "Property"), h("th", { class: "c-var" }, "Variable name"),
                h("th", { class: "c-scope" }, "Store in"), h("th", { class: "c-last" }, "Last value"), h("th", { class: "c-del" }))),
            tbody));
        for (const x of d.extract) tbody.appendChild(captureRow(x, sources));
        const needsEnv = d.extract.some((x) => x.enabled !== false && x.scope === "environment") && !App.activeEnvironmentId(tab.suiteId);
        if (needsEnv) tabBody.appendChild(h("div", { class: "callout warn", style: { marginTop: "10px" } }, icon("alert"), "Some captures store into the environment, but no environment is active. Pick one in the top bar."));
    }

    function captureRow(x, sources) {
        const d = draft();
        const tr = h("tr", { class: x.enabled === false ? "disabled" : "" });
        const on = h("input", { type: "checkbox", checked: x.enabled !== false });
        on.addEventListener("change", () => { x.enabled = on.checked; tr.classList.toggle("disabled", !on.checked); changed(); });
        const srcSel = select(sources.map((s) => ({ value: s.value, label: s.label, title: s.hint })), x.source);
        const sm = sourceMeta(sources, x.source);
        const prop = h("input", { type: "text", class: "mono", value: x.property || "", spellcheck: "false", placeholder: sm.needsProperty ? (sm.propertyPlaceholder || "") : "—", disabled: !sm.needsProperty });
        prop.addEventListener("input", () => { x.property = prop.value; changed({ counts: false }); });
        srcSel.addEventListener("change", () => {
            x.source = srcSel.value;
            if (!sourceMeta(sources, x.source).needsProperty) x.property = "";
            changed();
            tr.replaceWith(captureRow(x, sources));
        });
        const varIn = h("input", { type: "text", class: "mono", value: x.variable || "", spellcheck: "false", placeholder: "token" });
        varIn.addEventListener("input", () => { x.variable = varIn.value.replace(/[{}\s]/g, ""); if (varIn.value !== x.variable) varIn.value = x.variable; changed({ counts: false }); });
        const scopeSel = select(CAPTURE_SCOPES, x.scope || "runtime");
        scopeSel.addEventListener("change", () => { x.scope = scopeSel.value; changed({ counts: false }); renderTabBody(); });
        const last = (tab.result?.captures || []).find((c) => c.id === x.id);
        const lastCell = h("td", { class: "c-last", dataset: { label: "Last value" } });
        if (last) lastCell.appendChild(h("div", { class: `last-value ${last.ok ? "" : "fail"}`, title: last.ok ? String(last.value ?? "") : last.message || "" },
            last.ok ? String(last.value ?? "") : (last.message || "not found")));
        const del = h("button", { class: "btn ghost icon row-delete", type: "button", title: "Delete capture" }, icon("trash"));
        del.addEventListener("click", () => { d.extract.splice(d.extract.indexOf(x), 1); changed(); renderTabBody(); });
        put(tr, h("td", { class: "c-on" }, on), h("td", { class: "c-src" }, srcSel), h("td", { class: "c-prop", dataset: { label: "Property" } }, prop),
            h("td", { class: "c-var", dataset: { label: "Variable" } }, varIn), h("td", { class: "c-scope" }, scopeSel), lastCell, h("td", { class: "c-del" }, del));
        return tr;
    }

    async function addCapture({ source, property = "", suggestedName = "" }) {
        const name = await promptDialog("Capture as variable", "Variable name", suggestedName || "value", {
            okLabel: "Add capture",
            hint: `${source === "jsonpath" ? property : `${source} ${property}`} will be stored in {{name}} after every send.`,
            validate: (v) => (/^[\w.\-]+$/.test(v) ? null : "Use letters, digits, _ . - only")
        });
        if (!name) return;
        const d = draft();
        d.extract.push({ id: uid("x"), enabled: true, source, property, variable: name, scope: "runtime" });
        changed();
        selectTab("capture");
        flashLastRow();
        toast(`Will capture {{${name}}} on the next send`, "success", 2400);
    }

    function flashLastRow() {
        const rows = tabBody.querySelectorAll("tbody tr");
        const row = rows[rows.length - 1];
        if (row) { row.classList.add("flash"); row.scrollIntoView({ block: "nearest" }); }
    }

    // Scripts
    function renderScripts() {
        const d = draft();
        tabBody.className = "req-tab-body fill";
        const pre = codeEditor(d.scripts.pre, (v) => { d.scripts.pre = v; changed(); }, { placeholder: "// Runs before the request is sent\n// vars.set(\"requestId\", Date.now().toString());\n// request.headers[\"X-Trace\"] = vars.get(\"requestId\");" });
        const post = codeEditor(d.scripts.post, (v) => { d.scripts.post = v; changed(); }, { placeholder: "// Runs after the response arrived\n// test(\"status is 200\", () => expect(response.status).toBe(200));\n// vars.set(\"userId\", response.json().id);" });
        const snippet = (target, text) => {
            const v = target.value;
            const add = (v && !v.endsWith("\n") ? "\n" : "") + text + "\n";
            target.focus();
            target.setRangeText(add, v.length, v.length, "end");
            target.dispatchEvent(new Event("input"));
        };
        const snippets = (target, list) => h("div", { class: "snippet-btns" }, list.map(([label, text]) => h("button", { class: "btn small ghost", type: "button", title: text, onclick: () => snippet(target, text) }, icon("plus"), label)));
        tabBody.appendChild(h("div", { class: "scripts-grid" },
            h("div", { class: "scripts-editors" },
                h("div", { class: "editor-area" },
                    h("div", { class: "row", style: { marginBottom: "4px" } }, h("span", { class: "label" }, "Pre-request script"), h("span", { class: "spacer" }),
                        snippets(pre, [["Set variable", "vars.set(\"name\", \"value\");"], ["Add header", "request.headers[\"X-Request-Id\"] = String(Date.now());"]])),
                    pre),
                h("div", { class: "editor-area" },
                    h("div", { class: "row", style: { marginBottom: "4px" } }, h("span", { class: "label" }, "Post-response script"), h("span", { class: "spacer" }),
                        snippets(post, [["Test status", "test(\"status is 200\", () => {\n    expect(response.status).toBe(200);\n});"],
                            ["Test JSON value", "test(\"has an id\", () => {\n    expect(response.json()).toHaveProperty(\"id\");\n});"],
                            ["Save value", "vars.set(\"id\", response.json().id);"], ["Log", "console.log(response.status, response.time);"]])),
                    post)),
            h("div", { class: "cheatsheet" },
                h("h4", null, "Script API"),
                h("div", { class: "muted", style: { marginBottom: "8px" } }, "Optional JavaScript. No-code assertions and captures cover most needs."),
                ...[
                    ["vars.get(\"name\")", "read a variable"],
                    ["vars.set(\"name\", value, \"runtime\")", "scope: runtime | environment | global"],
                    ["env.name", "active environment"],
                    ["request.method / url / headers / body", "pre: change before sending"],
                    ["response.status / headers / body / time", "post only"],
                    ["response.json()", "parsed JSON body"],
                    ["test(\"name\", () => { … })", "a named check, shown in Tests"],
                    ["expect(v).toBe(x) .toEqual .toContain\n  .toBeGreaterThan .toBeLessThan .toMatch\n  .toBeTruthy .toHaveProperty(\"a.b\")\n  .toHaveLength(n) .not.toBe(x)", "assertions"],
                    ["console.log(…)", "shown in the Console tab"]
                ].map(([code, note]) => h("div", { class: "cs-item" }, h("code", null, code), h("div", { class: "muted" }, note))),
                h("div", { class: "muted" }, "Scripts run with a 5 s limit and no file or network access."))));
    }

    // Settings
    function renderSettings() {
        const s = draft().settings;
        const app = App.effectiveSettings();
        const timeout = h("input", { type: "number", min: "0", step: "1000", value: s.timeoutMs ?? "", placeholder: `App default (${app.timeoutMs} ms)` });
        timeout.addEventListener("input", () => { s.timeoutMs = timeout.value === "" ? null : Math.max(0, Number(timeout.value)); changed(); });
        const tri = (key, onLabel, offLabel, appValue) => {
            const sel = select([{ value: "", label: `Use app setting (${appValue ? onLabel : offLabel})` }, { value: "true", label: onLabel }, { value: "false", label: offLabel }],
                s[key] === null || s[key] === undefined ? "" : String(s[key]));
            sel.addEventListener("change", () => { s[key] = sel.value === "" ? null : sel.value === "true"; changed(); });
            return sel;
        };
        tabBody.appendChild(h("div", { class: "stack", style: { maxWidth: "640px" } },
            h("div", { class: "form-grid two" },
                field("Timeout (ms)", timeout, "Empty uses the app setting. 0 means no timeout."),
                field("Redirects", tri("followRedirects", "Follow redirects", "Do not follow", app.followRedirects), "Up to 10 redirects are followed."),
                field("TLS certificates", tri("verifyTls", "Verify certificates", "Do not verify (self-signed OK)", app.verifyTls), "Turn verification off for test servers with self-signed certificates.")),
            h("div", { class: "hint" }, "Proxy, the default timeout and response size limit are in Settings.")));
    }

    // Docs
    function renderDocs() {
        tabBody.className = "req-tab-body fill";
        const ta = h("textarea", { class: "code-editor wrap", spellcheck: "true", placeholder: "Notes for this request: what it does, required data, expected results. Shared with the suite file." });
        ta.style.fontFamily = "var(--font)";
        ta.style.fontSize = "13px";
        ta.value = draft().description || "";
        ta.addEventListener("input", () => { draft().description = ta.value; changed(); });
        tabBody.appendChild(h("div", { class: "editor-area" }, ta));
    }

    // ------------------------------------------------------------ send / cancel
    async function send() {
        if (tab.sending) return;
        const d = draft();
        if (!composeUrl(d.url, d.params).trim()) { toast("Enter a URL first", "warn"); urlInput.focus(); return; }
        tab.sending = true;
        tab.sendSeq = (tab.sendSeq || 0) + 1;
        const seq = tab.sendSeq;
        updateSendBtn();
        response.render();
        try {
            const result = await api.call("request.send", {
                suiteId: tab.suiteId || null,
                requestId: tab.temp ? null : tab.itemId,
                request: deepClone(d),
                environmentId: App.activeEnvironmentId(tab.suiteId)
            });
            if (seq !== tab.sendSeq || destroyed) return;
            tab.result = result;
        } catch (err) {
            if (seq !== tab.sendSeq || destroyed) return;
            tab.result = { error: cleanError(err), failedToSend: true, startedAt: new Date().toISOString(), assertions: [], captures: [] };
        } finally {
            if (seq === tab.sendSeq && !destroyed) {
                clearTimeout(cancelTimer);
                tab.sending = false;
                updateSendBtn();
                response.render();
                updateTabs();
                if (currentTab === "assertions" || currentTab === "capture") renderTabBody();
                App.invalidateVars(tab.suiteId);
                App.renderStatusbar();
            }
        }
    }
    function cancel() {
        if (!tab.sending) return;
        api.call("request.cancel").catch(() => {});
        // if main does not answer quickly, stop waiting
        clearTimeout(cancelTimer);
        cancelTimer = setTimeout(() => {
            if (!tab.sending) return;
            tab.sendSeq++;
            tab.sending = false;
            tab.result = { error: "Request cancelled", cancelled: true, startedAt: new Date().toISOString(), assertions: [], captures: [] };
            updateSendBtn();
            response.render();
        }, 2500);
    }

    // ------------------------------------------------------------ cURL / code / more menu
    async function importCurl(text) {
        const parsed = await attempt(() => api.call("tools.parseCurl", text));
        if (!parsed) return;
        const d = draft();
        const req = normalizeDraft(parsed);
        for (const key of ["method", "url", "params", "headers", "body", "auth", "settings"]) d[key] = req[key];
        if (!d.name || d.name === "New Request") d.name = suggestName(d);
        changed();
        reload({ keepResult: true });
        toast("cURL command imported", "success", 2000);
    }

    async function showCode() {
        const r = await attempt(() => api.call("request.preview", { suiteId: tab.suiteId || null, requestId: tab.temp ? null : tab.itemId, request: deepClone(draft()), environmentId: App.activeEnvironmentId(tab.suiteId) }));
        if (!r) return;
        const snippets = r.snippets || {};
        const langs = [["curl", "cURL"], ["fetch", "JavaScript (fetch)"], ["python", "Python (requests)"], ["powershell", "PowerShell"]].filter(([k]) => snippets[k] || (k === "curl" && r.curl));
        let current = langs[0]?.[0] || "curl";
        const pre = h("pre", { class: "code-block" });
        const show = () => { pre.textContent = snippets[current] || (current === "curl" ? r.curl : "") || ""; };
        const strip = tabStrip(langs.map(([id, label]) => ({ id, label })), current, (id) => { current = id; show(); }, "small");
        show();
        const unresolved = r.prepared?.unresolved || [];
        modal({
            title: "Code for this request",
            size: "wide",
            body: h("div", { class: "code-tabs" }, strip.el,
                unresolved.length ? h("div", { class: "callout warn" }, icon("alert"), `Unknown variables left as written: ${unresolved.join(", ")}`) : null,
                pre,
                h("div", { class: "hint" }, "Variables are resolved with the active environment. OAuth 2.0 tokens are not fetched for this preview.")),
            buttons: [{ label: "Copy", icon: "copy", onClick: () => { copyText(pre.textContent, "code"); return false; } }, { label: "Close", class: "primary", value: null }]
        });
    }

    function moreMenu(at) {
        const s = suite();
        contextMenu(at, [
            { label: "Copy as cURL", icon: "terminal", onClick: async () => {
                const r = await attempt(() => api.call("request.preview", { suiteId: tab.suiteId || null, requestId: tab.temp ? null : tab.itemId, request: deepClone(draft()), environmentId: App.activeEnvironmentId(tab.suiteId) }));
                if (r && r.curl) copyText(r.curl, "cURL command");
            } },
            { label: "Code snippets…", icon: "code", onClick: showCode },
            "-",
            { label: tab.temp ? "Save to a suite…" : "Save as copy…", icon: "save", onClick: () => App.saveRequestAs(tab, deepClone(draft())) },
            !tab.temp ? { label: "Duplicate", icon: "copy", onClick: () => Sidebar.duplicate(tab.suiteId, tab.itemId) } : null,
            tab.dirty && !tab.temp ? { label: "Discard changes", icon: "undo", onClick: async () => {
                if (!(await confirmDialog("Discard changes", "Go back to the saved version of this request?", "Discard", true))) return;
                tab.draft = JSON.parse(tab.baseline);
                tab.dirty = false;
                App.requestChanged(tab);
                reload({ keepResult: true });
            } } : null,
            "-",
            !tab.temp && s ? { label: "Show in sidebar", icon: "search", onClick: () => Sidebar.reveal(tab.suiteId, tab.itemId) } : null,
            !tab.temp && s ? { label: "Run this request", icon: "runner", onClick: () => App.showRunner({ suiteId: tab.suiteId, itemIds: [tab.itemId] }) } : null,
            { label: App.state.ui.responseLayout === "horizontal" ? "Response below" : "Response on the right", icon: App.state.ui.responseLayout === "horizontal" ? "layoutRows" : "layoutCols", onClick: toggleLayout },
            !tab.temp && s ? "-" : null,
            !tab.temp && s ? { label: "Delete request", icon: "trash", danger: true, onClick: () => Sidebar.remove(tab.suiteId, tab.itemId) } : null
        ]);
    }

    // ------------------------------------------------------------ (re)load from tab.draft
    function reload({ keepResult = true } = {}) {
        if (!keepResult) tab.result = null;
        methodSel.value = draft().method;
        colorMethod();
        urlInput.value = urlText();
        urlField.refresh();
        refreshHeader();
        updateTabs();
        renderTabBody();
        renderPreview();
        response.render();
    }

    // ------------------------------------------------------------ app events
    unsubs.push(App.on("vars-invalidated", (p) => {
        if (p.suiteId && p.suiteId !== tab.suiteId) return;
        varsStale = true;
        if (App.activeTabId === tab.id) refreshVars();
    }));
    unsubs.push(App.on("suites-changed", (p) => {
        if (p && p.suiteId && p.suiteId !== tab.suiteId) return;
        refreshHeader();
        if (App.activeTabId === tab.id && (currentTab === "headers" || currentTab === "auth")) renderTabBody();
    }));
    unsubs.push(App.on("environment-changed", (p) => { if (p.suiteId === tab.suiteId) renderPreview(); }));
    unsubs.push(App.on("layout-changed", applyLayout));
    unsubs.push(App.on("settings-changed", () => { if (currentTab === "settings") renderTabBody(); }));

    applyLayout();
    reload();

    return {
        el,
        send,
        cancel,
        reload,
        refreshHeader,
        focusUrl() { urlInput.focus(); urlInput.select(); },
        onShow() { if (varsStale) refreshVars(); else renderPreview(); refreshHeader(); },
        onHide() { closeContextMenu(); },
        beforeSave() { /* edits are applied to the draft as they happen */ },
        addAssertion,
        addCapture,
        selectTab,
        destroy() {
            destroyed = true;
            clearTimeout(cancelTimer);
            unsubs.forEach((u) => u());
            response.destroy();
        }
    };
}

// ------------------------------------------------------------------ editor helpers (shared)

/** Tab / Shift+Tab indent, Enter keeps the indentation, closing bracket outdents. */
function editorKeys(e, ta) {
    if (e.key === "Tab" && !e.ctrlKey && !e.metaKey && !e.altKey) {
        if (document.querySelector(".ac-popup")) return;
        e.preventDefault();
        const { selectionStart: s, selectionEnd: en, value } = ta;
        const lineStart = value.lastIndexOf("\n", s - 1) + 1;
        if (s === en && !e.shiftKey) { ta.setRangeText("    ", s, en, "end"); }
        else {
            const block = value.slice(lineStart, en);
            const out = e.shiftKey ? block.replace(/^( {1,4}|\t)/gm, "") : block.replace(/^/gm, "    ");
            ta.setRangeText(out, lineStart, en, "select");
        }
        ta.dispatchEvent(new Event("input"));
    } else if (e.key === "Enter" && !e.shiftKey && !e.ctrlKey && !e.metaKey && !document.querySelector(".ac-popup")) {
        const { selectionStart: s, value } = ta;
        const lineStart = value.lastIndexOf("\n", s - 1) + 1;
        const indent = (value.slice(lineStart, s).match(/^[ \t]*/) || [""])[0];
        const prev = value.slice(0, s).trimEnd().slice(-1);
        const next = value.slice(s).trimStart().charAt(0);
        e.preventDefault();
        if ((prev === "{" || prev === "[") && (next === "}" || next === "]") && value.slice(s).match(/^\s*[}\]]/)) {
            ta.setRangeText(`\n${indent}    \n${indent}`, s, ta.selectionEnd, "start");
            ta.setSelectionRange(s + indent.length + 5, s + indent.length + 5);
        } else {
            const extra = prev === "{" || prev === "[" ? "    " : "";
            ta.setRangeText(`\n${indent}${extra}`, s, ta.selectionEnd, "end");
        }
        ta.dispatchEvent(new Event("input"));
    }
}

/**
 * Replaces {{vars}} so the text can be parsed as JSON. sameLength keeps character positions (for error
 * locations); otherwise unique tokens are used and restore() puts the variables back after formatting.
 */
function maskJsonVars(text, sameLength) {
    const tokens = [];
    let out = "";
    let inString = false;
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (inString) {
            if (c === "\\") { out += c + (text[i + 1] ?? ""); i++; continue; }
            if (c === "\"") inString = false;
        } else if (c === "\"") inString = true;
        if (c === "{" && text[i + 1] === "{") {
            const end = text.indexOf("}}", i + 2);
            if (end > 0 && !text.slice(i + 2, end).includes("{")) {
                const raw = text.slice(i, end + 2);
                if (sameLength) out += inString ? "x".repeat(raw.length) : "0" + " ".repeat(raw.length - 1);
                else {
                    const tok = `__ATV${tokens.length}__`;
                    tokens.push({ tok, raw, quoted: !inString });
                    out += inString ? tok : `"${tok}"`;
                }
                i = end + 1;
                continue;
            }
        }
        out += c;
    }
    return { text: out, restore: (s) => tokens.reduce((acc, t) => acc.split(t.quoted ? `"${t.tok}"` : t.tok).join(t.raw), s) };
}

function checkJson(text) {
    if (!String(text || "").trim()) return { ok: true };
    const masked = maskJsonVars(String(text), true).text;
    try {
        JSON.parse(masked);
        return { ok: true };
    } catch (err) {
        const m = /position (\d+)/.exec(err.message);
        let where = "";
        if (m) {
            const pos = Number(m[1]);
            const before = masked.slice(0, pos);
            const line = before.split("\n").length;
            const col = pos - before.lastIndexOf("\n");
            where = ` (line ${line}, column ${col})`;
        }
        const msg = err.message.replace(/ in JSON at position \d+.*$/, "").replace(/^JSON\.parse: /, "").replace(/\s*\(line \d+ column \d+\)$/, "");
        return { ok: false, message: `${msg}${where}` };
    }
}

function formatJson(text) {
    const m = maskJsonVars(String(text || ""), false);
    try {
        return { text: m.restore(JSON.stringify(JSON.parse(m.text), null, 4)) };
    } catch (err) {
        return { error: checkJson(text).message || err.message };
    }
}

/** Simple XML pretty-printer (keeps text nodes and comments). */
function formatXml(xml) {
    const text = String(xml || "").trim();
    if (!text) return text;
    const tokens = text.replace(/>\s+</g, "><").split(/(<[^>]+>)/).filter((t) => t.trim() !== "");
    let depth = 0;
    const lines = [];
    for (let i = 0; i < tokens.length; i++) {
        const t = tokens[i];
        if (/^<\//.test(t)) { depth = Math.max(0, depth - 1); lines.push("    ".repeat(depth) + t); }
        else if (/^<[a-zA-Z_][^>]*>$/.test(t) && !/\/>$/.test(t)) {
            // <a>text</a> on one line
            if (tokens[i + 1] && !tokens[i + 1].startsWith("<") && tokens[i + 2] && /^<\//.test(tokens[i + 2])) {
                lines.push("    ".repeat(depth) + t + tokens[i + 1] + tokens[i + 2]);
                i += 2;
            } else { lines.push("    ".repeat(depth) + t); depth++; }
        } else lines.push("    ".repeat(depth) + t.trim());
    }
    return lines.join("\n");
}

function looksJson(resp) {
    if (!resp) return false;
    return /json/i.test(resp.contentType || resp.headersMap?.["content-type"] || "");
}

function responseJson(resp) {
    if (!resp) return undefined;
    if (resp.json !== undefined) return resp.json;
    try { return JSON.parse(resp.bodyText); } catch (_) { return undefined; }
}

/** A JSON Schema describing a sample value (types + required keys), used by "Generate from last response". */
function schemaFromValue(v, depth = 0) {
    if (depth > 6) return {};
    if (v === null) return { type: "null" };
    if (Array.isArray(v)) return v.length ? { type: "array", items: schemaFromValue(v[0], depth + 1) } : { type: "array" };
    if (typeof v === "object") {
        const properties = {};
        for (const [k, x] of Object.entries(v)) properties[k] = schemaFromValue(x, depth + 1);
        return { type: "object", required: Object.keys(v), properties };
    }
    return { type: Number.isInteger(v) ? "integer" : typeof v };
}

/** Sensible default checks for a response (mirrors core suggestAssertions). */
function suggestAssertionsLocal(resp) {
    const out = [{ source: "status", operator: "equals", expected: String(resp.status) }];
    out.push({ source: "responseTime", operator: "lt", expected: "2000" });
    const ct = resp.contentType || resp.headersMap?.["content-type"] || "";
    if (/json/i.test(ct)) out.push({ source: "contentType", operator: "contains", expected: "json" });
    const json = responseJson(resp);
    if (json && typeof json === "object") {
        if (Array.isArray(json)) out.push({ source: "jsonpath", property: "$", operator: "isType", expected: "array" });
        else for (const k of Object.keys(json).slice(0, 5)) out.push({ source: "jsonpath", property: `$${JsonView.jsonPathKey(k)}`, operator: "exists", expected: "" });
    }
    return out;
}
