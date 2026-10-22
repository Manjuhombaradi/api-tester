"use strict";
/*
 * Built-in guide: getting started, shortcuts, variables (+ dynamic variables from main), assertions, captures,
 * scripts, runner & data files, command line / CI, sharing suites, troubleshooting.
 * Help.open(topic?)   topic: one of the TOPICS ids
 */
(function () {
    "use strict";
    const VH = window.ViewHelpers;
    const { call, safeIcon, add } = VH;

    // Explanations for the assertion operators (labels come from main's metadata when available)
    const OPERATOR_HELP = {
        equals: ["Same value. Numbers compare as numbers (200 = 200.0); JSON objects and arrays compare by content.", "Status · equals · 200"],
        notEquals: ["Any other value.", "$.status · not equals · error"],
        contains: ["Text contains the expected text (case-sensitive); an array contains the item.", "Body · contains · \"ok\""],
        notContains: ["Text or array does not contain it.", "Body · not contains · Exception"],
        startsWith: ["Text starts with it.", "Content type · starts with · application/json"],
        endsWith: ["Text ends with it.", "$.email · ends with · @example.com"],
        gt: ["Greater than (numbers).", "$.total · > · 0"],
        gte: ["Greater than or equal.", "$.items.length · >= · 1"],
        lt: ["Less than.", "Response time · < · 500"],
        lte: ["Less than or equal.", "Size · <= · 10000"],
        exists: ["The value is present (not undefined). No expected value needed.", "$.data.id · exists"],
        notExists: ["The value is missing.", "$.error · not exists"],
        matches: ["Regular expression, plain (\\d+) or with flags (/abc/i).", "$.id · matches · ^[0-9a-f-]{36}$"],
        isType: ["JSON type: string, number, boolean, object, array or null.", "$.items · is type · array"],
        lengthEquals: ["Length of a text or array.", "$.items · length equals · 10"],
        lengthGt: ["Length greater than.", "$.name · length > · 0"],
        lengthLt: ["Length less than.", "$.items · length < · 101"],
        in: ["One of a list: comma separated or a JSON array.", "Status · in · 200, 201, 204"],
        notIn: ["None of the list.", "Status · not in · 500, 502, 503"],
        isEmpty: ["Empty text, array or object (or missing).", "$.errors · is empty"],
        isNotEmpty: ["Has content.", "$.token · is not empty"],
        validSchema: ["The JSON body matches a JSON Schema (draft 2020-12 / 07, formats like email, date-time).", "Body schema · valid schema · {\"type\":\"object\",\"required\":[\"id\"]}"]
    };

    const SOURCE_HELP = {
        status: "HTTP status code, e.g. 200",
        statusText: "Status text, e.g. OK",
        responseTime: "Total time in milliseconds",
        size: "Body size in bytes",
        header: "A response header (name is not case-sensitive)",
        contentType: "The Content-Type header",
        body: "The whole body as text",
        jsonpath: "A value in the JSON body, by JSONPath",
        schema: "The whole JSON body, checked against a JSON Schema",
        script: "Results of test() in the post-response script"
    };

    const TOPICS = [
        { id: "start", title: "Getting started", icon: "play" },
        { id: "shortcuts", title: "Keyboard shortcuts", icon: "more" },
        { id: "variables", title: "Variables & environments", icon: "env" },
        { id: "assertions", title: "Assertions", icon: "check" },
        { id: "captures", title: "Captures & chaining", icon: "copy" },
        { id: "scripts", title: "Scripts", icon: "code" },
        { id: "runner", title: "Runner & data files", icon: "runner" },
        { id: "cli", title: "Command line & CI", icon: "code" },
        { id: "sharing", title: "Sharing suites", icon: "export" },
        { id: "troubleshooting", title: "Troubleshooting", icon: "help" }
    ];
    const TOPIC_ALIASES = { shortcut: "shortcuts", keys: "shortcuts", variable: "variables", environments: "variables", assertion: "assertions", tests: "assertions", capture: "captures", extract: "captures", script: "scripts", run: "runner", data: "runner", ci: "cli", share: "sharing", import: "sharing", export: "sharing", about: "troubleshooting" };

    let openPromise = null;

    function open(topic) {
        const wanted = TOPIC_ALIASES[topic] || topic;
        if (openPromise && openPromise.select) { openPromise.select(wanted); return openPromise; }
        let active = TOPICS.some((t) => t.id === wanted) ? wanted : "start";
        const info = App.state.info || {};
        const isMac = info.platform === "darwin";
        const mod = isMac ? "⌘" : "Ctrl";
        const cli = info.cliCommand || "api-tester";

        const nav = h("div", { class: "hp-nav" });
        const content = h("div", { class: "hp-content help" });
        const body = h("div", { class: "hp" }, nav, content);

        const code = (t) => h("code", null, t);
        const kbd = (t) => h("kbd", null, t);
        const p = (...c) => h("p", null, ...c);
        const ul = (...items) => h("ul", null, items.filter(Boolean).map((i) => h("li", null, i)));
        const title = (t) => h("h3", null, t);
        const block = (text) => {
            const copy = h("button", { class: "btn ghost icon hp-copy", type: "button", title: "Copy" }, safeIcon("copy"));
            copy.addEventListener("click", () => copyText(text));
            return h("div", { class: "hp-block" }, h("pre", null, text), copy);
        };
        const table = (head, rows) => h("div", { class: "table-wrap hp-table" }, h("table", null,
            h("thead", null, h("tr", null, head.map((x) => h("th", null, x)))),
            h("tbody", null, rows.map((r) => h("tr", null, r.map((c) => h("td", null, c)))))));
        const button = (label, onClick, cls = "btn small") => { const b = h("button", { class: cls, type: "button" }, label); b.addEventListener("click", onClick); return b; };

        const RENDER = {
            start: () => [
                title("Getting started"),
                h("ol", null,
                    h("li", null, "Create a suite with ", h("b", null, "+"), " in the sidebar, import one, or try the sample suite. A suite holds folders, requests and environments."),
                    h("li", null, "Pick an environment in the top bar and write URLs like ", code("{{baseUrl}}/users"), "."),
                    h("li", null, "Press ", h("b", null, "Send"), " (", kbd(`${mod} + Enter`), "). The response shows body, headers, cookies, tests and a timeline."),
                    h("li", null, "Add checks in ", h("b", null, "Assertions"), " — ", h("b", null, "Add suggested"), " creates sensible ones from the last response. Click a value in the JSON response to assert or capture it."),
                    h("li", null, "Capture values (a token, a new id) in ", h("b", null, "Capture"), " and use them in later requests as ", code("{{token}}"), "."),
                    h("li", null, "Run a whole suite or folder in the ", h("b", null, "Runner"), ", with iterations and CSV data, and export an HTML or JUnit report."),
                    h("li", null, h("b", null, "Export"), " the suite as a file to share it; others ", h("b", null, "Import"), " it.")),
                h("div", { class: "row wrap" },
                    button("Show the welcome screen", () => { closeHelp(); setTimeout(() => Welcome.show(), 0); }, "btn small primary"),
                    button("Open data folder", () => attempt(() => call("app.openDataFolder")))),
                p(h("span", { class: "muted small" }, `Version ${info.version || "?"} · ${info.platform || ""}${info.dataDir ? ` · data in ${info.dataDir}` : ""}`))
            ],

            shortcuts: () => [
                title("Keyboard shortcuts"),
                h("div", { class: "kv hp-kv" }, ...[
                    ["Send the request", `${mod} + Enter`],
                    ["Save the request", `${mod} + S`],
                    ["New request", `${mod} + N`],
                    ["New suite", `${mod} + Shift + N`],
                    ["Close the tab", `${mod} + W`],
                    ["Next / previous tab", "Ctrl + Tab / Ctrl + Shift + Tab"],
                    ["Go to tab 1 … 9", `${mod} + 1 … 9`],
                    ["Search requests", `${mod} + K`],
                    ["Go to the URL field", `${mod} + L`],
                    ["Import", `${mod} + O`],
                    ["Export the suite", `${mod} + Shift + E`],
                    ["Environments", `${mod} + E`],
                    ["Runner", `${mod} + Shift + R`],
                    ["Settings", `${mod} + ,`],
                    ["Light / dark theme", `${mod} + Shift + L`],
                    ["Help", "F1"],
                    ["Close a dialog or menu", "Esc"],
                    ["Insert a variable", "type {{"]
                ].flatMap(([a, b]) => [h("div", null, a), h("div", null, kbd(b))])),
                p(h("span", { class: "hint" }, "The menu bar shows all commands with their shortcuts."))
            ],

            variables: () => {
                const box = h("div", null, h("div", { class: "muted" }, "Loading…"));
                VH.getMeta().then((meta) => {
                    clear(box);
                    if (!meta.dynamicVariables.length) { box.appendChild(h("div", { class: "hint" }, "The list of dynamic variables could not be loaded.")); return; }
                    box.appendChild(table(["Variable", "Value"], meta.dynamicVariables.map((d) => [code(`{{${d.name}}}`), d.description])));
                });
                return [
                    title("Variables"),
                    p("Write ", code("{{name}}"), " in the URL, params, headers, body, auth fields and expected values of assertions. Unknown names stay as written and are highlighted in red; the request's Console lists them."),
                    p("Where variables come from, highest priority first:"),
                    h("ol", null,
                        h("li", null, h("b", null, "Runtime"), " — captured values and ", code("vars.set()"), " from scripts in this session (Environments → Runtime)"),
                        h("li", null, h("b", null, "Data row"), " — columns of the runner's data file, per iteration"),
                        h("li", null, h("b", null, "Environment"), " — the active environment of the suite (top bar)"),
                        h("li", null, h("b", null, "Folder"), " — folder variables, inner folder first"),
                        h("li", null, h("b", null, "Suite"), " — suite variables"),
                        h("li", null, h("b", null, "Globals"), " — for all suites on this machine")),
                    p("A value may use other variables, e.g. ", code("url = {{scheme}}://{{host}}"), ". Mark tokens and passwords as ", h("b", null, "secret"), ": they are masked in logs and reports and left out of exported files unless you include them."),
                    h("div", { class: "row wrap" }, button("Open environments", () => { closeHelp(); setTimeout(() => Environments.open(App.activeSuiteId()), 0); })),
                    title("Dynamic variables"),
                    p("A new value every time they are used:"),
                    box
                ];
            },

            assertions: () => {
                const box = h("div", null, h("div", { class: "muted" }, "Loading…"));
                VH.getMeta().then((meta) => {
                    clear(box);
                    const sources = meta.assertionSources.length ? meta.assertionSources : Object.keys(SOURCE_HELP).map((value) => ({ value, label: value }));
                    const operators = meta.assertionOperators.length ? meta.assertionOperators : Object.keys(OPERATOR_HELP).map((value) => ({ value, label: value }));
                    add(box, 
                        title("What can be checked"),
                        table(["Source", "Meaning", "Property"], sources.filter((s) => s.value !== "script" || true).map((s) => [
                            h("b", null, s.label || s.value), s.hint || SOURCE_HELP[s.value] || "", s.needsProperty ? code(s.propertyPlaceholder || "required") : h("span", { class: "muted" }, "—")])),
                        title("Operators"),
                        table(["Operator", "Passes when", "Example"], operators.map((o) => [
                            h("b", null, o.label || o.value), (OPERATOR_HELP[o.value] || [""])[0], h("span", { class: "mono small" }, (OPERATOR_HELP[o.value] || ["", ""])[1])])));
                });
                return [
                    title("Assertions"),
                    p("Assertions check a response without writing code. Each row is: ", h("b", null, "source"), " (what to look at), ", h("b", null, "property"), " (header name or JSONPath, when needed), ", h("b", null, "operator"), " and ", h("b", null, "expected value"), ". A request passes when all enabled assertions pass."),
                    ul(
                        ["JSONPath examples: ", code("$.id"), ", ", code("$.data[0].name"), ", ", code("$.items.length"), ", ", code("$..price"), " (all prices), ", code("$.users[?(@.active)].email"), "."],
                        ["Expected values may use variables: ", code("$.id equals {{userId}}"), "."],
                        "Numbers compare as numbers when both sides are numeric; texts are case-sensitive.",
                        ["Tip: in the response body, click a value and choose ", h("b", null, "Assert equals …"), " (the menu shows the value)."]),
                    box
                ];
            },

            captures: () => {
                const box = h("div");
                VH.getMeta().then((meta) => {
                    if (!meta.extractSources.length) return;
                    box.appendChild(table(["Source", "Property"], meta.extractSources.map((s) => [h("b", null, s.label || s.value), s.hint || s.propertyPlaceholder || ""])));
                });
                return [
                    title("Captures & chaining"),
                    p("A capture takes a value from the response and stores it in a variable, so later requests can use it. Typical flow:"),
                    h("ol", null,
                        h("li", null, code("POST {{baseUrl}}/login"), " → Capture: JSONPath ", code("$.token"), " → variable ", code("token")),
                        h("li", null, code("GET {{baseUrl}}/me"), " with auth Bearer token ", code("{{token}}"))),
                    title("Where the value is stored"),
                    ul(
                        [h("b", null, "Runtime"), " (default) — for this session or run only; not saved. See Environments → Runtime."],
                        [h("b", null, "Environment"), " — saved into the active environment (shared when you export it)."],
                        [h("b", null, "Global"), " — saved in globals, for all suites on this machine."]),
                    p("Objects and arrays are stored as JSON text. In the runner, captured values carry over from request to request across the whole run."),
                    box
                ];
            },

            scripts: () => [
                title("Scripts (optional)"),
                p("For cases the tables can't cover. JavaScript runs before the request (pre-request) or after the response (post-response), in a sandbox without file or network access, with a 5 second limit."),
                table(["In scripts", "What it does"], [
                    [code("vars.get(\"name\")"), "Read a variable (any level)"],
                    [code("vars.set(\"name\", value, \"runtime\")"), "Set a variable; scope runtime (default), environment or global"],
                    [code("env.name"), "Name of the active environment"],
                    [code("request.url / .method / .headers / .body"), "Pre-request: change them before sending. Post-response: read only"],
                    [code("response.status / .headers / .body / .json() / .time"), "Post-response only"],
                    [code("test(\"name\", () => { … })"), "A named check; shows in Tests and reports"],
                    [code("expect(x).toBe(y)"), "Also toEqual, toContain, toBeGreaterThan, toBeLessThan, toMatch, toBeTruthy, toBeFalsy, toBeDefined, toHaveProperty, toHaveLength, .not"],
                    [code("console.log(…)"), "Output appears in the Console tab"]
                ]),
                title("Example (post-response)"),
                block([
                    "const body = response.json();",
                    "test(\"has users\", () => {",
                    "    expect(response.status).toBe(200);",
                    "    expect(body.users.length).toBeGreaterThan(0);",
                    "});",
                    "vars.set(\"firstUserId\", body.users[0].id);"
                ].join("\n"))
            ],

            runner: () => [
                title("Runner"),
                p("Runs many requests in a row, in tree order. Open it with ", h("b", null, "Runner"), " in the top bar, or ", h("b", null, "Run"), " on a suite or folder."),
                ul(
                    "Tick the folders and requests to run, choose the environment and the number of iterations.",
                    "Delay adds a pause between requests (rate limits). “Stop on the first failure” ends the run at the first failed request.",
                    "Results come in live; click a row for assertions, captured values, console output and the response.",
                    ["Export the result as ", h("b", null, "HTML"), " (to read and share), ", h("b", null, "JUnit XML"), " (for CI servers) or ", h("b", null, "JSON"), "."],
                    "The runner uses the saved suite: save open requests first."),
                title("Data files (data-driven tests)"),
                p("Choose a CSV or JSON file: each row is one iteration, and each column a variable for that iteration."),
                block("name,email,expectedStatus\nAnn,ann@example.com,201\nBob,bob@example.com,201\n,missing-name@example.com,400"),
                p("Use ", code("{{name}}"), ", ", code("{{email}}"), " in the request body and ", code("{{expectedStatus}}"), " as the expected value of a Status assertion. CSV may use commas or semicolons and quotes; JSON must be an array of objects like ", code("[{\"name\": \"Ann\"}]"), ".")
            ],

            cli: () => [
                title("Command line"),
                info.isPortable
                    ? p("Run exported suites without the window — on a build server, in a pipeline or in a terminal. The portable app has no command line version: use the installer (",
                        code("bin\\api-tester.cmd"), "), Node.js or Docker. With the installed version:")
                    : p("Run exported suites without the window — on a build server, in a pipeline or in a terminal. The command for this installation:"),
                block(`${cli} run my-api.apisuite --env "Test" --reporter cli,junit,html --out reports`),
                info.platform === "win32" ? p("In PowerShell put ", code("&"), " in front of a quoted command: ", code(`& ${cli} run my-api.apisuite`), ".") : null,
                table(["Option", "Meaning"], [
                    [code("--env <name|id>"), "Environment to use (default: the suite's active one)"],
                    [code("--folder <name|id>"), "Only this folder or request; repeat for more (also \"Folder/Sub\")"],
                    [code("--iterations <n>"), "Run the selection n times"],
                    [code("--data <file.csv|json>"), "Data file: one iteration per row, columns become variables"],
                    [code("--var key=value"), "Set a variable, e.g. a token from a CI secret; repeatable"],
                    [code("--globals <file.json>"), "Global variables for the run"],
                    [code("--delay <ms>"), "Pause between requests"],
                    [code("--bail"), "Stop at the first failed request"],
                    [code("--timeout <ms>"), "Timeout for requests that do not set their own (default 30000, 0 = none)"],
                    [code("--insecure"), "Do not verify TLS certificates, for every request (self-signed test servers)"],
                    [code("--proxy <url>"), "HTTP proxy for all requests"],
                    [code("--reporter cli,junit,html,json"), "Reports to write (default cli)"],
                    [code("--out <dir>"), "Folder for the junit / html / json reports (default ./api-tester-reports)"],
                    [code("--echo-server"), "Start the local echo server during the run (--echo-port <n>)"],
                    [code("--no-color"), "Plain text output"]
                ]),
                p("Exit code ", code("0"), " when everything passed, ", code("1"), " when something failed, ", code("2"), " for a wrong command. The Runner view shows the exact command for its current settings."),
                title("GitHub Actions example"),
                block([
                    "- name: API tests",
                    "  run: api-tester run tests/my-api.apisuite --env CI --var token=${{ secrets.API_TOKEN }} --reporter cli,junit --out reports",
                    "- uses: actions/upload-artifact@v4",
                    "  if: always()",
                    "  with: { name: api-test-reports, path: reports }"
                ].join("\n")),
                p("The build machine needs the command: install the Linux package (.deb puts ", code("api-tester"), " on the PATH) or use the Docker image below."),
                title("Docker"),
                p("Build the image once from the source folder: ", code("docker build -t api-tester ."), ". Then, in the folder with your suite:"),
                block("docker run --rm --user \"$(id -u):$(id -g)\" -v \"$PWD:/work\" api-tester run my-api.apisuite --reporter cli,junit --out reports"),
                p("Other commands: ", code(`${cli} echo-server --port 3999`), " runs the local echo server; ", code(`${cli} --help`), " lists everything.")
            ],

            sharing: () => [
                title("Sharing suites"),
                ul(
                    [h("b", null, "Export"), " (top bar, or the suite's ⋯ menu) saves the suite as a ", code(".apisuite"), " file: folders, requests, assertions, captures, scripts, variables and, if you choose, environments."],
                    ["Secret values are ", h("b", null, "left out"), " unless you tick “Include secret values”. The receiver sees which ones to fill in."],
                    [h("b", null, "Import"), " the file on any machine — or double-click it, or drop it on the window. Importing the same suite again lets you keep both or replace yours."],
                    ["The file is readable JSON, so it works well in Git: commit it next to your code and run it in CI with the command line."],
                    "Globals, history and captured runtime values stay on your machine."),
                title("Import from other tools"),
                ul(
                    [h("b", null, "Postman"), " collections (v2.0 / v2.1) with folders, auth, bodies and variables, and Postman environments. Simple pm.test checks (status, headers, JSON values) become assertions; other script code is kept as comments to translate by hand."],
                    [h("b", null, "OpenAPI 3"), " and ", h("b", null, "Swagger 2"), " (JSON or YAML): one request per operation, grouped by tag, with example bodies, a status assertion and ", code("{{baseUrl}}"), "."],
                    [h("b", null, "cURL"), ": paste a command (e.g. “Copy as cURL” from the browser's developer tools) into Import, or onto the sidebar."]),
                h("div", { class: "row wrap" }, button("Import…", () => { closeHelp(); setTimeout(() => ImportExport.openImport(), 0); }))
            ],

            troubleshooting: () => [
                title("Troubleshooting"),
                ul(
                    [h("b", null, "Red {{name}} / “unresolved variable”"), " — the variable is not defined in the active environment, suite, folder or globals. Check the environment selector in the top bar."],
                    [h("b", null, "Certificate errors (self-signed, expired)"), " — turn off “Verify TLS” for the request (Settings tab) or in Settings for all requests. Use this only for test servers."],
                    [h("b", null, "Timeouts"), " — raise the timeout in Settings or per request. Check proxy settings in a company network."],
                    [h("b", null, "Works in the browser but not here"), " — the browser may send cookies or headers you don't; copy the request as cURL from the browser's developer tools and import it."],
                    [h("b", null, "Echo server port in use"), " — change the port in Settings → Local echo server; the sample's ", code("baseUrl"), " in the “Local echo server” environment follows automatically."],
                    [h("b", null, "The runner sends an old version"), " — it uses the saved suite; save open requests (", kbd(`${mod} + S`), ")."]),
                p("Your data (suites, globals, settings, history) is stored in ", code(info.dataDir || "the data folder"), info.logDir ? [", logs in ", code(info.logDir)] : "", "."),
                h("div", { class: "row wrap" }, button("Open data folder", () => attempt(() => call("app.openDataFolder"))))
            ]
        };

        const render = () => {
            clear(nav);
            for (const t of TOPICS) {
                const b = h("button", { class: `hp-nav-item ${t.id === active ? "active" : ""}`, type: "button" }, safeIcon(t.icon), t.title);
                b.addEventListener("click", () => { active = t.id; render(); });
                nav.appendChild(b);
            }
            add(clear(content), ...RENDER[active]().filter(Boolean));
            content.scrollTop = 0;
        };
        let closeModal = null; // set by modal onMount
        const closeHelp = () => { if (closeModal) closeModal(null); else VH.closeModalOf(body); };
        render();

        const promise = modal({
            title: "Help", body, wide: true, className: "hp-modal",
            buttons: [{ label: "Close", class: "primary", value: null }],
            onMount: ({ close }) => { closeModal = close; }
        });
        promise.select = (id) => { if (TOPICS.some((t) => t.id === id)) { active = id; render(); } };
        openPromise = promise;
        promise.finally(() => { openPromise = null; });
        return promise;
    }

    window.Help = { open };
})();
