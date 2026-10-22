"use strict";
// Bridge between the sandboxed renderer and the main process. The page only sees window.api:
//   api.call(method, ...args) -> Promise (rejects with Error(message))
//   api.on(channel, cb)       -> unsubscribe function
//   api.pathForFile(file)     -> absolute path of a File from drag & drop (or null)
const { contextBridge, ipcRenderer, webUtils } = require("electron");

const EVENTS = ["history-changed", "suite-changed", "globals-changed", "runner-event", "menu", "open-file", "echo-changed"];

async function call(method, ...args) {
    if (typeof method !== "string") throw new Error("api.call needs a method name");
    const res = await ipcRenderer.invoke("api", method, args);
    if (!res || !res.ok) throw new Error((res && res.error) || `No answer for ${method}`);
    return res.result;
}

contextBridge.exposeInMainWorld("api", {
    call,
    on(channel, cb) {
        if (!EVENTS.includes(channel)) throw new Error(`Unknown event "${channel}"`);
        if (typeof cb !== "function") throw new Error("api.on needs a callback");
        const listener = (_e, data) => cb(data);
        ipcRenderer.on(channel, listener);
        // files opened before the page listened (double-click on a suite at app start) are delivered now
        if (channel === "open-file") ipcRenderer.send("api-listening", channel);
        return () => ipcRenderer.removeListener(channel, listener);
    },
    pathForFile(file) {
        try {
            return webUtils.getPathForFile(file) || null;
        } catch (_) {
            return null;
        }
    }
});
