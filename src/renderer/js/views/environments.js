"use strict";
/*
 * Environments dialog: the environments of a suite (add, rename, duplicate, delete, use), the workspace-wide
 * Globals, and the Runtime tab with values captured during this session plus the cookie jar.
 * Environments.open(suiteId, tab = "environments" | "globals" | "runtime", envId?)  (envId "new" adds one)
 */
(function () {
    "use strict";
    const VH = window.ViewHelpers;
    const { clone, call, cleanVars, plural, safeIcon, add } = VH;

    let current = null; // the open dialog (only one at a time)

    function uniqueName(base, taken) {
        const names = new Set(taken.map((n) => n.toLowerCase()));
        if (!names.has(base.toLowerCase())) return base;
        for (let i = 2; ; i++) if (!names.has(`${base} ${i}`.toLowerCase())) return `${base} ${i}`;
    }

    function open(suiteId, tab = "environments", envId = null) {
        if (current) {
            current.show(tab, suiteId, envId);
            return current.promise;
        }
        const suites = () => App.state.suites || [];
        let activeSuiteId = suiteId || App.activeSuiteId() || suites()[0]?.id || null;
        let activeTab = ["environments", "globals", "runtime"].includes(tab) ? tab : "environments";
        let disposed = false;

        const statusLine = h("span", { class: "ve-save-state saved" }, "Changes are saved automatically");
        const setStatus = (state, message) => {
            statusLine.className = `ve-save-state ${state}`;
            statusLine.textContent = { pending: "Saving…", saved: "All changes saved", error: `Not saved: ${message}` }[state] || "Changes are saved automatically";
        };

        // ------------------------------------------------------------ environments working copy + saving
        let envs = [];
        let selectedEnvId = null;
        let envTimer = null;
        let envDirty = false;
        let chain = Promise.resolve();

        const loadEnvs = () => {
            const suite = App.getSuite(activeSuiteId);
            envs = clone(suite?.environments || []);
            if (!envs.some((e) => e.id === selectedEnvId)) selectedEnvId = App.activeEnvironmentId(activeSuiteId) || envs[0]?.id || null;
            if (!envs.some((e) => e.id === selectedEnvId)) selectedEnvId = envs[0]?.id || null;
        };
        const saveEnvsNow = async (forSuiteId, list) => {
            const latest = App.getSuite(forSuiteId);
            if (!latest) return;
            const copy = clone(latest);
            copy.environments = list.map((e) => ({ id: e.id, name: String(e.name || "").trim() || "Environment", variables: cleanVars(e.variables) }));
            if (!copy.environments.some((e) => e.id === copy.activeEnvironmentId)) copy.activeEnvironmentId = copy.environments[0]?.id || null;
            try {
                await App.saveSuite(copy);
                if (!disposed) setStatus(envDirty || globalsDirty ? "pending" : "saved");
            } catch (err) {
                if (!disposed) setStatus("error", err?.message || String(err));
                else toast(`Environments not saved: ${err?.message || err}`, "error");
            }
        };
        const flushEnvs = () => {
            clearTimeout(envTimer);
            envTimer = null;
            if (!envDirty) return chain;
            envDirty = false;
            const sid = activeSuiteId, list = clone(envs);
            chain = chain.then(() => saveEnvsNow(sid, list));
            return chain;
        };
        const envsChanged = (delay = 400) => {
            envDirty = true;
            setStatus("pending");
            clearTimeout(envTimer);
            envTimer = setTimeout(flushEnvs, delay);
        };

        // ------------------------------------------------------------ globals working copy + saving
        let globals = clone(App.state.globals || []);
        let globalsTimer = null;
        let globalsDirty = false;
        const flushGlobals = () => {
            clearTimeout(globalsTimer);
            globalsTimer = null;
            if (!globalsDirty) return chain;
            globalsDirty = false;
            const list = cleanVars(globals);
            chain = chain.then(async () => {
                try {
                    await App.saveGlobals(list);
                    if (!disposed) setStatus(envDirty || globalsDirty ? "pending" : "saved");
                } catch (err) {
                    if (!disposed) setStatus("error", err?.message || String(err));
                    else toast(`Globals not saved: ${err?.message || err}`, "error");
                }
            });
            return chain;
        };
        const globalsChanged = () => {
            globalsDirty = true;
            setStatus("pending");
            clearTimeout(globalsTimer);
            globalsTimer = setTimeout(flushGlobals, 400);
        };
        const flushAll = () => Promise.all([flushEnvs(), flushGlobals()]);

        // ------------------------------------------------------------ layout
        const tabBar = h("div", { class: "tabs ve-tabs" });
        const content = h("div", { class: "ev-content" });
        const body = h("div", { class: "ev-dialog" }, h("div", { class: "ev-top" }, tabBar, h("span", { class: "spacer" }), statusLine), content);

        const TABS = [
            { id: "environments", label: "Environments", icon: "env" },
            { id: "globals", label: "Globals", icon: "globe" },
            { id: "runtime", label: "Runtime values & cookies", icon: "history" }
        ];
        const renderTabs = () => {
            clear(tabBar);
            for (const t of TABS) {
                const b = h("button", { class: `tab ${t.id === activeTab ? "active" : ""}`, type: "button" }, safeIcon(t.icon), t.label);
                b.addEventListener("click", () => switchTab(t.id));
                tabBar.appendChild(b);
            }
        };
        const switchTab = async (id) => {
            await flushAll();
            activeTab = id;
            renderTabs();
            render();
        };
        const render = () => {
            clear(content);
            if (activeTab === "globals") renderGlobals();
            else if (activeTab === "runtime") renderRuntime();
            else renderEnvironments();
        };

        const suitePicker = () => {
            const list = suites();
            if (list.length < 2) return list.length ? h("div", { class: "ev-suite-name" }, "Suite: ", h("b", null, list[0].name)) : null;
            const sel = select(list.map((s) => ({ value: s.id, label: s.name })), activeSuiteId, { class: "ev-suite-select" });
            sel.addEventListener("change", async () => {
                await flushEnvs();
                activeSuiteId = sel.value;
                selectedEnvId = null;
                loadEnvs();
                render();
            });
            return h("label", { class: "ev-suite-name" }, "Suite", sel);
        };

        // ------------------------------------------------------------ Environments tab
        function addEnvironment() {
            const template = envs.find((e) => e.id === selectedEnvId) || envs[0];
            // a new environment starts with the keys the others use (values empty), so nothing is forgotten
            const variables = template
                ? cleanVars(template.variables).map((v) => ({ ...v, value: "" }))
                : [VH.newVariable("baseUrl", "", { description: "e.g. https://api.example.com" })];
            const env = VH.newEnvironment(uniqueName(envs.length ? "New environment" : "Development", envs.map((e) => e.name)), variables);
            envs.push(env);
            selectedEnvId = env.id;
            envsChanged(0);
            renderEnvironments(true);
        }

        function renderEnvironments(focusName = false) {
            clear(content);
            const suite = App.getSuite(activeSuiteId);
            if (!suite) {
                content.appendChild(h("div", { class: "empty" },
                    h("div", null, "There is no suite yet."),
                    h("div", { class: "hint" }, "Environments belong to a suite. Create or import a suite first; Globals work without one.")));
                return;
            }
            const activeId = App.activeEnvironmentId(activeSuiteId);

            // left: list
            const list = h("div", { class: "ev-list" });
            for (const env of envs) {
                const item = h("button", { class: `ev-item ${env.id === selectedEnvId ? "selected" : ""}`, type: "button" },
                    h("span", { class: "ev-item-name" }, env.name || "(no name)"),
                    env.id === activeId ? h("span", { class: "badge info", title: "Used for requests" }, "Active") : null);
                item.addEventListener("click", () => { selectedEnvId = env.id; renderEnvironments(); });
                list.appendChild(item);
            }
            if (!envs.length) list.appendChild(h("div", { class: "hint ev-list-empty" }, "No environments yet."));
            const addBtn = h("button", { class: "btn small", type: "button" }, safeIcon("plus"), "Add environment");
            addBtn.addEventListener("click", addEnvironment);
            const left = h("div", { class: "ev-left" }, suitePicker(), list, addBtn);

            // right: editor of the selected environment
            const right = h("div", { class: "ev-right" });
            const env = envs.find((e) => e.id === selectedEnvId);
            if (!env) {
                right.appendChild(h("div", { class: "empty" },
                    h("div", { class: "big" }, safeIcon("env")),
                    h("div", null, "Environments hold values that change between stages or machines."),
                    h("div", { class: "hint" }, "For example ", h("code", null, "baseUrl"), " = http://localhost:8080 in “Local” and https://api.example.com in “Production”. Use them as ", h("code", null, "{{baseUrl}}"), "."),
                    h("div", { style: { marginTop: "12px" } }, (() => { const b = h("button", { class: "btn primary" }, safeIcon("plus"), "Add environment"); b.addEventListener("click", addEnvironment); return b; })())));
            } else {
                const nameInput = h("input", { value: env.name, placeholder: "Environment name", class: "ev-name-input", spellcheck: "false" });
                nameInput.addEventListener("input", () => {
                    env.name = nameInput.value;
                    const label = list.querySelector(".ev-item.selected .ev-item-name");
                    if (label) label.textContent = env.name || "(no name)";
                    envsChanged();
                });
                const isActive = env.id === activeId;
                const useBtn = h("button", { class: `btn small ${isActive ? "" : "primary"}`, type: "button", disabled: isActive, title: "Requests and the runner use the active environment" },
                    safeIcon("check"), isActive ? "Active" : "Use this environment");
                useBtn.addEventListener("click", async () => {
                    await flushEnvs();
                    await attempt(() => App.setActiveEnvironment(activeSuiteId, env.id));
                    renderEnvironments();
                });
                const dupBtn = h("button", { class: "btn small", type: "button", title: "Copy with all values" }, safeIcon("copy"), "Duplicate");
                dupBtn.addEventListener("click", () => {
                    const copy = VH.newEnvironment(uniqueName(`${env.name} copy`, envs.map((e) => e.name)), cleanVars(env.variables));
                    envs.splice(envs.indexOf(env) + 1, 0, copy);
                    selectedEnvId = copy.id;
                    envsChanged(0);
                    renderEnvironments(true);
                });
                const delBtn = h("button", { class: "btn small ghost danger-text", type: "button" }, safeIcon("trash"), "Delete");
                delBtn.addEventListener("click", async () => {
                    const ok = await confirmDialog("Delete environment", `Delete “${env.name}” and its ${plural(cleanVars(env.variables).length, "variable")}?`, "Delete", true);
                    if (!ok || disposed) return;
                    envs = envs.filter((e) => e !== env);
                    selectedEnvId = envs[0]?.id || null;
                    envsChanged(0);
                    renderEnvironments();
                });

                // keys used by the other environments but missing here
                const ownKeys = new Set(cleanVars(env.variables).map((v) => v.key));
                const missing = [];
                for (const other of envs) {
                    if (other === env) continue;
                    for (const v of cleanVars(other.variables)) if (v.key && !ownKeys.has(v.key) && !missing.some((m) => m.key === v.key)) missing.push(v);
                }
                const missingBox = missing.length ? h("div", { class: "callout warn" },
                    h("span", null, `Other environments also define: ${missing.slice(0, 8).map((m) => m.key).join(", ")}${missing.length > 8 ? ` +${missing.length - 8} more` : ""}.`),
                    (() => {
                        const b = h("button", { class: "btn small", type: "button" }, "Add them here");
                        b.addEventListener("click", () => {
                            env.variables = cleanVars(env.variables).concat(missing.map((m) => ({ ...m, value: "" })));
                            envsChanged(0);
                            renderEnvironments();
                        });
                        return b;
                    })()) : null;

                add(right, 
                    h("div", { class: "ev-right-head" }, field("Name", nameInput), h("div", { class: "ev-right-actions" }, useBtn, dupBtn, delBtn)),
                    missingBox,
                    kvTable(env.variables, {
                        columns: ["enabled", "key", "value", "secret", "description"],
                        keyPlaceholder: "name", valuePlaceholder: "value",
                        onChange: () => envsChanged()
                    }),
                    h("div", { class: "hint" }, "Use as ", h("code", null, "{{name}}"), ". Mark tokens and passwords as secret: they are masked here, in logs and reports, and left out of exports unless you include them."));
                if (focusName) setTimeout(() => { nameInput.focus(); nameInput.select(); }, 30);
            }
            content.appendChild(h("div", { class: "ev-split" }, left, right));
        }

        // ------------------------------------------------------------ Globals tab
        function renderGlobals() {
            clear(content);
            add(content, 
                h("div", { class: "callout" }, safeIcon("globe"),
                    h("span", null, "Globals are available in every suite of this workspace, with the lowest priority: suite, folder and environment variables with the same name win. They stay on this machine and are not exported with suites.")),
                kvTable(globals, {
                    columns: ["enabled", "key", "value", "secret", "description"],
                    keyPlaceholder: "name", valuePlaceholder: "value",
                    onChange: globalsChanged
                }));
        }

        // ------------------------------------------------------------ Runtime tab
        let runtimeSeq = 0;
        async function renderRuntime() {
            clear(content);
            const seq = ++runtimeSeq;
            const suite = App.getSuite(activeSuiteId);
            if (!suite) {
                content.appendChild(h("div", { class: "empty" }, "There is no suite yet."));
                return;
            }
            const box = h("div", { class: "ev-runtime" }, h("div", { class: "muted" }, "Loading…"));
            const refresh = h("button", { class: "btn small", type: "button" }, "Refresh");
            refresh.addEventListener("click", renderRuntime);
            add(content, h("div", { class: "ev-runtime-head" }, suitePicker(), h("span", { class: "spacer" }), refresh), box);

            let data;
            try {
                data = await call("runtime.get", activeSuiteId);
            } catch (err) {
                if (seq !== runtimeSeq || disposed) return;
                clear(box).appendChild(h("div", { class: "callout bad" }, `Could not read runtime values: ${err?.message || err}`));
                return;
            }
            if (seq !== runtimeSeq || disposed || activeTab !== "runtime") return;
            clear(box);
            const vars = Object.entries(data?.variables || {});
            const cookies = Array.isArray(data?.cookies) ? data.cookies : [];

            const clearButton = (label, what, count) => {
                const b = h("button", { class: "btn small", type: "button", disabled: !count }, safeIcon("trash"), label);
                b.addEventListener("click", async () => {
                    await attempt(() => call("runtime.clear", activeSuiteId, what), what === "cookies" ? "Cookies cleared" : "Runtime values cleared");
                    if (typeof App.invalidateVars === "function") App.invalidateVars(activeSuiteId); // {{var}} highlighting
                    renderRuntime();
                });
                return b;
            };

            const varTable = vars.length
                ? h("div", { class: "table-wrap ev-table" }, h("table", null,
                    h("thead", null, h("tr", null, h("th", null, "Name"), h("th", null, "Value"), h("th", null, ""))),
                    h("tbody", null, vars.map(([k, v]) => {
                        const value = typeof v === "string" ? v : JSON.stringify(v);
                        const copy = h("button", { class: "btn ghost icon", title: "Copy value", type: "button" }, safeIcon("copy"));
                        copy.addEventListener("click", () => copyText(value));
                        return h("tr", null, h("td", { class: "mono" }, k), h("td", { class: "mono ev-value", title: value }, value.length > 300 ? `${value.slice(0, 300)}…` : value), h("td", { class: "actions" }, copy));
                    }))))
                : h("div", { class: "hint ev-empty-line" }, "Nothing captured yet. Values from Capture rows and scripts with scope “runtime” appear here.");

            const cookieTable = cookies.length
                ? h("div", { class: "table-wrap ev-table" }, h("table", null,
                    h("thead", null, h("tr", null, ["Domain", "Path", "Name", "Value", "Expires", "Flags"].map((t) => h("th", null, t)))),
                    h("tbody", null, cookies.map((c) => h("tr", null,
                        h("td", null, c.domain || ""), h("td", null, c.path || "/"), h("td", { class: "mono" }, c.name),
                        h("td", { class: "mono ev-value", title: c.value }, String(c.value ?? "").slice(0, 200)),
                        h("td", { class: "small" }, !c.expires || c.expires === "Infinity" ? "Session" : fmtTime(c.expires)),
                        h("td", { class: "small" }, [c.httpOnly ? "HttpOnly" : "", c.secure ? "Secure" : ""].filter(Boolean).join(", ")))))))
                : h("div", { class: "hint ev-empty-line" }, "No cookies stored. Cookies set by responses are kept here and sent with later requests to the same site.");

            add(box, 
                h("div", { class: "ev-runtime-section" },
                    h("div", { class: "ve-section-head row" }, h("h3", null, `Captured values (${vars.length})`), h("span", { class: "spacer" }), clearButton("Clear values", "variables", vars.length)),
                    h("div", { class: "hint" }, "Captured during this session. They have the highest priority and are not saved: they are gone after Clear or a restart."),
                    varTable),
                h("div", { class: "ev-runtime-section" },
                    h("div", { class: "ve-section-head row" }, h("h3", null, `Cookies (${cookies.length})`), h("span", { class: "spacer" }), clearButton("Clear cookies", "cookies", cookies.length)),
                    cookieTable));
        }

        // ------------------------------------------------------------ outside changes
        // Saved data is taken over only when it differs from the working copy (our own saves come back here too),
        // nothing is waiting to be saved and the user is not typing in the table that would be replaced.
        const isTyping = () => body.contains(document.activeElement) && /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName);
        const envKey = (list) => JSON.stringify((list || []).map((e) => ({ id: e.id, name: String(e.name || "").trim(), variables: cleanVars(e.variables) })));
        const offs = [
            App.on("suites-changed", () => {
                if (disposed) return;
                if (!App.getSuite(activeSuiteId)) {
                    activeSuiteId = App.activeSuiteId() || suites()[0]?.id || null;
                    envDirty = false;
                    clearTimeout(envTimer);
                    envTimer = null;
                    loadEnvs();
                    render();
                    return;
                }
                if (envDirty || envTimer) return;
                if (envKey(App.getSuite(activeSuiteId).environments) === envKey(envs)) return; // nothing new (e.g. our own save)
                if (activeTab === "environments") {
                    if (isTyping()) return;
                    loadEnvs();
                    renderEnvironments();
                } else loadEnvs();
            }),
            App.on("environment-changed", () => { if (!disposed && activeTab === "environments" && !isTyping()) renderEnvironments(); }),
            App.on("globals-changed", () => {
                if (disposed || globalsDirty || globalsTimer) return;
                if (JSON.stringify(cleanVars(App.state.globals)) === JSON.stringify(cleanVars(globals))) return;
                if (activeTab === "globals" && isTyping()) return; // keep the table the user is typing in
                globals = clone(App.state.globals || []);
                if (activeTab === "globals") renderGlobals();
            }),
            App.on("history-changed", () => { if (!disposed && activeTab === "runtime") renderRuntime(); })
        ];

        loadEnvs();
        renderTabs();
        render();
        if (envId === "new") addEnvironment();
        else if (envId && envs.some((e) => e.id === envId)) { selectedEnvId = envId; renderEnvironments(); }

        const promise = modal({ title: "Environments & variables", body, wide: true, buttons: [{ label: "Close", value: null }] }); // not "primary": Enter in a table cell must not close it
        current = {
            promise,
            show: async (tabId, sid, eid) => {
                await flushAll();
                if (sid && sid !== activeSuiteId && App.getSuite(sid)) { activeSuiteId = sid; selectedEnvId = null; loadEnvs(); }
                if (eid && envs.some((e) => e.id === eid)) selectedEnvId = eid;
                activeTab = ["environments", "globals", "runtime"].includes(tabId) ? tabId : activeTab;
                renderTabs();
                render();
                if (eid === "new" && activeTab === "environments") addEnvironment();
            }
        };
        promise.finally(() => {
            flushAll().catch(() => { /* errors are shown by the save functions */ });
            disposed = true;
            current = null;
            for (const off of offs) { try { if (typeof off === "function") off(); } catch (err) { /* ignore */ } }
        });
        return promise;
    }

    window.Environments = { open };
})();
