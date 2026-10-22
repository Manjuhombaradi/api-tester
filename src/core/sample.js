"use strict";
// The "Sample: Echo API" suite: a guided tour of every feature, written against the built-in echo server
// (echoServer.js), so it works offline and every assertion passes out of the box.
const {
    newSuite, newFolder, newRequest, newVariable, newKeyValue, newEnvironment, newAssertion, newExtraction,
    defaultAuth, defaultBody
} = require("./model");

const DEFAULT_BASE_URL = "http://127.0.0.1:3999";
const SAMPLE_DATA_FILE_NAME = "sample-users.csv";
const SAMPLE_DATA_CSV = [
    "name,email",
    "Katherine Johnson,katherine@example.com",
    "Linus Torvalds,linus@example.com",
    "Margaret Hamilton,margaret@example.com",
    ""
].join("\n");

// ------------------------------------------------------------------ small builders

const kv = (key, value, extra) => newKeyValue(key, value, extra);
const check = (source, property, operator, expected = "") => newAssertion(source, operator, expected, property);
const status = (code) => check("status", "", "equals", String(code));
const jsonPath = (path, operator, expected = "") => check("jsonpath", path, operator, expected);
const capture = (path, variable, scope = "runtime") => newExtraction("jsonpath", path, variable, scope);

function request(name, method, path, extra = {}) {
    return newRequest(name, { method, url: `{{baseUrl}}${path}`, ...extra });
}

function jsonBody(value) {
    return { ...defaultBody("json"), raw: typeof value === "string" ? value : JSON.stringify(value, null, 2) };
}

function auth(type, settings) {
    const a = defaultAuth(type);
    if (settings) a[type] = { ...a[type], ...settings };
    return a;
}

// ------------------------------------------------------------------ folders

function basicsFolder() {
    return newFolder("1. Requests and assertions", {
        description: "Sending requests and checking responses with no-code assertions.",
        items: [
            request("Get with query parameters", "GET", "/anything/search", {
                description: "Query parameters live in the Params tab. Disabled rows are not sent. The echo server returns what it received, " +
                    "so the assertions can check the parameters and the default header that the suite adds to every request.",
                params: [kv("q", "api tester"), kv("page", "1"), kv("debug", "true", { enabled: false, description: "Disabled: not sent" })],
                assertions: [
                    status(200),
                    jsonPath("$.query.q", "equals", "api tester"),
                    jsonPath("$.query.page", "equals", "1"),
                    jsonPath("$.query.debug", "notExists"),
                    jsonPath("$.headers['x-client-name']", "equals", "API Tester sample"),
                    check("responseTime", "", "lt", "2000")
                ]
            }),
            request("Post JSON with assertions", "POST", "/anything/orders", {
                description: "A JSON body with variables: {{username}} comes from the suite variables and {{$guid}} is a dynamic variable " +
                    "(a new UUID each time). The assertions check the status, a header, values inside the JSON (JSONPath), the response time " +
                    "and the shape of the whole body (JSON Schema).",
                body: jsonBody(`{
  "orderId": "{{$guid}}",
  "customer": "{{username}}",
  "items": [
    { "sku": "BOOK-1", "qty": 2, "price": 9.99 }
  ],
  "total": 19.98,
  "express": true
}`),
                assertions: [
                    status(200),
                    check("header", "Content-Type", "contains", "application/json"),
                    jsonPath("$.json.customer", "equals", "{{username}}"),
                    jsonPath("$.json.items[0].qty", "equals", "2"),
                    jsonPath("$.json.total", "gt", "10"),
                    jsonPath("$.json.express", "isType", "boolean"),
                    check("responseTime", "", "lt", "2000"),
                    check("schema", "", "validSchema", JSON.stringify({
                        type: "object",
                        required: ["method", "json"],
                        properties: {
                            method: { const: "POST" },
                            json: {
                                type: "object",
                                required: ["orderId", "items", "total"],
                                properties: {
                                    orderId: { type: "string", format: "uuid" },
                                    items: { type: "array", minItems: 1 },
                                    total: { type: "number" }
                                }
                            }
                        }
                    }, null, 2))
                ]
            }),
            request("Read a JSON document", "GET", "/json", {
                description: "Click a value in the response tree to add an assertion or a capture for it.",
                assertions: [
                    status(200),
                    jsonPath("$.store.name", "equals", "Book Corner"),
                    jsonPath("$.store.open", "equals", "true"),
                    jsonPath("$.store.books", "lengthEquals", "3"),
                    jsonPath("$.store.books[*].price", "isType", "array"),
                    jsonPath("$.store.address.city", "in", "Springfield, Shelbyville"),
                    jsonPath("$.updatedAt", "matches", "^\\d{4}-\\d{2}-\\d{2}T")
                ]
            }),
            request("Expect an error status", "GET", "/status/404", {
                description: "Tests can expect errors too: this request passes because the assertion expects 404.",
                assertions: [status(404), jsonPath("$.statusText", "equals", "Not Found")]
            })
        ]
    });
}

