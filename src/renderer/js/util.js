"use strict";
/*
 * Small DOM + UI helpers shared by all renderer views (classic script, globals on purpose).
 * Contract (spec 4.1): h, clear, toast, attempt, modal, confirmDialog, field, select, checkbox, icon, debounce,
 * fmtMs, fmtBytes, fmtTime, copyText, methodBadge, statusClass, kvTable.
 * Extras used by the shell views: promptDialog, contextMenu, varInput, attachVarAutocomplete, makeResizer,
 * tabStrip, uid, deepClone, escapeRegExp, saveTextAs, fmtRelative, spinner.
 */

// ------------------------------------------------------------------ DOM

/** Creates an element. Text is always added as text (no HTML parsing anywhere in the app). */
function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    if (attrs) {
        for (const [k, v] of Object.entries(attrs)) {
            if (v === undefined || v === null || v === false) continue;
            if (k === "class") el.className = v;
            else if (k === "style" && typeof v === "object") {
                for (const [prop, val] of Object.entries(v)) {
                    if (prop.startsWith("--")) el.style.setProperty(prop, String(val)); // custom properties need setProperty
                    else el.style[prop] = val;
                }
            }
            else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2).toLowerCase(), v);
            else if (k === "value") el.value = v;
            else if (k === "checked") el.checked = !!v;
            else if (k === "text") el.textContent = v;
            else if (k === "dataset") Object.assign(el.dataset, v);
            else el.setAttribute(k, v === true ? "" : v);
        }
    }
    appendChildren(el, children);
    return el;
}

function appendChildren(el, children) {
    for (const c of children.flat(Infinity)) {
        if (c === null || c === undefined || c === false) continue;
        el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
    }
}

/** Element.append() that skips null / undefined / false (DOM append would print "null"). */
function put(el, ...children) {
    appendChildren(el, children);
    return el;
}

function clear(el) {
    while (el.firstChild) el.removeChild(el.firstChild);
    return el;
}

