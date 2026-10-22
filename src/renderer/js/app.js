"use strict";
/*
 * Application shell: workspace state, document tabs, persistence, top bar / status bar, keyboard shortcuts,
 * menu commands and events from the main process. Views: Sidebar, RequestView (+ ResponseView, JsonView)
 * from this team; SuiteEditor, Environments, Runner, ImportExport, Settings, Welcome, Help from views.
 */

// ------------------------------------------------------------------ renderer side model helpers
// (main normalizes everything it saves; these only build objects in the same shape as core/model.js)
const Model = {
    newRequest(name = "New Request", extra = {}) {
        return {
            id: uid("r"), type: "request", name, description: "", method: "GET", url: "", params: [], headers: [],
            auth: Model.defaultAuth("inherit"), body: Model.defaultBody("none"), assertions: [], extract: [],
            scripts: { pre: "", post: "" }, settings: { timeoutMs: null, followRedirects: null, verifyTls: null }, ...extra
        };
    },
    newFolder(name = "New Folder", extra = {}) {
        return { id: uid("f"), type: "folder", name, description: "", auth: Model.defaultAuth("inherit"), headers: [], variables: [], items: [], ...extra };
    },
    defaultAuth(type = "inherit") {
        return {
            type,
            basic: { username: "", password: "" },
            bearer: { token: "" },
            apikey: { key: "X-API-Key", value: "", in: "header" },
            oauth2: { grantType: "client_credentials", tokenUrl: "", clientId: "", clientSecret: "", scope: "", audience: "", username: "", password: "", clientAuth: "body" }
        };
    },
    defaultBody(mode = "none") {
        return { mode, raw: "", form: [], multipart: [], binaryPath: "", graphql: { query: "", variables: "" } };
    },
    /** -> { item, parents (outer -> inner folders), list, index } or null */
    findItem(suite, id) {
        let found = null;
        const visit = (list, parents) => {
            for (let i = 0; i < list.length; i++) {
                const item = list[i];
                if (item.id === id) { found = { item, parents, list, index: i }; return true; }
                if (item.type === "folder" && visit(item.items || [], [...parents, item])) return true;
            }
            return false;
        };
        if (suite) visit(suite.items || [], []);
        return found;
    },
    walk(items, fn, parents = []) {
        for (const item of items || []) {
            if (fn(item, parents) === false) return false;
            if (item.type === "folder" && Model.walk(item.items, fn, [...parents, item]) === false) return false;
        }
        return true;
    },
    countRequests(items) {
        let n = 0;
        Model.walk(items, (i) => { if (i.type === "request") n++; });
        return n;
    },
    cloneWithNewIds(item) {
        const copy = deepClone(item);
        const remap = (i) => {
            i.id = uid(i.type === "folder" ? "f" : "r");
            for (const a of i.assertions || []) a.id = uid("a");
            for (const x of i.extract || []) x.id = uid("x");
            (i.items || []).forEach(remap);
        };
        remap(copy);
        return copy;
    },
    /** Is `ancestorId` the item itself or one of its parents? (drop target checks) */
    isWithin(suite, itemId, ancestorId) {
        if (itemId === ancestorId) return true;
        const f = Model.findItem(suite, itemId);
        return !!f && f.parents.some((p) => p.id === ancestorId);
    }
};

// ------------------------------------------------------------------ fallback metadata (used if meta.get is unavailable)
const FALLBACK_META = {
    httpMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"],
    bodyModes: ["none", "json", "text", "xml", "form", "multipart", "binary", "graphql"],
    authTypes: ["inherit", "none", "basic", "bearer", "apikey", "oauth2"],
    assertionSources: [
        { value: "status", label: "Status code", needsProperty: false },
        { value: "statusText", label: "Status text", needsProperty: false },
        { value: "responseTime", label: "Response time (ms)", needsProperty: false },
        { value: "size", label: "Body size (bytes)", needsProperty: false },
        { value: "header", label: "Header", needsProperty: true, propertyPlaceholder: "Content-Type" },
        { value: "contentType", label: "Content type", needsProperty: false },
        { value: "body", label: "Body text", needsProperty: false },
        { value: "jsonpath", label: "JSON value", needsProperty: true, propertyPlaceholder: "$.data[0].id" },
        { value: "schema", label: "JSON schema", needsProperty: false }
    ],
    assertionOperators: [
        { value: "equals", label: "equals", needsExpected: true },
        { value: "notEquals", label: "not equals", needsExpected: true },
        { value: "contains", label: "contains", needsExpected: true },
        { value: "notContains", label: "does not contain", needsExpected: true },
        { value: "startsWith", label: "starts with", needsExpected: true },
        { value: "endsWith", label: "ends with", needsExpected: true },
        { value: "gt", label: "greater than", needsExpected: true, numeric: true },
        { value: "gte", label: "greater or equal", needsExpected: true, numeric: true },
        { value: "lt", label: "less than", needsExpected: true, numeric: true },
        { value: "lte", label: "less or equal", needsExpected: true, numeric: true },
        { value: "exists", label: "exists", needsExpected: false },
        { value: "notExists", label: "does not exist", needsExpected: false },
        { value: "matches", label: "matches regex", needsExpected: true },
        { value: "isType", label: "is type", needsExpected: true },
        { value: "lengthEquals", label: "length equals", needsExpected: true, numeric: true },
        { value: "lengthGt", label: "length greater than", needsExpected: true, numeric: true },
        { value: "lengthLt", label: "length less than", needsExpected: true, numeric: true },
        { value: "in", label: "is one of", needsExpected: true },
        { value: "notIn", label: "is not one of", needsExpected: true },
        { value: "isEmpty", label: "is empty", needsExpected: false },
        { value: "isNotEmpty", label: "is not empty", needsExpected: false },
        { value: "validSchema", label: "matches schema", needsExpected: true }
    ],
    extractSources: [
        { value: "jsonpath", label: "JSON value", needsProperty: true, propertyPlaceholder: "$.token" },
        { value: "header", label: "Header", needsProperty: true, propertyPlaceholder: "Location" },
        { value: "regex", label: "Regex on body", needsProperty: true, propertyPlaceholder: "id=(\\d+)" },
        { value: "status", label: "Status code", needsProperty: false },
        { value: "body", label: "Whole body", needsProperty: false },
        { value: "cookie", label: "Cookie", needsProperty: true, propertyPlaceholder: "session" }
    ],
    dynamicVariables: [
        { name: "$guid", description: "Random UUID v4" }, { name: "$uuid", description: "Random UUID v4" },
        { name: "$timestamp", description: "Unix time in seconds" }, { name: "$timestampMs", description: "Unix time in milliseconds" },
        { name: "$isoTimestamp", description: "Current time, ISO 8601 (UTC)" }, { name: "$randomInt", description: "Random integer 0-1000" },
        { name: "$randomFloat", description: "Random number 0-1000" }, { name: "$randomString", description: "Random 12 character string" },
        { name: "$randomEmail", description: "Random e-mail address" }, { name: "$randomBoolean", description: "true or false" }
    ]
};

const DEFAULT_SETTINGS = {
    timeoutMs: 30000, followRedirects: true, verifyTls: true, enforceTlsVerification: false, proxy: { enabled: false, url: "", noProxy: "localhost,127.0.0.1" },
    maxResponseMB: 20, historySize: 100, echoServer: { autoStart: false, port: 3999 }, theme: "system"
};

/** The sample suite's environment for the built-in echo server (core/sample.js). */
const ECHO_ENVIRONMENT = "Local echo server";
/** A busy echo server port moves to one of the next ports (3999 -> 4000 ... 4010). */
const ECHO_PORT_TRIES = 12;

// ------------------------------------------------------------------ App

