"use strict";
/*
 * Settings dialog: request defaults (timeout, redirects, TLS), proxy, limits, local echo server, appearance.
 * Settings.open()
 */
(function () {
    "use strict";
    const VH = window.ViewHelpers;
    const { clone, call, safeIcon, add } = VH;

    const DEFAULTS = {
        timeoutMs: 30000,
        followRedirects: true,
        verifyTls: true,
        proxy: { enabled: false, url: "", noProxy: "localhost,127.0.0.1" },
        maxResponseMB: 20,
        historySize: 100,
        echoServer: { autoStart: true, port: 3999 },
        theme: "system"
    };

    let openPromise = null;

    function open() {
        if (openPromise) return openPromise;
        const current = App.state.settings || {};
        const s = {
            ...clone(DEFAULTS), ...clone(current),
            proxy: { ...DEFAULTS.proxy, ...(current.proxy || {}) },
            echoServer: { ...DEFAULTS.echoServer, ...(current.echoServer || {}) }
        };

        const num = (value, attrs) => h("input", { type: "number", value, ...attrs });
        const timeout = num(s.timeoutMs, { min: 0, max: 3600000, step: 1000 });
        const follow = checkbox("Follow redirects (301, 302, 303, 307, 308)", s.followRedirects !== false);
        const verify = checkbox("Verify TLS certificates", s.verifyTls !== false);
        const tlsHint = h("div", { class: "callout warn hidden" }, "Certificates are not checked: any server can pretend to be the one you test. Use only for local or test servers with self-signed certificates.");
        verify.querySelector("input").addEventListener("change", (e) => tlsHint.classList.toggle("hidden", e.target.checked));
        tlsHint.classList.toggle("hidden", s.verifyTls !== false);

        const proxyOn = checkbox("Send requests through a proxy", !!s.proxy.enabled);
        const proxyUrl = h("input", { type: "text", value: s.proxy.url || "", placeholder: "http://proxy.company.local:8080", spellcheck: "false" });
        const noProxy = h("input", { type: "text", value: s.proxy.noProxy || "", placeholder: "localhost,127.0.0.1,.internal.example.com", spellcheck: "false" });
        const proxyFields = h("div", { class: "form-grid two" },
            field("Proxy URL", proxyUrl, "http:// or https://, optionally with user:password@"),
            field("No proxy for", noProxy, "Comma separated host names or domains (.example.com)"));
        const syncProxy = () => proxyFields.classList.toggle("sg-disabled", !proxyOn.querySelector("input").checked);
        proxyOn.querySelector("input").addEventListener("change", syncProxy);
        syncProxy();

        const maxMb = num(s.maxResponseMB, { min: 1, max: 1024, step: 1 });
        const historySize = num(s.historySize, { min: 0, max: 1000, step: 10 });

        const echoAuto = checkbox("Start the echo server when the app opens", s.echoServer.autoStart !== false);
        const echoPort = num(s.echoServer.port, { min: 1, max: 65535, step: 1 });
        const echoState = h("div", { class: "sg-echo-state" });
        let echo = App.state.info?.echoServer || { running: false };
        const renderEcho = () => {
            clear(echoState);
            const toggle = h("button", { class: `btn small ${echo.running ? "" : "primary"}`, type: "button" }, safeIcon(echo.running ? "stop" : "play"), echo.running ? "Stop" : "Start");
            toggle.addEventListener("click", async () => {
                toggle.disabled = true;
                const port = Number(echoPort.value) || 3999;
                const r = await attempt(() => (echo.running ? call("echo.stop") : call("echo.start", port)));
                if (r && typeof r === "object") echo = r;
                else echo = (await call("echo.status").catch(() => null)) || echo;
                renderEcho();
            });
            if (echo.running) {
                const url = echo.url || `http://127.0.0.1:${echo.port}`;
                const copy = h("button", { class: "btn ghost icon", type: "button", title: "Copy URL" }, safeIcon("copy"));
                copy.addEventListener("click", () => copyText(url));
                add(echoState, h("span", { class: "dot on" }), h("span", null, "Running at ", h("code", null, url)), copy, h("span", { class: "spacer" }), toggle);
            } else {
                add(echoState, h("span", { class: "dot off" }), h("span", { class: "muted" }, "Stopped"), h("span", { class: "spacer" }), toggle);
            }
        };
        renderEcho();
        call("echo.status").then((r) => { if (r) { echo = r; renderEcho(); } }).catch(() => { /* keep what app.info said */ });
        const offEcho = App.on("echo-changed", (r) => { if (r) { echo = r; renderEcho(); } });

        const theme = select([{ value: "system", label: "Same as the system" }, { value: "light", label: "Light" }, { value: "dark", label: "Dark" }], s.theme || "system");

        const info = App.state.info || {};
        const dataBtn = h("button", { class: "btn small", type: "button" }, safeIcon("folderOpen"), "Open data folder");
        dataBtn.addEventListener("click", () => attempt(() => call("app.openDataFolder")));
        const clearHistory = h("button", { class: "btn small", type: "button" }, safeIcon("trash"), "Clear history");
        clearHistory.addEventListener("click", async () => {
            if (!(await confirmDialog("Clear history", "Remove all entries from the request history?", "Clear", true))) return;
            await attempt(() => call("workspace.clearHistory"), "History cleared");
        });

        const section = (title, ...content) => h("section", { class: "sg-section" }, h("h3", null, title), ...content);
        const body = h("div", { class: "sg-dialog" },
            section("Requests",
                h("div", { class: "form-grid two" }, field("Timeout (ms)", timeout, "0 = wait forever. A request can override it.")),
                h("div", { class: "checks" }, follow, verify),
                tlsHint),
            section("Proxy", proxyOn, proxyFields),
            section("Limits",
                h("div", { class: "form-grid two" },
                    field("Max. response size (MB)", maxMb, "Bigger responses are cut off"),
                    field("History entries", historySize, "Requests kept in the History list"))),
            section("Local echo server",
                h("div", { class: "hint" }, "A small test API on this machine (used by the sample suite): /anything, /status/404, /delay/500, /json, /users, /login …"),
                h("div", { class: "form-grid two" }, field("Port", echoPort), h("div", { class: "field sg-echo-field" }, h("label", null, "Status"), echoState)),
                echoAuto),
            section("Appearance", h("div", { class: "form-grid two" }, field("Theme", theme))),
            section("About",
                h("div", { class: "kv sg-about" },
                    h("div", null, "Version"), h("div", null, info.version || "—"),
                    h("div", null, "Data folder"), h("div", null, info.dataDir || "—"),
                    h("div", null, "Logs"), h("div", null, info.logDir || "—")),
                h("div", { class: "row wrap", style: { marginTop: "8px" } }, dataBtn, clearHistory)));

        // same limits as main (workspace.js normalizeSettings)
        const readNumber = (input, label, min, max, integer = true) => {
            const v = Number(input.value);
            if (input.value === "" || !Number.isFinite(v) || v < min || v > max) {
                input.focus();
                throw new Error(`${label}: enter a number from ${min} to ${max}`);
            }
            return integer ? Math.round(v) : v;
        };

        const save = async () => {
            const next = clone(App.state.settings || {});
            next.timeoutMs = readNumber(timeout, "Timeout", 0, 3600000);
            next.followRedirects = follow.querySelector("input").checked;
            next.verifyTls = verify.querySelector("input").checked;
            const pUrl = proxyUrl.value.trim();
            const pOn = proxyOn.querySelector("input").checked;
            if (pOn && !/^https?:\/\/[^\s/]+/i.test(pUrl)) { proxyUrl.focus(); throw new Error("Proxy URL: enter it like http://proxy.local:8080"); }
            next.proxy = { enabled: pOn, url: pUrl, noProxy: noProxy.value.trim() };
            next.maxResponseMB = readNumber(maxMb, "Max. response size", 1, 1024, false);
            next.historySize = readNumber(historySize, "History entries", 0, 1000);
            const port = readNumber(echoPort, "Echo server port", 1, 65535);
            const portChanged = Number(s.echoServer.port) !== port;
            next.echoServer = { autoStart: echoAuto.querySelector("input").checked, port };
            next.theme = theme.value;
            await App.saveSettings(next);
            // a running echo server moves to the new port right away
            if (portChanged && echo.running && Number(echo.port) !== port) {
                const r = await attempt(async () => { await call("echo.stop"); return call("echo.start", port); });
                if (r && r.running) toast(`Echo server now runs on port ${r.port}. Update baseUrl in environments that use the old port.`, "info");
            }
            toast("Settings saved", "success");
            return true;
        };

        openPromise = modal({ title: "Settings", body, wide: true, buttons: [{ label: "Cancel", value: null }, { label: "Save", class: "primary", onClick: save }] });
        openPromise.finally(() => { openPromise = null; if (typeof offEcho === "function") offEcho(); });
        return openPromise;
    }

    window.Settings = { open };
})();