function chainingFolder() {
    return newFolder("2. Login and chaining", {
        description: "Captures store values from one response in variables; later requests use them as {{name}}. Run this folder in order.",
        items: [
            request("Log in (captures token)", "POST", "/login", {
                description: "Logs in with the suite variables {{username}} and {{password}}. The Capture tab stores the token from " +
                    "the response in the variable {{token}}.",
                body: jsonBody(`{
  "username": "{{username}}",
  "password": "{{password}}"
}`),
                assertions: [status(200), jsonPath("$.token", "exists")],
                extract: [capture("$.token", "token")]
            }),
            request("Get my profile (uses {{token}})", "GET", "/me", {
                description: "Bearer auth with the captured {{token}}. Send \"Log in\" first, or run the whole folder.",
                auth: auth("bearer", { token: "{{token}}" }),
                assertions: [status(200), jsonPath("$.username", "equals", "{{username}}")]
            }),
            request("Create a user (captures userId)", "POST", "/users", {
                description: "Creates a user and captures its id as {{userId}} for the next requests.",
                body: jsonBody(`{
  "name": "Ada Lovelace",
  "email": "{{$randomEmail}}"
}`),
                assertions: [status(201), check("header", "Location", "startsWith", "/users/"), jsonPath("$.id", "isType", "number")],
                extract: [capture("$.id", "userId")]
            }),
            request("Get the new user", "GET", "/users/{{userId}}", {
                assertions: [status(200), jsonPath("$.name", "equals", "Ada Lovelace")]
            }),
            request("Rename the user", "PATCH", "/users/{{userId}}", {
                body: jsonBody({ name: "Ada King" }),
                assertions: [status(200), jsonPath("$.name", "equals", "Ada King"), jsonPath("$.updatedAt", "exists")]
            }),
            request("Delete the user", "DELETE", "/users/{{userId}}", {
                assertions: [status(204), check("size", "", "equals", "0")]
            }),
            request("Deleted user is gone", "GET", "/users/{{userId}}", {
                assertions: [status(404), jsonPath("$.error", "contains", "not found")]
            })
        ]
    });
}

function authFolder() {
    return newFolder("3. OAuth 2.0 and Basic auth", {
        description: "This folder's Auth tab uses OAuth 2.0 client credentials: API Tester fetches a token from the token URL, " +
            "caches it and sends it with every request in the folder. A request can still use its own auth. " +
            "{{clientSecret}} is a secret variable: masked on screen and not exported unless you choose to.",
        auth: auth("oauth2", {
            grantType: "client_credentials",
            tokenUrl: "{{baseUrl}}/auth/token",
            clientId: "{{clientId}}",
            clientSecret: "{{clientSecret}}",
            scope: "read",
            clientAuth: "body"
        }),
        items: [
            request("Profile with an OAuth token", "GET", "/me", {
                description: "Auth is \"Inherit\": the folder's OAuth 2.0 settings are used.",
                assertions: [status(200), jsonPath("$.authenticatedWith", "equals", "client_credentials"), jsonPath("$.scope", "equals", "read")]
            }),
            request("See the Authorization header", "GET", "/headers", {
                assertions: [status(200), jsonPath("$.headers.authorization", "startsWith", "Bearer ")]
            }),
            request("Basic auth (overrides the folder)", "GET", "/basic-auth/{{username}}/{{password}}", {
                description: "This request sets its own Basic auth instead of inheriting the folder's OAuth 2.0.",
                auth: auth("basic", { username: "{{username}}", password: "{{password}}" }),
                assertions: [status(200), jsonPath("$.authenticated", "equals", "true")]
            })
        ]
    });
}

