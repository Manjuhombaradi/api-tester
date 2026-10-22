"use strict";
/*
 * First-run welcome: try the sample suite (starts the local echo server), start with an empty suite, or import.
 * Welcome.show()
 */
(function () {
    "use strict";
    const VH = window.ViewHelpers;
    const { call, safeIcon, firstRequest } = VH;

    let openPromise = null;

    /** -> true when the sample suite was added. */
    async function addSampleSuite() {
        if (typeof App.addSampleSuite === "function") {
            // the shell's version also starts the echo server and reveals the suite in the sidebar
            const saved = await App.addSampleSuite();
            if (!saved) return false;
            const echo = App.state.info && App.state.info.echoServer;
            // App.addSampleSuite already reports the result (one toast per action)
            return true;
        }
        // the sample talks to the local echo server; it works without it too (requests then fail with a clear error)
        let echo = null;
        try {
            echo = await call("echo.start");
        } catch (err) {
            toast(`The local echo server did not start: ${err?.message || err}. Change its port in Settings.`, "warn");
        }
        const suite = await call("tools.sampleSuite");
        await App.saveSuite(suite);
        const req = firstRequest(suite);
        setTimeout(() => {
            if (req) App.openRequest(suite.id, req.id);
            else App.openItemSettings(suite.id, null);
        }, 0);
        toast(echo && echo.running
            ? `Sample suite added. The echo server runs at ${echo.url || `http://127.0.0.1:${echo.port}`}. Press Send to try the first request.`
            : "Sample suite added.", "success");
        return true;
    }

    async function createEmptySuite(name, baseUrl) {
        const url = String(baseUrl || "").trim().replace(/\/+$/, "");
        const env = url ? VH.newEnvironment("Default", [VH.newVariable("baseUrl", url, { description: "Start of every URL" })]) : null;
        const request = VH.newRequest("First request", { url: url ? "{{baseUrl}}/" : "" });
        const suite = VH.newSuite(String(name || "").trim() || "My API", {
            environments: env ? [env] : [],
            activeEnvironmentId: env ? env.id : null,
            items: [request]
        });
        await App.saveSuite(suite);
        setTimeout(() => App.openRequest(suite.id, request.id), 0);
        toast(`Suite “${suite.name}” created`, "success");
    }

    function markDone() {
        // saving the UI state creates the workspace file, so the next start is not a "first run" any more
        try {
            if (typeof App.saveUi === "function") App.saveUi({ welcomeDone: true });
            else if (App.state.ui && typeof App.state.ui === "object") {
                App.state.ui.welcomeDone = true;
                call("workspace.saveUi", App.state.ui).catch(() => { /* not critical */ });
            }
        } catch (err) { /* not critical */ }
    }

    function show() {
        if (openPromise) return openPromise;
        let choice = "sample";
        const nameInput = h("input", { type: "text", value: "My API", placeholder: "Suite name", spellcheck: "false" });
        const urlInput = h("input", { type: "text", value: "", placeholder: "https://api.example.com (optional)", spellcheck: "false" });
        const emptyFields = h("div", { class: "form-grid two wl-empty-fields hidden" },
            field("Suite name", nameInput),
            field("Base URL", urlInput, h("span", null, "Saved as ", h("code", null, "{{baseUrl}}"), " in a “Default” environment")));

        const choices = [
            { id: "sample", icon: "play", title: "Try the sample suite", badge: "Recommended", desc: "Ready-made requests against the built-in echo server: assertions, captured tokens, OAuth 2.0, a data-driven runner demo. Works offline." },
            { id: "empty", icon: "plus", title: "Start empty", desc: "A new suite with one request. Optionally set the base URL of your API." },
            { id: "import", icon: "import", title: "Import…", desc: "A suite file from a colleague (.apisuite), a Postman collection, an OpenAPI / Swagger file or a cURL command." }
        ];
        const grid = h("div", { class: "wl-choices" });
        const renderChoices = () => {
            clear(grid);
            for (const c of choices) {
                const card = h("button", { class: `wl-choice ${choice === c.id ? "selected" : ""}`, type: "button" },
                    h("div", { class: "wl-choice-icon" }, safeIcon(c.icon)),
                    h("div", { class: "wl-choice-title" }, c.title, c.badge ? h("span", { class: "badge info" }, c.badge) : null),
                    h("div", { class: "wl-choice-desc" }, c.desc));
                card.addEventListener("click", () => { choice = c.id; renderChoices(); if (c.id === "empty") setTimeout(() => nameInput.focus(), 20); });
                card.addEventListener("dblclick", () => { choice = c.id; VH.modalButton(body, "Continue")?.click(); });
                grid.appendChild(card);
            }
            emptyFields.classList.toggle("hidden", choice !== "empty");
        };

        const features = [
            ["send", "Send requests", "any method, params, headers, JSON / form / file bodies, auth"],
            ["check", "Check responses", "assertions without code: status, JSON values, headers, time, schema"],
            ["env", "Environments", "the same suite against local, test and production"],
            ["runner", "Run whole suites", "iterations, CSV data, HTML / JUnit reports, command line for CI"],
            ["export", "Share", "export a suite file, a colleague imports it"]
        ];
        const body = h("div", { class: "wl" },
            h("div", { class: "wl-intro" },
                h("div", { class: "wl-logo" }, "API"),
                h("div", null,
                    h("div", { class: "wl-headline" }, "Test HTTP APIs on your machine"),
                    h("div", { class: "muted" }, "Everything stays local. Pick how you want to start:"))),
            grid,
            emptyFields,
            h("div", { class: "wl-features" }, features.map(([ic, title, desc]) => h("div", { class: "wl-feature" }, safeIcon(ic), h("div", null, h("b", null, title), h("span", { class: "muted" }, ` — ${desc}`))))),
            h("div", { class: "hint" }, "You can come back here any time: Help (F1) → Getting started."));
        renderChoices();

        const go = async () => {
            if (choice === "sample") { if (!(await addSampleSuite())) return false; } // keep the welcome open on failure
            else if (choice === "empty") await createEmptySuite(nameInput.value, urlInput.value);
            else setTimeout(() => ImportExport.openImport(), 0);
            markDone();
            return true;
        };
        openPromise = modal({
            title: "Welcome to API Tester",
            body,
            wide: true,
            buttons: [
                { label: "Skip", value: null },
                { label: "Continue", class: "primary", onClick: go }
            ]
        });
        openPromise.then((v) => { if (v === null) markDone(); }).finally(() => { openPromise = null; });
        return openPromise;
    }

    window.Welcome = { show };
})();