const App = {
    state: { suites: [], globals: [], settings: { ...DEFAULT_SETTINGS }, history: [], ui: {}, info: {}, meta: FALLBACK_META },
    listeners: {},
    tabs: [],
    activeTabId: null,
    selectedSuiteId: null, // sidebar selection, used when no tab is active
    saveChain: Promise.resolve(),
    lastCommand: { name: null, time: 0 },
    echoSyncing: new Set(), // suite ids whose echo environment is being updated
    mac: /Mac/i.test(navigator.platform),

    // ------------------------------------------------------------ events
    on(event, cb) {
        (this.listeners[event] = this.listeners[event] || []).push(cb);
        return () => { this.listeners[event] = (this.listeners[event] || []).filter((x) => x !== cb); };
    },
    emit(event, data) {
        for (const cb of [...(this.listeners[event] || [])]) {
            try { cb(data); } catch (err) { console.error(`[${event}]`, err); }
        }
    },

    // ------------------------------------------------------------ state access
    getSuite(id) { return this.state.suites.find((s) => s.id === id) || null; },
    activeSuiteId() {
        const tab = this.activeTab();
        if (tab && tab.suiteId && this.getSuite(tab.suiteId)) return tab.suiteId;
        if (this.selectedSuiteId && this.getSuite(this.selectedSuiteId)) return this.selectedSuiteId;
        return this.state.suites[0]?.id || null;
    },
    activeTab() { return this.tabs.find((t) => t.id === this.activeTabId) || null; },
    meta() { return this.state.meta || FALLBACK_META; },
    dynamicVariables() {
        const d = this.meta().dynamicVariables;
        if (Array.isArray(d)) return d.map((x) => (typeof x === "string" ? { name: x, description: "" } : { name: x.name || x.key, description: x.description || "" }));
        if (d && typeof d === "object") return Object.entries(d).map(([name, v]) => ({ name, description: typeof v === "string" ? v : v?.description || "" }));
        return FALLBACK_META.dynamicVariables;
    },
    effectiveSettings() { return { ...DEFAULT_SETTINGS, ...(this.state.settings || {}) }; },

    // ------------------------------------------------------------ security helpers
    /**
     * TLS certificate checks of a request when it is sent: { off, overridden, from }. off: certificates are not
     * verified; overridden: the request (or Settings) turns verification off, but Settings → "Enforce TLS
     * verification" is on, so they are verified anyway. from: "request" | "settings".
     */
    tlsState(request) {
        const s = this.effectiveSettings();
        const own = request && request.settings && typeof request.settings.verifyTls === "boolean" ? request.settings.verifyTls : null;
        const wanted = own === null ? s.verifyTls !== false : own;
        const enforced = s.enforceTlsVerification === true;
        return { off: !wanted && !enforced, overridden: !wanted && enforced, from: own === null ? "settings" : "request" };
    },
    /**
     * A request or run was not sent because it uploads local files that are not allowed yet (needs: main's
     * needsFileApproval). Main asks the user in a native dialog; -> true when allowed (then send / run again).
     */
    async allowUploads(needs, context = "send") {
        if (!needs || !Array.isArray(needs.files) || !needs.files.length) return false;
        const r = await attempt(() => api.call("files.approve", { suiteId: needs.suiteId || null, files: needs.files, context }));
        this.emit("file-approvals-changed", { suiteId: needs.suiteId || null });
        return !!(r && r.approved);
    },

    // ------------------------------------------------------------ persistence
    /** Persists a suite (insert or replace), updates state and emits "suites-changed". Saves are serialized. */
    saveSuite(suite) {
        const run = async () => {
            const saved = await api.call("workspace.saveSuite", suite);
            this.applySuite(saved || suite);
            return saved || suite;
        };
        const p = this.saveChain.then(run, run);
        this.saveChain = p.catch(() => {});
        return p;
    },
    /** Puts a suite object from main into the state and refreshes everything that shows it. */
    applySuite(suite, { silent = false } = {}) {
        if (!suite || !suite.id) return;
        const idx = this.state.suites.findIndex((s) => s.id === suite.id);
        if (idx >= 0) this.state.suites[idx] = suite; else this.state.suites.push(suite);
        for (const tab of [...this.tabs]) if (tab.suiteId === suite.id) this.syncTabWithSuite(tab); // may close tabs
        this.invalidateVars(suite.id);
        this.renderTabs();
        this.renderEnvPicker();
        if (!silent) this.emit("suites-changed", { suiteId: suite.id, suite });
    },
    async deleteSuite(id) {
        await api.call("workspace.deleteSuite", id);
        this.state.suites = this.state.suites.filter((s) => s.id !== id);
        for (const tab of [...this.tabs]) if (tab.suiteId === id) this.closeTab(tab.id, { force: true });
        if (this.selectedSuiteId === id) this.selectedSuiteId = null;
        this.renderEnvPicker();
        this.emit("suites-changed", { suiteId: id, deleted: true });
    },
    async reorderSuites(ids) {
        const byId = new Map(this.state.suites.map((s) => [s.id, s]));
        this.state.suites = ids.map((id) => byId.get(id)).filter(Boolean);
        this.emit("suites-changed", { reordered: true });
        await attempt(() => api.call("workspace.reorderSuites", ids));
    },
    async saveGlobals(globals) {
        const saved = await api.call("workspace.saveGlobals", globals);
        this.state.globals = Array.isArray(saved) ? saved : globals;
        this.invalidateVars();
        this.emit("globals-changed", { globals: this.state.globals });
        return this.state.globals;
    },
    async saveSettings(settings) {
        const saved = await api.call("workspace.saveSettings", settings);
        this.state.settings = { ...DEFAULT_SETTINGS, ...(saved || settings) };
        this.applyTheme();
        this.emit("settings-changed", this.state.settings);
        return this.state.settings;
    },
    /** Merges a patch into the UI state and saves it (debounced). */
    saveUi(patch) {
        if (patch) Object.assign(this.state.ui, patch);
        this.persistUi();
    },
    persistUi: debounce(() => App.writeUi(), 500),
    writeUi() {
        const ui = this.state.ui;
        ui.openTabs = this.tabs.filter((t) => t.kind !== "runner").map((t) => {
            const out = { kind: t.kind, suiteId: t.suiteId || null, itemId: t.itemId || null };
            if (t.kind === "request") {
                if (t.temp) { out.temp = true; out.title = t.title; }
                if (t.temp || t.dirty) out.draft = t.draft; // unsaved edits survive a restart
                if (t.reqTab) out.reqTab = t.reqTab;
                if (t.autoCreated) out.autoCreated = t.autoCreated; // a blank new request is still cleaned up after a restart
            }
            return out;
        });
        ui.activeTab = this.activeTabId;
        ui.activeIndex = Math.max(0, this.tabs.findIndex((t) => t.id === this.activeTabId)); // temp tabs get new ids on restore
        api.call("workspace.saveUi", ui).catch((err) => console.warn("saveUi failed:", err.message));
    },

    activeEnvironmentId(suiteId) {
        const suite = this.getSuite(suiteId);
        if (!suite) return null;
        if ((this.state.ui.noEnvironment || []).includes(suiteId)) return null;
        const id = suite.activeEnvironmentId;
        return (suite.environments || []).some((e) => e.id === id) ? id : null;
    },
    activeEnvironment(suiteId) {
        const id = this.activeEnvironmentId(suiteId);
        return id ? (this.getSuite(suiteId).environments || []).find((e) => e.id === id) : null;
    },
    /** envId null = "No environment" (kept in the UI state: suites always store an environment when they have one). */
    async setActiveEnvironment(suiteId, envId) {
        const suite = this.getSuite(suiteId);
        if (!suite) return;
        const noEnv = new Set(this.state.ui.noEnvironment || []);
        if (!envId) noEnv.add(suiteId); else noEnv.delete(suiteId);
        this.saveUi({ noEnvironment: [...noEnv] });
        if (envId && suite.activeEnvironmentId !== envId) {
            const copy = deepClone(suite);
            copy.activeEnvironmentId = envId;
            await this.saveSuite(copy);
        }
        this.invalidateVars(suiteId);
        this.renderEnvPicker();
        this.emit("environment-changed", { suiteId, environmentId: envId || null });
    },

    // ------------------------------------------------------------ variables (cached snapshots for highlighting)
    varCache: new Map(),
    invalidateVars(suiteId) {
        if (!suiteId) this.varCache.clear();
        else for (const k of [...this.varCache.keys()]) if (k.startsWith(`${suiteId}|`) || k.startsWith("|")) this.varCache.delete(k);
        this.emit("vars-invalidated", { suiteId: suiteId || null });
    },
    /** -> Promise<Map name -> { value, source, secret }> */
    loadVars(suiteId, requestId) {
        const envId = this.activeEnvironmentId(suiteId);
        const key = `${suiteId || ""}|${requestId || ""}|${envId || ""}`;
        if (this.varCache.has(key)) return this.varCache.get(key);
        const p = api.call("variables.snapshot", { suiteId: suiteId || null, requestId: requestId || null, environmentId: envId })
            .then((list) => {
                const map = new Map();
                for (const v of Array.isArray(list) ? list : (list?.variables || [])) map.set(v.key, { value: v.value ?? "", source: v.source, secret: !!v.secret });
                return map;
            })
            .catch(() => {
                // fall back to what the renderer knows (globals + suite + environment)
                const map = new Map();
                const add = (list, source) => { for (const v of list || []) if (v.enabled !== false && v.key && !map.has(v.key)) map.set(v.key, { value: v.value, source, secret: !!v.secret }); };
                const suite = this.getSuite(suiteId);
                add(this.activeEnvironment(suiteId)?.variables, "environment");
                add(suite?.variables, "suite");
                add(this.state.globals, "global");
                return map;
            });
        this.varCache.set(key, p);
        return p;
    },

    // ------------------------------------------------------------ tabs
    tabTitle(tab) {
        if (tab.kind === "runner") return "Runner";
        if (tab.kind === "settings") {
            const suite = this.getSuite(tab.suiteId);
            if (!tab.itemId) return suite ? suite.name : "Suite";
            const f = Model.findItem(suite, tab.itemId);
            return f ? f.item.name : "Folder";
        }
        return (tab.draft && tab.draft.name) || tab.title || "Request";
    },
    findTab(id) { return this.tabs.find((t) => t.id === id) || null; },

    createPane(tab) {
        tab.pane = h("div", { class: "tab-pane", dataset: { tab: tab.id } });
        document.getElementById("tab-content").appendChild(tab.pane);
    },
    /** Builds the view of a tab the first time it is shown. */
    mountTab(tab) {
        if (tab.mounted) return;
        if (!tab.pane) this.createPane(tab);
        tab.mounted = true;
        try {
            if (tab.kind === "request") {
                tab.view = RequestView.create(tab);
                tab.pane.appendChild(tab.view.el);
            } else if (tab.kind === "settings") {
                tab.pane.classList.add("scroll");
                if (typeof SuiteEditor === "undefined") tab.pane.appendChild(missingView("Suite settings"));
                else tab.unmount = SuiteEditor.mount(tab.pane, { suiteId: tab.suiteId, folderId: tab.itemId || null });
            } else if (tab.kind === "runner") {
                tab.pane.classList.add("scroll");
                if (typeof Runner === "undefined") tab.pane.appendChild(missingView("Runner"));
                else tab.unmount = Runner.mount(tab.pane, { ...(tab.opts || {}) });
            }
        } catch (err) {
            console.error(err);
            tab.pane.appendChild(h("div", { class: "empty" }, h("h3", null, "This view could not be shown"), h("p", null, err.message)));
        }
    },
    unmountTab(tab) {
        try {
            if (tab.view && tab.view.destroy) tab.view.destroy();
            if (typeof tab.unmount === "function") tab.unmount();
        } catch (err) { console.error(err); }
        tab.view = null;
        tab.unmount = null;
        tab.mounted = false;
        if (tab.pane) { tab.pane.remove(); tab.pane = null; }
    },
    addTab(tab, { activate = true, index } = {}) {
        if (index === undefined) {
            // open next to the active tab (like browsers)
            const ai = this.tabs.findIndex((t) => t.id === this.activeTabId);
            index = ai >= 0 ? ai + 1 : this.tabs.length;
        }
        this.tabs.splice(index, 0, tab);
        if (activate) this.activateTab(tab.id); else this.renderTabs();
        this.persistUi();
        return tab;
    },
    activateTab(id) {
        const tab = this.findTab(id);
        if (!tab) return;
        const prev = this.activeTab();
        if (prev && prev !== tab && prev.view && prev.view.onHide) prev.view.onHide();
        this.activeTabId = id;
        this.mountTab(tab);
        for (const t of this.tabs) if (t.pane) t.pane.classList.toggle("active", t.id === id);
        document.getElementById("home-pane")?.classList.toggle("active", false);
        if (tab.suiteId) this.selectedSuiteId = tab.suiteId;
        if (tab.view && tab.view.onShow) tab.view.onShow();
        this.renderTabs();
        this.renderEnvPicker();
        this.emit("active-tab-changed", tab);
        this.persistUi();
        // keep the active tab visible in the strip
        const el = document.querySelector(`#doc-tabs .doc-tab[data-id="${CSS.escape(id)}"]`);
        if (el) el.scrollIntoView({ block: "nearest", inline: "nearest" });
    },
    async closeTab(id, { force = false } = {}) {
        const tab = this.findTab(id);
        if (!tab) return true;
        if (!force && tab.kind === "request" && (tab.dirty || (tab.temp && tab.touched))) {
            const choice = await modal({
                title: "Unsaved changes",
                body: h("div", { class: "confirm-text" }, `"${this.tabTitle(tab)}" has changes that are not saved.`),
                buttons: [{ label: "Cancel", value: null }, { label: "Don't save", class: "danger-outline", value: "discard" }, { label: "Save", class: "primary", value: "save" }]
            });
            if (!choice) return false;
            if (choice === "save" && !(await this.saveRequestTab(tab))) return false;
        }
        if (!force && tab.kind === "request" && tab.sending && tab.view) tab.view.cancel();
        const idx = this.tabs.indexOf(tab);
        this.tabs.splice(idx, 1);
        this.unmountTab(tab);
        if (!force) this.discardIfUntouched(tab); // forced closes come from deletions that save the suite themselves
        if (this.activeTabId === id) {
            const next = this.tabs[idx] || this.tabs[idx - 1];
            this.activeTabId = null;
            if (next) this.activateTab(next.id);
            else this.showHome();
        } else this.renderTabs();
        this.persistUi();
        return true;
    },
    async closeTabs(filter) {
        for (const t of this.tabs.filter(filter)) {
            if (!(await this.closeTab(t.id))) return false;
        }
        return true;
    },
    showHome() {
        this.activeTabId = null;
        for (const t of this.tabs) if (t.pane) t.pane.classList.remove("active");
        let home = document.getElementById("home-pane");
        if (!home) {
            home = h("div", { class: "tab-pane scroll", id: "home-pane" });
            document.getElementById("tab-content").appendChild(home);
        }
        renderHome(home);
        home.classList.add("active");
        this.renderTabs();
        this.renderEnvPicker();
        this.emit("active-tab-changed", null);
    },

    /** Keeps a request tab in line with its saved request (title, baseline; draft when not edited). */
    syncTabWithSuite(tab) {
        const suite = this.getSuite(tab.suiteId);
        if (tab.kind === "settings") {
            if (!suite || (tab.itemId && !Model.findItem(suite, tab.itemId))) this.closeTab(tab.id, { force: true });
            return;
        }
        if (tab.kind !== "request" || tab.temp) return;
        const found = suite ? Model.findItem(suite, tab.itemId) : null;
        if (!found) {
            // the request was deleted: keep the edits as an unsaved copy rather than losing them
            if (tab.dirty) { tab.temp = true; tab.title = tab.draft.name; tab.touched = true; if (tab.view) tab.view.refreshHeader(); }
            else this.closeTab(tab.id, { force: true });
            return;
        }
        const saved = normalizeDraft(deepClone(found.item));
        const savedText = JSON.stringify(saved);
        if (savedText === tab.baseline) { if (tab.view) tab.view.refreshHeader(); return; }
        tab.baseline = savedText;
        if (!tab.dirty) {
            tab.draft = saved;
            if (tab.view) tab.view.reload();
        } else {
            tab.dirty = JSON.stringify(tab.draft) !== tab.baseline;
            if (tab.view) tab.view.refreshHeader();
        }
    },

    openRequest(suiteId, requestId, { activate = true } = {}) {
        const id = `r:${suiteId}:${requestId}`;
        const existing = this.findTab(id);
        if (existing) { if (activate) this.activateTab(id); return existing; }
        const suite = this.getSuite(suiteId);
        const found = Model.findItem(suite, requestId);
        if (!found || found.item.type !== "request") { toast("That request no longer exists", "warn"); return null; }
        const draft = normalizeDraft(deepClone(found.item));
        const tab = { id, kind: "request", suiteId, itemId: requestId, draft, baseline: JSON.stringify(draft), dirty: false, result: null };
        return this.addTab(tab, { activate });
    },
    /** Opens an unsaved request (history copy, pasted cURL, ...). */
    openTemp(request, { title, suiteId = null, touched = false } = {}) {
        const draft = normalizeDraft(deepClone(request));
        if (!draft.id) draft.id = uid("r");
        const tab = { id: `t:${uid("t")}`, kind: "request", temp: true, touched, suiteId: suiteId && this.getSuite(suiteId) ? suiteId : null, itemId: null,
            draft, baseline: JSON.stringify(draft), dirty: false, title: title || draft.name, result: null };
        return this.addTab(tab);
    },
    openHistory(entry) {
        if (!entry || !entry.request) return toast("This history entry has no request data", "warn");
        const req = deepClone(entry.request);
        const tab = this.openTemp(req, { title: req.name || entry.name, suiteId: entry.suiteId });
        // the history keeps no passwords, tokens or API keys (workspace.js): say so where they are missing
        if (entry.credentialsRemoved) {
            toast("The history does not keep credentials: passwords, tokens and API keys of this copy are empty or shown as •••••. Enter them again, or open the saved request.", "info", 8000);
        }
        return tab;
    },
    openItemSettings(suiteId, folderId = null) {
        const id = `s:${suiteId}:${folderId || "suite"}`;
        const existing = this.findTab(id);
        if (existing) return this.activateTab(id);
        if (!this.getSuite(suiteId)) return toast("That suite no longer exists", "warn");
        this.addTab({ id, kind: "settings", suiteId, itemId: folderId || null });
    },
    showRunner(opts = {}) {
        const suiteId = opts.suiteId || this.activeSuiteId();
        if (!suiteId) return toast("Create or import a suite first", "warn");
        const tab = this.findTab("runner");
        const nextOpts = { suiteId, itemIds: opts.itemIds || [] };
        if (tab) {
            // remount only when asked for something else (a running run keeps going otherwise)
            if (JSON.stringify(tab.opts) !== JSON.stringify(nextOpts) && (opts.suiteId || opts.itemIds)) {
                tab.opts = nextOpts;
                tab.suiteId = suiteId;
                this.unmountTab(tab);
            }
            return this.activateTab("runner");
        }
        this.addTab({ id: "runner", kind: "runner", suiteId, opts: nextOpts }, { index: this.tabs.length });
    },
    closeRunner() { return this.closeTab("runner", { force: true }); },

    /** Called by the request editor after every edit. */
    requestChanged(tab) {
        const wasDirty = tab.dirty;
        tab.dirty = JSON.stringify(tab.draft) !== tab.baseline;
        if (tab.temp) tab.touched = true;
        if (wasDirty !== tab.dirty || tab.temp) this.renderTabs();
        this.persistUi();
    },

    /** Saves a request tab into its suite. Unsaved copies ask where to save. Returns true when saved. */
    async saveRequestTab(tab) {
        if (!tab || tab.kind !== "request") return false;
        if (tab.view && tab.view.beforeSave) tab.view.beforeSave();
        // the suggested name goes into the draft itself: the saved version then equals the draft (no stale dirty state)
        if ((!tab.draft.name || tab.draft.name === "New Request") && tab.draft.url) {
            tab.draft.name = suggestName(tab.draft);
            if (tab.view) tab.view.refreshHeader();
        }
        const draft = deepClone(tab.draft);
        if (tab.temp) return this.saveRequestAs(tab, draft);
        const suite = deepClone(this.getSuite(tab.suiteId));
        const found = suite && Model.findItem(suite, tab.itemId);
        if (!found) return this.saveRequestAs(tab, draft);
        found.list[found.index] = { ...draft, id: tab.itemId, type: "request" };
        try {
            await this.saveSuite(suite);
        } catch (err) {
            toast(`Could not save: ${cleanError(err)}`, "error");
            return false;
        }
        const saved = Model.findItem(this.getSuite(tab.suiteId), tab.itemId);
        tab.draft = normalizeDraft(deepClone(saved ? saved.item : draft));
        tab.baseline = JSON.stringify(tab.draft);
        tab.dirty = false;
        tab.autoCreated = null; // saved on purpose: keep it
        if (tab.view) tab.view.reload({ keepResult: true });
        this.renderTabs();
        this.persistUi();
        toast("Saved", "success", 1400);
        return true;
    },
    async saveRequestAs(tab, draft) {
        const target = await pickLocation({ title: "Save request", name: draft.name || "New Request", suiteId: tab.suiteId || this.activeSuiteId() });
        if (!target) return false;
        let suite = target.suiteId ? deepClone(this.getSuite(target.suiteId)) : null;
        if (!suite) {
            suite = await this.saveSuite({ name: "My Suite", items: [] }).catch((err) => { toast(cleanError(err), "error"); return null; });
            if (!suite) return false;
            suite = deepClone(suite);
        }
        const item = { ...draft, id: uid("r"), type: "request", name: target.name };
        const parent = target.folderId ? Model.findItem(suite, target.folderId)?.item : null;
        (parent ? parent.items : suite.items).push(item);
        try { await this.saveSuite(suite); } catch (err) { toast(`Could not save: ${cleanError(err)}`, "error"); return false; }
        // files chosen for this unsaved request stay allowed for upload in the suite it is saved to
        const files = requestFilePaths(draft);
        if (!tab.suiteId && files.length) await api.call("files.carryApprovals", { toSuiteId: suite.id, paths: files }).catch(() => {});
        // turn the tab into a normal one bound to the saved request
        const oldId = tab.id;
        tab.temp = false;
        tab.touched = false;
        tab.suiteId = suite.id;
        tab.itemId = item.id;
        tab.id = `r:${suite.id}:${item.id}`;
        if (this.activeTabId === oldId) this.activeTabId = tab.id;
        if (tab.pane) tab.pane.dataset.tab = tab.id;
        const saved = Model.findItem(this.getSuite(suite.id), item.id);
        tab.draft = normalizeDraft(deepClone(saved ? saved.item : item));
        tab.baseline = JSON.stringify(tab.draft);
        tab.dirty = false;
        if (tab.view) tab.view.reload({ keepResult: true });
        if (typeof Sidebar !== "undefined") Sidebar.reveal(suite.id, item.id);
        this.renderTabs();
        this.renderEnvPicker();
        this.persistUi();
        toast(`Saved to ${suite.name}`, "success");
        return true;
    },

    // ------------------------------------------------------------ creating things
    async newSuite(name) {
        const suiteName = name || await promptDialog("New suite", "Name", "My API", { okLabel: "Create", hint: "A suite groups requests, folders and environments. You can export it as one file." });
        if (!suiteName) return null;
        const saved = await attempt(() => this.saveSuite({ name: suiteName, items: [] }));
        if (saved) {
            this.selectedSuiteId = saved.id;
            if (typeof Sidebar !== "undefined") Sidebar.expand(saved.id);
            this.renderEnvPicker();
            // show the new suite: its settings (base URL variables, auth, headers) are the usual next step
            this.openItemSettings(saved.id, null);
        }
        return saved || null;
    },
    /**
     * Creates a request in a suite (or folder) and opens it. It is saved right away, so it inherits the folder's
     * auth, headers and variables when sent. A blank one whose tab is closed again without being saved by the
     * user is removed (discardIfUntouched), so quick tries leave no empty "New Request" behind.
     * Without any suite an unsaved tab opens; Save then asks where to keep it.
     */
    async newRequest({ suiteId, folderId, request } = {}) {
        const sid = suiteId || this.activeSuiteId();
        let fid = folderId;
        if (!sid) {
            const temp = this.openTemp(request || Model.newRequest("New Request"), { touched: !!request });
            if (temp && temp.view) setTimeout(() => temp.view.focusUrl(), 30);
            return temp;
        }
        if (fid === undefined && !suiteId) {
            // from a shortcut: next to the request that is being edited
            const tab = this.activeTab();
            if (tab && tab.kind === "request" && tab.suiteId === sid && tab.itemId) {
                const f = Model.findItem(this.getSuite(sid), tab.itemId);
                fid = f && f.parents.length ? f.parents[f.parents.length - 1].id : null;
            }
        }
        const suite = deepClone(this.getSuite(sid));
        const item = request ? { ...deepClone(request), id: uid("r"), type: "request" } : Model.newRequest("New Request");
        const parent = fid ? Model.findItem(suite, fid)?.item : null;
        (parent && parent.type === "folder" ? parent.items : suite.items).push(item);
        const saved = await attempt(() => this.saveSuite(suite));
        if (!saved) return null;
        if (typeof Sidebar !== "undefined") Sidebar.reveal(sid, item.id);
        const tab = this.openRequest(sid, item.id);
        if (tab && !request) { tab.autoCreated = tab.baseline; this.persistUi(); }
        if (tab && tab.view) setTimeout(() => tab.view.focusUrl(), 30);
        return tab;
    },
    /**
     * Removes a blank request made by newRequest when its tab closes while the saved version is still exactly as
     * created (the user never saved it, or chose "Don't save"). Saved or renamed ones are kept.
     */
    isUntouchedNew(tab) {
        if (!tab || tab.kind !== "request" || tab.temp || !tab.autoCreated) return false;
        const suite = this.getSuite(tab.suiteId);
        const found = suite && Model.findItem(suite, tab.itemId);
        if (!found || found.item.type !== "request") return false;
        return JSON.stringify(normalizeDraft(deepClone(found.item))) === tab.autoCreated;
    },
    /**
     * Ids of blank requests that were just created (Ctrl+N / +) and never saved by the user. They are in the
     * suite only so they inherit folder settings while being edited; the Runner leaves them out.
     */
    untouchedNewRequestIds(suiteId) {
        return new Set(this.tabs.filter((t) => t.suiteId === suiteId && this.isUntouchedNew(t)).map((t) => t.itemId));
    },
    discardIfUntouched(tab) {
        if (!this.isUntouchedNew(tab)) return;
        const suite = this.getSuite(tab.suiteId);
        const copy = deepClone(suite);
        const f = Model.findItem(copy, tab.itemId);
        f.list.splice(f.index, 1);
        this.saveSuite(copy).catch((err) => toast(`Could not remove the empty request: ${cleanError(err)}`, "error"));
    },
    async newFolder({ suiteId, folderId } = {}) {
        const sid = suiteId || this.activeSuiteId();
        if (!sid) return toast("Create a suite first", "warn");
        const name = await promptDialog("New folder", "Name", "New Folder", { okLabel: "Create", hint: "Folders can have their own variables, headers and auth for the requests inside." });
        if (!name) return null;
        const suite = deepClone(this.getSuite(sid));
        const folder = Model.newFolder(name);
        const parent = folderId ? Model.findItem(suite, folderId)?.item : null;
        (parent ? parent.items : suite.items).push(folder);
        const saved = await attempt(() => this.saveSuite(suite));
        if (saved && typeof Sidebar !== "undefined") Sidebar.reveal(sid, folder.id);
        return saved ? folder : null;
    },
    /**
     * Adds the sample suite. The echo server is started first (on the next free port when the configured one
     * is busy), so the sample's "Local echo server" environment points at the server that really runs.
     * Returns the saved suite, or null when nothing was added (the welcome dialog then stays open).
     */
    async addSampleSuite() {
        const echo = await this.ensureEchoForSample();
        if (!echo) return null;
        const sample = await attempt(() => api.call("tools.sampleSuite")); // uses the running server's URL
        if (!sample) return null;
        const saved = await attempt(() => this.saveSuite(sample), "Sample suite added");
        if (!saved) return null;
        if (typeof Sidebar !== "undefined") Sidebar.expandAll(saved.id);
        let first = null;
        Model.walk(saved.items, (i) => { if (i.type === "request") { first = i; return false; } return true; });
        if (first) this.openRequest(saved.id, first.id);
        return saved;
    },

    // ------------------------------------------------------------ active tab actions
    saveActive() {
        const tab = this.activeTab();
        if (tab && tab.kind === "request") return this.saveRequestTab(tab);
        if (tab && tab.kind === "settings") return; // the suite editor saves its own changes
        return undefined;
    },
    sendActive() {
        const tab = this.activeTab();
        if (tab && tab.kind === "request" && tab.view) tab.view.send();
    },
    cycleTab(dir) {
        if (!this.tabs.length) return;
        const i = this.tabs.findIndex((t) => t.id === this.activeTabId);
        const next = this.tabs[(i + dir + this.tabs.length) % this.tabs.length];
        if (next) this.activateTab(next.id);
    },

    // ------------------------------------------------------------ commands (menu + shortcuts)
    command(name, source = "ui") {
        // menu accelerators and our own key handler may both fire for one key press
        const now = Date.now();
        if (this.lastCommand.name === name && now - this.lastCommand.time < 250 && this.lastCommand.source !== source) return;
        this.lastCommand = { name, time: now, source };
        const views = viewGlobals();
        const need = (v, label) => { if (!v) toast(`${label} is not available`, "error"); return !!v; };
        switch (name) {
            case "newSuite": return this.newSuite();
            case "newRequest": return this.newRequest();
            case "newFolder": return this.newFolder();
            case "import": return need(views.ImportExport, "Import") && views.ImportExport.openImport();
            case "exportSuite": {
                const sid = this.activeSuiteId();
                if (!sid) return toast("There is no suite to export yet", "warn");
                return need(views.ImportExport, "Export") && views.ImportExport.openExport(sid);
            }
            case "save": return this.saveActive();
            case "send": return this.sendActive();
            case "runner": return this.showRunner({});
            case "settings": return need(views.Settings, "Settings") && views.Settings.open();
            case "environments": {
                const sid = this.activeSuiteId();
                if (!sid) return toast("Create or import a suite first: environments belong to a suite", "warn");
                return need(views.Environments, "Environments") && views.Environments.open(sid);
            }
            case "toggleTheme": return this.toggleTheme();
            case "help": return need(views.Help, "Help") && views.Help.open();
            case "about": return this.showAbout();
            case "closeTab": return this.activeTabId && this.closeTab(this.activeTabId);
            case "welcome": return need(views.Welcome, "Welcome") && views.Welcome.show();
            case "sample": return this.addSampleSuite();
            default: console.warn("Unknown command", name);
        }
        return undefined;
    },

    onKeyDown(e) {
        if (e.defaultPrevented || e.isComposing) return;
        const mod = this.mac ? e.metaKey : e.ctrlKey;
        const modalOpen = !!document.querySelector("#modal-root .modal-backdrop");
        const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
        if (e.key === "F1") { e.preventDefault(); return this.command("help", "key"); }
        if (e.ctrlKey && e.key === "Tab" && !modalOpen) { e.preventDefault(); return this.cycleTab(e.shiftKey ? -1 : 1); }
        if (!mod || e.altKey) return;
        if (modalOpen) return; // dialogs handle their own keys
        let cmd = null;
        if (key === "Enter") cmd = "send";
        else if (key === "s" && !e.shiftKey) cmd = "save";
        else if (key === "w" && !e.shiftKey) cmd = "closeTab";
        else if (key === "n" && !e.shiftKey) cmd = "newRequest";
        else if (key === "n" && e.shiftKey) cmd = "newSuite";
        else if (key === "o" && !e.shiftKey) cmd = "import";
        else if (key === "e" && !e.shiftKey) cmd = "environments";
        else if (key === "," && !e.shiftKey) cmd = "settings";
        else if (key === "r" && e.shiftKey) cmd = "runner";
        else if ((key === "k" || key === "p") && !e.shiftKey) {
            e.preventDefault();
            if (typeof Sidebar !== "undefined") Sidebar.focusSearch();
            return;
        } else if (key === "l" && !e.shiftKey) {
            const tab = this.activeTab();
            if (tab && tab.view && tab.view.focusUrl) { e.preventDefault(); tab.view.focusUrl(); }
            return;
        } else if (/^[1-9]$/.test(key) && !e.shiftKey) {
            const t = key === "9" ? this.tabs[this.tabs.length - 1] : this.tabs[Number(key) - 1];
            if (t) { e.preventDefault(); this.activateTab(t.id); }
            return;
        }
        if (cmd) { e.preventDefault(); this.command(cmd, "key"); }
    },

    // ------------------------------------------------------------ theme
    effectiveTheme() {
        const t = this.state.settings.theme || "system";
        if (t === "light" || t === "dark") return t;
        return window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    },
    applyTheme() {
        document.documentElement.dataset.theme = this.effectiveTheme();
        this.renderTopbar();
    },
    async toggleTheme() {
        const next = this.effectiveTheme() === "dark" ? "light" : "dark";
        document.documentElement.dataset.theme = next;
        await attempt(() => this.saveSettings({ ...this.state.settings, theme: next }));
    },

    // ------------------------------------------------------------ echo server (the local test API)
    setEcho(status) {
        this.state.info.echoServer = status || { running: false };
        this.renderStatusbar();
        this.emit("echo-changed", this.state.info.echoServer);
        this.syncEchoEnvironments(this.state.info.echoServer);
    },

    /**
     * Starts the echo server. When the configured port is used by another program, the next ports are tried
     * (3999 -> 4000 ... 4010) and the port that worked is saved in Settings, so the next app start (auto start)
     * uses it too. Resolves the status when it runs; otherwise { running: false, error }.
     */
    async startEchoServer() {
        const current = await api.call("echo.status").catch(() => null);
        if (current && current.running) { this.setEcho(current); return current; }
        const settings = this.effectiveSettings();
        const configured = Math.min(65535, Math.max(1, Number(settings.echoServer && settings.echoServer.port) || 3999));
        const lastPort = Math.min(65535, configured + ECHO_PORT_TRIES - 1);
        let error = null;
        let busy = 0;
        for (let port = configured; port <= lastPort; port++) {
            try {
                const status = await api.call("echo.start", port);
                if (!status || !status.running) continue;
                this.setEcho(status);
                if (status.port !== configured) {
                    await this.saveSettings({ ...this.state.settings, echoServer: { ...(settings.echoServer || {}), port: status.port } })
                        .catch((err) => console.warn("Could not save the echo server port:", err.message));
                    toast(`Port ${configured} is used by another program, so the echo server runs on port ${status.port} (saved in Settings).`, "info", 6000);
                }
                return status;
            } catch (err) {
                error = cleanError(err);
                if (!/already in use|EADDRINUSE/i.test(error)) break; // only a busy port is worth another try
                busy++;
            }
        }
        if (busy > 1 && busy === lastPort - configured + 1) error = `Ports ${configured} to ${lastPort} are all in use by other programs.`;
        const failed = await api.call("echo.status").catch(() => ({ running: false }));
        this.setEcho(failed);
        return { running: false, error: error || "The echo server did not start." };
    },

    /** Echo server for the sample suite. Asks what to do when it cannot start. -> status, or null = cancelled. */
    async ensureEchoForSample() {
        const status = await this.startEchoServer();
        if (status.running) return status;
        const port = this.effectiveSettings().echoServer?.port || 3999;
        const choice = await modal({
            title: "The echo server did not start",
            body: h("div", { class: "stack tight" },
                h("div", { class: "confirm-text" }, "The sample suite sends its requests to the echo server, a small test API on this computer. It could not start:"),
                h("div", { class: "callout bad" }, icon("alert"), h("div", null, status.error)),
                h("div", { class: "confirm-text" }, "Choose another port in Settings → Local echo server, then try again. ",
                    "If you add the sample now, its requests go to ", h("code", null, `http://127.0.0.1:${port}`), " and fail or reach another program.")),
            buttons: [
                { label: "Add anyway", class: "danger-outline", value: "add" },
                { spacer: true },
                { label: "Cancel", value: null },
                { label: "Open Settings", class: "primary", value: "settings" }
            ]
        });
        if (choice === "settings") {
            if (typeof Settings !== "undefined") setTimeout(() => Settings.open(), 0);
            return null;
        }
        return choice === "add" ? status : null;
    },

    /**
     * Keeps the sample's "Local echo server" environment pointing at the running echo server when it moves to
     * another port (Settings change, busy port). Only a plain loopback baseUrl (http://127.0.0.1:<port>) is changed.
     */
    syncEchoEnvironments(status) {
        if (!status || !status.running || !status.port) return;
        const target = String(status.url || `http://127.0.0.1:${status.port}`).replace(/\/+$/, "");
        for (const suite of this.state.suites) {
            const updated = [];
            const copy = deepClone(suite);
            for (const env of copy.environments || []) {
                if (env.name !== ECHO_ENVIRONMENT) continue;
                for (const v of env.variables || []) {
                    const m = v.key === "baseUrl" ? /^http:\/\/(?:127\.0\.0\.1|localhost):(\d+)\/?$/.exec(String(v.value || "").trim()) : null;
                    if (m && Number(m[1]) !== status.port) { v.value = target; updated.push(env.name); }
                }
            }
            if (!updated.length || this.echoSyncing.has(suite.id)) continue;
            this.echoSyncing.add(suite.id); // several echo events may arrive for one change
            this.saveSuite(copy)
                .then(() => toast(`"${ECHO_ENVIRONMENT}" in ${suite.name} now uses ${target}`, "info", 4000))
                .catch((err) => console.warn("Could not update the echo server environment:", err.message))
                .finally(() => this.echoSyncing.delete(suite.id));
        }
    },

    // ------------------------------------------------------------ chrome
    renderTopbar() {
        const logo = clear(document.getElementById("brand-logo"));
        logo.appendChild(icon("zap"));
        const bar = clear(document.getElementById("topbar-actions"));
        const btn = (ic, label, title, cmd) => h("button", { class: "btn ghost", type: "button", title, onclick: () => this.command(cmd) }, icon(ic), label);
        const k = (s) => (this.mac ? s.replace("Ctrl+", "⌘").replace("Shift+", "⇧") : s);
        put(bar, 
            btn("import", "Import", `Import a suite, Postman collection, OpenAPI file or cURL (${k("Ctrl+O")})`, "import"),
            btn("export", "Export", "Export the current suite to a file you can share", "exportSuite"),
            btn("runner", "Runner", `Run a whole suite or folder with reports (${k("Ctrl+Shift+R")})`, "runner"),
            h("div", { class: "topbar-sep" }),
            iconButton("settings", `Settings (${k("Ctrl+,")})`, () => this.command("settings")),
            iconButton("help", "Help (F1)", () => this.command("help")),
            iconButton(this.effectiveTheme() === "dark" ? "sun" : "moon", "Switch light / dark theme", () => this.command("toggleTheme")));
    },
    renderEnvPicker() {
        const host = document.getElementById("env-picker");
        if (!host) return;
        clear(host);
        const sid = this.activeSuiteId();
        const suite = this.getSuite(sid);
        if (!suite) {
            host.appendChild(h("span", { class: "muted small" }, "No suite yet"));
            return;
        }
        const envs = suite.environments || [];
        const active = this.activeEnvironmentId(sid);
        const sel = select([{ value: "", label: "No environment" }, ...envs.map((e) => ({ value: e.id, label: e.name }))], active || "",
            { title: `Environment used for "${suite.name}"`, "aria-label": "Environment" });
        sel.addEventListener("change", () => this.setActiveEnvironment(sid, sel.value || null));
        put(host, 
            h("span", { class: "env-suite", title: suite.name }, suite.name),
            h("div", { class: `env-select-wrap ${active ? "active" : ""}` }, icon("env"), sel),
            h("button", { class: "btn ghost small", type: "button", title: `Manage environments and variables (${this.mac ? "⌘E" : "Ctrl+E"})`, onclick: () => this.command("environments") },
                envs.length ? "Environments" : "Add environment"));
    },
    renderStatusbar() {
        const bar = clear(document.getElementById("statusbar"));
        const echo = this.state.info.echoServer || { running: false };
        // one name everywhere for the built-in test API: "echo server" (Settings, sample environment, CLI command)
        const echoBtn = h("button", { class: "sb-item", type: "button",
            title: "Local echo server: a small test API on this computer for the sample suite and first tries (click for options)" },
            h("span", { class: `dot ${echo.running ? "on" : "off"}` }),
            echo.running ? `Echo server running · ${echo.url || `http://127.0.0.1:${echo.port}`}` : "Echo server stopped");
        echoBtn.addEventListener("click", () => contextMenu(echoBtn, [
            echo.running
                ? { label: "Copy URL", icon: "copy", onClick: () => copyText(echo.url || `http://127.0.0.1:${echo.port}`) }
                : { label: "Start echo server", icon: "play", onClick: () => this.startEchoServer().then((s) => { if (!s.running) toast(s.error, "error"); }) },
            echo.running ? { label: "Stop echo server", icon: "stop", onClick: () => attempt(() => api.call("echo.stop")).then(() => api.call("echo.status")).then((s) => this.setEcho(s)).catch(() => this.setEcho({ running: false })) } : null,
            "-",
            { label: "Add the sample suite", icon: "sparkles", onClick: () => this.addSampleSuite() },
            { label: "Echo server settings…", icon: "settings", onClick: () => this.command("settings") }
        ]));
        const tab = this.activeTab();
        put(bar, 
            echoBtn,
            h("span", { class: "spacer" }),
            tab && tab.kind === "request" && tab.result ? h("span", { class: "sb-item muted" }, `Last sent ${fmtTime(tab.result.startedAt)}`) : null,
            h("button", { class: "sb-item", type: "button", title: "Keyboard shortcuts and guide", onclick: () => this.command("help") }, icon("help"), "Help"),
            h("span", { class: "sb-item muted" }, this.state.info.version ? `v${this.state.info.version}` : ""));
    },
    renderTabs() {
        const strip = document.getElementById("doc-tabs");
        if (!strip) return;
        clear(strip);
        for (const tab of this.tabs) {
            const isActive = tab.id === this.activeTabId;
            const lead = tab.kind === "request" ? methodBadge(tab.draft?.method, { short: true })
                : h("span", { class: "dt-icon" }, icon(tab.kind === "runner" ? "runner" : tab.itemId ? "folder" : "suite"));
            const closeBtn = h("button", { class: "dt-close", type: "button", title: tab.dirty ? "Unsaved changes - close" : `Close (${this.mac ? "⌘W" : "Ctrl+W"})` },
                tab.dirty ? h("span", { class: "dirty-dot" }) : null, icon("x"));
            closeBtn.addEventListener("click", (e) => { e.stopPropagation(); this.closeTab(tab.id); });
            const suffix = tab.kind === "settings" ? " · settings" : "";
            const el = h("div", {
                class: `doc-tab ${isActive ? "active" : ""} ${tab.temp ? "temp" : ""}`, role: "tab", draggable: "true", dataset: { id: tab.id },
                title: tabTooltip(tab)
            }, lead, h("span", { class: "dt-label" }, this.tabTitle(tab) + suffix), closeBtn);
            el.addEventListener("mousedown", (e) => { if (e.button === 1) e.preventDefault(); });
            el.addEventListener("auxclick", (e) => { if (e.button === 1) { e.preventDefault(); this.closeTab(tab.id); } });
            el.addEventListener("click", () => this.activateTab(tab.id));
            el.addEventListener("contextmenu", (e) => {
                e.preventDefault();
                contextMenu(e, [
                    { label: "Close", icon: "x", onClick: () => this.closeTab(tab.id) },
                    { label: "Close others", onClick: () => this.closeTabs((t) => t.id !== tab.id) },
                    { label: "Close tabs to the right", onClick: () => { const i = this.tabs.indexOf(tab); return this.closeTabs((t) => this.tabs.indexOf(t) > i); } },
                    { label: "Close saved tabs", onClick: () => this.closeTabs((t) => !t.dirty && !t.temp) },
                    { label: "Close all", onClick: () => this.closeTabs(() => true) },
                    tab.kind === "request" && !tab.temp ? "-" : null,
                    tab.kind === "request" && !tab.temp ? { label: "Show in sidebar", icon: "search", onClick: () => Sidebar.reveal(tab.suiteId, tab.itemId) } : null
                ]);
            });
            // drag to reorder tabs
            el.addEventListener("dragstart", (e) => { e.dataTransfer.setData("application/x-apitester-tab", tab.id); e.dataTransfer.effectAllowed = "move"; });
            el.addEventListener("dragover", (e) => {
                if (!e.dataTransfer.types.includes("application/x-apitester-tab")) return;
                e.preventDefault();
                el.classList.add("drag-over");
            });
            el.addEventListener("dragleave", () => el.classList.remove("drag-over"));
            el.addEventListener("drop", (e) => {
                const id = e.dataTransfer.getData("application/x-apitester-tab");
                el.classList.remove("drag-over");
                if (!id || id === tab.id) return;
                e.preventDefault();
                const moving = this.findTab(id);
                this.tabs.splice(this.tabs.indexOf(moving), 1);
                this.tabs.splice(this.tabs.indexOf(tab), 0, moving);
                this.renderTabs();
                this.persistUi();
            });
            strip.appendChild(el);
        }
        const actions = clear(document.getElementById("tabbar-actions"));
        put(actions, iconButton("plus", `New request (${this.mac ? "⌘N" : "Ctrl+N"})`, () => this.command("newRequest")));
        if (this.tabs.length > 1) {
            put(actions, iconButton("chevronDown", "All open tabs", (e) => contextMenu(e.currentTarget, this.tabs.map((t) => ({
                label: this.tabTitle(t) + (t.dirty ? "  •" : ""), icon: t.kind === "request" ? "send" : t.kind === "runner" ? "runner" : "settings", onClick: () => this.activateTab(t.id)
            })))));
        }
        this.renderStatusbar();
        if (typeof Sidebar !== "undefined" && Sidebar.syncDirtyDots) Sidebar.syncDirtyDots(); // tree rows show unsaved tabs too
        // window title shows what is being edited
        const active = this.activeTab();
        document.title = active ? `${this.tabTitle(active)}${active.dirty ? " •" : ""} - API Tester` : "API Tester";
    },

    showAbout() {
        const info = this.state.info || {};
        modal({
            title: "About API Tester",
            body: h("div", { class: "stack" },
                h("div", { class: "row" }, h("div", { class: "brand-logo", style: { width: "40px", height: "40px" } }, icon("zap")),
                    h("div", null, h("div", { class: "strong", style: { fontSize: "15px" } }, "API Tester"), h("div", { class: "muted" }, `Version ${info.version || "?"} · ${info.platform || ""}`))),
                h("div", { class: "text-2" }, "Test HTTP APIs: requests, environments, assertions, captured values, a suite runner with reports, and suite files you can share."),
                h("div", { class: "kv" },
                    h("div", null, "Data folder"), h("div", null, info.dataDir || "—"),
                    h("div", null, "Logs"), h("div", null, info.logDir || "—"),
                    h("div", null, "Command line"), h("div", null, info.cliCommand ? `${info.cliCommand} run my-suite.apisuite` : "—"))),
            buttons: [
                { label: "Open data folder", onClick: () => attempt(() => api.call("app.openDataFolder")).then(() => false) },
                info.cliCommand ? { label: "Copy CLI command", onClick: () => { copyText(info.cliCommand); return false; } } : null,
                { label: "Close", class: "primary", value: null }
            ]
        });
    },

    // ------------------------------------------------------------ layout (sidebar width)
    initLayout() {
        const sidebar = document.getElementById("sidebar");
        const width = Number(this.state.ui.sidebarWidth) || 280;
        sidebar.style.width = `${Math.max(200, Math.min(600, width))}px`;
        makeResizer(document.getElementById("sidebar-resizer"), {
            axis: "x",
            getSize: () => sidebar.getBoundingClientRect().width,
            onMove: (d, start) => { sidebar.style.width = `${Math.max(200, Math.min(600, Math.round(start + d)))}px`; },
            onEnd: () => this.saveUi({ sidebarWidth: Math.round(sidebar.getBoundingClientRect().width) })
        });
    },

    // ------------------------------------------------------------ external files (drag & drop onto the window)
    initFileDrop() {
        // The overlay "drop to import" shows while files are dragged over the window, except over an element that
        // takes the drop itself (it calls preventDefault on dragover, e.g. the runner's data file box, or is marked
        // with data-dropzone). Resets run in the capture phase, so a drop handler that stops propagation cannot
        // leave the overlay behind; a timer clears it when the drag leaves the window or ends elsewhere.
        let depth = 0;
        let idle = null;
        const body = document.body;
        const isFiles = (e) => !!e.dataTransfer && [...e.dataTransfer.types].includes("Files");
        const modalOpen = () => !!document.querySelector("#modal-root .modal-backdrop");
        const reset = () => { depth = 0; clearTimeout(idle); body.classList.remove("drag-file", "drag-local"); };
        const keepAlive = () => { clearTimeout(idle); idle = setTimeout(reset, 1500); };
        window.addEventListener("dragenter", (e) => {
            if (!isFiles(e) || modalOpen()) return;
            depth++;
            body.classList.add("drag-file");
            keepAlive();
        }, true);
        window.addEventListener("dragleave", (e) => {
            if (!isFiles(e)) return;
            depth = Math.max(0, depth - 1);
            const outside = e.clientX <= 0 || e.clientY <= 0 || e.clientX >= window.innerWidth || e.clientY >= window.innerHeight;
            if (!depth || outside) reset(); // the pointer left the window
        }, true);
        window.addEventListener("dragover", (e) => {
            if (!isFiles(e)) return;
            if (modalOpen()) { reset(); return; }
            body.classList.add("drag-file");
            keepAlive();
        }, true);
        window.addEventListener("dragover", (e) => {
            if (!isFiles(e)) return;
            // bubble phase: an element below that accepts the drop has already called preventDefault
            const local = e.defaultPrevented || !!(e.target instanceof Element && e.target.closest("[data-dropzone]"));
            body.classList.toggle("drag-local", local);
            e.preventDefault(); // allow dropping on the window (otherwise the file would be opened as a page)
        });
        window.addEventListener("drop", reset, true);
        window.addEventListener("dragend", reset, true);
        window.addEventListener("blur", () => { if (body.classList.contains("drag-file")) reset(); });
        window.addEventListener("drop", async (e) => {
            if (!isFiles(e)) return;
            const handled = e.defaultPrevented || !!(e.target instanceof Element && e.target.closest("[data-dropzone]"));
            e.preventDefault();
            if (handled || modalOpen()) return; // a drop zone (or the import dialog) took the file
            const file = e.dataTransfer.files[0];
            if (!file) return;
            if (file.size > 50 * 1024 * 1024) return toast("That file is too large to import (over 50 MB)", "error");
            const text = await file.text().catch(() => null);
            if (text === null) return toast("Could not read the dropped file", "error");
            const result = await attempt(() => api.call("files.importText", text, file.name));
            if (result) this.handleImportResult(result);
        });
    },
    handleImportResult(result) {
        if (typeof ImportExport !== "undefined" && ImportExport.importResult) return ImportExport.importResult(result);
        // minimal fallback: add the suites directly
        return Promise.all((result.suites || []).map((s) => this.saveSuite(s))).then(() => toast("Imported", "success"));
    },

    // ------------------------------------------------------------ main process events
    initEvents() {
        api.on("suite-changed", (p) => {
            if (!p) return;
            if (p.suite) this.applySuite(p.suite);
            else if (p.deleted && p.suiteId) {
                this.state.suites = this.state.suites.filter((s) => s.id !== p.suiteId);
                this.emit("suites-changed", { suiteId: p.suiteId, deleted: true });
            }
        });
        api.on("globals-changed", (p) => {
            const g = Array.isArray(p) ? p : p?.globals;
            if (Array.isArray(g)) this.state.globals = g;
            this.invalidateVars();
            this.emit("globals-changed", { globals: this.state.globals });
        });
        api.on("history-changed", (p) => this.onHistoryChanged(p));
        api.on("runner-event", (p) => this.emit("runner-event", p));
        api.on("menu", (cmd) => this.command(typeof cmd === "string" ? cmd : cmd?.command, "menu"));
        api.on("open-file", async (file) => {
            const result = await attempt(() => api.call("files.importPath", file));
            if (result) this.handleImportResult(result);
        });
        api.on("echo-changed", (s) => this.setEcho(s));
        // the home screen lists different actions once suites exist
        this.on("suites-changed", () => {
            const home = document.getElementById("home-pane");
            if (home && !this.activeTabId && home.classList.contains("active")) renderHome(home);
        });
        if (window.matchMedia) {
            window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => { if ((this.state.settings.theme || "system") === "system") this.applyTheme(); });
        }
        document.addEventListener("keydown", (e) => this.onKeyDown(e));
        window.addEventListener("beforeunload", () => { this.persistUi.cancel(); this.writeUi(); });
        // stray promise errors end up in the console, not as silent failures
        window.addEventListener("unhandledrejection", (e) => { console.error("Unhandled:", e.reason); });
    },
    async onHistoryChanged(p) {
        if (Array.isArray(p)) this.state.history = p;
        else if (p && Array.isArray(p.history)) this.state.history = p.history;
        else if (p && p.entry && p.entry.id) this.state.history = [p.entry, ...this.state.history.filter((x) => x.id !== p.entry.id)];
        else if (p && p.id && p.time) this.state.history = [p, ...this.state.history.filter((x) => x.id !== p.id)];
        else {
            const ws = await api.call("workspace.load").catch(() => null);
            if (ws && Array.isArray(ws.history)) this.state.history = ws.history;
        }
        this.emit("history-changed", this.state.history);
    },

    // ------------------------------------------------------------ start
    async init() {
        const [ws, info, meta] = await Promise.all([
            api.call("workspace.load"),
            api.call("app.info").catch(() => ({})),
            api.call("meta.get").catch(() => null)
        ]);
        this.state.suites = Array.isArray(ws.suites) ? ws.suites : [];
        this.state.globals = Array.isArray(ws.globals) ? ws.globals : [];
        this.state.settings = { ...DEFAULT_SETTINGS, ...(ws.settings || {}) };
        this.state.history = Array.isArray(ws.history) ? ws.history : [];
        this.state.ui = ws.ui && typeof ws.ui === "object" ? ws.ui : {};
        this.state.info = info || {};
        this.state.meta = { ...FALLBACK_META, ...(meta || {}) };
        if (this.state.info.platform) this.mac = this.state.info.platform === "darwin";
        document.body.classList.toggle("mac", this.mac);
        this.applyTheme();
        this.initLayout();
        this.initEvents();
        this.initFileDrop();
        Sidebar.mount(document.getElementById("sidebar"));
        this.restoreTabs();
        this.renderEnvPicker();
        this.renderStatusbar();
        if (!this.state.info.echoServer) api.call("echo.status").then((s) => this.setEcho(s)).catch(() => {});
        if (ws.firstRun) {
            if (typeof Welcome !== "undefined") Welcome.show();
            else this.showHome();
        }
        // a problem while loading (damaged file, saved secrets the system keychain would not decrypt)
        if (ws.warning) {
            setTimeout(() => modal({
                title: "Your workspace needs attention",
                body: h("div", { class: "callout warn" }, icon("alert"), h("span", { style: { overflowWrap: "anywhere" } }, ws.warning)),
                buttons: [{ label: "OK", class: "primary", value: null }]
            }), 300);
        }
    },
    restoreTabs() {
        const saved = Array.isArray(this.state.ui.openTabs) ? this.state.ui.openTabs : [];
        for (const t of saved) {
            try {
                if (t.kind === "request") {
                    const suite = this.getSuite(t.suiteId);
                    const found = !t.temp && suite ? Model.findItem(suite, t.itemId) : null;
                    if (found && found.item.type === "request") {
                        const baseline = normalizeDraft(deepClone(found.item));
                        const draft = t.draft ? normalizeDraft(deepClone(t.draft)) : deepClone(baseline);
                        const tab = { id: `r:${t.suiteId}:${t.itemId}`, kind: "request", suiteId: t.suiteId, itemId: t.itemId, draft, baseline: JSON.stringify(baseline), result: null, reqTab: t.reqTab,
                            autoCreated: typeof t.autoCreated === "string" ? t.autoCreated : null };
                        tab.dirty = JSON.stringify(draft) !== tab.baseline;
                        if (!this.findTab(tab.id)) this.tabs.push(tab);
                    } else if (t.draft) {
                        const draft = normalizeDraft(deepClone(t.draft));
                        this.tabs.push({ id: `t:${uid("t")}`, kind: "request", temp: true, touched: true, suiteId: suite ? t.suiteId : null, itemId: null, draft,
                            baseline: JSON.stringify(draft), dirty: false, title: t.title || draft.name, result: null, reqTab: t.reqTab });
                    }
                } else if (t.kind === "settings") {
                    const suite = this.getSuite(t.suiteId);
                    if (suite && (!t.itemId || Model.findItem(suite, t.itemId))) {
                        const id = `s:${t.suiteId}:${t.itemId || "suite"}`;
                        if (!this.findTab(id)) this.tabs.push({ id, kind: "settings", suiteId: t.suiteId, itemId: t.itemId || null });
                    }
                }
            } catch (err) { console.warn("Could not restore a tab:", err); }
        }
        // the saved active id of a temp tab changes on restore; fall back to the first tab
        const restoredAll = this.tabs.length === saved.filter((t) => t.kind !== "runner").length;
        const active = this.tabs.find((t) => t.id === this.state.ui.activeTab)
            || (restoredAll ? this.tabs[Number(this.state.ui.activeIndex) || 0] : null) || this.tabs[0];
        if (active) this.activateTab(active.id); else this.showHome();
    }
};