function bodiesFolder() {
    return newFolder("4. Forms, files and GraphQL", {
        description: "Other body types. The echo server shows how it received each one.",
        items: [
            request("URL-encoded form", "POST", "/anything/form", {
                body: { ...defaultBody("form"), form: [kv("name", "Ada"), kv("city", "London"), kv("newsletter", "yes", { enabled: false })] },
                assertions: [
                    status(200),
                    jsonPath("$.form.city", "equals", "London"),
                    jsonPath("$.form.newsletter", "notExists"),
                    jsonPath("$.headers['content-type']", "contains", "x-www-form-urlencoded")
                ]
            }),
            request("Multipart form with a file", "POST", "/anything/upload", {
                description: "To upload a file: pick one in the \"attachment\" row and enable the row. The echo server then lists it under \"files\".",
                body: {
                    ...defaultBody("multipart"),
                    multipart: [
                        { key: "title", type: "text", value: "Quarterly report", filePath: "", contentType: "", enabled: true },
                        { key: "pages", type: "text", value: "12", filePath: "", contentType: "", enabled: true },
                        { key: "attachment", type: "file", value: "", filePath: "", contentType: "", enabled: false }
                    ]
                },
                assertions: [
                    status(200),
                    jsonPath("$.form.title", "equals", "Quarterly report"),
                    jsonPath("$.headers['content-type']", "startsWith", "multipart/form-data")
                ]
            }),
            request("GraphQL query", "POST", "/anything/graphql", {
                description: "GraphQL mode sends {\"query\": ..., \"variables\": ...} as JSON.",
                body: {
                    ...defaultBody("graphql"),
                    graphql: {
                        query: "query Books($limit: Int) {\n  books(limit: $limit) {\n    id\n    title\n    author\n  }\n}",
                        variables: "{\n  \"limit\": 2\n}"
                    }
                },
                assertions: [status(200), jsonPath("$.json.query", "contains", "books"), jsonPath("$.json.variables.limit", "equals", "2")]
            })
        ]
    });
}

function responsesFolder() {
    return newFolder("5. Responses, cookies and redirects", {
        items: [
            request("XML response", "GET", "/xml", {
                assertions: [status(200), check("contentType", "", "contains", "xml"), check("body", "", "contains", "<title>Clean Code</title>")]
            }),
            request("Image response", "GET", "/image.png", {
                description: "Images are shown in the Preview tab.",
                assertions: [status(200), check("contentType", "", "equals", "image/png"), check("size", "", "gt", "100")]
            }),
            request("Set a cookie", "GET", "/cookies/set", {
                description: "The server sets a cookie. API Tester keeps cookies per suite and sends them back, like a browser.",
                params: [kv("session", "abc123")],
                assertions: [status(200), check("header", "Set-Cookie", "contains", "session=abc123")]
            }),
            request("Cookie is sent back", "GET", "/cookies", {
                description: "Send \"Set a cookie\" first. The Cookies tab of the Environments dialog lists and clears stored cookies.",
                assertions: [status(200), jsonPath("$.cookies.session", "equals", "abc123")]
            }),
            request("Redirects are followed", "GET", "/redirect/2", {
                description: "Two redirects, then /anything. The Timeline tab lists the redirects. Turn off \"Follow redirects\" in this request's Settings tab to see the 302.",
                assertions: [status(200), jsonPath("$.path", "equals", "/anything")]
            }),
            request("Compressed response", "GET", "/gzip", {
                assertions: [status(200), check("header", "Content-Encoding", "equals", "gzip"), jsonPath("$.gzipped", "equals", "true")]
            }),
            request("Slow response", "GET", "/delay/300", {
                description: "The server waits 300 ms. This request has its own timeout of 5 seconds (Settings tab).",
                settings: { timeoutMs: 5000, followRedirects: null, verifyTls: null },
                assertions: [status(200), check("responseTime", "", "gte", "300")]
            })
        ]
    });
}

