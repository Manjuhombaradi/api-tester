"use strict";
/*
 * Import dialog (drop zone, file chooser, paste box -> preview of what was detected + warnings -> add) and
 * export dialog (include environments / secret values -> save as .apisuite).
 * ImportExport.openImport(prefill?)   prefill: text | { text, fileName } | { path } | ImportResult
 * ImportExport.importResult(result)  preview + add (used for files opened with the app / dropped on the window)
 * ImportExport.openExport(suiteId)
 */
(function () {
    "use strict";
    const VH = window.ViewHelpers;
    const { clone, call, newId, walk, countItems, plural, safeIcon, firstRequest, add } = VH;

    const SOURCE_LABELS = {
        "api-tester": "API Tester suite",
        postman: "Postman collection",
        "postman-environment": "Postman environment",
        openapi: "OpenAPI 3 definition",
        swagger: "Swagger 2.0 definition",
        curl: "cURL command"
    };
    const MAX_FILE_BYTES = 50 * 1024 * 1024;

    function uniqueSuiteName(name) {
        const taken = new Set((App.state.suites || []).map((s) => s.name.toLowerCase()));
        if (!taken.has(String(name).toLowerCase())) return name;
        for (let i = 2; ; i++) if (!taken.has(`${name} (${i})`.toLowerCase())) return `${name} (${i})`;
    }

    /** Copy of a suite with fresh ids everywhere (import as a copy next to an existing one). */
    function withNewIds(suite) {
        const s = clone(suite);
        s.id = newId("s");
        const envMap = {};
        for (const env of s.environments || []) { const id = newId("e"); envMap[env.id] = id; env.id = id; }
        s.activeEnvironmentId = envMap[s.activeEnvironmentId] || s.environments?.[0]?.id || null;
        walk(s.items, (item) => {
            item.id = newId(item.type === "folder" ? "f" : "r");
            for (const a of item.assertions || []) a.id = newId("a");
            for (const x of item.extract || []) x.id = newId("x");
        });
        return s;
    }

    /**
     * Security notes of an import result: from main (result.securityWarnings), or worked out here for an older
     * result: local files the requests upload, requests with scripts, requests that turn TLS checks off.
     */
    function securityNotes(result) {
        if (Array.isArray(result.securityWarnings)) return result.securityWarnings;
        const files = [], scripts = [], tls = [];
        for (const suite of result.suites || []) {
            walk(suite.items, (item, parents) => {
                if (item.type !== "request") return true;
                const name = [...parents.map((p) => p.name), item.name].join(" / ");
                const b = item.body || {};
                if (b.mode === "binary" && b.binaryPath) files.push(`"${name}" (${b.binaryPath})`);
                if (b.mode === "multipart") for (const part of b.multipart || []) if (part && part.enabled !== false && part.type === "file" && part.filePath) files.push(`"${name}" (${part.filePath})`);
                if (item.scripts && (String(item.scripts.pre || "").trim() || String(item.scripts.post || "").trim())) scripts.push(name);
                if (item.settings && item.settings.verifyTls === false) tls.push(name);
                return true;
            });
        }
        const out = [];
        if (files.length) out.push(`Local files: ${plural(files.length, "file")} of this computer would be uploaded when the requests are sent: ${files.slice(0, 8).join(", ")}${files.length > 8 ? " …" : ""}.`);
        if (scripts.length) out.push(`Scripts: ${plural(scripts.length, "request")} run JavaScript before or after sending: ${scripts.slice(0, 8).join(", ")}${scripts.length > 8 ? " …" : ""}.`);
        if (tls.length) out.push(`TLS certificate checks are off for ${plural(tls.length, "request")}: ${tls.slice(0, 8).join(", ")}${tls.length > 8 ? " …" : ""}.`);
        return out;
    }

    function readDroppedFile(file) {
        if (!file) return Promise.reject(new Error("No file"));
        if (file.size > MAX_FILE_BYTES) return Promise.reject(new Error(`“${file.name}” is larger than 50 MB`));
        return file.text().then((text) => call("files.importText", text, file.name));
    }

    // ================================================================== import

    let importDialog = null; // { promise, prefill(p) } while the import dialog is open
    let exportDialog = null; // promise while the export dialog is open

    function openImport(prefill) {
        // a second call (menu, file opened with the app) reuses the open dialog
        if (importDialog) {
            if (prefill) importDialog.prefill(prefill);
            return importDialog.promise;
        }
        let result = null; // ImportResult being previewed
        let error = null;
        let busy = false;
        let seq = 0;
        let options = {}; // per preview: { mode per suite index, targetSuiteId }
        let origin = null; // where the previewed result came from: { from: "file" | "paste", fileName }
        let sourceOpen = false; // the user asked for the drop zone / paste box again after a file was loaded

        const preview = h("div", { class: "ie-preview" });

        const chooseBtn = h("button", { class: "btn primary", type: "button" }, safeIcon("file"), "Choose file…");
        const drop = h("div", { class: "ie-drop", tabindex: "0" },
            h("div", { class: "ie-drop-icon" }, safeIcon("import")),
            h("div", { class: "ie-drop-title" }, "Drop a file here"),
            h("div", { class: "hint" }, "API Tester suite (.apisuite) · Postman collection or environment · OpenAPI / Swagger (JSON or YAML) · cURL command"),
            h("div", { style: { marginTop: "10px" } }, chooseBtn));
        const paste = h("textarea", {
            class: "ie-paste", rows: 5, spellcheck: "false",
            placeholder: "Or paste here: a cURL command (e.g. from the browser's “Copy as cURL”), Postman collection JSON or an OpenAPI document"
        });
        const detectBtn = h("button", { class: "btn small", type: "button" }, safeIcon("search"), "Detect");

        // the full source area (drop zone + paste box); once a file is loaded it folds into a one-line bar so the
        // preview and its notes are in view
        const sourceArea = h("div", { class: "ie-source-full" },
            drop,
            h("div", { class: "ie-or" }, h("span", null, "or paste")),
            paste,
            h("div", { class: "ie-paste-row" }, h("span", { class: "hint" }, "Detected automatically while you paste."), h("span", { class: "spacer" }), detectBtn));
        const sourceName = h("span", { class: "ellipsis" });
        const anotherBtn = h("button", { class: "btn small", type: "button" }, safeIcon("file"), "Choose another file…");
        const pasteInsteadBtn = h("button", { class: "btn small ghost", type: "button" }, "Paste text instead");
        const sourceBar = h("div", { class: "ie-source hidden" }, safeIcon("file"), sourceName, h("span", { class: "spacer" }), anotherBtn, pasteInsteadBtn);

        // security notes of the previewed file: first thing in the dialog, never below the fold
        const securityBox = h("div", { class: "callout ie-security hidden", role: "alert" });
        const body = h("div", { class: "ie-dialog" }, securityBox, sourceArea, sourceBar, preview);

        const renderSource = () => {
            const folded = !!result && origin?.from === "file" && !sourceOpen;
            sourceArea.classList.toggle("hidden", folded);
            sourceBar.classList.toggle("hidden", !folded);
            clear(sourceName);
            if (folded) add(sourceName, origin.fileName ? ["From ", h("b", { title: origin.fileName }, origin.fileName)] : "From a file");
        };
        const setBusy = (on, label) => {
            busy = on;
            drop.classList.toggle("busy", on);
            anotherBtn.disabled = on;
            if (on) clear(preview).appendChild(h("div", { class: "muted ie-loading" }, label || "Reading…"));
        };
        // from: "file" | "paste" (where the text comes from; a file result folds the source area)
        const load = async (fn, label, from = "file") => {
            const mySeq = ++seq;
            setBusy(true, label);
            try {
                const r = await fn();
                if (mySeq !== seq) return;
                if (r === null || r === undefined) { setBusy(false); renderPreview(); return; } // dialog cancelled
                result = r;
                error = null;
                options = {};
                origin = { from, fileName: from === "file" ? r.fileName || "" : "" };
                sourceOpen = false;
            } catch (err) {
                if (mySeq !== seq) return;
                result = null;
                error = err?.message || String(err);
            }
            setBusy(false);
            renderPreview();
        };

        // the whole drop zone (and its button) opens the file chooser
        const chooseFile = () => { if (!busy) load(() => call("files.importDialog"), "Waiting for the file chooser…"); };
        drop.addEventListener("click", chooseFile);
        anotherBtn.addEventListener("click", chooseFile);
        pasteInsteadBtn.addEventListener("click", () => {
            sourceOpen = true;
            renderSource();
            paste.focus();
        });
        drop.addEventListener("keydown", (e) => { if (e.target === drop && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); chooseFile(); } });
        // files can be dropped anywhere on the dialog (also on the paste box)
        const hasFiles = (e) => !!e.dataTransfer && [...e.dataTransfer.types].includes("Files");
        const setDrag = (on) => { drop.classList.toggle("drag", on); sourceBar.classList.toggle("drag", on); };
        body.addEventListener("dragover", (e) => { if (!hasFiles(e)) return; e.preventDefault(); e.stopPropagation(); setDrag(true); });
        body.addEventListener("dragleave", (e) => { if (!body.contains(e.relatedTarget)) setDrag(false); });
        body.addEventListener("drop", (e) => {
            if (!hasFiles(e) && e.target === paste) return; // dragged text into the paste box: let the browser insert it
            e.preventDefault();
            e.stopPropagation();
            setDrag(false);
            const file = e.dataTransfer?.files?.[0];
            if (file) {
                paste.value = "";
                load(() => readDroppedFile(file).then((r) => (r ? { ...r, fileName: r.fileName || file.name } : r)), `Reading ${file.name}…`);
                return;
            }
            const text = e.dataTransfer?.getData("text/plain");
            if (text) { paste.value = text; detect(); }
        });

        const detect = () => {
            const text = paste.value.trim();
            if (!text) { result = null; error = null; renderPreview(); return; }
            load(() => call("files.importText", text, ""), "Detecting…", "paste");
        };
        const autoDetect = debounce(detect, 600);
        paste.addEventListener("input", autoDetect);
        detectBtn.addEventListener("click", detect);

        // ---------------------------------------------------------- preview
        function renderSecurity() {
            const notes = result && !error ? securityNotes(result) : [];
            clear(securityBox);
            securityBox.classList.toggle("hidden", !notes.length);
            if (!notes.length) return [];
            // red when local files would be uploaded, orange for scripts / TLS
            securityBox.classList.toggle("bad", notes.some((w) => /^Local files/i.test(w)));
            securityBox.classList.toggle("warn", !notes.some((w) => /^Local files/i.test(w)));
            add(securityBox, safeIcon("alert"), h("div", { class: "ie-security-body" },
                h("b", null, "Check this before you send or run anything"),
                h("ul", null, notes.map((w) => h("li", null, w))),
                h("div", { class: "hint" }, "Importing runs nothing and sends nothing. Local files are only uploaded after you allow each one, and Settings → Enforce TLS verification keeps certificate checks on for every request.")));
            return notes;
        }

        function renderPreview() {
            clear(preview);
            renderSource();
            const security = renderSecurity();
            const importButton = VH.modalButton(body, "Import");
            if (importButton) importButton.disabled = !result || busy;
            if (error) {
                preview.appendChild(h("div", { class: "callout bad" }, safeIcon("x"),
                    h("span", null, h("b", null, "Can't import this. "), error)));
                return;
            }
            if (!result) return;
            const kind = result.kind;
            const sourceLabel = result.summary || SOURCE_LABELS[result.source] || result.source || kind;
            preview.appendChild(h("div", { class: "ie-detected" }, safeIcon("check"), h("span", null, "Detected: ", h("b", null, sourceLabel))));

            // notes first (e.g. secret values to fill in): they matter more than the list of requests
            const warnings = (result.warnings || []).filter((w) => !security.includes(w));
            if (warnings.length) {
                preview.appendChild(h("div", { class: "callout warn ie-warnings" },
                    h("div", null, h("b", null, plural(warnings.length, "note"))),
                    h("ul", null, warnings.slice(0, 30).map((w) => h("li", null, w))),
                    warnings.length > 30 ? h("div", { class: "hint" }, `… and ${warnings.length - 30} more`) : null));
            }

            if (kind === "environment") renderEnvironmentPreview();
            else if (kind === "curl") renderCurlPreview();
            else renderSuitesPreview();
        }

        const targetSelect = (defaultNew, label) => {
            const list = App.state.suites || [];
            const active = App.activeSuiteId();
            if (options.targetSuiteId === undefined) options.targetSuiteId = defaultNew || !list.length ? "" : active && App.getSuite(active) ? active : list[0].id;
            const sel = select([{ value: "", label: "A new suite" }, ...list.map((s) => ({ value: s.id, label: s.name }))], options.targetSuiteId);
            sel.addEventListener("change", () => { options.targetSuiteId = sel.value; });
            return field(label, sel);
        };

        function renderSuitesPreview() {
            const suites = result.suites || [];
            if (!suites.length) { preview.appendChild(h("div", { class: "callout warn" }, "The file contains no requests.")); return; }
            suites.forEach((suite, index) => {
                const counts = countItems(suite);
                const reqs = VH.requestsUnder(suite.items);
                const existing = App.getSuite(suite.id);
                if (!options[index]) options[index] = existing ? "copy" : "new";
                const card = h("div", { class: "ie-card" },
                    h("div", { class: "ie-card-head" }, safeIcon("folderOpen"), h("b", null, suite.name || "Suite"),
                        h("span", { class: "muted small" }, [plural(counts.folders, "folder"), plural(counts.requests, "request"), plural((suite.environments || []).length, "environment")].join(" · "))),
                    suite.description ? h("div", { class: "hint ie-desc" }, suite.description.slice(0, 300)) : null,
                    h("div", { class: "ie-requests" },
                        reqs.slice(0, 8).map((r) => h("div", { class: "ie-request" }, methodBadge(r.method), h("span", { class: "ellipsis" }, r.name), h("span", { class: "muted small ellipsis" }, r.url))),
                        reqs.length > 8 ? h("div", { class: "hint" }, `… and ${plural(reqs.length - 8, "more request")}`) : null));
                if (existing) {
                    const radio = (value, label, hint) => {
                        const input = h("input", { type: "radio", name: `ie-mode-${index}`, value, checked: options[index] === value });
                        input.addEventListener("change", () => { if (input.checked) options[index] = value; });
                        return h("label", { class: "ie-radio" }, input, h("span", null, label, hint ? h("span", { class: "hint" }, ` — ${hint}`) : null));
                    };
                    card.appendChild(h("div", { class: "ie-conflict" },
                        h("div", { class: "small" }, `You already have this suite (“${existing.name}”).`),
                        radio("copy", "Keep both", "add the file as a copy"),
                        radio("replace", "Replace mine", "your version and its environments are overwritten")));
                }
                preview.appendChild(card);
            });
        }

        function renderCurlPreview() {
            const reqs = VH.requestsUnder((result.suites || [])[0]?.items);
            if (!reqs.length) { preview.appendChild(h("div", { class: "callout warn" }, "No request found in the command.")); return; }
            preview.appendChild(h("div", { class: "ie-card" },
                reqs.slice(0, 10).map((req) => {
                    const headers = (req.headers || []).filter((x) => x.key).length;
                    return h("div", { class: "ie-curl" },
                        h("div", { class: "ie-request" }, methodBadge(req.method), h("span", { class: "mono ellipsis", title: req.url }, req.url)),
                        h("div", { class: "hint" }, [plural(headers, "header"), req.body && req.body.mode !== "none" ? `${req.body.mode} body` : "no body",
                            req.auth && !["inherit", "none"].includes(req.auth.type) ? `${VH.AUTH_LABELS[req.auth.type] || req.auth.type}` : null].filter(Boolean).join(" · ")));
                }),
                reqs.length > 10 ? h("div", { class: "hint" }, `… and ${plural(reqs.length - 10, "more request")}`) : null,
                targetSelect(false, reqs.length > 1 ? "Add the requests to" : "Add the request to")));
        }

        function renderEnvironmentPreview() {
            const envs = result.environments || [];
            preview.appendChild(h("div", { class: "ie-card" },
                envs.map((env) => h("div", { class: "ie-request" }, safeIcon("env"), h("b", null, env.name), h("span", { class: "muted small" }, plural((env.variables || []).filter((v) => v.key).length, "variable")))),
                targetSelect(false, "Add to suite"),
                h("div", { class: "hint" }, "Environments belong to a suite. Pick the suite whose requests use these variables.")));
        }

        // ---------------------------------------------------------- apply
        async function apply() {
            if (busy) return false;
            if (!result) {
                toast(error ? "Fix the problem shown in the dialog, or choose another file" : "Choose a file, drop one, or paste something to import first", "warn");
                return false;
            }
            if (result.kind === "environment") return applyEnvironment();
            if (result.kind === "curl") return applyCurl();
            return applySuites();
        }

        async function applySuites() {
            const added = [];
            for (const [index, suite] of (result.suites || []).entries()) {
                const existing = App.getSuite(suite.id);
                let s = clone(suite);
                if (existing && options[index] !== "replace") {
                    s = withNewIds(s);
                    s.name = uniqueSuiteName(s.name);
                } else if (!existing) {
                    s.name = uniqueSuiteName(s.name);
                } else {
                    // replaced by a file from outside: files allowed for upload in the old version must be allowed again
                    await call("files.forgetApprovals", s.id);
                }
                await App.saveSuite(s);
                added.push(s);
            }
            if (!added.length) return false;
            const first = added[0];
            const req = firstRequest(App.getSuite(first.id) || first);
            toast(added.length === 1 ? `Imported “${first.name}” (${plural(countItems(first).requests, "request")})` : `Imported ${plural(added.length, "suite")}`, "success");
            setTimeout(() => {
                if (req) App.openRequest(first.id, req.id);
                else App.openItemSettings(first.id, null);
            }, 0);
            return true;
        }

        async function targetSuite(nameForNew) {
            if (options.targetSuiteId && App.getSuite(options.targetSuiteId)) return clone(App.getSuite(options.targetSuiteId));
            return VH.newSuite(uniqueSuiteName(nameForNew));
        }

        async function applyCurl() {
            const reqs = VH.requestsUnder((result.suites || [])[0]?.items);
            if (!reqs.length) return false;
            const suite = await targetSuite("Imported requests");
            const added = reqs.map((req) => {
                const request = clone(req);
                request.id = newId("r");
                for (const a of request.assertions || []) a.id = newId("a");
                for (const x of request.extract || []) x.id = newId("x");
                return request;
            });
            suite.items.push(...added);
            await App.saveSuite(suite);
            toast(added.length === 1 ? `Added “${added[0].name}” to “${suite.name}”` : `Added ${plural(added.length, "request")} to “${suite.name}”`, "success");
            setTimeout(() => App.openRequest(suite.id, added[0].id), 0);
            return true;
        }

        async function applyEnvironment() {
            const envs = result.environments || [];
            if (!envs.length) return false;
            const suite = await targetSuite(envs[0].name || "Imported environment");
            const taken = new Set((suite.environments || []).map((e) => e.name.toLowerCase()));
            suite.environments = suite.environments || [];
            for (const env of envs) {
                const copy = clone(env);
                copy.id = newId("e");
                let name = copy.name || "Environment";
                for (let i = 2; taken.has(name.toLowerCase()); i++) name = `${copy.name} (${i})`;
                copy.name = name;
                taken.add(name.toLowerCase());
                suite.environments.push(copy);
            }
            if (!suite.activeEnvironmentId) suite.activeEnvironmentId = suite.environments[0].id;
            await App.saveSuite(suite);
            toast(`Added ${plural(envs.length, "environment")} to “${suite.name}”`, "success");
            setTimeout(() => Environments.open(suite.id, "environments", suite.environments[suite.environments.length - 1].id), 0);
            return true;
        }

        const promise = modal({
            title: "Import",
            body,
            wide: true,
            buttons: [
                { label: "Cancel", value: null },
                { label: "Import", class: "primary", onClick: apply }
            ]
        });
        renderPreview();

        const applyPrefill = (p) => {
            if (typeof p === "string" && p.trim()) { paste.value = p; detect(); }
            else if (p && typeof p === "object") {
                if (Array.isArray(p.suites) || Array.isArray(p.environments)) {
                    seq++; // an ImportResult (a file opened with the app or dropped on the window): shown as is
                    paste.value = "";
                    result = p;
                    error = null;
                    options = {};
                    origin = { from: "file", fileName: p.fileName || "" };
                    sourceOpen = false;
                    setBusy(false);
                    renderPreview();
                } else if (p.path) load(() => call("files.importPath", p.path), "Reading file…");
                else if (typeof p.text === "string") {
                    paste.value = p.text;
                    load(() => call("files.importText", p.text, p.fileName || ""), "Detecting…", "paste");
                }
            }
        };
        applyPrefill(prefill);
        importDialog = { promise, prefill: applyPrefill };
        promise.finally(() => { importDialog = null; });
        return promise;
    }

    function importResult(result) {
        return openImport(result);
    }

    // ================================================================== export

    function openExport(suiteId) {
        if (exportDialog) return exportDialog;
        const id = suiteId || App.activeSuiteId() || (App.state.suites || [])[0]?.id;
        const suite = id ? App.getSuite(id) : null;
        if (!suite) {
            toast("There is no suite to export yet", "warn");
            return Promise.resolve(null);
        }
        const counts = countItems(suite);
        const envCount = (suite.environments || []).length;
        const secretNames = [];
        const collect = (vars) => { for (const v of vars || []) if (v.secret && v.key && v.value && !secretNames.includes(v.key)) secretNames.push(v.key); };
        collect(suite.variables);
        for (const env of suite.environments || []) collect(env.variables);
        walk(suite.items, (item) => { if (item.type === "folder") collect(item.variables); });

        let includeEnvironments = true;
        let includeSecrets = false;
        const secretWarning = h("div", { class: "callout bad hidden" }, safeIcon("lock"),
            h("span", null, "Secret values will be readable by anyone who gets the file. Share it only through a safe channel."));
        const secretInfo = h("div", { class: "hint" });
        const renderSecretInfo = () => {
            secretWarning.classList.toggle("hidden", !includeSecrets);
            const auth = "Passwords and tokens typed directly into Auth fields are left out too ({{variables}} stay).";
            secretInfo.textContent = includeSecrets
                ? (secretNames.length ? `Included: ${secretNames.join(", ")}, and passwords / tokens typed into Auth fields.` : "Passwords and tokens typed into Auth fields are included.")
                : (secretNames.length ? `Left empty in the file: ${secretNames.join(", ")}. The receiver fills them in after importing. ${auth}` : `This suite has no secret variables with values. ${auth}`);
        };
        renderSecretInfo();

        const body = h("div", { class: "stack ie-export" },
            h("div", { class: "ie-card" },
                h("div", { class: "ie-card-head" }, safeIcon("folderOpen"), h("b", null, suite.name),
                    h("span", { class: "muted small" }, [plural(counts.folders, "folder"), plural(counts.requests, "request"), plural(envCount, "environment")].join(" · ")))),
            checkbox(`Include environments (${envCount})`, true, (v) => { includeEnvironments = v; }),
            checkbox("Include secret values", false, (v) => { includeSecrets = v; renderSecretInfo(); }),
            secretInfo,
            secretWarning,
            h("div", { class: "hint" }, "The file (", h("code", null, VH.safeFileName(suite.name)), ") contains the saved suite: folders, requests, assertions, captures, scripts and variables. ",
                "Anyone can open it with API Tester (Import, or double-click), and run it from the command line. Globals and history stay on this machine."));

        exportDialog = modal({
            title: "Export suite",
            body,
            buttons: [
                { label: "Cancel", value: null },
                {
                    label: "Save file…", class: "primary",
                    onClick: async () => {
                        const path = await call("files.exportSuite", suite.id, { includeEnvironments, includeSecrets });
                        if (!path) return false; // save dialog cancelled: keep this dialog open
                        toast(`Exported: ${path.split(/[\\/]/).pop()}`, "success");
                        return path;
                    }
                }
            ]
        });
        exportDialog.finally(() => { exportDialog = null; });
        return exportDialog;
    }

    window.ImportExport = { openImport, importResult, openExport };
})();