// ------------------------------------------------------------------ helpers used by the shell

function viewGlobals() {
    return {
        SuiteEditor: typeof SuiteEditor !== "undefined" ? SuiteEditor : null,
        Environments: typeof Environments !== "undefined" ? Environments : null,
        Runner: typeof Runner !== "undefined" ? Runner : null,
        ImportExport: typeof ImportExport !== "undefined" ? ImportExport : null,
        Settings: typeof Settings !== "undefined" ? Settings : null,
        Welcome: typeof Welcome !== "undefined" ? Welcome : null,
        Help: typeof Help !== "undefined" ? Help : null
    };
}

function missingView(name) {
    return h("div", { class: "empty" }, h("h3", null, `${name} is not available`), h("p", null, "This part of the app failed to load. Check the log file."));
}

function tabTooltip(tab) {
    const suite = App.getSuite(tab.suiteId);
    if (tab.kind === "request") {
        const where = tab.temp ? "Unsaved request" : suite ? pathLabel(suite, tab.itemId) : "";
        return `${tab.draft?.method || ""} ${tab.draft?.url || ""}\n${where}${tab.dirty ? " (unsaved changes)" : ""}`.trim();
    }
    if (tab.kind === "settings") return `${suite ? suite.name : ""}${tab.itemId ? " / " + App.tabTitle(tab) : ""} settings`;
    return "Runner";
}