function dataAndScriptsFolder() {
    return newFolder("6. Data-driven and scripts", {
        description: "In the Runner, choose a CSV or JSON data file: the requests run once per row and each column is a variable.",
        items: [
            request("Create a user from data row", "POST", "/users", {
                description: "Uses {{name}} and {{email}}. Without a data file the suite variables are used. In the Runner, load " +
                    `a CSV with the columns name,email (like ${SAMPLE_DATA_FILE_NAME}) to create one user per row.`,
                body: jsonBody(`{
  "name": "{{name}}",
  "email": "{{email}}"
}`),
                assertions: [status(201), jsonPath("$.name", "equals", "{{name}}"), jsonPath("$.email", "equals", "{{email}}")],
                extract: [capture("$.id", "createdUserId")]
            }),
            request("Scripts: before and after", "POST", "/anything/scripts", {
                description: "Optional JavaScript. The pre-request script adds a header and stores a variable; the post-response script " +
                    "runs test() checks (shown in the Tests tab) and writes to the Console tab.",
                body: jsonBody({ hello: "scripts" }),
                scripts: {
                    pre: [
                        "// Runs before the request is sent: change the request or set variables.",
                        "const traceId = \"trace-\" + Date.now();",
                        "vars.set(\"traceId\", traceId);",
                        "request.headers[\"X-Trace-Id\"] = traceId;",
                        "console.log(\"Sending with trace id\", traceId);"
                    ].join("\n"),
                    post: [
                        "// Runs after the response arrives. test() results appear in the Tests tab.",
                        "const data = response.json();",
                        "test(\"status is 200\", () => {",
                        "    expect(response.status).toBe(200);",
                        "});",
                        "test(\"the trace id header was sent\", () => {",
                        "    expect(data.headers[\"x-trace-id\"]).toBe(vars.get(\"traceId\"));",
                        "});",
                        "test(\"body was echoed\", () => {",
                        "    expect(data.json).toHaveProperty(\"hello\");",
                        "    expect(data.json.hello).toEqual(\"scripts\");",
                        "});",
                        "console.log(\"Echoed path:\", data.path);"
                    ].join("\n")
                },
                assertions: [status(200)]
            })
        ]
    });
}

/**
 * The sample suite. baseUrl: address of the running echo server (the "Local echo server" environment uses it).
 */
function createSampleSuite({ baseUrl = DEFAULT_BASE_URL } = {}) {
    const url = String(baseUrl || DEFAULT_BASE_URL).trim().replace(/\/+$/, "");
    const local = newEnvironment("Local echo server", [
        newVariable("baseUrl", url, { description: "The built-in echo server (Settings > Echo server)" })
    ]);
    const custom = newEnvironment("Custom", [
        newVariable("baseUrl", "", { description: "Address of another server, e.g. http://192.168.1.20:3999" })
    ]);
    return newSuite("Sample: Echo API", {
        description: "A tour of API Tester against the built-in echo server (it runs on this computer, no internet needed). " +
            "Open the requests one by one, or run everything with the Runner: every check should pass. " +
            "Each request's Docs tab explains what it shows.",
        variables: [
            newVariable("username", "demo", { description: "Login of the echo server" }),
            newVariable("password", "demo", { description: "Password of the echo server's demo user" }),
            newVariable("clientId", "demo", { description: "OAuth 2.0 client of the echo server" }),
            newVariable("clientSecret", "secret", { secret: true, description: "A secret variable: hidden on screen and left out when you export the suite (unless you choose to include secrets)" }),
            newVariable("name", "Grace Hopper", { description: "Default for the data-driven request (a data file overrides it)" }),
            newVariable("email", "grace@example.com", { description: "Default for the data-driven request (a data file overrides it)" })
        ],
        headers: [kv("X-Client-Name", "API Tester sample", { description: "Sent with every request of this suite" })],
        auth: defaultAuth("none"),
        environments: [local, custom],
        activeEnvironmentId: local.id,
        items: [basicsFolder(), chainingFolder(), authFolder(), bodiesFolder(), responsesFolder(), dataAndScriptsFolder()]
    });
}

module.exports = { createSampleSuite, SAMPLE_DATA_CSV, SAMPLE_DATA_FILE_NAME, DEFAULT_BASE_URL };
