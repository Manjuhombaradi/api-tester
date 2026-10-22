"use strict";
/*
 * Runner view (main area): pick requests of a suite (checkbox tree), environment, iterations, data file, delay,
 * stop on failure -> Run / Stop with live progress, expandable results, summary, report export and the
 * equivalent command line for CI.
 * Runner.mount(container, { suiteId, itemIds }) -> unmount function.
 *
 * The run itself lives in main; the progress is kept here at module level, so closing and reopening the view
 * while a run is going shows it again.
 */
(function () {
    "use strict";
    const VH = window.ViewHelpers;
    const { clone, call, walk, requestsUnder, plural, safeIcon, shellQuote, safeFileName, add } = VH;

    const MAX_ROWS = 1000; // result rows rendered at once (reports contain everything)
    const BODY_PREVIEW = 4000; // characters of a response body shown in the details
    // below this runner width the setup column hides itself when a run starts, so the results get the room
    const NARROW_RUNNER_PX = 900;

    // ------------------------------------------------------------ run session (module level)
    const session = {
        runId: null,
        starting: false,
        running: false,
        suiteId: null,
        suiteName: "",
        iterations: 1,
        total: 0,
        results: [],
        current: null, // { name, iteration } of the request being sent
        result: null, // RunResult after run-done
        startedAt: 0,
        finishedAt: 0,
        buffered: [] // events that arrived before runner.start returned the run id
    };
    const views = new Set(); // mounted views, notified on every event
    let listening = false;
    const optionsBySuite = new Map(); // per suite: { checked: Set, environmentId, iterations, delayMs, stopOnFailure, data }

    function ensureListener() {
        if (listening) return;
        listening = true;
        App.on("runner-event", (payload) => {
            if (!payload || !payload.event) return;
            if (session.starting && !session.runId) { session.buffered.push(payload); return; }
            if (payload.runId !== session.runId) return;
            applyEvent(payload.event);
        });
    }

    /** Keeps the renderer copy small: the full results arrive again with run-done. */
    function slim(result) {
        if (!result || !result.response) return result;
        const r = { ...result, response: { ...result.response } };
        delete r.response.bodyBase64;
        if (typeof r.response.bodyText === "string" && r.response.bodyText.length > BODY_PREVIEW) {
            r.response.bodyText = r.response.bodyText.slice(0, BODY_PREVIEW);
            r.response.bodyPreviewCut = true;
        }
        return r;
    }

    function applyEvent(event) {
        switch (event.type) {
            case "run-start":
                session.total = Number(event.total) || 0;
                if (Number(event.iterations) > 0) session.iterations = Number(event.iterations);
                break;
            case "request-start":
                session.current = { name: event.name, iteration: event.iteration, index: event.index };
                break;
            case "request-done":
                if (event.result) session.results.push(slim(event.result));
                break;
            case "run-done":
                session.running = false;
                session.current = null;
                session.finishedAt = Date.now();
                session.result = event.result || null;
                if (event.result && Array.isArray(event.result.results)) session.results = event.result.results.map(slim);
                break;
            default:
                return;
        }
        for (const v of views) v.onEvent(event);
    }

    async function startRun(config) {
        ensureListener();
        Object.assign(session, {
            runId: null, starting: true, running: true, suiteId: config.suiteId, suiteName: config.suiteName,
            iterations: config.plannedIterations || 1, total: config.expectedTotal || 0, results: [], current: null, result: null, startedAt: Date.now(), finishedAt: 0, buffered: []
        });
        for (const v of views) v.onEvent({ type: "starting" });
        try {
            const r = await call("runner.start", {
                suiteId: config.suiteId,
                itemIds: config.itemIds,
                environmentId: config.environmentId,
                iterations: config.iterations,
                dataText: config.data ? config.data.text : null,
                dataFileName: config.data ? config.data.fileName : null,
                delayMs: config.delayMs,
                stopOnFailure: config.stopOnFailure
            });
            session.runId = r && r.runId;
            session.starting = false;
            const buffered = session.buffered;
            session.buffered = [];
            for (const p of buffered) if (p.runId === session.runId) applyEvent(p.event);
        } catch (err) {
            session.starting = false;
            session.running = false;
            session.finishedAt = Date.now();
            session.buffered = [];
            toast(`The run could not start: ${err?.message || err}`, "error");
            for (const v of views) v.onEvent({ type: "start-failed" });
        }
    }

    // ------------------------------------------------------------ small helpers

    const iterationNumber = (it) => Number(it) || 1; // the core runner counts iterations from 1
    const resultState = (r) => (r.error ? "error" : r.passed ? "pass" : "fail");
    const realAssertions = (r) => (r.assertions || []).filter((a) => !a.skipped);
    const responseTime = (r) => r.response?.timings?.total ?? r.durationMs ?? null;

    function liveStats(results) {
        const s = { requests: results.length, passed: 0, failed: 0, errors: 0, assertions: 0, assertionsPassed: 0, assertionsFailed: 0, avgResponseMs: 0 };
        let sum = 0, counted = 0;
        for (const r of results) {
            if (r.error) s.errors++;
            else if (r.passed) s.passed++;
            else s.failed++;
            for (const a of realAssertions(r)) { s.assertions++; if (a.passed) s.assertionsPassed++; else s.assertionsFailed++; }
            const t = responseTime(r);
            if (t != null && !r.error) { sum += t; counted++; }
        }
        s.avgResponseMs = counted ? Math.round(sum / counted) : 0;
        return s;
    }

    /** Minimal CSV / JSON reader for the data file preview (main parses the file again for the run). */
    function previewData(text, fileName) {
        const src = String(text || "").replace(/^\uFEFF/, "");
        const trimmed = src.trim();
        if (!trimmed) throw new Error("The file is empty");
        if (/\.json$/i.test(fileName || "") || trimmed.startsWith("[")) {
            let data;
            try { data = JSON.parse(trimmed); } catch (err) { throw new Error(`Not valid JSON: ${err.message}`); }
            if (!Array.isArray(data)) throw new Error("A JSON data file must be an array of objects, e.g. [{\"name\": \"Ann\"}]");
            const columns = [];
            for (const row of data) for (const k of Object.keys(row && typeof row === "object" ? row : {})) if (!columns.includes(k)) columns.push(k);
            return { columns, rows: data.slice(0, 5).map((r) => columns.map((c) => (r && r[c] !== undefined ? (typeof r[c] === "object" ? JSON.stringify(r[c]) : String(r[c])) : ""))), total: data.length };
        }
        const firstLine = src.split(/\r?\n/, 1)[0];
        const count = (ch) => firstLine.split(ch).length - 1;
        const delimiter = count(";") > count(",") ? ";" : count("\t") > count(",") ? "\t" : ",";
        const records = [];
        let row = [], cell = "", quoted = false;
        for (let i = 0; i < src.length; i++) {
            const c = src[i];
            if (quoted) {
                if (c === "\"" && src[i + 1] === "\"") { cell += "\""; i++; } else if (c === "\"") quoted = false; else cell += c;
            } else if (c === "\"" && cell === "") quoted = true;
            else if (c === delimiter) { row.push(cell); cell = ""; }
            else if (c === "\n" || c === "\r") {
                if (c === "\r" && src[i + 1] === "\n") i++;
                row.push(cell); cell = "";
                if (row.some((x) => x !== "")) records.push(row);
                row = [];
            } else cell += c;
        }
        row.push(cell);
        if (row.some((x) => x !== "")) records.push(row);
        if (!records.length) throw new Error("The file is empty");
        const columns = records[0].map((c) => c.trim());
        return { columns, rows: records.slice(1, 6), total: records.length - 1 };
    }

    const isTypingIn = (el) => el.contains(document.activeElement) && /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName) && document.activeElement.type !== "checkbox";

    function iterationsFor(opts) {
        const n = Math.max(1, Math.min(10000, Math.floor(Number(opts.iterations) || 1)));
        return opts.data ? Math.max(n, opts.data.rows || 0) : n;
    }

    /** Variable key -> environment variable name for the command line, e.g. clientSecret -> CLIENT_SECRET. */
    function envVarName(key) {
        const name = String(key).replace(/([a-z0-9])([A-Z])/g, "$1_$2").replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "").toUpperCase();
        return !name || /^\d/.test(name) ? `VAR_${name}` : name;
    }

    /** `--var key=<environment variable>` for the shell the command is shown for (cmd.exe on Windows). */
    function secretVarArg(key, envName, platform) {
        if (platform === "win32") return `"${String(key).replace(/"/g, "\"\"")}=%${envName}%"`;
        return `${shellQuote(key, platform)}="$${envName}"`;
    }

    // ------------------------------------------------------------ the view

    function mount(container, { suiteId, itemIds } = {}) {
        ensureListener();
        const suites = () => App.state.suites || [];
        let currentSuiteId = (suiteId && App.getSuite(suiteId) ? suiteId : null)
            || (session.running && App.getSuite(session.suiteId) ? session.suiteId : null)
            || App.activeSuiteId() || suites()[0]?.id || null;
        let disposed = false;
        let filter = "all";
        let renderedCount = 0;
        let savedReport = null; // { path, format }

        const root = h("div", { class: "rn" });
        container.appendChild(root);

        // ---------------------------------------------------------- options per suite
        // blank requests just created with Ctrl+N and never saved are not part of a run (App.untouchedNewRequestIds)
        const pendingNew = () => (App.untouchedNewRequestIds ? App.untouchedNewRequestIds(currentSuiteId) : new Set());
        const runnableUnder = (items) => { const skip = pendingNew(); return requestsUnder(items).filter((r) => !skip.has(r.id)); };
        const allRequestIds = (suite) => runnableUnder(suite?.items).map((r) => r.id);
        function optionsFor(sid, ids) {
            const suite = App.getSuite(sid);
            let o = optionsBySuite.get(sid);
            if (!o) {
                // followsActive: the environment follows the top bar selection until the user picks one here
                o = { checked: new Set(allRequestIds(suite)), environmentId: App.activeEnvironmentId(sid) || null, followsActive: true, iterations: 1, delayMs: 0, stopOnFailure: false, data: null };
                optionsBySuite.set(sid, o);
            }
            // ids: [] or none = keep the last selection; [suiteId] = whole suite; else these folders / requests
            if (ids && ids.includes(sid)) {
                o.checked = new Set(allRequestIds(suite));
            } else if (ids && ids.length && suite) {
                const wanted = new Set(ids);
                const picked = new Set();
                walk(suite.items, (item, parents) => {
                    if (item.type === "request" && (wanted.has(item.id) || parents.some((p) => wanted.has(p.id)))) picked.add(item.id);
                });
                if (picked.size) o.checked = picked;
            }
            // drop ids of deleted requests; environment that no longer exists -> active one
            const existing = new Set(allRequestIds(suite));
            o.checked = new Set([...o.checked].filter((id) => existing.has(id)));
            if (o.environmentId && !(suite?.environments || []).some((e) => e.id === o.environmentId)) o.environmentId = App.activeEnvironmentId(sid) || null;
            return o;
        }
        let opts = currentSuiteId ? optionsFor(currentSuiteId, itemIds) : null;

        // ---------------------------------------------------------- header
        const closeBtn = h("button", { class: "btn ghost", title: "Back to the requests" }, safeIcon("x"), "Close runner");
        closeBtn.addEventListener("click", () => App.closeRunner());
        // the setup column can be hidden to give the results the whole width (it hides itself on narrow windows
        // when a run starts); Run / Stop are then in the header
        let setupHidden = false;
        const setupToggle = h("button", { class: "btn ghost rn-setup-toggle", type: "button" });
        const headRunBtn = h("button", { class: "btn primary rn-head-run", type: "button", title: "Run again with the same setup" }, safeIcon("play"), "Run");
        const headStopBtn = h("button", { class: "btn danger rn-head-run hidden", type: "button" }, safeIcon("stop"), "Stop");
        const setSetupHidden = (hidden) => {
            setupHidden = hidden;
            root.classList.toggle("setup-hidden", hidden);
            clear(setupToggle);
            add(setupToggle, safeIcon("settings"), hidden ? "Show setup" : "Hide setup");
            setupToggle.title = hidden ? "Show the requests, environment and other run options" : "Hide the run options to give the results more room";
        };
        setupToggle.addEventListener("click", () => setSetupHidden(!setupHidden));
        root.appendChild(h("div", { class: "rn-head" },
            h("div", { class: "rn-title" }, safeIcon("runner"), h("h2", null, "Runner"),
                h("span", { class: "muted small rn-subtitle" }, "Run many requests in a row, check every assertion, export a report.")),
            h("span", { class: "spacer" }), headRunBtn, headStopBtn, setupToggle, closeBtn));
        setSetupHidden(false);

        const configPane = h("div", { class: "rn-config" });
        const resultsPane = h("div", { class: "rn-results" });
        root.appendChild(h("div", { class: "rn-body" }, configPane, resultsPane));

        // ---------------------------------------------------------- config pane
        const treeBox = h("div", { class: "rn-tree" });
        const selectionInfo = h("span", { class: "muted small" });
        const dataBox = h("div", { class: "rn-data" });
        const cliBox = h("div", { class: "rn-cli" });
        const runBtn = h("button", { class: "btn primary rn-run" }, safeIcon("play"), "Run");
        const stopBtn = h("button", { class: "btn danger rn-run hidden" }, safeIcon("stop"), "Stop");
        const planInfo = h("div", { class: "hint rn-plan" });

        function renderConfig() {
            clear(configPane);
            const suite = App.getSuite(currentSuiteId);
            if (!suite) {
                setSetupHidden(false); // the empty state below is the only thing to see
                configPane.appendChild(h("div", { class: "empty" },
                    h("div", { class: "big" }, safeIcon("runner")),
                    h("div", null, "No suite to run yet."),
                    h("div", { class: "hint" }, "Create a suite in the sidebar, import one, or try the sample suite."),
                    h("div", { class: "row", style: { justifyContent: "center", marginTop: "10px" } },
                        (() => { const b = h("button", { class: "btn" }, safeIcon("import"), "Import…"); b.addEventListener("click", () => ImportExport.openImport()); return b; })(),
                        (() => { const b = h("button", { class: "btn" }, "Welcome screen"); b.addEventListener("click", () => Welcome.show()); return b; })())));
                return;
            }

            const suiteSel = select(suites().map((s) => ({ value: s.id, label: s.name })), currentSuiteId);
            suiteSel.addEventListener("change", () => {
                currentSuiteId = suiteSel.value;
                opts = optionsFor(currentSuiteId);
                renderConfig();
            });

            const envs = suite.environments || [];
            const envSel = select([{ value: "", label: "No environment" }, ...envs.map((e) => ({ value: e.id, label: e.name }))], opts.environmentId || "");
            envSel.addEventListener("change", () => { opts.environmentId = envSel.value || null; opts.followsActive = false; renderCli(); });

            const iterations = h("input", { type: "number", min: 1, max: 10000, step: 1, value: opts.iterations });
            iterations.addEventListener("input", () => { opts.iterations = Math.max(1, Math.floor(Number(iterations.value) || 1)); renderPlan(); renderCli(); });
            const delay = h("input", { type: "number", min: 0, max: 600000, step: 50, value: opts.delayMs });
            delay.addEventListener("input", () => { opts.delayMs = Math.max(0, Math.floor(Number(delay.value) || 0)); renderCli(); });
            const stop = checkbox("Stop on the first failure", opts.stopOnFailure, (v) => { opts.stopOnFailure = v; renderCli(); });

            const all = h("button", { class: "btn ghost small", type: "button" }, "All");
            all.addEventListener("click", () => { opts.checked = new Set(allRequestIds(suite)); renderTree(); });
            const none = h("button", { class: "btn ghost small", type: "button" }, "None");
            none.addEventListener("click", () => { opts.checked = new Set(); renderTree(); });

            add(configPane, 
                field("Suite", suiteSel),
                h("div", { class: "field" },
                    h("div", { class: "rn-tree-head" }, h("label", null, "Requests"), selectionInfo, h("span", { class: "spacer" }), all, none),
                    treeBox),
                field("Environment", envSel, envs.length ? null : "This suite has no environments."),
                h("div", { class: "form-grid two" },
                    field("Iterations", iterations, "Repeat the whole selection"),
                    field("Delay (ms)", delay, "Pause between requests")),
                h("div", { class: "field" }, h("label", null, "Data file (optional)"), dataBox),
                stop,
                // sticks to the bottom of the column while the options above it scroll, so Run is always in view
                h("div", { class: "rn-config-foot" }, h("div", { class: "rn-actions" }, runBtn, stopBtn), planInfo),
                h("div", { class: "hint" }, "The runner uses the saved suite. Save open requests first (", h("kbd", null, App.state.info?.platform === "darwin" ? "⌘S" : "Ctrl+S"), ")."),
                cliBox);
            renderTree();
            renderData();
            renderButtons();
        }

        // checkbox tree of folders and requests
        const collapsed = new Set();
        function renderTree() {
            const suite = App.getSuite(currentSuiteId);
            clear(treeBox);
            if (!suite) return;
            const total = allRequestIds(suite).length;
            if (!total) {
                treeBox.appendChild(h("div", { class: "hint rn-tree-empty" }, "This suite has no requests yet."));
            }
            const setChecked = (ids, on) => { for (const id of ids) { if (on) opts.checked.add(id); else opts.checked.delete(id); } renderTree(); };
            const build = (items, depth) => {
                const out = [];
                for (const item of items || []) {
                    if (item.type === "folder") {
                        const ids = runnableUnder(item.items).map((r) => r.id);
                        const on = ids.filter((id) => opts.checked.has(id)).length;
                        const box = h("input", { type: "checkbox", checked: ids.length > 0 && on === ids.length, disabled: !ids.length });
                        box.indeterminate = on > 0 && on < ids.length;
                        box.addEventListener("change", () => setChecked(ids, on < ids.length));
                        const isCollapsed = collapsed.has(item.id);
                        const toggle = h("button", { class: "rn-tree-toggle", type: "button", title: isCollapsed ? "Expand" : "Collapse" }, safeIcon(isCollapsed ? "chevronRight" : "chevronDown"));
                        toggle.addEventListener("click", () => { if (isCollapsed) collapsed.delete(item.id); else collapsed.add(item.id); renderTree(); });
                        out.push(h("div", { class: "rn-tree-row folder", style: { paddingLeft: `${depth * 16 + 2}px` } },
                            toggle, h("label", { class: "rn-tree-label" }, box, safeIcon("folder"), h("span", { class: "ellipsis" }, item.name), h("span", { class: "muted small" }, String(ids.length)))));
                        if (!isCollapsed) out.push(...build(item.items, depth + 1));
                    } else if (!pendingNew().has(item.id)) {
                        const box = h("input", { type: "checkbox", checked: opts.checked.has(item.id) });
                        box.addEventListener("change", () => setChecked([item.id], box.checked));
                        out.push(h("div", { class: "rn-tree-row", style: { paddingLeft: `${depth * 16 + 20}px` } },
                            h("label", { class: "rn-tree-label" }, box, methodBadge(item.method), h("span", { class: "ellipsis", title: item.url }, item.name))));
                    }
                }
                return out;
            };
            add(treeBox, ...build(suite.items, 0));
            selectionInfo.textContent = `${opts.checked.size} of ${total} selected`;
            renderPlan();
            renderCli();
            renderButtons();
        }

        function renderPlan() {
            if (!opts) return;
            const n = opts.checked.size;
            const it = iterationsFor(opts);
            planInfo.textContent = n ? `${plural(n, "request")} × ${plural(it, "iteration")} = ${plural(n * it, "request")} to send.` : "Select at least one request.";
        }

        // data file
        async function useDataFile(load) {
            try {
                const info = await load();
                if (!info) return;
                const preview = previewData(info.text, info.fileName);
                opts.data = {
                    path: info.path || null, fileName: info.fileName, text: info.text,
                    rows: Number.isFinite(info.rows) ? info.rows : preview.total,
                    columns: Array.isArray(info.columns) && info.columns.length ? info.columns : preview.columns,
                    preview, error: null
                };
            } catch (err) {
                opts.data = { error: err?.message || String(err) };
            }
            renderData();
            renderPlan();
            renderCli();
            renderButtons();
        }
        function renderData() {
            clear(dataBox);
            const choose = h("button", { class: "btn small", type: "button" }, safeIcon("file"), opts.data && !opts.data.error ? "Change…" : "Choose file…");
            choose.addEventListener("click", () => useDataFile(async () => {
                const path = await call("files.pickFile", { title: "Choose a data file", filters: [{ name: "Data files (CSV, JSON)", extensions: ["csv", "json", "txt", "tsv"] }] });
                if (!path) return null;
                const r = await call("files.readDataFile", path);
                return { ...r, path };
            }));
            const remove = h("button", { class: "btn small ghost", type: "button" }, safeIcon("x"), "Remove");
            remove.addEventListener("click", () => { opts.data = null; renderData(); renderPlan(); renderCli(); renderButtons(); });

            const d = opts.data;
            dataBox.classList.toggle("has-data", !!(d && !d.error));
            if (!d) {
                add(dataBox, h("div", { class: "rn-data-row" }, choose, h("span", { class: "hint" }, "or drop a CSV / JSON file here")),
                    h("div", { class: "hint" }, "Each row is one iteration; columns become variables, e.g. ", h("code", null, "{{email}}"), "."));
                return;
            }
            if (d.error) {
                add(dataBox, h("div", { class: "rn-data-row" }, choose, remove), h("div", { class: "callout bad" }, d.error));
                return;
            }
            const p = d.preview;
            add(dataBox, 
                h("div", { class: "rn-data-row" }, safeIcon("file"), h("b", { class: "ellipsis", title: d.path || d.fileName }, d.fileName), h("span", { class: "spacer" }), choose, remove),
                h("div", { class: "hint" }, `${plural(d.rows, "row")} · columns: `, d.columns.map((c, i) => [i ? " " : "", h("code", null, `{{${c}}}`)])),
                p.rows.length ? h("div", { class: "table-wrap rn-data-table" }, h("table", null,
                    h("thead", null, h("tr", null, p.columns.map((c) => h("th", null, c)))),
                    h("tbody", null, p.rows.map((r) => h("tr", null, p.columns.map((c, i) => h("td", { class: "mono" }, String(r[i] ?? "").slice(0, 60)))))))) : null,
                d.rows > p.rows.length ? h("div", { class: "hint" }, `… and ${plural(d.rows - p.rows.length, "more row")}`) : null);
        }
        // drop a data file onto the box
        dataBox.addEventListener("dragover", (e) => { e.preventDefault(); dataBox.classList.add("drag"); });
        dataBox.addEventListener("dragleave", () => dataBox.classList.remove("drag"));
        dataBox.addEventListener("drop", (e) => {
            e.preventDefault();
            e.stopPropagation();
            dataBox.classList.remove("drag");
            const file = e.dataTransfer?.files?.[0];
            if (!file) return;
            if (file.size > 20 * 1024 * 1024) { toast("Data files up to 20 MB are supported", "error"); return; }
            useDataFile(async () => ({ fileName: file.name, text: await file.text(), path: null }));
        });

        // equivalent command line: whole folders where everything below is selected, single requests otherwise
        function cliSelection(suite) {
            if (opts.checked.size === allRequestIds(suite).length) return [];
            const picked = [];
            const visit = (items) => {
                for (const item of items || []) {
                    if (item.type === "folder") {
                        const ids = requestsUnder(item.items).map((r) => r.id);
                        if (ids.length && ids.every((id) => opts.checked.has(id))) picked.push(item);
                        else visit(item.items);
                    } else if (opts.checked.has(item.id)) picked.push(item);
                }
            };
            visit(suite.items);
            return picked;
        }
        /**
         * Secret variables with a value that the command needs (exported files leave these values empty): the
         * environment the command uses, folders above the selected requests and the suite, in that precedence.
         * A key is only listed when the definition that wins is a secret, so --var never replaces a plain value.
         */
        function cliSecrets(suite, env) {
            const keys = [];
            const seen = new Set();
            const collect = (vars) => {
                for (const v of vars || []) {
                    if (v.enabled === false || !v.key || seen.has(v.key)) continue;
                    seen.add(v.key);
                    if (v.secret && v.value) keys.push(v.key);
                }
            };
            collect(env?.variables);
            const folders = new Set(); // innermost first
            const requests = [];
            walk(suite.items, (item, parents) => {
                if (item.type !== "request" || !opts.checked.has(item.id)) return;
                requests.push(item);
                for (const p of [...parents].reverse()) folders.add(p);
            });
            for (const folder of folders) collect(folder.variables);
            collect(suite.variables);
            if (!keys.length) return [];
            // only secrets the selected requests use: {{key}} anywhere they inherit from (variable values included,
            // for nested references), or the key in quotes in a script, e.g. vars.get("key")
            const refs = JSON.stringify([
                requests.map(({ scripts, ...rest }) => rest),
                [...folders].map((f) => [f.auth, f.headers, f.variables]),
                [suite.auth, suite.headers, suite.variables, env?.variables]
            ]);
            const code = requests.map((r) => `${r.scripts?.pre || ""}\n${r.scripts?.post || ""}`).join("\n");
            const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
            const isUsed = (key) => new RegExp(`\\{\\{\\s*${esc(key)}\\s*\\}\\}`).test(refs) || new RegExp(`["'\`]${esc(key)}["'\`]`).test(code);
            const used = new Set();
            return keys.filter(isUsed).map((key) => {
                let name = envVarName(key);
                for (let i = 2; used.has(name); i++) name = `${envVarName(key)}_${i}`;
                used.add(name);
                return { key, envName: name };
            });
        }
        function cliCommand() {
            const suite = App.getSuite(currentSuiteId);
            const info = App.state.info || {};
            const platform = info.platform;
            const q = (v) => shellQuote(v, platform);
            const parts = [info.cliCommand || "api-tester", "run", q(safeFileName(suite.name))];
            const envs = suite.environments || [];
            const chosen = envs.find((e) => e.id === opts.environmentId) || null;
            // the command line has no "no environment" option: without --env it uses the suite's active environment
            const activeInFile = chosen ? null : envs.find((e) => e.id === suite.activeEnvironmentId) || null;
            const env = chosen || activeInFile;
            if (chosen) parts.push("--env", q(chosen.name && envs.filter((e) => e.name === chosen.name).length === 1 ? chosen.name : chosen.id));
            // --folder takes a folder or request name, its path ("Folder/Sub") or its id; the shortest unique one is used
            const count = {};
            const paths = new Map();
            walk(suite.items, (i, parents) => {
                const p = [...parents.map((x) => x.name), i.name].join("/");
                paths.set(i.id, p);
                count[`n:${i.name}`] = (count[`n:${i.name}`] || 0) + 1;
                count[`p:${p}`] = (count[`p:${p}`] || 0) + 1;
            });
            for (const item of cliSelection(suite)) {
                const p = paths.get(item.id);
                parts.push("--folder", q(item.name && count[`n:${item.name}`] === 1 ? item.name : p && count[`p:${p}`] === 1 && !count[`n:${p}`] ? p : item.id));
            }
            if (Number(opts.iterations) > 1) parts.push("--iterations", String(opts.iterations));
            if (opts.data && !opts.data.error) parts.push("--data", q(opts.data.path || opts.data.fileName));
            if (opts.delayMs > 0) parts.push("--delay", String(opts.delayMs));
            if (opts.stopOnFailure) parts.push("--bail");
            // secret values are left out of exported files: the command takes them from environment variables
            const secrets = cliSecrets(suite, env);
            for (const s of secrets) parts.push("--var", secretVarArg(s.key, s.envName, platform));
            parts.push("--reporter", "cli,junit,html", "--out", "reports");
            return { text: parts.join(" "), nothing: !opts.checked.size, secrets, activeInFile };
        }
        function renderCli() {
            clear(cliBox);
            const suite = App.getSuite(currentSuiteId);
            if (!suite || !opts) return;
            const cmd = cliCommand();
            const copy = h("button", { class: "btn small", type: "button" }, safeIcon("copy"), "Copy");
            copy.addEventListener("click", () => copyText(cmd.text));
            const exp = h("button", { class: "btn small ghost", type: "button" }, safeIcon("export"), "Export suite…");
            exp.addEventListener("click", () => ImportExport.openExport(currentSuiteId));
            const names = cmd.secrets.map((s) => s.envName);
            const list = (items) => items.map((n, i) => [i ? (i === items.length - 1 ? " and " : ", ") : "", h("code", null, n)]);
            add(cliBox,
                h("div", { class: "rn-cli-head" }, safeIcon("code"), h("b", null, "Same run from the command line (CI)"), h("span", { class: "spacer" }), copy),
                h("pre", { class: "rn-cli-cmd" }, cmd.text),
                (App.state.info || {}).isPortable ? h("div", { class: "callout warn rn-cli-note" }, safeIcon("code"),
                    h("span", null, "The portable app has no command line version. Use the installer (bin\\api-tester.cmd), Node.js or Docker for this command.")) : null,
                cmd.activeInFile ? h("div", { class: "callout warn rn-cli-note" }, safeIcon("env"),
                    h("span", null, "The command line has no “No environment” option: it uses the suite's active environment (",
                        h("b", null, cmd.activeInFile.name), "). To run without one, export the suite without environments.")) : null,
                names.length ? h("div", { class: "callout rn-cli-note" }, safeIcon("lock"),
                    h("span", null, "Secret values are left out of exported files, so the command reads them from environment variables. Set ",
                        list(names), " first (in CI: as ", names.length === 1 ? "a secret" : "secrets", ").")) : null,
                h("div", { class: "hint" }, "Export the suite to ", h("code", null, safeFileName(suite.name)), " first and run the command in its folder. Exit code 0 = all passed, 1 = failures. ", exp));
        }

        function renderButtons() {
            const busy = session.running || session.starting;
            const cannotRun = !opts || !opts.checked.size || !!(opts.data && opts.data.error) || !App.getSuite(currentSuiteId);
            for (const b of [runBtn, headRunBtn]) { b.classList.toggle("hidden", busy); b.disabled = cannotRun; }
            for (const b of [stopBtn, headStopBtn]) { b.classList.toggle("hidden", !busy); b.disabled = !session.runId; }
        }

        function run() {
            const suite = App.getSuite(currentSuiteId);
            if (!suite || !opts || !opts.checked.size || session.running || session.starting) return;
            const total = allRequestIds(suite).length;
            // everything selected -> [] (whole suite, also picks up requests added later)
            // ([] would also include the blank new requests that are left out above)
            const itemIds = opts.checked.size === total && !pendingNew().size ? [] : allRequestIds(suite).filter((id) => opts.checked.has(id));
            savedReport = null;
            expanded.clear();
            // narrow runner: hide the setup so the result rows have room (the header has Show setup / Run / Stop)
            if (root.clientWidth > 0 && root.clientWidth < NARROW_RUNNER_PX) setSetupHidden(true);
            startRun({
                suiteId: currentSuiteId,
                suiteName: suite.name,
                itemIds,
                environmentId: opts.environmentId || null,
                iterations: Math.max(1, Math.floor(Number(opts.iterations) || 1)),
                data: opts.data && !opts.data.error ? opts.data : null,
                delayMs: opts.delayMs || 0,
                stopOnFailure: !!opts.stopOnFailure,
                plannedIterations: iterationsFor(opts),
                expectedTotal: opts.checked.size * iterationsFor(opts)
            });
        }
        function stopRun() {
            if (!session.runId) return;
            stopBtn.disabled = true;
            headStopBtn.disabled = true;
            attempt(() => call("runner.stop", session.runId));
        }
        runBtn.addEventListener("click", run);
        headRunBtn.addEventListener("click", run);
        stopBtn.addEventListener("click", stopRun);
        headStopBtn.addEventListener("click", stopRun);

        // ---------------------------------------------------------- results pane
        const progressTitle = h("div", { class: "rn-progress-title" });
        const progressBar = h("div", { class: "rn-bar-fill" });
        const progressText = h("div", { class: "rn-progress-text muted small" });
        const statsBox = h("div", { class: "rn-stats" });
        const toolbar = h("div", { class: "rn-toolbar" });
        const list = h("div", { class: "rn-list" });
        const moreBox = h("div", { class: "rn-more" });
        add(resultsPane, 
            h("div", { class: "rn-progress" }, progressTitle, h("div", { class: "rn-bar" }, progressBar), progressText),
            statsBox, toolbar, list, moreBox);

        const expanded = new Set(); // result indexes with open details

        function renderProgress() {
            const done = session.results.length;
            const total = Math.max(session.total, done);
            const busy = session.running || session.starting;
            const stats = session.result?.stats || liveStats(session.results);
            const failedAny = stats.failed + stats.errors > 0;
            let title;
            if (!session.startedAt) title = h("span", { class: "muted" }, "Pick requests on the left and press Run.");
            else if (busy) title = h("span", { class: "rn-running" }, spinner(), session.current ? ["Running ", h("b", null, session.current.name), runIterations() > 1 ? ` (iteration ${iterationNumber(session.current.iteration)} of ${runIterations()})` : ""] : "Starting…");
            else if (!session.result) title = h("span", { class: "bad-text" }, "The run did not start.");
            else if (session.result.error) title = h("span", { class: "bad-text" }, safeIcon("x"), ` The run failed: ${session.result.error}`);
            else if (session.result.stopped) title = h("span", { class: "warn-text" }, safeIcon("stop"), " Stopped after ", plural(done, "request"));
            else title = failedAny ? h("span", { class: "bad-text" }, safeIcon("x"), ` ${plural(stats.failed + stats.errors, "request")} failed`) : h("span", { class: "good-text" }, safeIcon("check"), " All requests passed");
            add(clear(progressTitle), title, session.suiteName ? h("span", { class: "muted small rn-suite-name" }, session.suiteName, session.result?.environmentName ? ` · ${session.result.environmentName}` : "") : null);
            progressBar.style.width = total ? `${Math.round((done / total) * 100)}%` : busy ? "3%" : "0%";
            progressBar.className = `rn-bar-fill ${failedAny ? "has-failures" : ""} ${busy ? "busy" : ""}`;
            const elapsed = session.startedAt ? ((session.finishedAt || Date.now()) - session.startedAt) : 0;
            progressText.textContent = session.startedAt ? `${done} / ${total || "?"} · ${fmtMs(session.result?.durationMs ?? elapsed)}` : "";
        }
        const runIterations = () => session.result?.iterations || session.iterations || 1;

        function renderStats() {
            clear(statsBox);
            if (!session.startedAt) return;
            const s = session.result?.stats || liveStats(session.results);
            const stat = (label, value, cls = "") => h("div", { class: `rn-stat ${cls}`, title: `${label}: ${value}` }, h("div", { class: "rn-stat-value" }, String(value)), h("div", { class: "rn-stat-label" }, label));
            add(statsBox, 
                stat("Requests", s.requests),
                stat("Passed", s.passed, s.passed ? "good" : ""),
                stat("Failed", s.failed, s.failed ? "bad" : ""),
                stat("Errors", s.errors, s.errors ? "bad" : ""),
                stat("Assertions", `${s.assertionsPassed}/${s.assertions}`, s.assertionsFailed ? "bad" : s.assertions ? "good" : ""),
                stat("Avg. response", fmtMs(s.avgResponseMs || 0)));
        }

        function renderToolbar() {
            clear(toolbar);
            if (!session.startedAt) return;
            const busy = session.running || session.starting;
            const seg = (value, label) => {
                const b = h("button", { class: filter === value ? "active" : "", type: "button" }, label);
                b.addEventListener("click", () => { filter = value; renderToolbar(); renderList(true); });
                return b;
            };
            const failedCount = session.results.filter((r) => !r.passed).length;
            add(toolbar, h("div", { class: "segmented" }, seg("all", `All (${session.results.length})`), seg("failed", `Failed (${failedCount})`)));
            if (!busy && failedCount && session.suiteId === currentSuiteId && opts) {
                const pickFailed = h("button", { class: "btn small ghost", type: "button", title: "Select only the failed requests on the left" }, "Select failed");
                pickFailed.addEventListener("click", () => {
                    const suite = App.getSuite(currentSuiteId);
                    const existing = new Set(allRequestIds(suite));
                    opts.checked = new Set(session.results.filter((r) => !r.passed && existing.has(r.requestId)).map((r) => r.requestId));
                    renderTree();
                    toast(`${plural(opts.checked.size, "failed request")} selected. Press Run to try them again.`, "info");
                });
                toolbar.appendChild(pickFailed);
            }
            toolbar.appendChild(h("span", { class: "spacer" }));
            if (!busy && (session.result || session.results.length)) {
                const exportBtn = (format, label) => {
                    const b = h("button", { class: "btn small", type: "button" }, label);
                    b.addEventListener("click", () => exportReport(format));
                    return b;
                };
                // one group, so a narrow toolbar wraps it as a whole
                toolbar.appendChild(h("span", { class: "rn-report" }, h("span", { class: "muted small" }, "Report:"), exportBtn("html", "HTML"), exportBtn("junit", "JUnit XML"), exportBtn("json", "JSON")));
            }
            if (savedReport) {
                const openB = h("button", { class: "btn small ghost", type: "button" }, "Open");
                openB.addEventListener("click", () => attempt(() => call("files.openPath", savedReport.path)));
                const showB = h("button", { class: "btn small ghost", type: "button" }, "Show in folder");
                showB.addEventListener("click", () => attempt(() => call("files.showItem", savedReport.path)));
                toolbar.appendChild(h("div", { class: "rn-saved" }, safeIcon("check"), h("span", { class: "ellipsis", title: savedReport.path }, `Saved ${savedReport.path}`), openB, showB));
            }
        }

        async function exportReport(format) {
            let run = session.result;
            if (!run) run = await attempt(() => call("runner.last"));
            if (!run) { toast("There is no finished run to export yet", "warn"); return; }
            const path = await attempt(() => call("files.saveReport", run, format));
            if (!path || disposed) return;
            savedReport = { path, format };
            toast(`Report saved: ${path.split(/[\\/]/).pop()}`, "success");
            renderToolbar();
        }

        const visibleResults = () => session.results.map((r, i) => ({ r, i })).filter(({ r }) => filter === "all" || !r.passed);

        function renderList(full) {
            const items = visibleResults();
            if (full) { clear(list); renderedCount = 0; }
            if (!session.startedAt) {
                clear(list).appendChild(h("div", { class: "empty rn-empty" },
                    h("div", { class: "big" }, safeIcon("runner")),
                    h("div", null, "Results appear here while the run goes."),
                    h("div", { class: "hint" }, "Each row shows the status, time and assertions; click it for details.")));
                clear(moreBox);
                return;
            }
            if (!items.length && !(session.running || session.starting)) {
                clear(list).appendChild(h("div", { class: "empty" }, filter === "failed" ? "No failed requests." : "No requests were sent."));
                renderedCount = 0;
                clear(moreBox);
                return;
            }
            if (renderedCount === 0) clear(list);
            const limit = Math.min(items.length, MAX_ROWS);
            for (let k = renderedCount; k < limit; k++) list.appendChild(resultRow(items[k].r, items[k].i));
            renderedCount = limit;
            clear(moreBox);
            if (items.length > MAX_ROWS) moreBox.appendChild(h("div", { class: "hint" }, `Showing the first ${MAX_ROWS} of ${items.length} results. Use “Failed” or export a report to see everything.`));
        }

        function resultRow(r, index) {
            const state = resultState(r);
            const asserts = realAssertions(r);
            const okCount = asserts.filter((a) => a.passed).length;
            const status = r.response?.status;
            const row = h("div", { class: `rn-row is-${state} ${expanded.has(index) ? "open" : ""}` }); // not "pass": styles.css colors .pass text
            const main = h("button", { class: "rn-row-main", type: "button" },
                h("span", { class: `rn-mark ${state}` }, safeIcon(state === "pass" ? "check" : "x")),
                runIterations() > 1 ? h("span", { class: "rn-iter", title: "Iteration" }, `#${iterationNumber(r.iteration)}`) : null,
                methodBadge(r.method || "GET"),
                h("span", { class: "rn-name ellipsis", title: r.name || "" }, r.name || "Request"),
                h("span", { class: "rn-url ellipsis", title: r.url || "" }, r.url || ""),
                h("span", { class: "spacer" }),
                r.error ? h("span", { class: "status-pill st-error", title: r.error }, "Error") : statusPill(status, r.response?.statusText),
                h("span", { class: "rn-time" }, responseTime(r) != null ? fmtMs(responseTime(r)) : ""),
                asserts.length ? h("span", { class: `rn-asserts ${okCount === asserts.length ? "good" : "bad"}`, title: "Assertions passed" }, `${okCount}/${asserts.length}`) : h("span", { class: "rn-asserts none", title: "No assertions" }, "–"),
                h("span", { class: "rn-chev" }, safeIcon(expanded.has(index) ? "chevronDown" : "chevronRight")));
            row.appendChild(main);
            if (expanded.has(index)) row.appendChild(resultDetails(r));
            main.addEventListener("click", () => {
                if (expanded.has(index)) expanded.delete(index); else expanded.add(index);
                row.replaceWith(resultRow(r, index));
            });
            return row;
        }

        function resultDetails(r) {
            const d = h("div", { class: "rn-details" });
            const copyUrl = h("button", { class: "btn ghost icon", type: "button", title: "Copy URL" }, safeIcon("copy"));
            copyUrl.addEventListener("click", () => copyText(r.url || ""));
            const openReq = h("button", { class: "btn small", type: "button" }, safeIcon("edit"), "Open request");
            openReq.addEventListener("click", () => {
                const suiteIdOfRun = session.suiteId || currentSuiteId;
                if (!App.getSuite(suiteIdOfRun) || !VH.findItem(App.getSuite(suiteIdOfRun), r.requestId)) { toast("This request no longer exists", "warn"); return; }
                App.openRequest(suiteIdOfRun, r.requestId);
            });
            d.appendChild(h("div", { class: "rn-detail-line" }, h("span", { class: "mono ellipsis", title: r.url }, `${r.method} ${r.url}`), copyUrl, h("span", { class: "spacer" }), openReq));
            if (r.error) d.appendChild(h("div", { class: "callout bad" }, r.error));
            const unresolved = r.prepared?.unresolved || [];
            if (unresolved.length) d.appendChild(h("div", { class: "callout warn" }, `Unresolved variables: ${unresolved.map((n) => `{{${n}}}`).join(", ")} — define them in the environment, suite or data file.`));

            const asserts = r.assertions || [];
            if (asserts.length) {
                d.appendChild(h("div", { class: "rn-detail-title" }, "Assertions"));
                d.appendChild(h("div", { class: "table-wrap" }, h("table", { class: "rn-detail-table" },
                    h("thead", null, h("tr", null, h("th", null, ""), h("th", null, "Check"), h("th", null, "Actual"), h("th", null, "Message"))),
                    h("tbody", null, asserts.map((a) => h("tr", { class: a.skipped ? "is-skipped" : a.passed ? "is-pass" : "is-fail" },
                        h("td", null, h("span", { class: `rn-mark ${a.skipped ? "skip" : a.passed ? "pass" : "fail"}` }, safeIcon(a.passed ? "check" : "x"))),
                        h("td", null, a.label || ""),
                        h("td", { class: "mono" }, a.actual == null ? "" : String(a.actual)),
                        h("td", { class: "small" }, a.skipped ? "skipped" : a.passed ? "" : a.message || "")))))));
            }
            const captures = r.captures || [];
            if (captures.length) {
                d.appendChild(h("div", { class: "rn-detail-title" }, "Captured"));
                d.appendChild(h("div", { class: "rn-captures" }, captures.map((c) => h("div", { class: `rn-capture ${c.ok ? "" : "bad-text"}` },
                    h("code", null, `{{${c.variable}}}`), " = ",
                    c.ok ? h("span", { class: "mono" }, String(c.value ?? "").slice(0, 200)) : h("span", null, c.message || "not found"),
                    h("span", { class: "muted small" }, ` (${c.scope || "runtime"})`)))));
            }
            const logs = [...(r.logs || [])];
            for (const phase of ["pre", "post"]) {
                const err = r.scripts?.[phase]?.error;
                // script errors are usually in the logs already
                if (err && !logs.some((l) => String(typeof l === "string" ? l : l.message).includes(err))) {
                    logs.push({ level: "error", message: `${phase === "pre" ? "Pre-request" : "Post-response"} script: ${err}` });
                }
            }
            if (logs.length) {
                d.appendChild(h("div", { class: "rn-detail-title" }, "Console"));
                d.appendChild(h("div", { class: "rn-console" }, logs.slice(0, 200).map((l) => h("div", { class: `rn-log ${l.level || "log"}` },
                    h("span", { class: "rn-log-level" }, l.level || "log"), h("span", null, typeof l === "string" ? l : l.message)))));
            }
            if (r.response && Number(r.response.status) > 0) {
                const res = r.response;
                let text = res.bodyText || "";
                if (res.json !== undefined && text.length < 200000) { try { text = JSON.stringify(JSON.parse(text), null, 2); } catch (err) { /* keep raw */ } }
                const cut = text.length > BODY_PREVIEW || res.bodyPreviewCut || res.bodyTrimmed || res.truncated;
                d.appendChild(h("div", { class: "rn-detail-title" }, "Response ",
                    h("span", { class: "muted small" }, [res.contentType, res.size?.body != null ? fmtBytes(res.size.body) : null, `${(res.headers || []).length} headers`].filter(Boolean).join(" · "))));
                d.appendChild(h("pre", { class: "rn-body-preview" }, text ? text.slice(0, BODY_PREVIEW) + (cut ? "\n…" : "") : "(empty body)"));
                if (cut) d.appendChild(h("div", { class: "hint" }, "Shortened. Open the request and send it to see everything, or export an HTML report."));
            }
            return d;
        }

        // ---------------------------------------------------------- live updates
        let scheduled = false;
        let ticker = null;
        const refreshResults = (full) => {
            renderProgress();
            renderStats();
            renderToolbar();
            renderList(full);
            renderButtons();
        };
        const scheduleRefresh = () => {
            if (scheduled) return;
            scheduled = true;
            requestAnimationFrame(() => { scheduled = false; if (!disposed) refreshResults(false); });
        };
        const view = {
            onEvent(event) {
                if (disposed) return;
                if (event.type === "starting") { filter = "all"; refreshResults(true); startTicker(); return; }
                if (event.type === "run-done" || event.type === "start-failed") { stopTicker(); refreshResults(true); return; }
                scheduleRefresh();
            }
        };
        const startTicker = () => { stopTicker(); ticker = setInterval(() => { if (!disposed) renderProgress(); }, 500); };
        const stopTicker = () => { if (ticker) clearInterval(ticker); ticker = null; };
        views.add(view);

        const offs = [
            App.on("suites-changed", () => {
                if (disposed) return;
                if (!App.getSuite(currentSuiteId)) {
                    currentSuiteId = App.activeSuiteId() || suites()[0]?.id || null;
                    opts = currentSuiteId ? optionsFor(currentSuiteId) : null;
                    renderConfig();
                    return;
                }
                // keep the selection; requests that were added while everything was selected get selected too
                const suite = App.getSuite(currentSuiteId);
                const ids = allRequestIds(suite);
                const hadAll = opts.lastTotal != null && opts.checked.size === opts.lastTotal;
                opts = optionsFor(currentSuiteId);
                if (hadAll) opts.checked = new Set(ids);
                opts.lastTotal = ids.length;
                // the suite / environment selects must show renamed or new entries; while the user types in a
                // field of the form only the tree is refreshed, so the focus stays where it is
                if (isTypingIn(configPane)) renderTree(); else renderConfig();
            }),
            App.on("environment-changed", () => {
                if (disposed || !opts || !opts.followsActive) return;
                opts.environmentId = App.activeEnvironmentId(currentSuiteId) || null;
                if (isTypingIn(configPane)) renderCli(); else renderConfig();
            })
        ];

        if (opts) opts.lastTotal = allRequestIds(App.getSuite(currentSuiteId)).length;
        renderConfig();
        refreshResults(true);
        if (session.running || session.starting) startTicker();
        else if (!session.startedAt) {
            // show the last run of this app session, e.g. one started before the view was reopened elsewhere
            call("runner.last").then((last) => {
                if (disposed || !last || session.startedAt) return;
                Object.assign(session, {
                    runId: last.id || null, running: false, starting: false, suiteId: null, suiteName: last.suiteName || "", iterations: last.iterations || 1,
                    total: (last.results || []).length, results: (last.results || []).map(slim), current: null, result: last,
                    startedAt: Date.parse(last.startedAt) || Date.now(), finishedAt: Date.parse(last.finishedAt) || Date.now()
                });
                const match = suites().find((s) => s.name === last.suiteName);
                session.suiteId = match ? match.id : null;
                refreshResults(true);
            }).catch(() => { /* no previous run */ });
        }

        return () => {
            disposed = true;
            stopTicker();
            views.delete(view);
            for (const off of offs) { try { if (typeof off === "function") off(); } catch (err) { /* ignore */ } }
            root.remove();
        };
    }

    window.Runner = { mount };
})();