/** Local file paths a request uploads as written in it (binary body, multipart file fields). */
function requestFilePaths(req) {
    const b = (req && req.body) || {};
    if (b.mode === "binary") return b.binaryPath ? [b.binaryPath] : [];
    if (b.mode === "multipart") return (b.multipart || []).filter((p) => p && p.enabled !== false && p.type === "file" && p.filePath).map((p) => p.filePath);
    return [];
}

/** "Suite / Folder / Request" */
function pathLabel(suite, itemId) {
    const f = Model.findItem(suite, itemId);
    if (!f) return suite.name;
    return [suite.name, ...f.parents.map((p) => p.name), f.item.name].join(" / ");
}

/**
 * Request objects as the editor keeps them: the query string lives in `params` (prepare appends enabled
 * params to the URL), so a URL that still carries "?a=1" while params is empty is split once on load.
 */
function normalizeDraft(req) {
    if (!req || typeof req !== "object") return Model.newRequest();
    const d = Model.newRequest(req.name || "Request");
    const out = { ...d, ...req };
    out.params = Array.isArray(req.params) ? req.params : [];
    out.headers = Array.isArray(req.headers) ? req.headers : [];
    out.assertions = Array.isArray(req.assertions) ? req.assertions : [];
    out.extract = Array.isArray(req.extract) ? req.extract : [];
    out.auth = { ...Model.defaultAuth("inherit"), ...(req.auth || {}) };
    for (const k of ["basic", "bearer", "apikey", "oauth2"]) out.auth[k] = { ...Model.defaultAuth()[k], ...((req.auth || {})[k] || {}) };
    out.body = { ...Model.defaultBody(), ...(req.body || {}) };
    out.body.graphql = { query: "", variables: "", ...((req.body || {}).graphql || {}) };
    out.body.form = Array.isArray(out.body.form) ? out.body.form : [];
    out.body.multipart = Array.isArray(out.body.multipart) ? out.body.multipart : [];
    out.scripts = { pre: "", post: "", ...(req.scripts || {}) };
    out.settings = { timeoutMs: null, followRedirects: null, verifyTls: null, ...(req.settings || {}) };
    out.method = String(out.method || "GET").toUpperCase();
    out.url = String(out.url || "");
    if (!out.params.length && out.url.includes("?")) {
        const split = splitUrlQuery(out.url);
        if (split.params.length) { out.url = split.base; out.params = split.params; }
    }
    return out;
}

