"use strict";
/*
 * Fast collapsible JSON tree. Children are rendered only when a node is expanded, large arrays / objects are
 * shown in chunks, and search works on the data (not the DOM) so it stays quick for big responses.
 * Clicking a key or value offers "Assert ..." / "Capture as variable" with the JSONPath ($.data[0].id) filled in.
 *
 *   const view = JsonView.create(value, { onAction(action, info) });   // action: "assert" | "capture"
 *   view.el; view.expandAll(); view.collapseAll(); view.search(term) -> matches; view.next(); view.prev();
 */

const JsonView = (() => {
    const CHUNK = 100;               // children rendered per "show more" step
    const AUTO_EXPAND_NODES = 400;   // small documents open fully
    const DEFAULT_DEPTH = 2;         // otherwise the first levels are open
    const LONG_STRING = 1500;
    const MAX_MATCHES = 1000;
    const EXPAND_ALL_LIMIT = 20000;  // nodes; beyond that "expand all" only opens the first levels

    function jsonPathKey(key) {
        if (typeof key === "number") return `[${key}]`;
        if (/^[A-Za-z_$][\w$]*$/.test(key)) return `.${key}`;
        return `['${String(key).replace(/\\/g, "\\\\").replace(/'/g, "\\'")}']`;
    }

    function typeOf(v) {
        if (v === null) return "null";
        if (Array.isArray(v)) return "array";
        return typeof v;
    }

    /** Counts nodes up to `limit` (stops early). */
    function countNodes(value, limit) {
        let n = 0;
        const stack = [value];
        while (stack.length && n < limit) {
            const v = stack.pop();
            n++;
            if (v && typeof v === "object") {
                const vals = Array.isArray(v) ? v : Object.values(v);
                for (let i = 0; i < vals.length && n + stack.length < limit; i++) stack.push(vals[i]);
            }
        }
        return n;
    }

    /** Text shown for an assertion's expected value. */
    function expectedText(v) {
        if (typeof v === "string") return v;
        return JSON.stringify(v);
    }

    function create(data, opts = {}) {
        const root = h("div", { class: "json-tree", tabindex: "0" });
        const expanded = new Set();   // paths of open containers
        const shown = new Map();      // path -> number of children shown
        let term = "";
        let matches = [];             // [{ path, part: "key" | "value" }]
        let current = -1;

        const total = countNodes(data, AUTO_EXPAND_NODES + 1);
        const openAll = total <= AUTO_EXPAND_NODES;
        const isOpen = (path, depth) => expanded.has(path) || (!expanded.has(`!${path}`) && (openAll || depth < DEFAULT_DEPTH));
        const setOpen = (path, open) => {
            if (open) { expanded.add(path); expanded.delete(`!${path}`); } else { expanded.delete(path); expanded.add(`!${path}`); }
        };

        function highlight(text, isKey, path) {
            if (!term) return text;
            const lower = text.toLowerCase();
            const t = term.toLowerCase();
            if (!lower.includes(t)) return text;
            const frag = document.createDocumentFragment();
            let i = 0;
            for (let at; (at = lower.indexOf(t, i)) !== -1;) {
                frag.appendChild(document.createTextNode(text.slice(i, at)));
                const m = h("mark", { dataset: { path, part: isKey ? "key" : "value" } }, text.slice(at, at + t.length));
                frag.appendChild(m);
                i = at + t.length;
            }
            frag.appendChild(document.createTextNode(text.slice(i)));
            return frag;
        }

        function valueSpan(v, path) {
            const t = typeOf(v);
            if (t === "string") {
                let s = JSON.stringify(v);
                const long = s.length > LONG_STRING;
                if (long) s = s.slice(0, LONG_STRING);
                const span = h("span", { class: "jt-val jt-str", title: "Click to assert or capture" }, highlight(s, false, path), long ? "…" : null);
                if (long) {
                    const more = h("span", { class: "jt-more", title: "Show the whole text" }, ` show all (${fmtBytes(v.length)})`);
                    more.addEventListener("click", (e) => { e.stopPropagation(); clear(span).appendChild(highlight(JSON.stringify(v), false, path)); more.remove(); });
                    return h("span", null, span, more);
                }
                return span;
            }
            const cls = t === "number" ? "jt-num" : t === "boolean" ? "jt-bool" : "jt-null";
            return h("span", { class: `jt-val ${cls}`, title: "Click to assert or capture" }, highlight(String(v), false, path));
        }

        function keySpan(key, path) {
            if (key === undefined) return null;
            if (typeof key === "number") return h("span", { class: "jt-idx", title: path }, String(key), h("span", { class: "jt-punct" }, ": "));
            return h("span", null,
                h("span", { class: "jt-key", title: path }, highlight(JSON.stringify(key), true, path)),
                h("span", { class: "jt-punct" }, ": "));
        }

        function renderNode(key, value, path, depth, comma) {
            const t = typeOf(value);
            const node = h("div", { class: "jt-node", dataset: { path } });
            if (t !== "object" && t !== "array") {
                node.appendChild(h("div", { class: "jt-row", style: { "--d": depth } },
                    h("span", { class: "jt-content" }, keySpan(key, path), valueSpan(value, path), comma ? h("span", { class: "jt-punct" }, ",") : null)));
                bind(node, value, path, key);
                return node;
            }
            const isArr = t === "array";
            const entries = isArr ? value : Object.keys(value);
            const count = entries.length;
            const [open, close] = isArr ? ["[", "]"] : ["{", "}"];
            if (count === 0) {
                node.appendChild(h("div", { class: "jt-row", style: { "--d": depth } },
                    h("span", { class: "jt-content" }, keySpan(key, path), h("span", { class: "jt-val jt-punct" }, open + close), comma ? h("span", { class: "jt-punct" }, ",") : null)));
                bind(node, value, path, key);
                return node;
            }
            const opened = isOpen(path, depth);
            const toggle = h("span", { class: "jt-toggle", title: opened ? "Collapse" : "Expand" }, icon(opened ? "chevronDown" : "chevronRight"));
            const head = h("div", { class: "jt-row", style: { "--d": depth } }, toggle,
                h("span", { class: "jt-content" }, keySpan(key, path), h("span", { class: "jt-punct" }, open),
                    opened ? null : h("span", { class: "jt-summary" }, ` ${count} ${isArr ? (count === 1 ? "item" : "items") : (count === 1 ? "key" : "keys")} `),
                    opened ? null : h("span", { class: "jt-punct" }, close + (comma ? "," : ""))));
            node.appendChild(head);
            const flip = (e) => {
                e.stopPropagation();
                setOpen(path, !opened);
                node.replaceWith(renderNode(key, value, path, depth, comma));
            };
            toggle.addEventListener("click", flip);
            const summary = head.querySelector(".jt-summary");
            if (summary) summary.addEventListener("click", flip);
            if (opened) {
                const children = h("div", { class: "jt-children" });
                const limit = Math.min(count, shown.get(path) || CHUNK);
                for (let i = 0; i < limit; i++) {
                    const k = isArr ? i : entries[i];
                    const v = isArr ? value[i] : value[k];
                    children.appendChild(renderNode(k, v, path + jsonPathKey(k), depth + 1, i < count - 1));
                }
                if (limit < count) {
                    const more = h("div", { class: "jt-more", style: { "--d": depth + 1 } }, `Show ${Math.min(CHUNK, count - limit)} more (${count - limit} not shown)`);
                    more.addEventListener("click", () => {
                        shown.set(path, limit + CHUNK);
                        node.replaceWith(renderNode(key, value, path, depth, comma));
                    });
                    children.appendChild(more);
                }
                node.appendChild(children);
                node.appendChild(h("div", { class: "jt-row", style: { "--d": depth } }, h("span", { class: "jt-punct" }, close + (comma ? "," : ""))));
            }
            bind(node, value, path, key);
            return node;
        }

        // key / value clicks open the action menu (only for this node's own row)
        function bind(node, value, path, key) {
            const row = node.firstElementChild;
            row.addEventListener("click", (e) => {
                const target = e.target.closest(".jt-val, .jt-key, .jt-idx");
                if (!target || !row.contains(target)) return;
                e.stopPropagation();
                pick(target, value, path, key);
            });
        }

        function pick(target, value, path, key) {
            for (const p of root.querySelectorAll(".picked")) p.classList.remove("picked");
            target.classList.add("picked");
            const t = typeOf(value);
            const act = (action, extra) => { if (opts.onAction) opts.onAction(action, { path, value, key, ...extra }); };
            const items = [{ header: path.length > 48 ? `…${path.slice(-47)}` : path, mono: true, title: path }]; // JSONPath is case-sensitive: shown as is
            if (t !== "object" && t !== "array") {
                const shownValue = expectedText(value);
                const short = shownValue.length > 28 ? shownValue.slice(0, 28) + "…" : shownValue;
                items.push({ label: `Assert equals ${short}`, icon: "target", onClick: () => act("assert", { operator: "equals", expected: shownValue }) });
            } else if (t === "array") {
                items.push({ label: `Assert length equals ${value.length}`, icon: "target", onClick: () => act("assert", { operator: "lengthEquals", expected: String(value.length) }) });
            }
            items.push(
                { label: "Assert exists", icon: "check", onClick: () => act("assert", { operator: "exists", expected: "" }) },
                { label: `Assert type is ${t}`, icon: "braces", onClick: () => act("assert", { operator: "isType", expected: t }) },
                "-",
                { label: "Capture as variable…", icon: "capture", onClick: () => act("capture", {}) },
                "-",
                { label: "Copy value", icon: "copy", onClick: () => copyText(typeof value === "string" ? value : JSON.stringify(value, null, 2), "value") },
                { label: "Copy JSONPath", icon: "link", onClick: () => copyText(path) });
            contextMenu(target, items);
        }

        function render() {
            clear(root);
            root.appendChild(renderNode(undefined, data, "$", 0, false));
            markCurrent();
        }

        function expandPathsFor(path) {
            // open every ancestor container of `path` and make sure chunking shows the child
            const parts = [];
            const re = /\.([A-Za-z_$][\w$]*)|\[(\d+)\]|\['((?:[^'\\]|\\.)*)'\]/g;
            for (let m; (m = re.exec(path.slice(1)));) parts.push(m[2] !== undefined ? Number(m[2]) : m[1] !== undefined ? m[1] : m[3].replace(/\\(.)/g, "$1"));
            let p = "$";
            let v = data;
            for (const part of parts) {
                setOpen(p, true);
                if (v && typeof v === "object") {
                    const idx = Array.isArray(v) ? part : Object.keys(v).indexOf(part);
                    if (idx >= (shown.get(p) || CHUNK)) shown.set(p, Math.ceil((idx + 1) / CHUNK) * CHUNK);
                    v = v[part];
                }
                p += jsonPathKey(part);
            }
        }

        function search(text) {
            term = String(text || "").trim();
            matches = [];
            current = -1;
            if (term) {
                const t = term.toLowerCase();
                const walk = (v, path, key) => {
                    if (matches.length >= MAX_MATCHES) return;
                    if (typeof key === "string" && key.toLowerCase().includes(t)) matches.push({ path, part: "key" });
                    if (v && typeof v === "object") {
                        if (Array.isArray(v)) v.forEach((x, i) => walk(x, path + jsonPathKey(i), i));
                        else for (const k of Object.keys(v)) walk(v[k], path + jsonPathKey(k), k);
                    } else if (String(typeof v === "string" ? JSON.stringify(v) : v).toLowerCase().includes(t)) matches.push({ path, part: "value" });
                };
                walk(data, "$", undefined);
                for (const m of matches) expandPathsFor(m.path);
                if (matches.length) current = 0;
            }
            render();
            return matches.length;
        }

        function markCurrent() {
            const marks = root.querySelectorAll("mark");
            marks.forEach((m) => m.classList.remove("current"));
            if (current < 0 || !marks.length) return;
            const m = marks[Math.min(current, marks.length - 1)];
            m.classList.add("current");
            m.scrollIntoView({ block: "center" });
        }

        function step(dir) {
            const n = root.querySelectorAll("mark").length;
            if (!n) return 0;
            current = (current + dir + n) % n;
            markCurrent();
            return current + 1;
        }

        render();
        return {
            el: root,
            search,
            next: () => step(1),
            prev: () => step(-1),
            matchCount: () => root.querySelectorAll("mark").length,
            expandAll() {
                const big = countNodes(data, EXPAND_ALL_LIMIT + 1) > EXPAND_ALL_LIMIT;
                const walk = (v, path, depth) => {
                    if (!v || typeof v !== "object") return;
                    if (big && depth > 3) return;
                    setOpen(path, true);
                    if (Array.isArray(v)) v.slice(0, shown.get(path) || CHUNK).forEach((x, i) => walk(x, path + jsonPathKey(i), depth + 1));
                    else Object.keys(v).slice(0, shown.get(path) || CHUNK).forEach((k) => walk(v[k], path + jsonPathKey(k), depth + 1));
                };
                walk(data, "$", 0);
                render();
                if (big) toast("Large response: opened the first levels only", "info");
            },
            collapseAll() {
                expanded.clear();
                const walk = (v, path) => {
                    if (!v || typeof v !== "object") return;
                    if (path !== "$") setOpen(path, false);
                    if (Array.isArray(v)) v.slice(0, CHUNK).forEach((x, i) => walk(x, path + jsonPathKey(i)));
                    else Object.keys(v).slice(0, CHUNK).forEach((k) => walk(v[k], path + jsonPathKey(k)));
                };
                walk(data, "$");
                setOpen("$", true);
                render();
            }
        };
    }

    return { create, jsonPathKey, typeOf };
})();
