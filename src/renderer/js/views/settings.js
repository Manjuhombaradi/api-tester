"use strict";
/*
 * Settings dialog: request defaults (timeout, redirects, TLS), proxy, limits, local echo server, privacy & security,
 * appearance.
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
        enforceTlsVerification: false,
        extraCaFile: "",
        proxy: { enabled: false, url: "", noProxy: "localhost,127.0.0.1" },
        maxResponseMB: 20,
        historySize: 100,
        echoServer: { autoStart: false, port: 3999 },
        theme: "system"
    };

    let openPromise = null;

    /**
     * "http://user:pass@proxy:8080" -> { url: "http://user@proxy:8080", password: "pass" (decoded), raw: "pass" }.
     * The password gets its own masked field instead of showing in the URL.
     */
    function splitProxyUrl(value) {
        const text = String(value || "");
        const m = /^([a-z][a-z\d+.-]*:\/\/)([^/?#]*)(.*)$/i.exec(text);
        if (!m) return { url: text, password: "", raw: "" };
        const at = m[2].lastIndexOf("@");
        const info = at < 0 ? "" : m[2].slice(0, at);
        const colon = info.indexOf(":");
        if (colon < 0) return { url: text, password: "", raw: "" };
        const raw = info.slice(colon + 1);
        let password = raw;
        try { password = decodeURIComponent(raw); } catch (_) { /* keep as written */ }
        return { url: `${m[1]}${info.slice(0, colon)}${m[2].slice(at)}${m[3]}`, password, raw };
    }

    /** Puts the password back into the proxy URL (unchanged text when it was not edited). */
    function joinProxyUrl(url, password, original) {
        if (!password) return url;
        const m = /^([a-z][a-z\d+.-]*:\/\/)([^/?#]*)(.*)$/i.exec(url);
        if (!m) return url;
        const at = m[2].lastIndexOf("@");
        if (at < 0) throw new Error("Proxy password: add the user name to the proxy URL, like http://user@proxy.local:8080");
        const info = m[2].slice(0, at);
        if (info.includes(":")) return url; // a password typed into the URL itself wins
        const raw = original && password === original.password ? original.raw : encodeURIComponent(password);
        return `${m[1]}${info}:${raw}${m[2].slice(at)}${m[3]}`;
    }

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
        const enforce = checkbox("Enforce TLS verification", s.enforceTlsVerification === true);
        const enforceHint = h("div", { class: "hint" }, "Certificates are always checked, also for requests that turn checking off: “Do not verify” in a request, suites from other people, ",
            "Postman's strictSSL: false and cURL -k are ignored. Recommended in organisations.");
        const verifyInput = verify.querySelector("input");
        const enforceInput = enforce.querySelector("input");
        const syncTls = () => {
            if (enforceInput.checked) verifyInput.checked = true;
            verifyInput.disabled = enforceInput.checked;
            verify.classList.toggle("sg-disabled", enforceInput.checked);
            tlsHint.classList.toggle("hidden", verifyInput.checked);
        };
        verifyInput.addEventListener("change", syncTls);
        enforceInput.addEventListener("change", syncTls);
        syncTls();

        // company root certificates (TLS-inspecting proxies, internal certificate authorities)
        let caFile = s.extraCaFile || "";
        const caPath = h("code", { class: "sg-ca-path" });
        const caState = h("div", { class: "hint" });
        const caRemove = h("button", { class: "btn small", type: "button" }, "Remove");
        const caChoose = h("button", { class: "btn small", type: "button" }, "Choose file…");
        const renderCa = () => {
            caPath.textContent = caFile || "None";
            caRemove.classList.toggle("hidden", !caFile);
            const st = (App.state.info && App.state.info.trustedCa) || null;
            caState.textContent = st && st.error ? `Problem: ${st.error}`
                : st && st.count && caFile === (s.extraCaFile || "") ? `${st.count} extra certificate(s) trusted.`
                : "PEM file with your company's root certificate(s), from your IT department. Added to the built-in trusted roots.";
        };
        caChoose.addEventListener("click", async () => {
            const picked = await call("files.pickFile", { title: "Choose the CA certificate file (PEM)", purpose: "ca", filters: [{ name: "PEM certificates", extensions: ["pem", "crt", "cer"] }] });
            if (picked) { caFile = picked; renderCa(); }
        });
        caRemove.addEventListener("click", () => { caFile = ""; renderCa(); });
        renderCa();

        const proxyOn = checkbox("Send requests through a proxy", !!s.proxy.enabled);
        const proxyParts = splitProxyUrl(s.proxy.url);
        const proxyUrl = h("input", { type: "text", value: proxyParts.url, placeholder: "http://proxy.company.local:8080", spellcheck: "false" });
        const proxyPassword = secretInput(proxyParts.password, { placeholder: "Only if the proxy needs a login" });
        const proxyPasswordInput = proxyPassword.querySelector("input");
        const noProxy = h("input", { type: "text", value: s.proxy.noProxy || "", placeholder: "localhost,127.0.0.1,.internal.example.com", spellcheck: "false" });
        const proxyFields = h("div", { class: "form-grid two" },
            field("Proxy URL", proxyUrl, "http:// or https://, with user@ when the proxy needs a login (http://user@proxy:8080)"),
            field("Proxy password", proxyPassword, "Hidden here; saved encrypted with the system keychain when one is available"),
            field("No proxy for", noProxy, "Comma separated host names or domains (.example.com)"));
        const syncProxy = () => proxyFields.classList.toggle("sg-disabled", !proxyOn.querySelector("input").checked);
        proxyOn.querySelector("input").addEventListener("change", syncProxy);
        syncProxy();

        const maxMb = num(s.maxResponseMB, { min: 1, max: 1024, step: 1 });
        const historySize = num(s.historySize, { min: 0, max: 1000, step: 10 });

        const echoAuto = checkbox("Start the echo server when the app opens", s.echoServer.autoStart === true);
        const echoAutoHint = h("div", { class: "hint" }, "Off by default: the echo server runs only after you start it (here, in the status bar, or by adding the sample suite). ",
            "It accepts connections from this computer only (127.0.0.1).");
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

        // ---------------------------------------------------------- privacy & security
        const keychain = { darwin: "the macOS Keychain", win32: "Windows (DPAPI, tied to your user account and this computer)", linux: "the system keyring (GNOME Keyring / KWallet)" }[info.platform] || "the system keychain";
        const secretBox = h("div", { class: "stack tight" });
        const renderSecrets = (state) => {
            clear(secretBox);
            if (state === "plaintext") {
                const ui = App.state.ui || {};
                if (!ui.secretNoteDismissed) {
                    const ok = h("button", { class: "btn small", type: "button" }, "OK");
                    ok.addEventListener("click", () => { App.saveUi({ secretNoteDismissed: true }); renderSecrets(state); });
                    add(secretBox, h("div", { class: "callout warn" }, safeIcon("unlock"),
                        h("span", null, h("b", null, "Saved secrets are not encrypted. "), "No system keychain is available",
                            info.platform === "linux" ? " (install and unlock GNOME Keyring or KWallet, then restart API Tester)" : "",
                            ". Passwords, tokens, API keys and secret variables are stored as plain text in workspace.json, in a folder only your user account can open."), ok));
                } else {
                    add(secretBox, h("div", { class: "hint" }, safeIcon("unlock"), " Saved secrets are stored unencrypted (no system keychain available); the data folder is readable only by your user account."));
                }
            } else {
                add(secretBox, h("div", { class: "hint" }, safeIcon("lock"), ` Saved passwords, tokens, API keys, secret variables and URLs with a password or token are encrypted with ${keychain}`,
                    state === "encrypted" ? "." : " as soon as you save one.", " The history keeps no credentials. The data folder is readable only by your user account."));
            }
        };
        renderSecrets("none");
        call("app.secretStorage").then(renderSecrets).catch(() => { /* keep the general text */ });

        const section = (title, ...content) => h("section", { class: "sg-section" }, h("h3", null, title), ...content);
        const body = h("div", { class: "sg-dialog" },
            section("Requests",
                h("div", { class: "form-grid two" }, field("Timeout (ms)", timeout, "0 = wait forever. A request can override it.")),
                h("div", { class: "checks" }, follow, verify),
                tlsHint,
                enforce,
                enforceHint,
                field("Trusted CA certificates", h("div", { class: "row wrap" }, caPath, caChoose, caRemove), null),
                caState),
            section("Proxy", proxyOn, proxyFields),
            section("Limits",
                h("div", { class: "form-grid two" },
                    field("Max. response size (MB)", maxMb, "Bigger responses are cut off"),
                    field("History entries", historySize, "Requests kept in the History list"))),
            section("Local echo server",
                h("div", { class: "hint" }, "A small test API on this machine (used by the sample suite): /anything, /status/404, /delay/500, /json, /users, /login …"),
                h("div", { class: "form-grid two" }, field("Port", echoPort), h("div", { class: "field sg-echo-field" }, h("label", null, "Status"), echoState)),
                echoAuto,
                echoAutoHint),
            section("Privacy & security",
                h("div", { class: "hint" }, safeIcon("globe"), " API Tester connects only to the servers you send requests to. It makes no connections of its own: no update checks, telemetry or crash reports."),
                h("div", { class: "hint" }, safeIcon("file"), " Requests upload files from this computer only when you chose them in the app or allowed them when asked. Allowed files are remembered on this computer, never in exported suites."),
                secretBox),
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
            next.enforceTlsVerification = enforce.querySelector("input").checked;
            next.extraCaFile = caFile;
            const pOn = proxyOn.querySelector("input").checked;
            let pUrl;
            try {
                pUrl = joinProxyUrl(proxyUrl.value.trim(), proxyPasswordInput.value, proxyParts);
            } catch (err) {
                proxyUrl.focus();
                throw err;
            }
            if (pOn && !/^https?:\/\/[^\s/]+/i.test(pUrl)) { proxyUrl.focus(); throw new Error("Proxy URL: enter it like http://proxy.local:8080"); }
            next.proxy = { enabled: pOn, url: pUrl, noProxy: noProxy.value.trim() };
            next.maxResponseMB = readNumber(maxMb, "Max. response size", 1, 1024, false);
            next.historySize = readNumber(historySize, "History entries", 0, 1000);
            const port = readNumber(echoPort, "Echo server port", 1, 65535);
            const portChanged = Number(s.echoServer.port) !== port;
            next.echoServer = { autoStart: echoAuto.querySelector("input").checked, port };
            next.theme = theme.value;
            await App.saveSettings(next);
            try { App.state.info = await call("app.info"); } catch (_) { /* status line only */ }
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