/** "a/b?x=1&y" -> { base: "a/b", params: [{ key:"x", value:"1" }, { key:"y", value:"" }] } (values decoded when valid). */
function splitUrlQuery(url) {
    const text = String(url || "");
    const q = text.indexOf("?");
    if (q < 0) return { base: text, params: [], hadQuery: false };
    const base = text.slice(0, q);
    let query = text.slice(q + 1);
    const hash = query.indexOf("#");
    if (hash >= 0) query = query.slice(0, hash);
    const params = query.split("&").filter((p) => p !== "").map((pair) => {
        const eq = pair.indexOf("=");
        const k = eq >= 0 ? pair.slice(0, eq) : pair;
        const v = eq >= 0 ? pair.slice(eq + 1) : "";
        return { key: safeDecode(k), value: safeDecode(v), enabled: true, description: "" };
    });
    return { base, params, hadQuery: true };
}

function safeDecode(s) {
    if (!/%[0-9a-f]{2}/i.test(s)) return s;
    try { return decodeURIComponent(s); } catch (_) { return s; }
}

/** Encodes only what would break the query string when shown in the URL bar ({{vars}} stay readable). */
function encodeQueryPart(s, isKey) {
    return String(s ?? "").replace(/%(?=[0-9a-f]{2})/gi, "%25").replace(/&/g, "%26").replace(/#/g, "%23").replace(isKey ? /=/g : /(?!)/g, "%3D");
}

/** URL shown in the URL bar: stored base URL + enabled params. */
function composeUrl(base, params) {
    const enabled = (params || []).filter((p) => p.enabled !== false && (p.key || p.value));
    if (!enabled.length) return base || "";
    const query = enabled.map((p) => (p.value === "" && !String(p.key).includes("=") ? encodeQueryPart(p.key, true) : `${encodeQueryPart(p.key, true)}=${encodeQueryPart(p.value, false)}`)).join("&");
    return `${base || ""}${String(base || "").includes("?") ? "&" : "?"}${query}`;
}

/** Name for a new request from its URL: "GET /users/{{id}}". */
function suggestName(req) {
    let path = String(req.url || "").replace(/^\{\{\s*[^{}]+\s*\}\}/, "").replace(/^[a-z]+:\/\/[^/]+/i, "");
    if (!path || path === "/") path = req.url;
    return `${req.method} ${path}`.slice(0, 80);
}

/** Dialog: name + suite + folder. Resolves { name, suiteId, folderId } or null. */
function pickLocation({ title, name, suiteId }) {
    const nameInput = h("input", { type: "text", value: name || "", spellcheck: "false" });
    const suites = App.state.suites;
    const suiteSel = select(suites.length ? suites.map((s) => ({ value: s.id, label: s.name })) : [{ value: "", label: "New suite \"My Suite\"" }], suiteId || suites[0]?.id || "");
    const folderSel = h("select");
    const fillFolders = () => {
        clear(folderSel);
        folderSel.appendChild(h("option", { value: "" }, "(top level)"));
        const suite = App.getSuite(suiteSel.value);
        if (suite) Model.walk(suite.items, (item, parents) => {
            if (item.type === "folder") folderSel.appendChild(h("option", { value: item.id }, `${"  ".repeat(parents.length)}${item.name}`));
        });
    };
    suiteSel.addEventListener("change", fillFolders);
    fillFolders();
    setTimeout(() => nameInput.select(), 40);
    return modal({
        title,
        body: h("div", { class: "stack" }, field("Name", nameInput), h("div", { class: "form-grid two" }, field("Suite", suiteSel), field("Folder", folderSel))),
        buttons: [
            { label: "Cancel", value: null },
            { label: "Save", class: "primary", onClick: () => {
                if (!nameInput.value.trim()) { toast("Please enter a name", "warn"); nameInput.focus(); return false; }
                return { name: nameInput.value.trim(), suiteId: suiteSel.value || null, folderId: folderSel.value || null };
            } }
        ]
    });
}

/** Main area when no tab is open. */
function renderHome(el) {
    clear(el);
    const k = (s) => (App.mac ? s.replace(/Ctrl\+/g, "⌘").replace(/Shift\+/g, "⇧") : s);
    const action = (ic, title, desc, onClick) => h("button", { class: "home-action", type: "button", onclick: onClick },
        h("div", { class: "ha-icon" }, icon(ic)), h("div", null, h("div", { class: "ha-title" }, title), h("div", { class: "ha-desc" }, desc)));
    const hasSuites = App.state.suites.length > 0;
    el.appendChild(h("div", { class: "home" },
        h("h2", null, hasSuites ? "Pick a request or start a new one" : "Welcome to API Tester"),
        h("p", { class: "lead" }, hasSuites ? "Open a request from the sidebar, or use one of these:" : "Create a suite for your API, import an existing collection, or try the sample suite with the built-in echo server (a local test API)."),
        h("div", { class: "home-actions" },
            action("plus", "New request", `Start typing a URL (${k("Ctrl+N")})`, () => App.command("newRequest")),
            action("suite", "New suite", "A folder of requests with its own environments", () => App.command("newSuite")),
            action("import", "Import", "Suite file, Postman, OpenAPI / Swagger or cURL", () => App.command("import")),
            action("sparkles", "Sample suite", "Working examples of every feature, runs offline", () => App.addSampleSuite()),
            hasSuites ? action("runner", "Run a suite", "All requests with assertions and a report", () => App.command("runner")) : null,
            action("help", "Guide", "Variables, assertions, runner, CLI, sharing", () => App.command("help"))),
        h("div", { class: "section-title" }, "Keyboard shortcuts"),
        h("div", { class: "shortcuts" },
            h("span", null, "Send request"), h("span", null, h("kbd", null, k("Ctrl+Enter"))),
            h("span", null, "Save"), h("span", null, h("kbd", null, k("Ctrl+S"))),
            h("span", null, "New request"), h("span", null, h("kbd", null, k("Ctrl+N"))),
            h("span", null, "Search requests"), h("span", null, h("kbd", null, k("Ctrl+K"))),
            h("span", null, "Environments"), h("span", null, h("kbd", null, k("Ctrl+E"))),
            h("span", null, "Close tab"), h("span", null, h("kbd", null, k("Ctrl+W"))),
            h("span", null, "Insert a variable"), h("span", null, "type ", h("kbd", null, "{{")))));
}

window.addEventListener("DOMContentLoaded", () => {
    if (typeof api === "undefined") {
        document.body.textContent = "API Tester must be started as the desktop app (the preload bridge is missing).";
        return;
    }
    App.init().catch((err) => {
        console.error(err);
        const box = h("div", { style: { padding: "40px", fontFamily: "sans-serif" } },
            h("h2", null, "API Tester could not start"),
            h("p", null, cleanError(err)),
            h("button", { class: "btn primary", onclick: () => location.reload() }, "Try again"));
        clear(document.body).appendChild(box);
    });
});
