"use strict";
/*
 * Suite / folder settings editor (rendered in a main-area tab), plus small helpers shared by the other
 * ui-views files (environments, runner, import/export, settings, welcome, help) as window.ViewHelpers.
 * index.html loads this file before the other ui-views files.
 *
 * Every file of this group is wrapped in a function so that its helper names never clash with the
 * globals of the shell scripts (classic scripts share one global scope).
 */
(function () {
    "use strict";

    // ================================================================== shared helpers (window.ViewHelpers)

    const randomHex = (bytes) => Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (b) => b.toString(16).padStart(2, "0")).join("");
    /** Same id shape as core/model.js newId(): s_ suite, f_ folder, r_ request, e_ environment, a_ assertion, x_ capture. */
    const newId = (prefix) => `${prefix}_${randomHex(6)}`;
    const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
    const call = (method, ...args) => window.api.call(method, ...args);
    /** Appends children, skipping null / false (Element.append would show them as the text "null"). */
    const add = (el, ...children) => {
        for (const c of children.flat(Infinity)) if (c !== null && c !== undefined && c !== false) el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
        return el;
    };

    const AUTH_LABELS = {
        inherit: "Inherit from parent",
        none: "No auth",
        basic: "Basic auth",
        bearer: "Bearer token",
        apikey: "API key",
        oauth2: "OAuth 2.0"
    };

    const COMMON_HEADERS = [
        "Accept", "Accept-Encoding", "Accept-Language", "Authorization", "Cache-Control", "Content-Type", "Cookie",
        "If-Match", "If-None-Match", "Origin", "Referer", "User-Agent", "X-API-Key", "X-Correlation-ID", "X-Request-ID",
        "X-Requested-With", "X-Forwarded-For"
    ];

    function defaultAuth(type = "inherit") {
        return {
            type,
            basic: { username: "", password: "" },
            bearer: { token: "" },
            apikey: { key: "X-API-Key", value: "", in: "header" },
            oauth2: { grantType: "client_credentials", tokenUrl: "", clientId: "", clientSecret: "", scope: "", audience: "", username: "", password: "", clientAuth: "body" }
        };
    }

    /** Complete objects in the shape of core/model.js, so the renderer state is right before main normalizes it. */
    function newRequest(name = "New Request", extra = {}) {
        return {
            id: newId("r"), type: "request", name, description: "", method: "GET", url: "", params: [], headers: [],
            auth: defaultAuth("inherit"),
            body: { mode: "none", raw: "", form: [], multipart: [], binaryPath: "", graphql: { query: "", variables: "" } },
            assertions: [], extract: [], scripts: { pre: "", post: "" },
            settings: { timeoutMs: null, followRedirects: null, verifyTls: null },
            ...extra
        };
    }
    function newSuite(name = "New Suite", extra = {}) {
        return {
            format: "api-tester-suite", version: 1, id: newId("s"), name, description: "", variables: [],
            auth: defaultAuth("none"), headers: [], environments: [], activeEnvironmentId: null, items: [], ...extra
        };
    }
    const newVariable = (key = "", value = "", extra = {}) => ({ key, value: String(value ?? ""), enabled: true, secret: false, description: "", ...extra });
    const newEnvironment = (name = "Default", variables = []) => ({ id: newId("e"), name, variables });

    /** Calls fn(item, parents) for every folder and request, depth first; fn returning false stops. */
    function walk(items, fn, parents = []) {
        for (const item of items || []) {
            if (fn(item, parents) === false) return false;
            if (item.type === "folder" && walk(item.items, fn, [...parents, item]) === false) return false;
        }
        return true;
    }
    function findItem(suite, id) {
        let found = null;
        walk(suite?.items, (item, parents) => {
            if (item.id !== id) return true;
            found = { item, parents };
            return false;
        });
        return found;
    }
    function requestsUnder(items) {
        const out = [];
        walk(items, (item) => { if (item.type === "request") out.push(item); });
        return out;
    }
    function countItems(suite) {
        let folders = 0, requests = 0;
        walk(suite?.items, (item) => { if (item.type === "folder") folders++; else requests++; });
        return { folders, requests };
    }
    function firstRequest(suite) {
        return requestsUnder(suite?.items)[0] || null;
    }
    const plural = (n, word, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;

    /** Table rows -> clean Variable[] (drops the empty rows a table keeps for typing). */
    function cleanVars(rows) {
        return (rows || []).filter((r) => r && (String(r.key ?? "").trim() || String(r.value ?? ""))).map((r) => ({
            key: String(r.key ?? "").trim(), value: String(r.value ?? ""), enabled: r.enabled !== false, secret: !!r.secret, description: String(r.description ?? "")
        }));
    }
    function cleanKeyValues(rows) {
        return (rows || []).filter((r) => r && (String(r.key ?? "").trim() || String(r.value ?? ""))).map((r) => ({
            key: String(r.key ?? "").trim(), value: String(r.value ?? ""), enabled: r.enabled !== false, description: String(r.description ?? "")
        }));
    }

    /** Default export file name, same rules as core/suiteFile.js suiteFileName (hints and the CLI example). */
    function safeFileName(name) {
        let base = String(name || "").normalize("NFC")
            .replace(/\s*:\s*/g, " - ")
            .replace(/[\\/*?"<>|\u0000-\u001f\u007f]+/g, "-")
            .replace(/\s+/g, " ")
            .trim()
            .replace(/^[.\s-]+|[.\s]+$/g, "");
        if (base.length > 100) base = base.slice(0, 100).trim();
        if (!base) base = "suite";
        if (/^(con|prn|aux|nul|com\d|lpt\d)$/i.test(base)) base = `${base}-suite`;
        return `${base}.apisuite`;
    }

    /** Quotes one argument for the shell of the platform (cmd/PowerShell on Windows, sh elsewhere). */
    function shellQuote(value, platform) {
        const s = String(value ?? "");
        if (s && /^[\w@%+=:,./\\-]+$/.test(s)) return s;
        if (platform === "win32") return `"${s.replace(/"/g, "\"\"")}"`;
        return `'${s.replace(/'/g, "'\\''")}'`;
    }

    /** The modal that contains `el` is closed the way its own × button closes it. */
    function closeModalOf(el) {
        const backdrop = el?.closest?.(".modal-backdrop");
        if (!backdrop) return false;
        const closeButton = backdrop.querySelector(".modal-head button");
        if (closeButton) closeButton.click();
        else backdrop.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
        return true;
    }
    /** A footer button of the modal containing `el`, found by its label (for enabling / clicking it). */
    function modalButton(el, label) {
        const modalEl = el?.closest?.(".modal");
        if (!modalEl) return null;
        return [...modalEl.querySelectorAll(".modal-foot button")].find((b) => b.textContent.trim() === label) || null;
    }

    /** icon() from util.js, but never throws for an unknown name. */
    function safeIcon(name) {
        try { return icon(name); } catch (err) { return h("span"); }
    }

    // ------------------------------------------------------------ metadata from main (meta.get), cached
    let metaPromise = null;
    function normalizeMeta(m) {
        const list = (v) => (Array.isArray(v) ? v : []);
        let dyn = m?.dynamicVariables;
        if (dyn && !Array.isArray(dyn) && typeof dyn === "object") {
            dyn = Object.entries(dyn).map(([name, d]) => ({ name, description: typeof d === "string" ? d : d?.description || "" }));
        }
        dyn = list(dyn).map((d) => (typeof d === "string" ? { name: d, description: "" } : { name: d.name || d.key || "", description: d.description || "" }))
            .filter((d) => d.name).map((d) => ({ ...d, name: d.name.startsWith("$") ? d.name : `$${d.name}` }));
        return {
            assertionSources: list(m?.assertionSources),
            assertionOperators: list(m?.assertionOperators),
            extractSources: list(m?.extractSources),
            dynamicVariables: dyn,
            httpMethods: list(m?.httpMethods),
            bodyModes: list(m?.bodyModes),
            authTypes: list(m?.authTypes),
            loaded: !!m
        };
    }
    function getMeta() {
        // the shell loads the metadata at start (App.state.meta); ask main only when it is missing
        const known = typeof App !== "undefined" && App.state ? App.state.meta : null; // App is a script-level const, not on window
        if (known && Array.isArray(known.assertionOperators) && known.assertionOperators.length) return Promise.resolve(normalizeMeta(known));
        if (!metaPromise) {
            metaPromise = Promise.resolve()
                .then(() => call("meta.get"))
                .then(normalizeMeta)
                .catch((err) => {
                    console.error("meta.get failed", err);
                    metaPromise = null; // try again next time
                    return normalizeMeta(null);
                });
        }
        return metaPromise;
    }

    /** "label" of an option list entry that may be a string or { value, label }. */
    function optionLabel(list, value) {
        const hit = (list || []).find((o) => (typeof o === "object" ? o.value : o) === value);
        return hit ? (typeof hit === "object" ? hit.label || hit.value : hit) : value;
    }

    // ------------------------------------------------------------ auth editor (suite / folder)

    /** Password-like input with an eye toggle (util.js secretInput when the shell provides it). */
    function secretInput(value, placeholder, onInput) {
        if (typeof window.secretInput === "function") return window.secretInput(value || "", { placeholder }, onInput);
        const input = h("input", { type: "password", value: value || "", placeholder, spellcheck: "false", autocomplete: "off", class: "ve-grow" });
        input.addEventListener("input", () => onInput(input.value));
        const toggle = h("button", { class: "btn ghost icon", type: "button", title: "Show / hide" }, safeIcon("eye"));
        toggle.addEventListener("click", () => {
            const show = input.type === "password";
            input.type = show ? "text" : "password";
            clear(toggle).appendChild(safeIcon(show ? "eyeOff" : "eye"));
        });
        return h("div", { class: "ve-secret" }, input, toggle);
    }

    /**
     * Editor for an Auth object (mutated in place). inheritInfo() -> text that explains where "inherit" takes the
     * auth from. Returns { el, refresh() }.
     */
    function authEditor(auth, { allowInherit = false, inheritInfo = null, onChange = () => {} } = {}) {
        const base = defaultAuth(auth.type || (allowInherit ? "inherit" : "none"));
        for (const k of ["basic", "bearer", "apikey", "oauth2"]) auth[k] = { ...base[k], ...(auth[k] || {}) };
        if (!auth.type || (!allowInherit && auth.type === "inherit")) auth.type = allowInherit ? "inherit" : "none";

        const types = [...(allowInherit ? ["inherit"] : []), "none", "basic", "bearer", "apikey", "oauth2"];
        const typeSelect = select(types.map((t) => ({ value: t, label: AUTH_LABELS[t] })), auth.type);
        const fields = h("div", { class: "ve-auth-fields" });

        const text = (obj, key, placeholder, attrs = {}) => {
            const input = h("input", { type: "text", value: obj[key] || "", placeholder, spellcheck: "false", autocomplete: "off", ...attrs });
            input.addEventListener("input", () => { obj[key] = input.value; onChange(); });
            return input;
        };
        const secret = (obj, key, placeholder) => secretInput(obj[key], placeholder, (v) => { obj[key] = v; onChange(); });
        const choice = (obj, key, options, after) => {
            const el = select(options, obj[key]);
            el.addEventListener("change", () => { obj[key] = el.value; onChange(); if (after) after(); });
            return el;
        };

        const render = () => {
            clear(fields);
            const t = auth.type;
            if (t === "inherit") {
                fields.appendChild(h("div", { class: "callout" }, safeIcon("lock"), h("span", null, inheritInfo ? inheritInfo() : "Uses the auth of the parent folder or the suite.")));
            } else if (t === "none") {
                fields.appendChild(h("div", { class: "callout" }, "No authentication is added. Requests can still set their own auth or headers."));
            } else if (t === "basic") {
                fields.appendChild(h("div", { class: "form-grid two" },
                    field("Username", text(auth.basic, "username", "e.g. {{username}}")),
                    field("Password", secret(auth.basic, "password", "e.g. {{password}}"))));
            } else if (t === "bearer") {
                fields.appendChild(field("Token", secret(auth.bearer, "token", "e.g. {{token}}"), "Sent as: Authorization: Bearer <token>"));
            } else if (t === "apikey") {
                fields.appendChild(h("div", { class: "form-grid three" },
                    field("Key name", text(auth.apikey, "key", "X-API-Key")),
                    field("Value", secret(auth.apikey, "value", "e.g. {{apiKey}}")),
                    field("Add to", choice(auth.apikey, "in", [{ value: "header", label: "Header" }, { value: "query", label: "Query parameter" }]))));
            } else if (t === "oauth2") {
                const o = auth.oauth2;
                const isPassword = o.grantType === "password";
                add(fields, h("div", { class: "form-grid two" },
                    field("Grant type", choice(o, "grantType", [{ value: "client_credentials", label: "Client credentials" }, { value: "password", label: "Password (resource owner)" }], render)),
                    field("Token URL", text(o, "tokenUrl", "https://auth.example.com/oauth/token")),
                    field("Client ID", text(o, "clientId", "e.g. {{clientId}}")),
                    field("Client secret", secret(o, "clientSecret", "e.g. {{clientSecret}}")),
                    isPassword ? field("Username", text(o, "username", "e.g. {{username}}")) : null,
                    isPassword ? field("Password", secret(o, "password", "e.g. {{password}}")) : null,
                    field("Scope", text(o, "scope", "optional, e.g. read write")),
                    field("Audience", text(o, "audience", "optional")),
                    field("Send client credentials", choice(o, "clientAuth", [{ value: "body", label: "In the request body" }, { value: "basic", label: "As Basic auth header" }]))),
                h("div", { class: "hint" }, "The token is fetched before the first request, cached until it expires and sent as a Bearer token."));
            }
        };
        typeSelect.addEventListener("change", () => { auth.type = typeSelect.value; render(); onChange(); });
        render();
        const el = h("div", { class: "ve-auth" }, field("Type", typeSelect), fields,
            h("div", { class: "hint" }, "Every field can use variables such as {{token}}."));
        return { el, refresh: () => { if (auth.type === "inherit") render(); } };
    }

    /** Which parent provides the auth when a folder (or request) inherits. parents: outer -> inner folders. */
    function inheritedAuthText(suite, parents) {
        for (let i = parents.length - 1; i >= 0; i--) {
            const f = parents[i];
            if (f.auth && f.auth.type && f.auth.type !== "inherit") return `Uses ${AUTH_LABELS[f.auth.type] || f.auth.type} from folder “${f.name}”.`;
        }
        const type = suite?.auth?.type && suite.auth.type !== "inherit" ? suite.auth.type : "none";
        return `Uses ${AUTH_LABELS[type] || type} from the suite “${suite?.name || ""}”.`;
    }

    window.ViewHelpers = {
        newId, clone, call, add, AUTH_LABELS, COMMON_HEADERS, defaultAuth, newRequest, newSuite, newVariable, newEnvironment,
        walk, findItem, requestsUnder, countItems, firstRequest, plural, cleanVars, cleanKeyValues, safeFileName, shellQuote,
        closeModalOf, modalButton, safeIcon, getMeta, optionLabel, secretInput, authEditor, inheritedAuthText
    };

    // ================================================================== SuiteEditor

    /**
     * Mounts the settings of a suite (folderId null) or one of its folders into `container`.
     * Changes are saved automatically (debounced). Only the fields edited here are written back, onto the
     * latest saved suite, so edits made meanwhile elsewhere (sidebar, request tabs, captures) are kept.
     */
    function mount(container, { suiteId, folderId = null } = {}) {
        const isFolder = !!folderId;
        const root = h("div", { class: "ve-page se-page" });
        container.appendChild(root);

        const locate = () => {
            const suite = App.getSuite(suiteId);
            if (!suite) return null;
            if (!isFolder) return { suite, item: suite, parents: [] };
            const hit = findItem(suite, folderId);
            return hit && hit.item.type === "folder" ? { suite, item: hit.item, parents: hit.parents } : null;
        };
        const gone = () => {
            clear(root).appendChild(h("div", { class: "empty" },
                h("div", { class: "big" }, safeIcon(isFolder ? "folder" : "suite")),
                h("div", null, isFolder ? "This folder no longer exists." : "This suite no longer exists."),
                h("div", { class: "hint" }, "Close this tab, or pick another item in the sidebar.")));
        };

        let loc = locate();
        if (!loc) {
            gone();
            return () => root.remove();
        }

        // Local working copy of the fields this editor owns
        const local = {
            name: loc.item.name || "",
            description: loc.item.description || "",
            variables: clone(loc.item.variables || []),
            headers: clone(loc.item.headers || []),
            auth: clone(loc.item.auth || defaultAuth(isFolder ? "inherit" : "none"))
        };

        // ------------------------------------------------------------ saving
        const status = h("span", { class: "ve-save-state" });
        const setStatus = (state, message) => {
            status.className = `ve-save-state ${state}`;
            status.textContent = { pending: "Saving…", saved: "All changes saved", error: `Not saved: ${message}` }[state] || "";
            status.title = state === "error" ? message : "";
        };
        let timer = null;
        let dirty = false;
        let disposed = false;
        let chain = Promise.resolve();
        const doSave = async () => {
            const latest = locate();
            if (!latest) return;
            const copy = clone(latest.suite);
            const target = isFolder ? findItem(copy, folderId)?.item : copy;
            if (!target) return;
            target.name = local.name.trim() || target.name || (isFolder ? "Folder" : "Suite");
            target.description = local.description;
            target.variables = cleanVars(local.variables);
            target.headers = cleanKeyValues(local.headers);
            target.auth = clone(local.auth);
            try {
                await App.saveSuite(copy);
                if (!disposed) setStatus(dirty ? "pending" : "saved");
            } catch (err) {
                if (!disposed) setStatus("error", err?.message || String(err));
                else toast(`Suite settings not saved: ${err?.message || err}`, "error");
            }
        };
        const flush = () => {
            clearTimeout(timer);
            timer = null;
            if (!dirty) return chain;
            dirty = false;
            chain = chain.then(doSave);
            return chain;
        };
        const changed = () => {
            dirty = true;
            setStatus("pending");
            clearTimeout(timer);
            timer = setTimeout(flush, 500);
        };

        // ------------------------------------------------------------ header
        const nameInput = h("input", { class: "ve-title-input", value: local.name, placeholder: isFolder ? "Folder name" : "Suite name", spellcheck: "false" });
        nameInput.addEventListener("input", () => { local.name = nameInput.value; changed(); });
        nameInput.addEventListener("blur", () => { if (!nameInput.value.trim()) { nameInput.value = loc.item.name; local.name = loc.item.name; } });

        const meta = h("div", { class: "ve-meta" });
        const renderMeta = () => {
            const counts = countItems(isFolder ? { items: loc.item.items } : loc.suite);
            const parts = [plural(counts.folders, "folder"), plural(counts.requests, "request")];
            if (!isFolder) parts.push(plural((loc.suite.environments || []).length, "environment"));
            add(clear(meta), 
                isFolder ? h("span", null, "Folder in ", h("b", null, loc.suite.name), loc.parents.length ? ` › ${loc.parents.map((p) => p.name).join(" › ")}` : "", " · ") : null,
                parts.join(" · "));
        };

        const runButton = h("button", { class: "btn primary", title: isFolder ? "Run all requests of this folder" : "Run all requests of this suite" },
            safeIcon("play"), isFolder ? "Run folder" : "Run suite");
        runButton.addEventListener("click", async () => {
            await flush();
            App.showRunner({ suiteId, itemIds: [isFolder ? folderId : suiteId] }); // the suite id = whole suite
        });
        const envButton = h("button", { class: "btn", title: "Environments of this suite" }, safeIcon("env"), "Environments");
        envButton.addEventListener("click", async () => { await flush(); Environments.open(suiteId); });
        const exportButton = h("button", { class: "btn", title: "Save this suite as a file to share" }, safeIcon("export"), "Export");
        exportButton.addEventListener("click", async () => { await flush(); ImportExport.openExport(suiteId); });

        const head = h("div", { class: "ve-head" },
            h("div", { class: "ve-kicker" }, safeIcon(isFolder ? "folder" : "suite"), isFolder ? "Folder settings" : "Suite settings"),
            h("div", { class: "ve-title-row" }, nameInput,
                h("div", { class: "ve-head-actions" }, status, runButton, isFolder ? null : envButton, isFolder ? null : exportButton)),
            meta);

        // ------------------------------------------------------------ sections
        const section = (title, hint, ...content) => h("section", { class: "ve-section" },
            h("div", { class: "ve-section-head" }, h("h3", null, title), hint ? h("div", { class: "hint" }, hint) : null),
            ...content);

        const description = h("textarea", { class: "ve-description", rows: 3, placeholder: "What does this " + (isFolder ? "folder" : "suite") + " test? Notes for your team…" });
        description.value = local.description;
        description.addEventListener("input", () => { local.description = description.value; changed(); });

        const variablesTable = kvTable(local.variables, {
            columns: ["enabled", "key", "value", "secret", "description"],
            keyPlaceholder: "name", valuePlaceholder: "value",
            onChange: changed
        });

        const headersTable = kvTable(local.headers, {
            columns: ["enabled", "key", "value", "description"],
            keyPlaceholder: "Header", valuePlaceholder: "value", keySuggestions: COMMON_HEADERS,
            onChange: changed
        });
        const inheritedBox = h("div", { class: "ve-inherited" });
        const renderInherited = () => {
            clear(inheritedBox);
            if (!isFolder) return;
            const rows = [];
            for (const kv of loc.suite.headers || []) if (kv.enabled !== false && kv.key) rows.push({ ...kv, description: "from the suite" });
            for (const f of loc.parents) for (const kv of f.headers || []) if (kv.enabled !== false && kv.key) rows.push({ ...kv, description: `from folder “${f.name}”` });
            if (!rows.length) return;
            add(inheritedBox, h("div", { class: "ve-sub-title" }, "Inherited headers (read only)"),
                kvTable(rows, { columns: ["key", "value", "description"], readOnly: true }));
        };

        const authEd = authEditor(local.auth, {
            allowInherit: isFolder,
            inheritInfo: () => inheritedAuthText(loc.suite, loc.parents),
            onChange: changed
        });

        const envBox = h("div", { class: "ve-env-list" });
        const renderEnvironments = () => {
            if (isFolder) return;
            clear(envBox);
            const envs = loc.suite.environments || [];
            const activeId = App.activeEnvironmentId(suiteId);
            if (!envs.length) {
                envBox.appendChild(h("div", { class: "callout" },
                    h("span", null, "No environments yet. Use them for values that change between machines or stages, like ", h("code", null, "{{baseUrl}}"), " or tokens.")));
            }
            for (const env of envs) {
                const isActive = env.id === activeId;
                const vars = (env.variables || []).filter((v) => v.key);
                const setActive = h("button", { class: "btn small", title: "Use this environment for requests" }, "Use");
                setActive.addEventListener("click", () => attempt(() => App.setActiveEnvironment(suiteId, env.id)));
                const edit = h("button", { class: "btn small ghost", title: "Edit variables" }, safeIcon("edit"), "Edit");
                edit.addEventListener("click", () => Environments.open(suiteId, "environments", env.id));
                envBox.appendChild(h("div", { class: `ve-env-row ${isActive ? "active" : ""}` },
                    safeIcon("env"),
                    h("span", { class: "ve-env-name" }, env.name),
                    h("span", { class: "muted small" }, plural(vars.length, "variable")),
                    isActive ? h("span", { class: "badge info" }, "Active") : null,
                    h("span", { class: "spacer" }),
                    isActive ? null : setActive, edit));
            }
            const manage = h("button", { class: "btn small" }, safeIcon("plus"), envs.length ? "Manage environments" : "Add environment");
            manage.addEventListener("click", () => Environments.open(suiteId, "environments", envs.length ? null : "new"));
            envBox.appendChild(h("div", { class: "ve-env-actions" }, manage));
        };

        const scopeWord = isFolder ? "this folder" : "this suite";
        add(root, 
            head,
            section("Description", null, description),
            section("Variables", isFolder
                ? h("span", null, "Available as ", h("code", null, "{{name}}"), " in the requests of this folder. They override suite variables; environment values override them.")
                : h("span", null, "Available as ", h("code", null, "{{name}}"), " in every request of this suite. Values of the active environment override them."),
            variablesTable),
            section("Default headers", `Sent with every request in ${scopeWord}. A request header with the same name replaces it.`, headersTable, inheritedBox),
            section("Authorization", isFolder ? "Requests in this folder that use “Inherit” get this auth." : "Requests and folders that use “Inherit” get this auth.", authEd.el),
            isFolder ? null : section("Environments", "Environments belong to the suite and are shared with it when you export.", envBox));

        renderMeta();
        renderInherited();
        renderEnvironments();
        setStatus("saved");

        // ------------------------------------------------------------ outside changes
        const onSuitesChanged = () => {
            if (disposed) return;
            const next = locate();
            if (!next) {
                dirty = false;
                clearTimeout(timer);
                gone();
                return;
            }
            loc = next;
            // keep what the user is typing; otherwise follow renames from the sidebar
            if (document.activeElement !== nameInput && !dirty && !timer && nameInput.value !== loc.item.name) {
                nameInput.value = loc.item.name;
                local.name = loc.item.name;
            }
            renderMeta();
            renderInherited();
            renderEnvironments();
            authEd.refresh();
        };
        const offs = [
            App.on("suites-changed", onSuitesChanged),
            App.on("environment-changed", () => { if (!disposed) { loc = locate() || loc; renderEnvironments(); } })
        ];

        return () => {
            flush();
            disposed = true;
            for (const off of offs) { try { if (typeof off === "function") off(); } catch (err) { /* ignore */ } }
            root.remove();
        };
    }

    window.SuiteEditor = { mount };
})();