/** Random id in the same format as model.newId (prefix + 12 hex chars). */
function uid(prefix = "id") {
    const bytes = new Uint8Array(6);
    crypto.getRandomValues(bytes);
    return `${prefix}_${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

function deepClone(obj) {
    return obj === undefined ? undefined : JSON.parse(JSON.stringify(obj));
}

function escapeRegExp(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function spinner() {
    return h("span", { class: "spinner", "aria-label": "Loading" });
}

// ------------------------------------------------------------------ toasts

const MAX_TOASTS = 3;

function toast(message, type = "info", timeout = 3500) {
    const root = document.getElementById("toasts");
    if (!root) return;
    const ico = { success: "check", error: "alert", warn: "alert", info: "info" }[type] || "info";
    const el = h("div", { class: `toast ${type}`, role: type === "error" ? "alert" : "status" },
        h("span", { class: "toast-icon" }, icon(ico)),
        h("div", { class: "toast-msg", title: typeof message === "string" && message.length > 120 ? message : null }, message),
        h("button", { class: "toast-close", type: "button", title: "Dismiss", "aria-label": "Dismiss", onclick: () => el.remove() }, icon("x")));
    root.appendChild(el);
    // keep the stack short (it must not cover much of a dialog): old toasts go first
    while (root.children.length > MAX_TOASTS) root.firstElementChild.remove();
    setTimeout(() => el.remove(), type === "error" ? Math.max(timeout, 7000) : timeout);
}

/** Runs an async action and reports errors as toasts. Returns the result or undefined. */
async function attempt(fn, successMessage) {
    try {
        const r = await fn();
        if (successMessage) toast(typeof successMessage === "function" ? successMessage(r) : successMessage, "success");
        return r;
    } catch (err) {
        toast(cleanError(err), "error");
        return undefined;
    }
}

/** IPC errors arrive as "Error invoking remote method 'x': Error: message"; keep only the message. */
function cleanError(err) {
    const msg = (err && err.message) || String(err);
    return msg.replace(/^Error invoking remote method '[^']*': (?:Error: )?/, "");
}

// ------------------------------------------------------------------ modals

/**
 * Opens a modal. `buttons` is a list of { label, class, value, onClick }.
 * Returns a promise resolving with the clicked button's value (or onClick result), or null when dismissed.
 * onClick may return false to keep the modal open (and may be async; errors are shown as toasts).
 * Extra options: size ("wide" | "full"), className, onMount({ close, root }) to wire custom controls.
 * Escape closes only the topmost modal; Enter in a single-line input clicks the primary button.
 */
function modal({ title, body, buttons = [{ label: "Close", value: null }], wide = false, size, className, onMount }) {
    return new Promise((resolve) => {
        const root = document.getElementById("modal-root");
        let closed = false;
        const previousFocus = document.activeElement;
        const close = (v) => {
            if (closed) return;
            closed = true;
            backdrop.remove();
            document.removeEventListener("keydown", onKey, true);
            updateModalInert();
            if (previousFocus && previousFocus.isConnected && typeof previousFocus.focus === "function") previousFocus.focus();
            resolve(v === undefined ? null : v);
        };
        const onKey = (e) => {
            if (root.lastElementChild !== backdrop) return;
            if (e.key === "Tab" && !dialog.contains(document.activeElement)) {
                // focus got outside the dialog (e.g. on a toast): bring it back
                const list = focusableIn(dialog);
                if (list.length) { e.preventDefault(); (e.shiftKey ? list[list.length - 1] : list[0]).focus(); }
                return;
            }
            if (e.key === "Escape") {
                if (document.querySelector(".ctx-menu, .ac-popup")) return; // let menus / autocomplete close first
                e.preventDefault();
                e.stopImmediatePropagation();
                close(null);
            } else if (e.key === "Enter" && !e.shiftKey && !e.isComposing && e.target.tagName === "INPUT" && !e.target.closest("table") &&
                !["checkbox", "radio", "file", "button"].includes(e.target.type) && !document.querySelector(".ac-popup")) {
                const primary = foot.querySelector(".btn.primary:not(:disabled), .btn.danger:not(:disabled)");
                if (primary) { e.preventDefault(); primary.click(); }
            }
        };
        const foot = h("div", { class: "modal-foot" });
        for (const b of buttons.filter(Boolean)) {
            if (b.spacer) { foot.appendChild(h("span", { class: "spacer" })); continue; }
            const btn = h("button", { class: `btn ${b.class || ""}`, type: "button" }, b.icon ? icon(b.icon) : null, b.label);
            btn.addEventListener("click", async () => {
                if (!b.onClick) return close(b.value);
                btn.disabled = true;
                try {
                    const r = await b.onClick({ close });
                    if (closed) return;
                    if (r === false) { btn.disabled = false; return; }
                    close(r === undefined ? b.value : r);
                } catch (err) {
                    toast(cleanError(err), "error");
                    btn.disabled = false;
                }
            });
            foot.appendChild(btn);
        }
        const sizeClass = size || (wide ? "wide" : "");
        const dialog = h("div", { class: `modal ${sizeClass} ${className || ""}`, role: "dialog", "aria-modal": "true" },
            h("div", { class: "modal-head" },
                h("h3", null, title),
                h("button", { class: "btn ghost icon", title: "Close (Esc)", type: "button", onclick: () => close(null) }, icon("x"))),
            h("div", { class: "modal-body" }, body),
            foot.childElementCount ? foot : null);
        const backdrop = h("div", { class: "modal-backdrop" }, dialog);
        // close on a click that starts and ends on the backdrop (not when a text selection drag ends there)
        let downOnBackdrop = false;
        backdrop.addEventListener("mousedown", (e) => { downOnBackdrop = e.target === backdrop; });
        backdrop.addEventListener("mouseup", (e) => { if (downOnBackdrop && e.target === backdrop) close(null); downOnBackdrop = false; });
        // Tab / Shift+Tab wrap inside the dialog. Bubble phase: editors that use Tab for indenting call preventDefault first.
        backdrop.addEventListener("keydown", (e) => {
            if (e.key !== "Tab" || e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || root.lastElementChild !== backdrop) return;
            const list = focusableIn(dialog);
            if (!list.length) { e.preventDefault(); return; }
            const first = list[0];
            const last = list[list.length - 1];
            const i = list.indexOf(document.activeElement);
            if (i === -1) return; // e.g. a control focused by script: normal order (onKey catches focus outside the dialog)
            if (e.shiftKey && i === 0) { e.preventDefault(); last.focus(); }
            else if (!e.shiftKey && i === list.length - 1) { e.preventDefault(); first.focus(); }
        });
        document.addEventListener("keydown", onKey, true);
        root.appendChild(backdrop);
        updateModalInert();
        if (onMount) {
            try { onMount({ close, root: dialog }); } catch (err) { console.error(err); }
        }
        setTimeout(() => {
            if (closed || dialog.contains(document.activeElement)) return;
            // first visible field (hidden ones, like collapsed sections, are skipped), else the primary button
            const fields = [...dialog.querySelectorAll(".modal-body [autofocus], .modal-body input:not([type=checkbox]):not([type=radio]), .modal-body select, .modal-body textarea")];
            const first = fields.find(isFocusable);
            const target = first || foot.querySelector(".btn.primary:not(:disabled)") || focusableIn(dialog)[0];
            if (target) target.focus();
        }, 30);
    });
}

/** Visible, enabled elements of a dialog that Tab reaches, in document order. */
function focusableIn(root) {
    const sel = "button, [href], input, select, textarea, [tabindex]:not([tabindex='-1']), [contenteditable='true']";
    return [...root.querySelectorAll(sel)].filter((el) => el.tabIndex >= 0 && isFocusable(el));
}

function isFocusable(el) {
    if (el.disabled || el.closest("[inert], .hidden")) return false;
    if (el.tagName === "INPUT" && el.type === "hidden") return false;
    return el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden";
}

/** While a dialog is open, the app behind it cannot be reached with the keyboard (or screen readers). */
function updateModalInert() {
    const app = document.getElementById("app");
    const open = !!document.querySelector("#modal-root .modal-backdrop");
    if (app) app.inert = open;
    document.body.classList.toggle("modal-open", open);
}

function confirmDialog(title, message, okLabel = "OK", danger = false) {
    return modal({
        title,
        body: h("div", { class: "confirm-text" }, message),
        buttons: [{ label: "Cancel", value: false }, { label: okLabel, class: danger ? "danger" : "primary", value: true }]
    }).then((v) => v === true);
}

/** Asks for one line of text. Resolves with the trimmed text or null when cancelled. */
function promptDialog(title, label, value = "", { placeholder = "", okLabel = "OK", hint, validate } = {}) {
    const input = h("input", { type: "text", value, placeholder, autofocus: true, spellcheck: "false" });
    const err = h("div", { class: "field-error hidden" });
    setTimeout(() => input.select(), 40);
    return modal({
        title,
        body: h("div", { class: "stack" }, field(label, input, hint), err),
        buttons: [
            { label: "Cancel", value: null },
            {
                label: okLabel, class: "primary", onClick: () => {
                    const v = input.value.trim();
                    const problem = !v ? "Please enter a value" : (validate ? validate(v) : null);
                    if (problem) { err.textContent = problem; err.classList.remove("hidden"); input.focus(); return false; }
                    return v;
                }
            }
        ]
    });
}

// ------------------------------------------------------------------ form helpers

function field(label, input, hint) {
    return h("div", { class: "field" }, label ? h("label", null, label) : null, input, hint ? h("div", { class: "hint" }, hint) : null);
}

function select(options, value, attrs = {}) {
    const el = h("select", attrs);
    for (const o of options) {
        const opt = typeof o === "object" ? o : { value: o, label: o };
        if (opt.group) {
            const g = h("optgroup", { label: opt.group });
            for (const c of opt.options || []) g.appendChild(h("option", { value: c.value, disabled: c.disabled }, c.label ?? c.value));
            el.appendChild(g);
        } else {
            el.appendChild(h("option", { value: opt.value, disabled: opt.disabled, title: opt.title }, opt.label ?? opt.value));
        }
    }
    if (value !== undefined && value !== null) el.value = String(value);
    return el;
}

function checkbox(label, checked, onChange) {
    const input = h("input", { type: "checkbox", checked });
    if (onChange) input.addEventListener("change", () => onChange(input.checked));
    return h("label", { class: "check" }, input, label ? h("span", null, label) : null);
}

/** Password-like input with an eye toggle. */
function secretInput(value, attrs = {}, onInput) {
    const input = h("input", { type: "password", value, spellcheck: "false", autocomplete: "off", ...attrs });
    if (onInput) input.addEventListener("input", () => onInput(input.value));
    const btn = h("button", { class: "btn ghost icon eye-toggle", type: "button", title: "Show / hide value", tabindex: "-1" }, icon("eye"));
    btn.addEventListener("click", () => {
        const show = input.type === "password";
        input.type = show ? "text" : "password";
        clear(btn).appendChild(icon(show ? "eyeOff" : "eye"));
    });
    return h("div", { class: "secret-input" }, input, btn);
}

// ------------------------------------------------------------------ formatting

function pad(n, w = 2) { return String(n).padStart(w, "0"); }

function fmtMs(ms) {
    if (ms === null || ms === undefined || ms === "" || isNaN(ms)) return "—";
    const v = Number(ms);
    if (v < 1) return `${v.toFixed(2)} ms`;
    if (v < 1000) return `${Math.round(v)} ms`;
    if (v < 60000) return `${(v / 1000).toFixed(v < 10000 ? 2 : 1)} s`;
    const m = Math.floor(v / 60000);
    return `${m}m ${Math.round((v % 60000) / 1000)}s`;
}

function fmtBytes(n) {
    if (n === null || n === undefined || isNaN(n)) return "—";
    const v = Number(n);
    if (v < 1024) return `${v} B`;
    if (v < 1024 * 1024) return `${(v / 1024).toFixed(v < 10240 ? 2 : 1)} KB`;
    if (v < 1024 * 1024 * 1024) return `${(v / 1024 / 1024).toFixed(2)} MB`;
    return `${(v / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/** Local time; date is added when not today (or withDate). withMs adds milliseconds. */
function fmtTime(iso, withDate = false, withMs = false) {
    if (!iso) return "—";
    const d = new Date(iso);
    if (isNaN(d)) return String(iso);
    const t = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${withMs ? "." + pad(d.getMilliseconds(), 3) : ""}`;
    const today = new Date().toDateString() === d.toDateString();
    return withDate || !today ? `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${t}` : t;
}

/** "just now", "5 min ago", "3 h ago", else the date. */
function fmtRelative(iso) {
    const d = new Date(iso);
    if (isNaN(d)) return "";
    const s = Math.round((Date.now() - d.getTime()) / 1000);
    if (s < 45) return "just now";
    if (s < 3600) return `${Math.max(1, Math.round(s / 60))} min ago`;
    if (s < 86400) return `${Math.round(s / 3600)} h ago`;
    if (s < 86400 * 6) return `${Math.round(s / 86400)} d ago`;
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function debounce(fn, ms) {
    let t = null;
    const wrapped = (...args) => { clearTimeout(t); t = setTimeout(() => { t = null; fn(...args); }, ms); };
    wrapped.cancel = () => { clearTimeout(t); t = null; };
    wrapped.flush = (...args) => { if (t !== null) { clearTimeout(t); t = null; fn(...args); } };
    return wrapped;
}

function copyText(text, label) {
    const value = String(text ?? "");
    const done = () => {
        const shown = label || (value.length > 60 ? `${value.slice(0, 60)}…` : value);
        toast(`Copied${shown ? ": " + shown : ""}`, "success", 1800);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(value).then(done, () => fallbackCopy(value) && done());
    } else if (fallbackCopy(value)) done();
}

function fallbackCopy(value) {
    const ta = h("textarea", { style: { position: "fixed", left: "-9999px", top: "0" } });
    ta.value = value;
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand("copy"); } catch (_) { ok = false; }
    ta.remove();
    if (!ok) toast("Could not copy to the clipboard", "error");
    return ok;
}

/** Lets the user save text (or base64 data) to a file through the browser download (shows a save dialog). */
function saveTextAs(fileName, content, mime = "text/plain", base64 = false) {
    let blob;
    if (base64) {
        const bin = atob(content);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        blob = new Blob([bytes], { type: mime });
    } else blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = h("a", { href: url, download: fileName || "response.txt", style: { display: "none" } });
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
}

// ------------------------------------------------------------------ HTTP specific

const METHOD_SHORT = { DELETE: "DEL", OPTIONS: "OPT", PATCH: "PATCH" };

/** Colored method label. opts.short abbreviates long names (tree). */
function methodBadge(method, opts = {}) {
    const m = String(method || "GET").toUpperCase();
    const known = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"].includes(m);
    return h("span", { class: `method m-${known ? m.toLowerCase() : "other"}${opts.short ? " short" : ""}`, title: m },
        opts.short ? (METHOD_SHORT[m] || m) : m);
}

/** "ok" (1xx/2xx) | "redirect" (3xx) | "client" (4xx) | "server" (5xx) | "error" (no response). */
function statusClass(status) {
    const s = Number(status);
    if (!s || isNaN(s)) return "error";
    if (s < 300) return "ok";
    if (s < 400) return "redirect";
    if (s < 500) return "client";
    return "server";
}

function statusPill(status, statusText) {
    const cls = statusClass(status);
    return h("span", { class: `status-pill st-${cls}` }, status ? `${status} ${statusText || ""}`.trim() : "Error");
}

// ------------------------------------------------------------------ icons

/*
 * Inline SVG icons (24x24 grid, stroked with currentColor, 1em). No emoji: they render as boxes on
 * Linux desktops without an emoji font. Entries are path strings or [tag, attributes] pairs.
 */
const SVG_NS = "http://www.w3.org/2000/svg";
const ICONS = {
    plus: ["M12 5v14", "M5 12h14"],
    minus: ["M5 12h14"],
    trash: ["M3 6h18", "M8 6V4h8v2", "M5 6l1 14a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2l1-14", "M10 11v6M14 11v6"],
    copy: [["rect", { x: 8, y: 8, width: 13, height: 13, rx: 2 }], "M4 16V5a2 2 0 0 1 2-2h11"],
    edit: ["M12 20h9", "M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"],
    play: [["path", { d: "M7 4.5v15l12.5-7.5z", fill: "currentColor" }]],
    stop: [["rect", { x: 6, y: 6, width: 12, height: 12, rx: 2, fill: "currentColor" }]],
    send: ["M22 2L11 13", "M22 2l-7 20-4-9-9-4z"],
    save: ["M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z", "M17 21v-8H7v8", "M7 3v5h8"],
    import: ["M12 3v12", "M7 10l5 5 5-5", "M5 21h14"],
    export: ["M12 15V3", "M7 8l5-5 5 5", "M5 21h14"],
    download: ["M12 3v12", "M7 10l5 5 5-5", "M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"],
    upload: ["M12 15V3", "M7 8l5-5 5 5", "M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"],
    settings: [["circle", { cx: 12, cy: 12, r: 3 }],
        "M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68 1.65 1.65 0 0 0 10 3.17V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"],
    env: [["rect", { x: 3, y: 4, width: 18, height: 16, rx: 2 }], "M7 9h4", "M7 13h10", "M7 17h6", ["circle", { cx: 16, cy: 9, r: 1.2, fill: "currentColor" }]],
    folder: ["M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"],
    folderOpen: ["M5 19a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h4l2 2h6a2 2 0 0 1 2 2v1",
        "M5 19l2.6-7.2A1.5 1.5 0 0 1 9 11h11.5a1 1 0 0 1 .9 1.4L19 18a1.6 1.6 0 0 1-1.5 1z"],
    file: ["M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z", "M14 3v5h5"],
    suite: [["rect", { x: 3, y: 3, width: 7, height: 7, rx: 1.5 }], ["rect", { x: 14, y: 3, width: 7, height: 7, rx: 1.5 }],
        ["rect", { x: 3, y: 14, width: 7, height: 7, rx: 1.5 }], ["rect", { x: 14, y: 14, width: 7, height: 7, rx: 1.5 }]],
    chevronRight: ["M9 6l6 6-6 6"],
    chevronDown: ["M6 9l6 6 6-6"],
    chevronUp: ["M6 15l6-6 6 6"],
    chevronLeft: ["M15 6l-6 6 6 6"],
    search: [["circle", { cx: 11, cy: 11, r: 7 }], "M20 20l-4-4"],
    more: [["circle", { cx: 5, cy: 12, r: 1.4, fill: "currentColor" }], ["circle", { cx: 12, cy: 12, r: 1.4, fill: "currentColor" }],
        ["circle", { cx: 19, cy: 12, r: 1.4, fill: "currentColor" }]],
    check: ["M5 12.5l4.5 4.5L19 7.5"],
    x: ["M6 6l12 12", "M18 6L6 18"],
    history: ["M3 12a9 9 0 1 0 3-6.7L3 8", "M3 3v5h5", "M12 7v5l3.5 2"],
    sun: [["circle", { cx: 12, cy: 12, r: 4 }], "M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"],
    moon: ["M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"],
    help: [["circle", { cx: 12, cy: 12, r: 9 }], "M9.1 9a3 3 0 0 1 5.8 1c0 2-3 2.5-3 4.5", ["circle", { cx: 12, cy: 17.5, r: .6, fill: "currentColor" }]],
    runner: ["M5 4v16", "M9 6.5l10 5.5-10 5.5z"],
    eye: ["M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z", ["circle", { cx: 12, cy: 12, r: 3 }]],
    eyeOff: ["M9.9 5.1A10.4 10.4 0 0 1 12 5c6.5 0 10 7 10 7a17.6 17.6 0 0 1-2.9 3.9", "M6.6 6.6C3.8 8.4 2 12 2 12s3.5 7 10 7a9.7 9.7 0 0 0 5.4-1.6",
        "M9.9 9.9a3 3 0 0 0 4.2 4.2", "M3 3l18 18"],
    drag: [["circle", { cx: 9, cy: 6, r: 1.3, fill: "currentColor" }], ["circle", { cx: 15, cy: 6, r: 1.3, fill: "currentColor" }],
        ["circle", { cx: 9, cy: 12, r: 1.3, fill: "currentColor" }], ["circle", { cx: 15, cy: 12, r: 1.3, fill: "currentColor" }],
        ["circle", { cx: 9, cy: 18, r: 1.3, fill: "currentColor" }], ["circle", { cx: 15, cy: 18, r: 1.3, fill: "currentColor" }]],
    globe: [["circle", { cx: 12, cy: 12, r: 9 }], "M3 12h18", "M12 3a14 14 0 0 1 0 18", "M12 3a14 14 0 0 0 0 18"],
    lock: [["rect", { x: 5, y: 11, width: 14, height: 10, rx: 2 }], "M8 11V7a4 4 0 0 1 8 0v4"],
    unlock: [["rect", { x: 5, y: 11, width: 14, height: 10, rx: 2 }], "M8 11V7a4 4 0 0 1 7.5-2"],
    code: ["M8 7l-5 5 5 5", "M16 7l5 5-5 5"],
    braces: ["M8 3H7a2 2 0 0 0-2 2v4a2 2 0 0 1-2 2 2 2 0 0 1 2 2v4a2 2 0 0 0 2 2h1", "M16 3h1a2 2 0 0 1 2 2v4a2 2 0 0 0 2 2 2 2 0 0 0-2 2v4a2 2 0 0 1-2 2h-1"],
    alert: ["M12 3l9.5 17h-19z", "M12 10v4", ["circle", { cx: 12, cy: 17.2, r: .6, fill: "currentColor" }]],
    info: [["circle", { cx: 12, cy: 12, r: 9 }], "M12 11v5", ["circle", { cx: 12, cy: 7.8, r: .6, fill: "currentColor" }]],
    clock: [["circle", { cx: 12, cy: 12, r: 9 }], "M12 7v5l3 2"],
    refresh: ["M21 12a9 9 0 0 1-15.5 6.2L3 16", "M3 21v-5h5", "M3 12A9 9 0 0 1 18.5 5.8L21 8", "M21 3v5h-5"],
    layoutRows: [["rect", { x: 3, y: 3, width: 18, height: 18, rx: 2 }], "M3 12h18"],
    layoutCols: [["rect", { x: 3, y: 3, width: 18, height: 18, rx: 2 }], "M12 3v18"],
    target: [["circle", { cx: 12, cy: 12, r: 9 }], ["circle", { cx: 12, cy: 12, r: 5 }], ["circle", { cx: 12, cy: 12, r: 1, fill: "currentColor" }]],
    magnet: ["M6 3v8a6 6 0 0 0 12 0V3", "M6 7h4", "M14 7h4", "M10 3v8a2 2 0 0 0 4 0V3"],
    capture: ["M4 8V5a1 1 0 0 1 1-1h3", "M16 4h3a1 1 0 0 1 1 1v3", "M20 16v3a1 1 0 0 1-1 1h-3", "M8 20H5a1 1 0 0 1-1-1v-3", "M9 12h6", "M12 9v6"],
    sparkles: ["M12 3l1.8 4.7L18.5 9.5l-4.7 1.8L12 16l-1.8-4.7L5.5 9.5l4.7-1.8z", "M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z"],
    cookie: ["M12 3a9 9 0 1 0 9 9 4 4 0 0 1-5-4 4 4 0 0 1-4-5z", ["circle", { cx: 8.5, cy: 11, r: .9, fill: "currentColor" }],
        ["circle", { cx: 12, cy: 16, r: .9, fill: "currentColor" }], ["circle", { cx: 16, cy: 14, r: .9, fill: "currentColor" }]],
    list: ["M8 6h13", "M8 12h13", "M8 18h13", ["circle", { cx: 4, cy: 6, r: .8, fill: "currentColor" }],
        ["circle", { cx: 4, cy: 12, r: .8, fill: "currentColor" }], ["circle", { cx: 4, cy: 18, r: .8, fill: "currentColor" }]],
    terminal: [["rect", { x: 3, y: 4, width: 18, height: 16, rx: 2 }], "M7 9l3 3-3 3", "M13 15h4"],
    external: ["M14 4h6v6", "M20 4l-9 9", "M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"],
    wrap: ["M3 6h18", "M3 12h15a3 3 0 0 1 0 6h-4", "M16 16l-2 2 2 2", "M3 18h7"],
    key: [["circle", { cx: 7.5, cy: 15.5, r: 4.5 }], "M10.7 12.3L20 3", "M16 7l3 3", "M14 9l2 2"],
    user: [["circle", { cx: 12, cy: 8, r: 4 }], "M4 21a8 8 0 0 1 16 0"],
    server: [["rect", { x: 3, y: 4, width: 18, height: 7, rx: 1.5 }], ["rect", { x: 3, y: 13, width: 18, height: 7, rx: 1.5 }],
        ["circle", { cx: 7, cy: 7.5, r: .8, fill: "currentColor" }], ["circle", { cx: 7, cy: 16.5, r: .8, fill: "currentColor" }]],
    filter: ["M3 5h18l-7 8v6l-4 2v-8z"],
    expand: ["M4 9V4h5", "M20 9V4h-5", "M4 15v5h5", "M20 15v5h-5"],
    collapse: ["M9 4v5H4", "M15 4v5h5", "M9 20v-5H4", "M15 20v-5h5"],
    image: [["rect", { x: 3, y: 4, width: 18, height: 16, rx: 2 }], ["circle", { cx: 8.5, cy: 9.5, r: 1.5 }], "M21 16l-5-5-9 9"],
    dot: [["circle", { cx: 12, cy: 12, r: 4, fill: "currentColor", stroke: "none" }]],
    link: ["M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7", "M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"],
    flask: ["M9 3h6", "M10 3v6l-5.5 9.5A1.7 1.7 0 0 0 6 21h12a1.7 1.7 0 0 0 1.5-2.5L14 9V3", "M7.5 15h9"],
    zap: [["path", { d: "M13 2L4 14h7l-1 8 9-12h-7z" }]],
    undo: ["M9 14L4 9l5-5", "M4 9h11a5 5 0 0 1 0 10h-3"]
};

function icon(name, attrs = {}) {
    const svg = document.createElementNS(SVG_NS, "svg");
    const base = { viewBox: "0 0 24 24", width: "1em", height: "1em", fill: "none", stroke: "currentColor", "stroke-width": 2, "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true" };
    for (const [k, v] of Object.entries({ ...base, ...attrs })) if (k !== "class") svg.setAttribute(k, v);
    svg.setAttribute("class", `svg-icon ${attrs.class || ""}`.trim());
    for (const part of ICONS[name] || ICONS.dot) {
        const [tag, a] = typeof part === "string" ? ["path", { d: part }] : part;
        const el = document.createElementNS(SVG_NS, tag);
        for (const [k, v] of Object.entries(a)) el.setAttribute(k, v);
        svg.appendChild(el);
    }
    return svg;
}

/** Icon-only button with a tooltip. */
function iconButton(name, title, onClick, extraClass = "") {
    return h("button", { class: `btn ghost icon ${extraClass}`.trim(), type: "button", title, "aria-label": title, onclick: onClick }, icon(name));
}

// ------------------------------------------------------------------ context menu

/**
 * Shows a small menu at the mouse position (or below an element).
 * at: MouseEvent | { x, y } | HTMLElement. items: [{ label, icon, onClick, danger, disabled, hint }], "-" for a separator,
 * or { header, mono, title } for a caption (mono: shown as typed, e.g. a JSONPath, not upper-cased).
 */
function contextMenu(at, items) {
    closeContextMenu();
    const menu = h("div", { class: "ctx-menu", role: "menu", tabindex: "-1" });
    const entries = [];
    for (const it of items.filter(Boolean)) {
        if (it === "-") { if (menu.lastChild && !menu.lastChild.classList.contains("ctx-sep")) menu.appendChild(h("div", { class: "ctx-sep" })); continue; }
        if (it.header) { menu.appendChild(h("div", { class: `ctx-header ${it.mono ? "mono" : ""}`.trim(), title: it.title || null }, it.header)); continue; }
        const row = h("button", { class: `ctx-item ${it.danger ? "danger" : ""}`, type: "button", role: "menuitem", disabled: it.disabled },
            h("span", { class: "ctx-icon" }, it.icon ? icon(it.icon) : null),
            h("span", { class: "ctx-label" }, it.label),
            it.hint ? h("span", { class: "ctx-hint" }, it.hint) : null);
        row.addEventListener("click", (e) => {
            e.stopPropagation();
            closeContextMenu();
            if (it.onClick) Promise.resolve().then(() => it.onClick()).catch((err) => toast(cleanError(err), "error"));
        });
        menu.appendChild(row);
        entries.push(row);
    }
    if (menu.lastChild && menu.lastChild.classList.contains("ctx-sep")) menu.lastChild.remove();
    document.body.appendChild(menu);
    let x, y;
    if (at instanceof HTMLElement) {
        const r = at.getBoundingClientRect();
        x = r.left; y = r.bottom + 4;
    } else { x = at.clientX ?? at.x; y = at.clientY ?? at.y; }
    const mw = menu.offsetWidth, mh = menu.offsetHeight;
    if (x + mw > window.innerWidth - 6) x = Math.max(6, window.innerWidth - mw - 6);
    if (y + mh > window.innerHeight - 6) y = Math.max(6, (at instanceof HTMLElement ? at.getBoundingClientRect().top - mh - 4 : window.innerHeight - mh - 6));
    menu.style.left = `${x}px`;
    menu.style.top = `${y}px`;
    let focusIdx = -1;
    const onKey = (e) => {
        if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closeContextMenu(); }
        else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            const enabled = entries.filter((b) => !b.disabled);
            if (!enabled.length) return;
            focusIdx = (focusIdx + (e.key === "ArrowDown" ? 1 : -1) + enabled.length) % enabled.length;
            enabled[focusIdx].focus();
        }
    };
    const onDown = (e) => { if (!menu.contains(e.target)) closeContextMenu(); };
    setTimeout(() => {
        document.addEventListener("mousedown", onDown, true);
        window.addEventListener("blur", closeContextMenu);
        window.addEventListener("resize", closeContextMenu);
    }, 0);
    document.addEventListener("keydown", onKey, true);
    menu._cleanup = () => {
        document.removeEventListener("mousedown", onDown, true);
        document.removeEventListener("keydown", onKey, true);
        window.removeEventListener("blur", closeContextMenu);
        window.removeEventListener("resize", closeContextMenu);
    };
    menu.focus();
    return menu;
}

function closeContextMenu() {
    for (const m of document.querySelectorAll(".ctx-menu")) {
        if (m._cleanup) m._cleanup();
        m.remove();
    }
}

// ------------------------------------------------------------------ tabs

/**
 * Simple tab strip. tabs: [{ id, label, count, dot, title }]. Returns { el, setActive(id), update(tabs) }.
 */
function tabStrip(tabs, active, onSelect, extraClass = "") {
    const el = h("div", { class: `tabs ${extraClass}`.trim(), role: "tablist" });
    let current = active;
    let list = tabs;
    const render = () => {
        clear(el);
        for (const t of list) {
            const b = h("button", { class: `tab ${t.id === current ? "active" : ""}`, type: "button", role: "tab", title: t.title, dataset: { tab: t.id } },
                t.icon ? icon(t.icon) : null,
                h("span", null, t.label),
                t.count ? h("span", { class: `tab-count ${t.countClass || ""}` }, t.count) : null,
                t.dot ? h("span", { class: `tab-dot ${t.dotClass || ""}` }) : null);
            b.addEventListener("click", () => { current = t.id; render(); onSelect(t.id); });
            el.appendChild(b);
        }
    };
    render();
    return { el, setActive(id) { current = id; render(); }, update(next) { list = next; render(); } };
}

// ------------------------------------------------------------------ resizer

/**
 * Makes `handle` resize something by dragging. axis "x" or "y".
 * onMove(deltaPx, startSize) is called while dragging; onEnd() afterwards.
 * getSize() returns the current size at drag start.
 */
function makeResizer(handle, { axis = "x", getSize, onMove, onEnd }) {
    handle.addEventListener("mousedown", (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        const start = axis === "x" ? e.clientX : e.clientY;
        const startSize = getSize ? getSize() : 0;
        document.body.classList.add(axis === "x" ? "resizing-x" : "resizing-y");
        handle.classList.add("active");
        const move = (ev) => onMove((axis === "x" ? ev.clientX : ev.clientY) - start, startSize);
        const up = () => {
            document.removeEventListener("mousemove", move);
            document.removeEventListener("mouseup", up);
            document.body.classList.remove("resizing-x", "resizing-y");
            handle.classList.remove("active");
            if (onEnd) onEnd();
        };
        document.addEventListener("mousemove", move);
        document.addEventListener("mouseup", up);
    });
}

// ------------------------------------------------------------------ {{variables}} in inputs

const VAR_RE = /\{\{\s*([^{}]+?)\s*\}\}/g;

/**
 * Variable lookups for highlighting / tooltips. A provider returns a Map name -> { value, source, secret }
 * (or null when unknown). Dynamic variables ($guid...) are always known.
 */
function varStatus(name, vars) {
    if (name.startsWith("$")) return "dynamic";
    return vars && vars.has(name) ? "known" : "unknown";
}

/**
 * Wraps a text input with {{variable}} highlighting (colored chips behind the text), a hover tooltip showing
 * the value and source, and {{ autocomplete. opts.vars: () => Map | null; opts.dynamic: () => [{name, description}].
 * Returns the wrapper element; call wrapper.refresh() after setting input.value programmatically.
 */
function varInput(input, opts = {}) {
    const overlayInner = h("span", { class: "var-overlay-inner" });
    const overlay = h("div", { class: "var-overlay", "aria-hidden": "true" }, overlayInner);
    const wrap = h("div", { class: `var-field ${opts.class || ""}`.trim() }, overlay, input);
    input.classList.add("var-input");
    const render = () => {
        clear(overlayInner);
        const text = input.value;
        const vars = opts.vars ? opts.vars() : null;
        let last = 0;
        let unknown = 0;
        VAR_RE.lastIndex = 0;
        for (let m; (m = VAR_RE.exec(text));) {
            if (m.index > last) overlayInner.appendChild(document.createTextNode(text.slice(last, m.index)));
            const status = varStatus(m[1].trim(), vars);
            if (status === "unknown") unknown++;
            overlayInner.appendChild(h("span", { class: `var-chip var-${status}`, dataset: { name: m[1].trim() } }, m[0]));
            last = m.index + m[0].length;
        }
        if (last < text.length) overlayInner.appendChild(document.createTextNode(text.slice(last)));
        wrap.classList.toggle("has-unknown", unknown > 0);
        sync();
    };
    const sync = () => { overlayInner.style.transform = `translateX(${-input.scrollLeft}px)`; };
    input.addEventListener("input", render);
    input.addEventListener("scroll", sync);
    input.addEventListener("keyup", sync);
    input.addEventListener("mouseup", sync);
    input.addEventListener("focus", sync);
    input.addEventListener("blur", sync);
    input.addEventListener("select", sync);
    // tooltip: find the chip under the mouse (the overlay ignores pointer events, so compare rectangles)
    let tip = null;
    const hideTip = () => { if (tip) { tip.remove(); tip = null; } };
    input.addEventListener("mousemove", (e) => {
        const chip = [...overlayInner.querySelectorAll(".var-chip")].find((c) => {
            const r = c.getBoundingClientRect();
            return e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top - 2 && e.clientY <= r.bottom + 2;
        });
        if (!chip) return hideTip();
        if (tip && tip.dataset.name === chip.dataset.name) return;
        hideTip();
        tip = varTooltip(chip.dataset.name, opts.vars ? opts.vars() : null, opts.dynamic ? opts.dynamic() : []);
        tip.dataset.name = chip.dataset.name;
        document.body.appendChild(tip);
        const r = chip.getBoundingClientRect();
        const left = Math.min(r.left, window.innerWidth - tip.offsetWidth - 8);
        tip.style.left = `${Math.max(6, left)}px`;
        tip.style.top = `${r.bottom + 6}px`;
    });
    input.addEventListener("mouseleave", hideTip);
    input.addEventListener("keydown", hideTip);
    if (opts.autocomplete !== false) attachVarAutocomplete(input, { names: opts.names || (() => varNamesFrom(opts)) });
    wrap.refresh = render;
    render();
    return wrap;
}

function varNamesFrom(opts) {
    const vars = opts.vars ? opts.vars() : null;
    const out = [];
    if (vars) for (const [name, v] of vars) out.push({ name, detail: v.secret ? "•••••" : v.value, source: v.source });
    for (const d of opts.dynamic ? opts.dynamic() : []) out.push({ name: d.name, detail: d.description, source: "dynamic" });
    return out;
}

function varTooltip(name, vars, dynamic) {
    const tip = h("div", { class: "var-tooltip" });
    if (name.startsWith("$")) {
        const d = (dynamic || []).find((x) => x.name === name);
        put(tip, h("div", { class: "vt-name" }, `{{${name}}}`), h("div", { class: "vt-value" }, d ? d.description : "Dynamic value, generated when sent"),
            h("div", { class: "vt-source" }, "dynamic variable"));
        if (!d) tip.classList.add("unknown");
    } else if (vars && vars.has(name)) {
        const v = vars.get(name);
        const value = v.secret ? "••••• (secret)" : (v.value === "" ? "(empty)" : v.value);
        put(tip, h("div", { class: "vt-name" }, `{{${name}}}`), h("div", { class: "vt-value" }, value.length > 300 ? value.slice(0, 300) + "…" : value),
            h("div", { class: "vt-source" }, `from ${sourceLabel(v.source)}`));
    } else {
        tip.classList.add("unknown");
        put(tip, h("div", { class: "vt-name" }, `{{${name}}}`), h("div", { class: "vt-value" }, "Not defined in the active environment, suite, folders or globals."),
            h("div", { class: "vt-source" }, "Define it under Environments or capture it from a response."));
    }
    return tip;
}

function sourceLabel(source) {
    if (!source) return "unknown";
    if (source.startsWith("folder:")) return `folder "${source.slice(7)}"`;
    return { runtime: "runtime (captured)", data: "data file", environment: "environment", suite: "suite variables", global: "globals", dynamic: "dynamic" }[source] || source;
}

/** Resolves {{vars}} in text with a Map of known variables (local preview; dynamic ones stay as written). */
function resolveVarsLocal(text, vars, depth = 0) {
    const unresolved = new Set();
    let secret = false;
    const out = String(text ?? "").replace(VAR_RE, (m, raw) => {
        const name = raw.trim();
        if (name.startsWith("$")) return m;
        const v = vars && vars.get(name);
        if (!v) { unresolved.add(name); return m; }
        if (v.secret) { secret = true; return "•••••"; }
        if (depth < 8 && String(v.value).includes("{{")) {
            const inner = resolveVarsLocal(v.value, vars, depth + 1);
            inner.unresolved.forEach((u) => unresolved.add(u));
            if (inner.secret) secret = true;
            return inner.value;
        }
        return v.value;
    });
    return { value: out, unresolved: [...unresolved], secret };
}

/**
 * {{ autocomplete for inputs and textareas. names(): [{ name, detail, source }].
 */
function attachVarAutocomplete(el, { names }) {
    let popup = null;
    let items = [];
    let index = 0;
    let range = null; // { start, end } of the "{{prefix" being typed

    const close = () => { if (popup) { popup.remove(); popup = null; } };
    const context = () => {
        const pos = el.selectionStart;
        if (pos !== el.selectionEnd) return null;
        const before = el.value.slice(0, pos);
        const open = before.lastIndexOf("{{");
        if (open < 0) return null;
        const prefix = before.slice(open + 2);
        if (prefix.includes("}") || prefix.includes("\n") || prefix.length > 60 || !/^\s*[\w.$\-]*$/.test(prefix)) return null;
        return { start: open, end: pos, prefix: prefix.trim() };
    };
    const insert = (name) => {
        const after = el.value.slice(range.end);
        const closeTail = after.startsWith("}}") ? "" : "}}";
        const text = `{{${name}${closeTail}`;
        el.setRangeText(text, range.start, range.end, "end");
        if (!closeTail) el.setSelectionRange(range.start + text.length + 2, range.start + text.length + 2);
        close();
        el.dispatchEvent(new Event("input", { bubbles: true }));
    };
    const render = () => {
        if (!popup) {
            popup = h("div", { class: "ac-popup", role: "listbox" });
            popup.addEventListener("mousedown", (e) => e.preventDefault()); // keep focus in the input
            document.body.appendChild(popup);
        }
        clear(popup);
        items.forEach((it, i) => {
            const row = h("div", { class: `ac-item ${i === index ? "active" : ""}`, role: "option" },
                h("span", { class: `ac-name ${it.source === "dynamic" ? "dyn" : ""}` }, it.name),
                h("span", { class: "ac-detail" }, String(it.detail ?? "").slice(0, 60)),
                h("span", { class: "ac-source" }, it.source === "dynamic" ? "dynamic" : sourceLabel(it.source).replace(/ \(captured\)$/, "")));
            row.addEventListener("click", () => insert(it.name));
            popup.appendChild(row);
        });
        const caret = caretCoordinates(el, range.end);
        const r = el.getBoundingClientRect();
        let left = r.left + caret.left;
        let top = r.top + caret.top + caret.height + 4;
        popup.style.left = `${Math.max(6, Math.min(left, window.innerWidth - popup.offsetWidth - 8))}px`;
        if (top + popup.offsetHeight > window.innerHeight - 6) top = r.top + caret.top - popup.offsetHeight - 4;
        popup.style.top = `${top}px`;
        const active = popup.children[index];
        if (active) active.scrollIntoView({ block: "nearest" });
    };
    const update = () => {
        const ctx = context();
        if (!ctx) return close();
        range = ctx;
        const p = ctx.prefix.toLowerCase();
        const all = names() || [];
        const seen = new Set();
        items = all.filter((n) => {
            if (seen.has(n.name)) return false;
            seen.add(n.name);
            return !p || n.name.toLowerCase().includes(p);
        }).sort((a, b) => {
            const as = a.name.toLowerCase().startsWith(p) ? 0 : 1;
            const bs = b.name.toLowerCase().startsWith(p) ? 0 : 1;
            const ad = a.source === "dynamic" ? 1 : 0;
            const bd = b.source === "dynamic" ? 1 : 0;
            return as - bs || ad - bd || a.name.localeCompare(b.name);
        }).slice(0, 50);
        if (!items.length) return close();
        index = Math.min(index, items.length - 1);
        render();
    };
    el.addEventListener("input", () => { index = 0; update(); });
    el.addEventListener("keydown", (e) => {
        if (!popup) {
            if (e.key === " " && e.ctrlKey) { e.preventDefault(); update(); }
            return;
        }
        if (e.key === "ArrowDown") { e.preventDefault(); index = (index + 1) % items.length; render(); }
        else if (e.key === "ArrowUp") { e.preventDefault(); index = (index - 1 + items.length) % items.length; render(); }
        else if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); e.stopPropagation(); insert(items[index].name); }
        else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); }
    });
    el.addEventListener("blur", () => setTimeout(close, 120));
    el.addEventListener("click", () => { if (popup) update(); });
}

/** Caret position relative to the element's border box (mirror element technique). */
function caretCoordinates(el, position) {
    const style = getComputedStyle(el);
    const isInput = el.tagName === "INPUT";
    const mirror = h("div");
    const props = ["boxSizing", "width", "height", "overflowX", "overflowY", "borderTopWidth", "borderRightWidth", "borderBottomWidth", "borderLeftWidth",
        "paddingTop", "paddingRight", "paddingBottom", "paddingLeft", "fontStyle", "fontVariant", "fontWeight", "fontStretch", "fontSize", "lineHeight",
        "fontFamily", "textAlign", "textTransform", "textIndent", "letterSpacing", "wordSpacing", "tabSize"];
    for (const p of props) mirror.style[p] = style[p];
    Object.assign(mirror.style, { position: "absolute", visibility: "hidden", top: "0", left: "-9999px", whiteSpace: isInput ? "pre" : "pre-wrap", wordWrap: isInput ? "normal" : "break-word" });
    mirror.textContent = el.value.slice(0, position);
    const marker = h("span", null, el.value.slice(position) || ".");
    mirror.appendChild(marker);
    document.body.appendChild(mirror);
    const lineHeight = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.3;
    const coords = { top: marker.offsetTop - el.scrollTop, left: marker.offsetLeft - el.scrollLeft, height: lineHeight };
    mirror.remove();
    coords.left = Math.max(0, Math.min(coords.left, el.clientWidth));
    coords.top = Math.max(0, Math.min(coords.top, el.clientHeight - lineHeight));
    return coords;
}

// ------------------------------------------------------------------ key/value table

/**
 * Editable key/value table bound to `rows` (mutated in place). A blank "ghost" row is always shown at the
 * bottom; typing into it appends a real row. Options:
 *   columns:          ["enabled","key","value","description"] (+ "secret"), or custom { name, label, width, render(row, changed) }
 *   keyPlaceholder, valuePlaceholder, keySuggestions: string[], valueSuggestions(key): string[]
 *   readOnly:         render values as text
 *   onChange(rows):   called after every edit (typing, toggles, deletes)
 *   vars / dynamic:   variable providers for {{var}} highlighting + autocomplete in value cells
 *   newRow():         creates a row object (default { key, value, enabled, description [, secret] })
 *   emptyText:        text when readOnly and empty
 */
function kvTable(rows, opts = {}) {
    const columns = opts.columns || ["enabled", "key", "value", "description"];
    const hasSecret = columns.includes("secret");
    const listId = opts.keySuggestions && opts.keySuggestions.length ? uid("dl") : null;
    const table = h("table", { class: `kv-table ${opts.readOnly ? "readonly" : ""} ${opts.class || ""}` });
    const wrap = h("div", { class: "kv-wrap" }, table);
    if (listId) {
        const dl = h("datalist", { id: listId });
        for (const s of opts.keySuggestions) dl.appendChild(h("option", { value: s }));
        wrap.appendChild(dl);
    }
    const newRow = opts.newRow || (() => {
        const r = { key: "", value: "", enabled: true, description: "" };
        if (hasSecret) r.secret = false;
        return r;
    });
    let allBox = null;
    const syncAll = () => { if (allBox) allBox.checked = rows.length > 0 && rows.every((r) => r.enabled !== false); };
    const changed = () => { syncAll(); if (opts.onChange) opts.onChange(rows); };

    const labels = { enabled: "", key: opts.keyLabel || "Key", value: opts.valueLabel || "Value", description: "Description", secret: "Secret" };
    const thead = h("thead", null, h("tr", null,
        columns.map((c) => {
            const name = typeof c === "string" ? c : c.name;
            const label = typeof c === "string" ? labels[c] : c.label;
            return h("th", { class: `col-${name}`, style: typeof c === "object" && c.width ? { width: c.width } : null },
                name === "enabled" && !opts.readOnly ? toggleAllBox() : label);
        }),
        opts.readOnly ? null : h("th", { class: "col-actions" })));
    const tbody = h("tbody");
    put(table, thead, tbody);

    function toggleAllBox() {
        const box = h("input", { type: "checkbox", title: "Enable / disable all" });
        box.addEventListener("change", () => {
            for (const r of rows) r.enabled = box.checked;
            render();
            changed();
        });
        allBox = box;
        setTimeout(syncAll, 0);
        return box;
    }

    function cell(row, col, isGhost, tr) {
        const name = typeof col === "string" ? col : col.name;
        const materialize = () => {
            // the ghost row becomes a real one on first edit
            if (isGhost && !rows.includes(row)) {
                rows.push(row);
                tr.classList.remove("ghost");
                isGhost = false;
                for (const box of tr.querySelectorAll("input[type=checkbox]")) box.disabled = false;
                tbody.appendChild(rowEl(newRow(), true));
            }
        };
        if (typeof col === "object" && col.render) {
            return h("td", { class: `col-${name}` }, col.render(row, () => { materialize(); changed(); }, { readOnly: opts.readOnly, ghost: isGhost }));
        }
        if (name === "enabled") {
            if (opts.readOnly) return h("td", { class: "col-enabled" }, row.enabled === false ? icon("minus") : icon("check"));
            const box = h("input", { type: "checkbox", checked: row.enabled !== false, title: "Include this row", disabled: isGhost });
            box.addEventListener("change", () => { row.enabled = box.checked; tr.classList.toggle("disabled", !box.checked); changed(); });
            return h("td", { class: "col-enabled" }, box);
        }
        if (name === "secret") {
            if (opts.readOnly) return h("td", { class: "col-secret" }, row.secret ? icon("lock") : null);
            const btn = h("button", { class: `btn ghost icon secret-toggle ${row.secret ? "on" : ""}`, type: "button", title: "Secret: hide the value and leave it out of exports" },
                icon(row.secret ? "lock" : "unlock"));
            btn.addEventListener("click", () => {
                materialize();
                row.secret = !row.secret;
                clear(btn).appendChild(icon(row.secret ? "lock" : "unlock"));
                btn.classList.toggle("on", row.secret);
                const valInput = tr.querySelector(".col-value input");
                if (valInput) valInput.type = row.secret ? "password" : "text";
                const eye = tr.querySelector(".col-value .eye-toggle");
                if (eye) eye.classList.toggle("hidden", !row.secret);
                changed();
            });
            return h("td", { class: "col-secret" }, btn);
        }
        if (opts.readOnly) {
            const v = name === "value" && row.secret ? "•••••" : row[name];
            return h("td", { class: `col-${name}`, title: name === "value" && row.secret ? "" : v }, v);
        }
        const input = h("input", {
            type: name === "value" && row.secret ? "password" : "text",
            value: row[name] ?? "",
            placeholder: isGhost ? (name === "key" ? (opts.keyPlaceholder || "Add key") : name === "value" ? (opts.valuePlaceholder || "Value") : "Description") : "",
            spellcheck: "false",
            autocomplete: "off",
            list: name === "key" && listId ? listId : null
        });
        input.addEventListener("input", () => {
            materialize();
            row[name] = input.value;
            changed();
        });
        // Backspace in an empty key of an empty row removes it (keyboard friendly)
        input.addEventListener("keydown", (e) => {
            if (e.key === "Backspace" && name === "key" && !isGhost && !row.key && !row.value && rows.includes(row)) {
                e.preventDefault();
                const idx = rows.indexOf(row);
                rows.splice(idx, 1);
                render();
                changed();
                const keys = tbody.querySelectorAll(".col-key input");
                if (keys[Math.max(0, idx - 1)]) keys[Math.max(0, idx - 1)].focus();
            }
        });
        if (name === "value") {
            let content = input;
            if (opts.vars || opts.dynamic) content = varInput(input, { vars: opts.vars, dynamic: opts.dynamic });
            if (hasSecret) {
                const eye = h("button", { class: `btn ghost icon eye-toggle ${row.secret ? "" : "hidden"}`, type: "button", title: "Show / hide value", tabindex: "-1" }, icon("eye"));
                eye.addEventListener("click", () => {
                    const show = input.type === "password";
                    input.type = show ? "text" : "password";
                    clear(eye).appendChild(icon(show ? "eyeOff" : "eye"));
                });
                content = h("div", { class: "secret-input" }, content, eye);
            }
            return h("td", { class: "col-value" }, content);
        }
        return h("td", { class: `col-${name}` }, input);
    }

    function rowEl(row, isGhost) {
        const tr = h("tr", { class: `${isGhost ? "ghost" : ""} ${row.enabled === false ? "disabled" : ""}`.trim() });
        for (const c of columns) tr.appendChild(cell(row, c, isGhost, tr));
        if (!opts.readOnly) {
            const del = h("button", { class: "btn ghost icon row-delete", type: "button", title: "Delete row", tabindex: "-1" }, icon("trash"));
            del.addEventListener("click", () => {
                const idx = rows.indexOf(row);
                if (idx < 0) return;
                rows.splice(idx, 1);
                tr.remove();
                changed();
            });
            tr.appendChild(h("td", { class: "col-actions" }, del));
        }
        return tr;
    }

    function render() {
        clear(tbody);
        for (const r of rows) tbody.appendChild(rowEl(r, false));
        if (!opts.readOnly) tbody.appendChild(rowEl(newRow(), true));
        else if (!rows.length) tbody.appendChild(h("tr", { class: "empty-row" }, h("td", { colspan: columns.length }, opts.emptyText || "Nothing here")));
    }
    render();
    wrap.refresh = render;
    return wrap;
}
