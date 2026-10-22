"use strict";
/*
 * Left sidebar: search, suites tree (suite > folders > requests) with drag & drop, context menus and inline
 * rename, plus the request history at the bottom.
 */

const Sidebar = {
    el: null,
    treeEl: null,
    historyEl: null,
    searchInput: null,
    filter: "",
    expanded: new Set(),
    renaming: null, // { suiteId, itemId (null = suite) }
    drag: null,     // { suiteId, itemId (null = suite), type }

    mount(el) {
        this.el = el;
        const ui = App.state.ui;
        if (Array.isArray(ui.expanded)) this.expanded = new Set(ui.expanded);
        else for (const s of App.state.suites) this.expanded.add(s.id); // first start: suites open
        this.searchInput = h("input", { type: "search", placeholder: "Search requests", spellcheck: "false", "aria-label": "Search requests" });
        this.searchInput.addEventListener("input", debounce(() => { this.filter = this.searchInput.value.trim(); this.render(); }, 120));
        this.searchInput.addEventListener("keydown", (e) => {
            if (e.key === "Escape" && this.searchInput.value) { e.stopPropagation(); this.searchInput.value = ""; this.filter = ""; this.render(); }
            else if (e.key === "ArrowDown" || e.key === "Enter") {
                const first = this.treeEl.querySelector(this.filter ? ".tree-node.request" : ".tree-node");
                if (first) { e.preventDefault(); if (e.key === "Enter" && this.filter) first.click(); else first.focus(); }
            }
        });
        const addBtn = iconButton("plus", "New suite, request, folder or import", (e) => this.addMenu(e.currentTarget));
        this.treeEl = h("div", { class: "sb-tree tree", role: "tree" });
        this.treeEl.addEventListener("keydown", (e) => this.onTreeKey(e));
        this.treeEl.addEventListener("contextmenu", (e) => {
            if (e.target.closest(".tree-node")) return;
            e.preventDefault();
            this.addMenu(e);
        });
        // dropping on empty space below the tree moves a suite to the end
        this.treeEl.addEventListener("dragover", (e) => { if (this.drag && this.drag.itemId === null && e.target === this.treeEl) e.preventDefault(); });
        this.treeEl.addEventListener("drop", (e) => {
            if (!this.drag || this.drag.itemId !== null || e.target !== this.treeEl) return;
            e.preventDefault();
            const ids = App.state.suites.map((s) => s.id).filter((id) => id !== this.drag.suiteId);
            ids.push(this.drag.suiteId);
            App.reorderSuites(ids);
        });
        this.historyEl = h("div", { class: "sb-history" });
        put(clear(el), 
            h("div", { class: "sb-head" }, h("div", { class: "input-icon" }, icon("search"), this.searchInput), addBtn),
            this.treeEl,
            this.historyEl);
        App.on("suites-changed", () => this.render());
        App.on("active-tab-changed", () => this.updateSelection());
        App.on("history-changed", () => this.renderHistory());
        this.render();
    },

    saveExpanded: debounce(() => App.saveUi({ expanded: [...Sidebar.expanded] }), 400),
    expand(id) { this.expanded.add(id); this.saveExpanded(); this.render(); },
    expandAll(suiteId) {
        const suite = App.getSuite(suiteId);
        if (!suite) return;
        this.expanded.add(suiteId);
        Model.walk(suite.items, (i) => { if (i.type === "folder") this.expanded.add(i.id); });
        this.saveExpanded();
        this.render();
    },
    toggle(id) {
        if (this.expanded.has(id)) this.expanded.delete(id); else this.expanded.add(id);
        this.saveExpanded();
        this.render();
    },
    /** Opens the parents of an item, re-renders and scrolls it into view. */
    reveal(suiteId, itemId) {
        const suite = App.getSuite(suiteId);
        if (!suite) return;
        this.expanded.add(suiteId);
        const f = itemId ? Model.findItem(suite, itemId) : null;
        if (f) for (const p of f.parents) this.expanded.add(p.id);
        if (this.filter) { this.filter = ""; this.searchInput.value = ""; }
        this.saveExpanded();
        this.render();
        const row = this.rowFor(suiteId, itemId);
        if (row) { row.scrollIntoView({ block: "nearest" }); row.classList.add("flash"); setTimeout(() => row.classList.remove("flash"), 900); }
    },
    focusSearch() { this.searchInput.focus(); this.searchInput.select(); },
    rowFor(suiteId, itemId) {
        return this.treeEl.querySelector(`.tree-node[data-suite="${CSS.escape(suiteId)}"][data-item="${CSS.escape(itemId || "")}"]`);
    },

    // ------------------------------------------------------------ tree
    render() {
        if (!this.treeEl) return;
        const scroll = this.treeEl.scrollTop;
        clear(this.treeEl);
        const suites = App.state.suites;
        if (!suites.length) {
            this.treeEl.appendChild(h("div", { class: "empty" },
                h("div", { class: "big" }, icon("suite")),
                h("h3", null, "No suites yet"),
                h("p", null, "A suite holds your requests, folders and environments."),
                h("div", { class: "btn-group", style: { justifyContent: "center" } },
                    h("button", { class: "btn primary small", onclick: () => App.command("newSuite") }, icon("plus"), "New suite"),
                    h("button", { class: "btn small", onclick: () => App.command("import") }, icon("import"), "Import"),
                    h("button", { class: "btn small", onclick: () => App.addSampleSuite() }, icon("sparkles"), "Sample"))));
            this.renderHistory();
            return;
        }
        const term = this.filter.toLowerCase();
        let shownAny = false;
        for (const suite of suites) {
            const matches = term ? this.matchSet(suite, term) : null;
            if (term && !matches.size && !suite.name.toLowerCase().includes(term)) continue;
            shownAny = true;
            this.treeEl.appendChild(this.suiteRow(suite, term));
            const open = term ? true : this.expanded.has(suite.id);
            if (open) {
                const kids = this.renderItems(suite, suite.items, 1, term, matches);
                if (!kids.length && !term) {
                    this.treeEl.appendChild(h("div", { class: "tree-empty", style: { "--depth": 1 } }, "Empty suite. ",
                        h("button", { class: "link-btn", onclick: () => App.newRequest({ suiteId: suite.id, folderId: null }) }, "Add a request")));
                }
                kids.forEach((k) => this.treeEl.appendChild(k));
            }
        }
        if (term && !shownAny) this.treeEl.appendChild(h("div", { class: "empty small" }, `Nothing matches "${this.filter}"`));
        this.treeEl.scrollTop = scroll;
        this.updateSelection();
        this.renderHistory();
    },

    /** Ids of matching requests / folders and all their parents (search). */
    matchSet(suite, term) {
        const set = new Set();
        Model.walk(suite.items, (item, parents) => {
            const hay = item.type === "request" ? `${item.name} ${item.method} ${item.url}`.toLowerCase() : item.name.toLowerCase();
            if (hay.includes(term)) {
                set.add(item.id);
                parents.forEach((p) => set.add(p.id));
            }
        });
        return set;
    },

    renderItems(suite, items, depth, term, matches) {
        const out = [];
        for (const item of items || []) {
            if (term && !matches.has(item.id)) continue;
            out.push(item.type === "folder" ? this.folderRow(suite, item, depth, term) : this.requestRow(suite, item, depth, term));
            if (item.type === "folder" && (term || this.expanded.has(item.id))) {
                const kids = this.renderItems(suite, item.items, depth + 1, term, matches);
                if (!kids.length && !term) {
                    out.push(h("div", { class: "tree-empty", style: { "--depth": depth + 1 } }, "Empty folder. ",
                        h("button", { class: "link-btn", onclick: () => App.newRequest({ suiteId: suite.id, folderId: item.id }) }, "Add a request")));
                }
                out.push(...kids);
            }
        }
        return out;
    },

    label(text, term) {
        if (this.renaming) return h("span", { class: "tree-label" }, text);
        if (!term) return h("span", { class: "tree-label", title: text }, text);
        const i = text.toLowerCase().indexOf(term);
        if (i < 0) return h("span", { class: "tree-label", title: text }, text);
        return h("span", { class: "tree-label", title: text }, text.slice(0, i), h("mark", null, text.slice(i, i + term.length)), text.slice(i + term.length));
    },

    baseRow(cls, suiteId, itemId, depth) {
        return h("div", {
            class: `tree-node ${cls}`, role: "treeitem", tabindex: "-1", draggable: this.renaming ? "false" : "true",
            style: { "--depth": depth }, dataset: { suite: suiteId, item: itemId || "" }
        });
    },

    suiteRow(suite, term) {
        const open = term ? true : this.expanded.has(suite.id);
        const row = this.baseRow("suite", suite.id, null, 0);
        row.setAttribute("aria-expanded", String(open));
        const count = Model.countRequests(suite.items);
        put(row, 
            h("span", { class: "tree-toggle" }, icon(open ? "chevronDown" : "chevronRight")),
            h("span", { class: "tree-icon" }, icon("suite")),
            this.isRenaming(suite.id, null) ? this.renameInput(suite.name, (v) => this.renameSuite(suite.id, v)) : this.label(suite.name, term),
            h("span", { class: "tree-meta" }, String(count)),
            h("span", { class: "tree-actions" },
                iconButton("plus", "New request in this suite", (e) => { e.stopPropagation(); App.newRequest({ suiteId: suite.id, folderId: null }); }),
                iconButton("more", "More actions", (e) => { e.stopPropagation(); this.menuFor(suite.id, null, e.currentTarget); })));
        row.addEventListener("click", () => {
            if (this.renaming) return;
            App.selectedSuiteId = suite.id;
            App.renderEnvPicker();
            this.toggle(suite.id);
        });
        row.addEventListener("dblclick", (e) => { e.preventDefault(); App.openItemSettings(suite.id, null); });
        this.wireRow(row, suite.id, null, "suite");
        return row;
    },

    folderRow(suite, folder, depth, term) {
        const open = term ? true : this.expanded.has(folder.id);
        const row = this.baseRow("folder", suite.id, folder.id, depth);
        row.setAttribute("aria-expanded", String(open));
        put(row, 
            h("span", { class: "tree-toggle" }, icon(open ? "chevronDown" : "chevronRight")),
            h("span", { class: "tree-icon" }, icon(open ? "folderOpen" : "folder")),
            this.isRenaming(suite.id, folder.id) ? this.renameInput(folder.name, (v) => this.renameItem(suite.id, folder.id, v)) : this.label(folder.name, term),
            h("span", { class: "tree-meta" }, String(Model.countRequests(folder.items))),
            h("span", { class: "tree-actions" },
                iconButton("plus", "New request in this folder", (e) => { e.stopPropagation(); App.newRequest({ suiteId: suite.id, folderId: folder.id }); }),
                iconButton("more", "More actions", (e) => { e.stopPropagation(); this.menuFor(suite.id, folder.id, e.currentTarget); })));
        row.addEventListener("click", () => { if (!this.renaming) this.toggle(folder.id); });
        row.addEventListener("dblclick", (e) => { e.preventDefault(); App.openItemSettings(suite.id, folder.id); });
        this.wireRow(row, suite.id, folder.id, "folder");
        return row;
    },

    requestRow(suite, req, depth, term) {
        const row = this.baseRow("request", suite.id, req.id, depth);
        const tab = App.findTab(`r:${suite.id}:${req.id}`);
        row.title = `${req.method} ${req.url || "(no URL)"}`;
        put(row, 
            h("span", { class: "tree-toggle" }),
            methodBadge(req.method, { short: true }),
            this.isRenaming(suite.id, req.id) ? this.renameInput(req.name, (v) => this.renameItem(suite.id, req.id, v)) : this.label(req.name, term),
            tab && tab.dirty ? this.dirtyDot() : null,
            h("span", { class: "tree-actions" },
                iconButton("more", "More actions", (e) => { e.stopPropagation(); this.menuFor(suite.id, req.id, e.currentTarget); })));
        row.addEventListener("click", () => { if (!this.renaming) App.openRequest(suite.id, req.id); });
        this.wireRow(row, suite.id, req.id, "request");
        return row;
    },

    dirtyDot() {
        return h("span", { class: "tree-meta tree-dirty", title: "Unsaved changes" }, h("span", { class: "dot", style: { background: "var(--accent)" } }));
    },
    /** Puts the "unsaved changes" dot on exactly the request rows whose tab has unsaved edits (no full re-render). */
    syncDirtyDots() {
        if (!this.treeEl) return;
        for (const row of this.treeEl.querySelectorAll(".tree-node.request")) {
            const tab = App.findTab(`r:${row.dataset.suite}:${row.dataset.item}`);
            const want = !!(tab && tab.dirty);
            const dot = row.querySelector(".tree-dirty");
            if (want && !dot) row.insertBefore(this.dirtyDot(), row.querySelector(".tree-actions"));
            else if (!want && dot) dot.remove();
        }
    },

    wireRow(row, suiteId, itemId, type) {
        row.querySelector(".tree-toggle")?.addEventListener("click", (e) => {
            if (type === "request") return;
            e.stopPropagation();
            this.toggle(itemId || suiteId);
        });
        row.addEventListener("contextmenu", (e) => { e.preventDefault(); e.stopPropagation(); this.menuFor(suiteId, itemId, e); });
        // drag & drop
        row.addEventListener("dragstart", (e) => {
            if (this.renaming) { e.preventDefault(); return; }
            this.drag = { suiteId, itemId, type };
            e.dataTransfer.effectAllowed = "move";
            e.dataTransfer.setData("application/x-apitester-item", JSON.stringify(this.drag));
            setTimeout(() => row.classList.add("dragging"), 0);
        });
        row.addEventListener("dragend", () => { this.drag = null; this.clearDropMarks(); row.classList.remove("dragging"); });
        row.addEventListener("dragover", (e) => {
            const pos = this.dropPosition(e, row, suiteId, itemId, type);
            this.clearDropMarks();
            if (!pos) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = "move";
            row.classList.add(`drop-${pos}`);
            // hovering a closed folder for a moment opens it
            if (pos === "into" && type !== "request" && !this.expanded.has(itemId || suiteId)) {
                clearTimeout(this.hoverTimer);
                this.hoverTimer = setTimeout(() => { if (this.drag) { this.expanded.add(itemId || suiteId); this.render(); } }, 700);
            }
        });
        row.addEventListener("dragleave", () => { row.classList.remove("drop-before", "drop-after", "drop-into"); clearTimeout(this.hoverTimer); });
        row.addEventListener("drop", (e) => {
            const pos = this.dropPosition(e, row, suiteId, itemId, type);
            this.clearDropMarks();
            if (!pos || !this.drag) return;
            e.preventDefault();
            const src = this.drag;
            this.drag = null;
            if (src.itemId === null) this.moveSuite(src.suiteId, suiteId, pos);
            else this.moveItem(src, { suiteId, itemId, type }, pos);
        });
    },

    clearDropMarks() {
        for (const r of this.treeEl.querySelectorAll(".drop-before, .drop-after, .drop-into")) r.classList.remove("drop-before", "drop-after", "drop-into");
    },

    /** "before" | "after" | "into" | null for the current drag over a row. */
    dropPosition(e, row, suiteId, itemId, type) {
        const src = this.drag;
        if (!src) return null;
        const r = row.getBoundingClientRect();
        const y = (e.clientY - r.top) / r.height;
        if (src.itemId === null) {
            // suites only reorder among suites
            if (type !== "suite" || src.suiteId === suiteId) return null;
            return y < .5 ? "before" : "after";
        }
        if (src.suiteId === suiteId && src.itemId === itemId) return null;
        if (type === "suite") return "into";
        // a folder cannot go into itself or its children
        if (src.type === "folder" && src.suiteId === suiteId && Model.isWithin(App.getSuite(suiteId), itemId, src.itemId)) return null;
        if (type === "folder") return y < .28 ? "before" : y > .72 && !this.expanded.has(itemId) ? "after" : "into";
        return y < .5 ? "before" : "after";
    },

    async moveSuite(srcId, targetId, pos) {
        const ids = App.state.suites.map((s) => s.id).filter((id) => id !== srcId);
        const at = ids.indexOf(targetId) + (pos === "after" ? 1 : 0);
        ids.splice(at, 0, srcId);
        await App.reorderSuites(ids);
    },

    async moveItem(src, target, pos) {
        const same = src.suiteId === target.suiteId;
        const srcSuite = deepClone(App.getSuite(src.suiteId));
        const dstSuite = same ? srcSuite : deepClone(App.getSuite(target.suiteId));
        if (!srcSuite || !dstSuite) return;
        const from = Model.findItem(srcSuite, src.itemId);
        if (!from) return;
        const [item] = from.list.splice(from.index, 1);
        if (pos === "into") {
            const parent = target.itemId ? Model.findItem(dstSuite, target.itemId)?.item : null;
            (parent ? parent.items : dstSuite.items).push(item);
            this.expanded.add(target.itemId || target.suiteId);
        } else {
            const to = Model.findItem(dstSuite, target.itemId);
            if (!to) return;
            to.list.splice(to.index + (pos === "after" ? 1 : 0), 0, item);
        }
        try {
            await App.saveSuite(dstSuite);
            if (!same) {
                await App.saveSuite(srcSuite);
                // open tabs follow the moved requests into the other suite
                const ids = new Set();
                Model.walk([item], (i) => { ids.add(i.id); });
                for (const tab of App.tabs) {
                    if (tab.suiteId !== src.suiteId || !ids.has(tab.itemId)) continue;
                    const oldId = tab.id;
                    tab.suiteId = target.suiteId;
                    if (tab.kind === "request") tab.id = `r:${target.suiteId}:${tab.itemId}`;
                    else if (tab.kind === "settings") tab.id = `s:${target.suiteId}:${tab.itemId}`;
                    if (App.activeTabId === oldId) App.activeTabId = tab.id;
                    if (tab.pane) tab.pane.dataset.tab = tab.id;
                    App.syncTabWithSuite(tab);
                }
                App.renderTabs();
                App.persistUi();
                toast(`Moved to ${dstSuite.name}`, "success", 1800);
            }
        } catch (err) {
            toast(`Could not move: ${cleanError(err)}`, "error");
        }
        this.saveExpanded();
        this.render();
    },

    // ------------------------------------------------------------ selection + keyboard
    updateSelection() {
        const tab = App.activeTab();
        for (const r of this.treeEl.querySelectorAll(".tree-node.selected")) r.classList.remove("selected");
        if (!tab || tab.temp) return;
        const itemId = tab.kind === "settings" ? tab.itemId : tab.kind === "request" ? tab.itemId : null;
        if (tab.kind === "runner") return;
        const row = this.rowFor(tab.suiteId, itemId);
        if (row) row.classList.add("selected");
    },

    onTreeKey(e) {
        const row = e.target.closest(".tree-node");
        if (!row || e.target.tagName === "INPUT") return;
        const rows = [...this.treeEl.querySelectorAll(".tree-node")];
        const i = rows.indexOf(row);
        const suiteId = row.dataset.suite;
        const itemId = row.dataset.item || null;
        const isRequest = row.classList.contains("request");
        const id = itemId || suiteId;
        const focusRow = (r) => { if (r) r.focus(); };
        if (e.key === "ArrowDown") { e.preventDefault(); focusRow(rows[i + 1]); }
        else if (e.key === "ArrowUp") { e.preventDefault(); if (i === 0) this.searchInput.focus(); else focusRow(rows[i - 1]); }
        else if (e.key === "ArrowRight" && !isRequest) { e.preventDefault(); if (!this.expanded.has(id)) { this.expanded.add(id); this.saveExpanded(); this.render(); focusRow(this.rowFor(suiteId, itemId)); } else focusRow(rows[i + 1]); }
        else if (e.key === "ArrowLeft") {
            e.preventDefault();
            if (!isRequest && this.expanded.has(id) && !this.filter) { this.expanded.delete(id); this.saveExpanded(); this.render(); focusRow(this.rowFor(suiteId, itemId)); }
            else {
                const f = itemId ? Model.findItem(App.getSuite(suiteId), itemId) : null;
                if (f) focusRow(this.rowFor(suiteId, f.parents.length ? f.parents[f.parents.length - 1].id : null));
            }
        } else if (e.key === "Enter" || e.key === " ") { e.preventDefault(); if (isRequest) App.openRequest(suiteId, itemId); else row.click(); }
        else if (e.key === "F2") { e.preventDefault(); this.startRename(suiteId, itemId); }
        else if (e.key === "Delete" || (App.mac && e.key === "Backspace" && e.metaKey)) { e.preventDefault(); this.remove(suiteId, itemId); }
        else if (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) { e.preventDefault(); this.menuFor(suiteId, itemId, row); }
    },

    // ------------------------------------------------------------ rename
    isRenaming(suiteId, itemId) { return !!this.renaming && this.renaming.suiteId === suiteId && this.renaming.itemId === itemId; },
    startRename(suiteId, itemId) {
        this.renaming = { suiteId, itemId: itemId || null };
        this.render();
        const input = this.treeEl.querySelector(".rename-input");
        if (input) { input.focus(); input.select(); }
    },
    renameInput(value, commit) {
        const input = h("input", { class: "rename-input", type: "text", value, spellcheck: "false" });
        let done = false;
        const finish = (save) => {
            if (done) return;
            done = true;
            const v = input.value.trim();
            const target = this.renaming;
            this.renaming = null;
            if (save && v && v !== value) commit(v); else this.render();
            if (target) setTimeout(() => this.rowFor(target.suiteId, target.itemId)?.focus(), 0);
        };
        input.addEventListener("keydown", (e) => {
            e.stopPropagation();
            if (e.key === "Enter") { e.preventDefault(); finish(true); }
            else if (e.key === "Escape") { e.preventDefault(); finish(false); }
        });
        input.addEventListener("blur", () => finish(true));
        input.addEventListener("click", (e) => e.stopPropagation());
        input.addEventListener("dblclick", (e) => e.stopPropagation());
        return input;
    },
    async renameSuite(suiteId, name) {
        const suite = deepClone(App.getSuite(suiteId));
        if (!suite) return;
        suite.name = name;
        await attempt(() => App.saveSuite(suite));
    },
    async renameItem(suiteId, itemId, name) {
        const suite = deepClone(App.getSuite(suiteId));
        const f = suite && Model.findItem(suite, itemId);
        if (!f) return;
        f.item.name = name;
        // keep a dirty editor tab's name in step with the rename
        const tab = App.findTab(`r:${suiteId}:${itemId}`);
        if (tab && tab.dirty) { tab.draft.name = name; if (tab.view) tab.view.refreshHeader(); }
        await attempt(() => App.saveSuite(suite));
    },

    // ------------------------------------------------------------ actions
    addMenu(at) {
        const sid = App.activeSuiteId();
        contextMenu(at, [
            { label: "New suite", icon: "suite", hint: App.mac ? "⇧⌘N" : "Ctrl+Shift+N", onClick: () => App.newSuite() },
            sid ? { label: "New request", icon: "plus", hint: App.mac ? "⌘N" : "Ctrl+N", onClick: () => App.newRequest({ suiteId: sid, folderId: null }) } : null,
            sid ? { label: "New folder", icon: "folder", onClick: () => App.newFolder({ suiteId: sid }) } : null,
            "-",
            { label: "Import…", icon: "import", hint: App.mac ? "⌘O" : "Ctrl+O", onClick: () => App.command("import") },
            { label: "Paste cURL as new request…", icon: "terminal", onClick: () => this.pasteCurl(sid) },
            { label: "Add the sample suite", icon: "sparkles", onClick: () => App.addSampleSuite() }
        ]);
    },

    async pasteCurl(suiteId) {
        const ta = h("textarea", { rows: 8, placeholder: "curl -X POST https://api.example.com/users -H 'Content-Type: application/json' -d '{\"name\":\"Ann\"}'", spellcheck: "false", style: { width: "100%" } });
        const req = await modal({
            title: "New request from cURL",
            body: h("div", { class: "stack" }, ta, h("div", { class: "hint" }, "Paste a cURL command (for example from the browser's developer tools: Copy as cURL).")),
            buttons: [{ label: "Cancel", value: null }, {
                label: "Create request", class: "primary", onClick: async () => {
                    if (!ta.value.trim()) { toast("Paste a cURL command first", "warn"); return false; }
                    return api.call("tools.parseCurl", ta.value);
                }
            }]
        });
        if (!req) return;
        if (!req.name || req.name === "New Request") req.name = suggestName(normalizeDraft(req));
        await App.newRequest({ suiteId: suiteId || undefined, folderId: null, request: req });
    },

    menuFor(suiteId, itemId, at) {
        const suite = App.getSuite(suiteId);
        if (!suite) return;
        const f = itemId ? Model.findItem(suite, itemId) : null;
        const type = f ? f.item.type : "suite";
        const row = this.rowFor(suiteId, itemId);
        if (row) row.classList.add("menu-open");
        const k = (win, mac) => (App.mac ? mac : win);
        const items = [];
        if (type === "request") {
            items.push(
                { label: "Open", icon: "external", onClick: () => App.openRequest(suiteId, itemId) },
                { label: "Run", icon: "runner", onClick: () => App.showRunner({ suiteId, itemIds: [itemId] }) },
                { label: "Copy as cURL", icon: "terminal", onClick: () => this.copyCurl(suiteId, itemId) },
                "-");
        } else {
            items.push(
                { label: "New request", icon: "plus", onClick: () => App.newRequest({ suiteId, folderId: itemId }) },
                { label: "New folder", icon: "folder", onClick: () => App.newFolder({ suiteId, folderId: itemId }) },
                "-",
                { label: `Run ${type}`, icon: "runner", onClick: () => App.showRunner({ suiteId, itemIds: [itemId || suiteId] }) },
                { label: type === "suite" ? "Suite settings (variables, auth, headers)" : "Folder settings (variables, auth, headers)", icon: "settings", onClick: () => App.openItemSettings(suiteId, itemId) });
            if (type === "suite") {
                items.push({ label: "Environments…", icon: "env", onClick: () => (typeof Environments !== "undefined" ? Environments.open(suiteId) : toast("Environments are not available", "error")) });
            }
            items.push("-");
        }
        items.push(
            { label: "Rename", icon: "edit", hint: "F2", onClick: () => this.startRename(suiteId, itemId) },
            { label: "Duplicate", icon: "copy", onClick: () => this.duplicate(suiteId, itemId) });
        if (type === "suite") {
            items.push({ label: "Export to file…", icon: "export", onClick: () => (typeof ImportExport !== "undefined" ? ImportExport.openExport(suiteId) : toast("Export is not available", "error")) });
        }
        items.push("-", { label: "Delete", icon: "trash", danger: true, hint: k("Del", "⌘⌫"), onClick: () => this.remove(suiteId, itemId) });
        const menu = contextMenu(at, items);
        // remove the highlight when the menu goes away
        const obs = new MutationObserver(() => { if (!menu.isConnected) { row?.classList.remove("menu-open"); obs.disconnect(); } });
        obs.observe(document.body, { childList: true });
    },

    async copyCurl(suiteId, requestId) {
        const tab = App.findTab(`r:${suiteId}:${requestId}`);
        const req = tab ? tab.draft : Model.findItem(App.getSuite(suiteId), requestId)?.item;
        const r = await attempt(() => api.call("request.preview", { suiteId, requestId, request: req, environmentId: App.activeEnvironmentId(suiteId) }));
        if (r && r.curl) copyText(r.curl, "cURL command");
    },

    async duplicate(suiteId, itemId) {
        if (!itemId) {
            const copy = deepClone(App.getSuite(suiteId));
            delete copy.id;
            copy.name = `${copy.name} copy`;
            copy.items = copy.items.map((i) => Model.cloneWithNewIds(i));
            const saved = await attempt(() => App.saveSuite(copy), "Suite duplicated");
            if (saved) { this.expanded.add(saved.id); this.saveExpanded(); this.render(); }
            return;
        }
        const suite = deepClone(App.getSuite(suiteId));
        const f = Model.findItem(suite, itemId);
        if (!f) return;
        const copy = Model.cloneWithNewIds(f.item);
        copy.name = `${f.item.name} copy`;
        f.list.splice(f.index + 1, 0, copy);
        const saved = await attempt(() => App.saveSuite(suite));
        if (saved && copy.type === "request") App.openRequest(suiteId, copy.id);
    },

    async remove(suiteId, itemId) {
        const suite = App.getSuite(suiteId);
        if (!suite) return;
        if (!itemId) {
            const n = Model.countRequests(suite.items);
            const ok = await confirmDialog("Delete suite",
                h("div", null, "Delete ", h("b", null, suite.name), ` with ${n} request${n === 1 ? "" : "s"} and ${(suite.environments || []).length} environment(s)? This cannot be undone. Export it first if you may need it again.`),
                "Delete suite", true);
            if (ok) await attempt(() => App.deleteSuite(suiteId), "Suite deleted");
            return;
        }
        const f = Model.findItem(suite, itemId);
        if (!f) return;
        const isFolder = f.item.type === "folder";
        const n = isFolder ? Model.countRequests(f.item.items) : 0;
        const ok = await confirmDialog(isFolder ? "Delete folder" : "Delete request",
            h("div", null, "Delete ", h("b", null, f.item.name), isFolder ? ` and the ${n} request${n === 1 ? "" : "s"} in it?` : "?", " This cannot be undone."),
            "Delete", true);
        if (!ok) return;
        const copy = deepClone(suite);
        const g = Model.findItem(copy, itemId);
        g.list.splice(g.index, 1);
        // tabs of deleted requests close without asking (their edits would have nowhere to go)
        const ids = new Set();
        Model.walk([f.item], (i) => { ids.add(i.id); });
        for (const tab of [...App.tabs]) if (tab.suiteId === suiteId && ids.has(tab.itemId)) await App.closeTab(tab.id, { force: true });
        await attempt(() => App.saveSuite(copy));
    },

    // ------------------------------------------------------------ history
    renderHistory() {
        if (!this.historyEl) return;
        const open = !!App.state.ui.historyOpen;
        const all = App.state.history || [];
        const term = this.filter.toLowerCase();
        const list = term ? all.filter((e) => `${e.name || ""} ${e.method} ${e.url}`.toLowerCase().includes(term)) : all;
        clear(this.historyEl);
        const head = h("div", { class: "sb-history-head", title: open ? "Hide history" : "Show the requests you sent" },
            h("span", { class: "tree-toggle" }, icon(open ? "chevronDown" : "chevronUp")),
            h("span", { class: "title" }, icon("history"), "History"),
            h("span", { class: "badge" }, String(all.length)),
            h("span", { class: "spacer" }),
            open && all.length ? iconButton("trash", "Clear history", async (e) => {
                e.stopPropagation();
                if (!(await confirmDialog("Clear history", "Remove all entries from the request history?", "Clear", true))) return;
                const r = await attempt(() => api.call("workspace.clearHistory"));
                if (r !== undefined) { App.state.history = []; App.emit("history-changed", []); }
            }) : null);
        head.addEventListener("click", () => {
            App.saveUi({ historyOpen: !open });
            this.renderHistory();
        });
        this.historyEl.appendChild(head);
        if (!open) { this.historyEl.style.height = ""; return; }
        const height = Math.max(120, Math.min(Number(App.state.ui.historyHeight) || 260, window.innerHeight - 220));
        this.historyEl.style.height = `${height}px`;
        const resizer = h("div", { class: "resizer-y", title: "Drag to resize" });
        makeResizer(resizer, {
            axis: "y",
            getSize: () => this.historyEl.getBoundingClientRect().height,
            onMove: (d, start) => { this.historyEl.style.height = `${Math.max(100, Math.min(window.innerHeight - 200, start - d))}px`; },
            onEnd: () => App.saveUi({ historyHeight: Math.round(this.historyEl.getBoundingClientRect().height) })
        });
        this.historyEl.prepend(resizer);
        const body = h("div", { class: "sb-history-list" });
        if (!list.length) body.appendChild(h("div", { class: "empty small" }, term ? "No matching history" : "Requests you send show up here."));
        let lastDay = null;
        const today = new Date().toDateString();
        const yesterday = new Date(Date.now() - 86400000).toDateString();
        for (const e of list.slice(0, 200)) {
            const d = new Date(e.time);
            const day = d.toDateString();
            if (day !== lastDay) {
                lastDay = day;
                body.appendChild(h("div", { class: "hist-day" }, day === today ? "Today" : day === yesterday ? "Yesterday" : fmtTime(e.time, true).slice(0, 10)));
            }
            const cls = statusClass(e.status);
            const item = h("div", { class: "hist-item", title: `${e.method} ${e.url}\n${e.name || ""}\n${fmtTime(e.time, true)}` },
                methodBadge(e.method, { short: true }),
                h("span", { class: "hist-url" }, shortUrl(e.url)),
                h("span", { class: `hist-status txt-${cls}` }, e.status ? String(e.status) : "ERR"),
                h("span", { class: "hist-meta" }, h("span", null, fmtTime(e.time).slice(0, 5)), h("span", null, fmtMs(e.durationMs)),
                    historyOutcome(e), e.name ? h("span", { class: "ellipsis" }, e.name) : null));
            item.addEventListener("click", () => App.openHistory(e));
            item.addEventListener("contextmenu", (ev) => {
                ev.preventDefault();
                contextMenu(ev, [
                    { label: "Open a copy", icon: "external", onClick: () => App.openHistory(e) },
                    e.suiteId && e.requestId && App.getSuite(e.suiteId) && Model.findItem(App.getSuite(e.suiteId), e.requestId)
                        ? { label: "Open the saved request", icon: "file", onClick: () => App.openRequest(e.suiteId, e.requestId) } : null,
                    { label: "Copy URL", icon: "copy", onClick: () => copyText(e.url) },
                    "-",
                    { label: "Remove from history", icon: "trash", danger: true, onClick: async () => {
                        const r = await attempt(() => api.call("workspace.deleteHistory", e.id));
                        if (r !== undefined) { App.state.history = App.state.history.filter((x) => x.id !== e.id); App.emit("history-changed", App.state.history); }
                    } }
                ]);
            });
            body.appendChild(item);
        }
        this.historyEl.appendChild(body);
    }
};

/** "tests failed" only when a response arrived and a check failed; no response is already shown as ERR. */
function historyOutcome(e) {
    if (!e.status || e.error) return e.error ? h("span", { class: "fail", title: String(e.error) }, "error") : h("span", { class: "fail" }, "no response");
    return e.passed === false ? h("span", { class: "fail" }, "tests failed") : null;
}

/** URL without the scheme for compact lists. */
function shortUrl(url) {
    return String(url || "").replace(/^https?:\/\//i, "");
}
