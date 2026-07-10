// Tessel script editor canvas.
//
// A combined authoring + diagnostics surface: a CodeMirror-backed editor for
// authoring Tessel scripts that live on disk under `tessel-scripts/` in the repo.
// It can create new files (auto-injecting `require('tessel')`), open/save existing
// ones, run them on the device (`t2 run <file>`) or deploy them to run on boot
// (`t2 push <file>`), and streams the device output into a console. It also folds
// in the device-terminal diagnostics: list Tessels, read version, provision,
// configurable discovery timeouts, a settable CLI command, and an arbitrary t2
// subcommand runner. Process plumbing is shared via runtime.mjs.

import { createServer } from "node:http";
import { promises as fs, existsSync } from "node:fs";
import path from "node:path";
import { createCanvas, CanvasError } from "@github/copilot-sdk/extension";
import {
    PROJECT_REPO_ROOT,
    LIST_DISCOVERY_TIMEOUT_SECONDS,
    VERSION_DISCOVERY_TIMEOUT_SECONDS,
    defaultCliTokens,
    escapeHtml,
    toTokens,
    json,
    parseJsonBody,
    sseWrite,
    snapshot,
    emitState,
    startCommand,
    killRunningCommand,
    sendOutputToSession,
    listCommandArgs,
    versionCommandArgs,
    listTimeoutSeconds,
    versionTimeoutSeconds,
    normalizeTimeoutSeconds,
    deviceTargetArgs,
} from "./runtime.mjs";

const instances = new Map();

const SCRIPTS_DIRNAME = "tessel-scripts";
const NEW_FILE_BOILERPLATE = "const tessel = require('tessel');\n\n";

// t2 run/push refuse to deploy a project that has no `.npmrc` (normally written
// by `t2 init`). Since our scripts live in tessel-scripts/ and no package.json
// exists up the tree, that folder becomes the deploy target, so we drop the same
// `.npmrc` there ourselves. This avoids `t2 init` (which would also scaffold a
// sample app) while still satisfying the deploy preflight.
const NPMRC_CONTENT =
    "# Created for Tessel 2 deployment (the single file `t2 init` requires to deploy).\n" +
    "# Forces npm to install dependencies with the layout Tessel expects, restoring\n" +
    "# .tesselignore/.tesselinclude control over what gets bundled onto the device.\n" +
    "global-style = true\n";

async function ensureScriptsDir(instance) {
    await fs.mkdir(instance.scriptsDir, { recursive: true });
    const npmrcPath = path.join(instance.scriptsDir, ".npmrc");
    if (!existsSync(npmrcPath)) {
        await fs.writeFile(npmrcPath, NPMRC_CONTENT, "utf8");
    }
}

function sanitizeScriptName(raw) {
    if (typeof raw !== "string") {
        throw new Error("File name is required.");
    }
    let name = raw.trim().replace(/\\/g, "/");
    if (!name) {
        throw new Error("File name is required.");
    }
    if (name.includes("/")) {
        throw new Error("File name cannot contain path separators.");
    }
    if (name === "." || name === "..") {
        throw new Error("Invalid file name.");
    }
    if (!/^[A-Za-z0-9._ -]+$/.test(name)) {
        throw new Error("File name may only contain letters, numbers, spaces, '.', '_' and '-'.");
    }
    if (!/\.js$/i.test(name)) {
        name += ".js";
    }
    return name;
}

function resolveScriptPath(instance, name) {
    const full = path.join(instance.scriptsDir, name);
    const relative = path.relative(instance.scriptsDir, full);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
        throw new Error("Resolved file path escapes the scripts directory.");
    }
    return full;
}

async function refreshFiles(instance) {
    await ensureScriptsDir(instance);
    const entries = await fs.readdir(instance.scriptsDir, { withFileTypes: true });
    instance.files = entries
        .filter((entry) => entry.isFile() && /\.js$/i.test(entry.name))
        .map((entry) => entry.name)
        .sort((a, b) => a.localeCompare(b));
}

function renderHtml(instanceId) {
    const cdn = "https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.65.16";
    return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Tessel script editor</title>
    <link rel="stylesheet" href="${cdn}/codemirror.min.css" />
    <link rel="stylesheet" href="${cdn}/theme/material-darker.min.css" />
    <style>
      :root { color-scheme: light dark; }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        background: var(--background-color-default, #fff);
        color: var(--text-color-default, #1f2328);
        font-family: var(--font-sans, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif);
        font-size: var(--text-body-medium, 14px);
        line-height: var(--leading-body-medium, 20px);
      }
      .layout {
        display: grid;
        grid-template-rows: auto minmax(0, 1fr) 220px;
        height: 100vh;
      }
      .toolbar {
        display: flex;
        gap: 8px;
        align-items: center;
        flex-wrap: wrap;
        padding: 10px 12px;
        border-bottom: 1px solid var(--border-color-default, #d1d9e0);
      }
      .toolbar .spacer { flex: 1; }
      button, select {
        border: 1px solid var(--border-color-default, #d1d9e0);
        background: var(--background-color-default, #fff);
        color: var(--text-color-default, #1f2328);
        border-radius: 6px;
        padding: 6px 10px;
        font: inherit;
        cursor: pointer;
      }
      button.primary {
        border-color: var(--true-color-blue, #0969da);
        color: var(--color-white, #fff);
        background: var(--true-color-blue, #0969da);
      }
      button:disabled { opacity: 0.5; cursor: not-allowed; }
      input {
        border: 1px solid var(--border-color-default, #d1d9e0);
        background: var(--background-color-default, #fff);
        color: var(--text-color-default, #1f2328);
        border-radius: 6px;
        padding: 6px 10px;
        font: inherit;
      }
      button.subtle {
        background: transparent;
        border-color: transparent;
        color: var(--text-color-muted, #59636e);
      }
      button.subtle:hover { border-color: var(--border-color-default, #d1d9e0); }
      button.subtle.active {
        border-color: var(--border-color-default, #d1d9e0);
        background: var(--background-color-muted, #f6f8fa);
        color: var(--text-color-default, #1f2328);
      }
      .settings {
        display: none;
        gap: 14px;
        align-items: center;
        flex-wrap: wrap;
        padding: 8px 12px;
        border-bottom: 1px solid var(--border-color-default, #d1d9e0);
        background: var(--background-color-muted, #f6f8fa);
      }
      .settings.open { display: flex; }
      .settings .field { display: inline-flex; align-items: center; gap: 6px; }
      .settings .field > span { color: var(--text-color-muted, #59636e); font-size: var(--text-body-small, 12px); }
      .settings input[type="number"] { width: 58px; }
      .settings input.cli { min-width: 320px; flex: 1; font-family: var(--font-mono, Consolas, monospace); }
      .cmd-input {
        min-width: 220px;
        flex: 1;
        font-family: var(--font-mono, Consolas, monospace);
      }
      .status { color: var(--text-color-muted, #59636e); }
      .main { display: flex; min-height: 0; }
      .sidebar {
        width: 200px;
        border-right: 1px solid var(--border-color-default, #d1d9e0);
        overflow: auto;
        padding: 8px;
      }
      .sidebar h2 {
        font-size: var(--text-body-small, 12px);
        text-transform: uppercase;
        letter-spacing: 0.04em;
        color: var(--text-color-muted, #59636e);
        margin: 4px 6px 8px;
      }
      .file-item {
        padding: 6px 8px;
        border-radius: 6px;
        cursor: pointer;
        font-family: var(--font-mono, Consolas, monospace);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .file-item:hover { background: var(--background-color-muted, #f6f8fa); }
      .file-item.active {
        background: var(--true-color-blue-muted, #ddf4ff);
        color: var(--text-color-default, #1f2328);
        font-weight: var(--font-weight-semibold, 600);
      }
      .muted { color: var(--text-color-muted, #59636e); padding: 6px 8px; }
      .editor-wrap { flex: 1; min-width: 0; position: relative; }
      .CodeMirror { height: 100%; font-family: var(--font-mono, Consolas, monospace); font-size: 13px; }
      #code { width: 100%; height: 100%; border: 0; padding: 10px; resize: none;
        font-family: var(--font-mono, Consolas, monospace); display: none;
        background: var(--background-color-default, #fff); color: var(--text-color-default, #1f2328); }
      .console {
        border-top: 1px solid var(--border-color-default, #d1d9e0);
        display: grid;
        grid-template-rows: auto minmax(0, 1fr);
        min-height: 0;
      }
      .console-head {
        display: flex;
        gap: 8px;
        align-items: center;
        padding: 6px 12px;
        border-bottom: 1px solid var(--border-color-default, #d1d9e0);
      }
      .console-head strong { font-size: var(--text-body-small, 12px); }
      .console-body {
        overflow: auto;
        padding: 10px 12px;
        font-family: var(--font-mono, Consolas, monospace);
        white-space: pre-wrap;
        word-break: break-word;
      }
      .entry { border-top: 1px solid var(--border-color-default, #d1d9e0); margin-top: 10px; padding-top: 10px; }
      .entry:first-child { border-top: 0; margin-top: 0; padding-top: 0; }
      .entry .cmd { font-weight: var(--font-weight-semibold, 600); }
      .entry .meta { color: var(--text-color-muted, #59636e); font-size: var(--text-body-small, 12px); }
      .entry pre { white-space: pre-wrap; margin: 6px 0 0; }
    </style>
  </head>
  <body>
    <div class="layout">
      <div class="header">
        <div class="toolbar">
          <button id="newBtn">New file</button>
          <button id="saveBtn">Save</button>
          <button id="runBtn" class="primary">Run on device</button>
          <button id="pushBtn">Push to device</button>
          <button id="stopBtn">Stop</button>
          <span class="spacer"></span>
          <button id="listDevicesBtn">List Tessels</button>
          <button id="versionBtn" title="Read firmware/CLI version from the selected Tessel">Version</button>
          <button id="provisionBtn" title="Authorize this computer to control the USB-connected Tessel">Provision</button>
          <select id="deviceSelect" title="Target device"></select>
          <button id="settingsBtn" class="subtle" title="Diagnostics &amp; settings">&#9881; Settings</button>
          <span id="status" class="status">Ready</span>
        </div>
        <div id="settings" class="settings">
          <label class="field">
            <span>List timeout (s)</span>
            <input id="listTimeout" type="number" min="0.1" step="0.1" />
          </label>
          <label class="field">
            <span>Version timeout (s)</span>
            <input id="versionTimeout" type="number" min="0.1" step="0.1" />
          </label>
          <button id="saveTimeoutsBtn">Apply timeouts</button>
          <span class="spacer" style="flex:1"></span>
          <label class="field">
            <span>CLI</span>
            <input id="cliCommand" class="cli" placeholder="node repos\\t2-cli\\bin\\tessel-2.js" />
          </label>
          <button id="saveCliBtn">Set CLI</button>
        </div>
      </div>
      <div class="main">
        <div class="sidebar">
          <h2>Scripts</h2>
          <div id="fileList"><div class="muted">No files yet</div></div>
        </div>
        <div class="editor-wrap">
          <textarea id="code" spellcheck="false"></textarea>
        </div>
      </div>
      <div class="console">
        <div class="console-head">
          <strong>Device output</strong>
          <input id="customCmd" class="cmd-input" placeholder="t2 subcommand, e.g. list --lan" />
          <button id="runCustomBtn">Run</button>
          <span class="spacer" style="flex:1"></span>
          <button id="sendBtn">Send output to chat</button>
          <button id="clearBtn">Clear view</button>
        </div>
        <div id="console" class="console-body">No commands run yet.</div>
      </div>
    </div>
    <script src="${cdn}/codemirror.min.js"></script>
    <script src="${cdn}/mode/javascript/javascript.min.js"></script>
    <script src="${cdn}/addon/edit/closebrackets.min.js"></script>
    <script src="${cdn}/addon/edit/matchbrackets.min.js"></script>
    <script>
      const instanceId = ${JSON.stringify(instanceId)};
      const statusEl = document.getElementById("status");
      const fileList = document.getElementById("fileList");
      const consoleEl = document.getElementById("console");
      const deviceSelect = document.getElementById("deviceSelect");
      const textarea = document.getElementById("code");
      const newBtn = document.getElementById("newBtn");
      const saveBtn = document.getElementById("saveBtn");
      const runBtn = document.getElementById("runBtn");
      const pushBtn = document.getElementById("pushBtn");
      const stopBtn = document.getElementById("stopBtn");
      const listDevicesBtn = document.getElementById("listDevicesBtn");
      const versionBtn = document.getElementById("versionBtn");
      const provisionBtn = document.getElementById("provisionBtn");
      const settingsBtn = document.getElementById("settingsBtn");
      const settingsPanel = document.getElementById("settings");
      const listTimeout = document.getElementById("listTimeout");
      const versionTimeout = document.getElementById("versionTimeout");
      const saveTimeoutsBtn = document.getElementById("saveTimeoutsBtn");
      const cliCommand = document.getElementById("cliCommand");
      const saveCliBtn = document.getElementById("saveCliBtn");
      const customCmd = document.getElementById("customCmd");
      const runCustomBtn = document.getElementById("runCustomBtn");
      const sendBtn = document.getElementById("sendBtn");
      const clearBtn = document.getElementById("clearBtn");

      let timeoutsDirty = false;
      let cliDirty = false;

      let latestState = null;
      let currentFile = null;
      let dirty = false;
      let suppressChange = false;
      let cm = null;
      let hideOutput = false;

      function escHtml(value) {
        return String(value).replace(/[&<>]/g, function (m) {
          return { "&": "&amp;", "<": "&lt;", ">": "&gt;" }[m];
        });
      }
      function escAttr(value) {
        return String(value)
          .replace(/&/g, "&amp;")
          .replace(/"/g, "&quot;")
          .replace(/</g, "&lt;");
      }

      function isDark() {
        const attr =
          document.documentElement.getAttribute("data-color-mode") ||
          document.body.getAttribute("data-color-mode");
        if (attr === "dark") return true;
        if (attr === "light") return false;
        return !!(window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches);
      }

      if (window.CodeMirror) {
        cm = window.CodeMirror.fromTextArea(textarea, {
          mode: "javascript",
          lineNumbers: true,
          theme: isDark() ? "material-darker" : "default",
          autoCloseBrackets: true,
          matchBrackets: true,
          tabSize: 2,
          indentUnit: 2,
          lineWrapping: false,
        });
        cm.on("change", function () {
          if (!suppressChange) {
            dirty = true;
            updateStatus();
          }
        });
      } else {
        textarea.style.display = "block";
      }

      function getCode() {
        return cm ? cm.getValue() : textarea.value;
      }
      function setCode(value) {
        suppressChange = true;
        if (cm) {
          cm.setValue(value);
        } else {
          textarea.value = value;
        }
        suppressChange = false;
        dirty = false;
        updateStatus();
      }

      function updateStatus(text) {
        if (text != null) {
          statusEl.textContent = text;
          return;
        }
        if (latestState && latestState.running) {
          statusEl.textContent = "Running: " + latestState.running.command;
          return;
        }
        if (!currentFile) {
          statusEl.textContent = "No file open";
          return;
        }
        statusEl.textContent = currentFile + (dirty ? " \u2022 unsaved" : " \u2022 saved");
      }

      async function post(path, payload) {
        const response = await fetch(path, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload || {}),
        });
        if (!response.ok) {
          const err = await response.text();
          throw new Error(err || "Request failed");
        }
        return response.json();
      }

      function renderFiles() {
        const files = (latestState && latestState.files) || [];
        if (!files.length) {
          fileList.innerHTML = '<div class="muted">No files yet</div>';
          return;
        }
        fileList.innerHTML = files
          .map(function (name) {
            const active = name === currentFile ? " active" : "";
            return (
              '<div class="file-item' + active + '" data-file="' + escAttr(name) + '">' +
              escHtml(name) +
              "</div>"
            );
          })
          .join("");
      }

      function renderDevices() {
        const state = latestState || {};
        deviceSelect.innerHTML = "";
        const blank = document.createElement("option");
        blank.value = "";
        blank.textContent = "USB (default)";
        deviceSelect.appendChild(blank);
        for (const device of state.devices || []) {
          const option = document.createElement("option");
          option.value = device.id;
          option.textContent = device.transport + "  " + device.name;
          deviceSelect.appendChild(option);
        }
        deviceSelect.value = state.selectedDeviceId || "";
      }

      function renderConsole() {
        const state = latestState || {};
        const history = state.history || [];
        if (hideOutput || !history.length) {
          consoleEl.textContent = hideOutput ? "Cleared. New output will appear here." : "No commands run yet.";
          return;
        }
        consoleEl.innerHTML = history
          .map(function (entry) {
            return (
              '<div class="entry">' +
              '<div class="cmd">' + escHtml(entry.command) + "</div>" +
              '<div class="meta">status=' + entry.status + ", exit=" + (entry.exitCode == null ? "n/a" : entry.exitCode) +
              ' &middot; <button data-send="' + escAttr(entry.id) + '">Send to chat</button></div>' +
              "<pre>" + escHtml(entry.output || "") + "</pre>" +
              "</div>"
            );
          })
          .join("");
        consoleEl.scrollTop = consoleEl.scrollHeight;
      }

      function renderSettings() {
        const state = latestState || {};
        const timeouts = state.timeouts || {};
        if (!timeoutsDirty && document.activeElement !== listTimeout && document.activeElement !== versionTimeout) {
          if (timeouts.list != null) listTimeout.value = timeouts.list;
          if (timeouts.version != null) versionTimeout.value = timeouts.version;
        }
        if (!cliDirty && document.activeElement !== cliCommand) {
          cliCommand.value = state.cliCommand || "";
        }
      }

      function renderState(state) {
        latestState = state;
        renderFiles();
        renderDevices();
        renderSettings();
        renderConsole();
        updateStatus();
      }

      async function openFile(name) {
        if (dirty && currentFile && !confirm("Discard unsaved changes to " + currentFile + "?")) {
          return;
        }
        const res = await post("/api/file/open", { name: name });
        currentFile = res.name;
        setCode(res.content);
        hideOutput = false;
        renderFiles();
      }

      async function newFile() {
        const name = window.prompt("New script file name", "app.js");
        if (!name) return;
        try {
          const res = await post("/api/file/new", { name: name });
          currentFile = res.name;
          setCode(res.content);
          hideOutput = false;
          renderFiles();
          updateStatus("Created " + res.name);
        } catch (error) {
          updateStatus(error.message);
        }
      }

      async function save() {
        if (!currentFile) {
          updateStatus("No file open. Click New file first.");
          return false;
        }
        await post("/api/file/save", { name: currentFile, content: getCode() });
        dirty = false;
        renderFiles();
        updateStatus("Saved " + currentFile);
        return true;
      }

      async function runOrPush(endpoint, label) {
        if (!currentFile) {
          updateStatus("No file open. Click New file first.");
          return;
        }
        try {
          await post("/api/file/save", { name: currentFile, content: getCode() });
          dirty = false;
          hideOutput = false;
          await post(endpoint, { name: currentFile });
          updateStatus(label + " " + currentFile + "...");
        } catch (error) {
          updateStatus(error.message);
        }
      }

      newBtn.addEventListener("click", newFile);
      saveBtn.addEventListener("click", function () {
        save().catch(function (error) { updateStatus(error.message); });
      });
      runBtn.addEventListener("click", function () { runOrPush("/api/run", "Running"); });
      pushBtn.addEventListener("click", function () { runOrPush("/api/push", "Pushing"); });
      stopBtn.addEventListener("click", function () {
        post("/api/kill").catch(function (error) { updateStatus(error.message); });
      });
      listDevicesBtn.addEventListener("click", function () {
        post("/api/list-devices").catch(function (error) { updateStatus(error.message); });
      });
      versionBtn.addEventListener("click", function () {
        hideOutput = false;
        post("/api/get-version")
          .then(function () { updateStatus("Reading version..."); })
          .catch(function (error) { updateStatus(error.message); });
      });
      provisionBtn.addEventListener("click", function () {
        hideOutput = false;
        post("/api/provision")
          .then(function () { updateStatus("Provisioning..."); })
          .catch(function (error) { updateStatus(error.message); });
      });
      settingsBtn.addEventListener("click", function () {
        const open = settingsPanel.classList.toggle("open");
        settingsBtn.classList.toggle("active", open);
      });
      function markTimeoutsDirty() { timeoutsDirty = true; }
      listTimeout.addEventListener("input", markTimeoutsDirty);
      versionTimeout.addEventListener("input", markTimeoutsDirty);
      cliCommand.addEventListener("input", function () { cliDirty = true; });
      saveTimeoutsBtn.addEventListener("click", function () {
        post("/api/set-timeouts", { list: listTimeout.value, version: versionTimeout.value })
          .then(function (res) {
            timeoutsDirty = false;
            if (res && res.timeouts) {
              listTimeout.value = res.timeouts.list;
              versionTimeout.value = res.timeouts.version;
            }
            updateStatus("Timeouts updated.");
          })
          .catch(function (error) { updateStatus(error.message); });
      });
      saveCliBtn.addEventListener("click", function () {
        const value = cliCommand.value.trim();
        if (!value) { updateStatus("Enter a CLI command first."); return; }
        post("/api/set-cli", { command: value })
          .then(function () { cliDirty = false; updateStatus("CLI command updated."); })
          .catch(function (error) { updateStatus(error.message); });
      });
      function runCustom() {
        const value = customCmd.value.trim();
        if (!value) { updateStatus("Enter a t2 subcommand first."); return; }
        hideOutput = false;
        post("/api/run-custom", { subcommand: value })
          .then(function () { customCmd.value = ""; updateStatus("Running " + value + "..."); })
          .catch(function (error) { updateStatus(error.message); });
      }
      runCustomBtn.addEventListener("click", runCustom);
      customCmd.addEventListener("keydown", function (event) {
        if (event.key === "Enter") { event.preventDefault(); runCustom(); }
      });
      deviceSelect.addEventListener("change", function () {
        post("/api/select-device", { id: deviceSelect.value || null }).catch(function (error) {
          updateStatus(error.message);
        });
      });
      clearBtn.addEventListener("click", function () {
        hideOutput = true;
        renderConsole();
      });
      sendBtn.addEventListener("click", function () {
        post("/api/send-output", {})
          .then(function () { updateStatus("Output sent to chat."); })
          .catch(function (error) { updateStatus(error.message); });
      });
      fileList.addEventListener("click", function (event) {
        const name = event.target && event.target.dataset ? event.target.dataset.file : null;
        if (!name) return;
        openFile(name).catch(function (error) { updateStatus(error.message); });
      });
      consoleEl.addEventListener("click", function (event) {
        const id = event.target && event.target.dataset ? event.target.dataset.send : null;
        if (!id) return;
        post("/api/send-output", { commandId: id })
          .then(function () { updateStatus("Output sent to chat."); })
          .catch(function (error) { updateStatus(error.message); });
      });

      const events = new EventSource("/events");
      events.addEventListener("state", function (event) {
        renderState(JSON.parse(event.data));
      });
      events.addEventListener("output", function (event) {
        const payload = JSON.parse(event.data);
        if (!latestState) return;
        const history = latestState.history || [];
        const target = history.find(function (entry) { return entry.id === payload.entryId; });
        if (target) {
          target.output = payload.output || "";
          hideOutput = false;
        }
        renderConsole();
        updateStatus();
      });
      events.onerror = function () {
        updateStatus("Waiting for updates...");
      };

      (async function init() {
        try {
          const response = await fetch("/api/state");
          const state = await response.json();
          renderState(state);
          const files = state.files || [];
          const toOpen = state.currentFile || files[0];
          if (toOpen) {
            await openFile(toOpen);
          } else {
            updateStatus('No scripts yet. Click "New file" to create one.');
          }
        } catch (error) {
          updateStatus(error.message);
        }
      })();
    </script>
  </body>
</html>`;
}

async function createInstance(instanceId, workspacePath) {
    const instance = {
        instanceId,
        workspacePath,
        cliTokens: defaultCliTokens(workspacePath),
        selectedDeviceId: null,
        devices: [],
        history: [],
        running: null,
        submodulesReady: false,
        submoduleInitPromise: null,
        nodeDepsReady: false,
        nodeDepsPromise: null,
        commandCounter: 0,
        sseClients: new Set(),
        server: null,
        url: "",
        scriptsDir: path.join(workspacePath || PROJECT_REPO_ROOT, SCRIPTS_DIRNAME),
        files: [],
        currentFile: null,
        timeouts: {
            list: LIST_DISCOVERY_TIMEOUT_SECONDS,
            version: VERSION_DISCOVERY_TIMEOUT_SECONDS,
        },
    };

    try {
        await refreshFiles(instance);
    } catch {
        instance.files = [];
    }

    const server = createServer(async (req, res) => {
        const requestUrl = new URL(req.url ?? "/", "http://127.0.0.1");
        const pathname = requestUrl.pathname;

        if (req.method === "GET" && pathname === "/") {
            res.statusCode = 200;
            res.setHeader("Content-Type", "text/html; charset=utf-8");
            res.end(renderHtml(instanceId));
            return;
        }

        if (req.method === "GET" && pathname === "/api/state") {
            json(res, 200, snapshot(instance));
            return;
        }

        if (req.method === "GET" && pathname === "/events") {
            res.writeHead(200, {
                "Content-Type": "text/event-stream",
                "Cache-Control": "no-cache",
                Connection: "keep-alive",
            });
            instance.sseClients.add(res);
            sseWrite(res, "state", snapshot(instance));
            req.on("close", () => {
                instance.sseClients.delete(res);
            });
            return;
        }

        if (req.method === "POST" && pathname === "/api/file/new") {
            try {
                const body = await parseJsonBody(req);
                const name = sanitizeScriptName(body.name);
                const full = resolveScriptPath(instance, name);
                if (existsSync(full)) {
                    json(res, 400, { error: `File already exists: ${name}` });
                    return;
                }
                await fs.mkdir(instance.scriptsDir, { recursive: true });
                await fs.writeFile(full, NEW_FILE_BOILERPLATE, "utf8");
                await refreshFiles(instance);
                instance.currentFile = name;
                emitState(instance);
                json(res, 200, { name, content: NEW_FILE_BOILERPLATE });
            } catch (error) {
                json(res, 400, { error: error.message });
            }
            return;
        }

        if (req.method === "POST" && pathname === "/api/file/open") {
            try {
                const body = await parseJsonBody(req);
                const name = sanitizeScriptName(body.name);
                const full = resolveScriptPath(instance, name);
                if (!existsSync(full)) {
                    json(res, 404, { error: `File not found: ${name}` });
                    return;
                }
                const content = await fs.readFile(full, "utf8");
                instance.currentFile = name;
                emitState(instance);
                json(res, 200, { name, content });
            } catch (error) {
                json(res, 400, { error: error.message });
            }
            return;
        }

        if (req.method === "POST" && pathname === "/api/file/save") {
            try {
                const body = await parseJsonBody(req);
                const name = sanitizeScriptName(body.name);
                const content = typeof body.content === "string" ? body.content : "";
                const full = resolveScriptPath(instance, name);
                await fs.mkdir(instance.scriptsDir, { recursive: true });
                await fs.writeFile(full, content, "utf8");
                await refreshFiles(instance);
                instance.currentFile = name;
                emitState(instance);
                json(res, 200, { saved: true, name });
            } catch (error) {
                json(res, 400, { error: error.message });
            }
            return;
        }

        if (req.method === "POST" && pathname === "/api/file/delete") {
            try {
                const body = await parseJsonBody(req);
                const name = sanitizeScriptName(body.name);
                const full = resolveScriptPath(instance, name);
                if (existsSync(full)) {
                    await fs.unlink(full);
                }
                await refreshFiles(instance);
                if (instance.currentFile === name) {
                    instance.currentFile = null;
                }
                emitState(instance);
                json(res, 200, { deleted: true, name });
            } catch (error) {
                json(res, 400, { error: error.message });
            }
            return;
        }

        if (req.method === "POST" && (pathname === "/api/run" || pathname === "/api/push")) {
            try {
                const body = await parseJsonBody(req);
                const name = sanitizeScriptName(body.name);
                const full = resolveScriptPath(instance, name);
                if (!existsSync(full)) {
                    json(res, 404, { error: `File not found: ${name}` });
                    return;
                }
                const verb = pathname === "/api/run" ? "run" : "push";
                await ensureScriptsDir(instance);
                const relPath = path.join(SCRIPTS_DIRNAME, name);
                const args = [verb, relPath, ...deviceTargetArgs(instance)];
                const started = await startCommand(instance, args, { kind: verb });
                json(res, 200, started);
            } catch (error) {
                json(res, 400, { error: error.message });
            }
            return;
        }

        if (req.method === "POST" && pathname === "/api/list-devices") {
            try {
                const started = await startCommand(instance, listCommandArgs(instance), {
                    kind: "list-devices",
                    timeoutSeconds: listTimeoutSeconds(instance),
                });
                json(res, 200, started);
            } catch (error) {
                json(res, 400, { error: error.message });
            }
            return;
        }

        if (req.method === "POST" && pathname === "/api/get-version") {
            try {
                const started = await startCommand(instance, versionCommandArgs(instance), {
                    kind: "get-version",
                    timeoutSeconds: versionTimeoutSeconds(instance),
                });
                json(res, 200, started);
            } catch (error) {
                json(res, 400, { error: error.message });
            }
            return;
        }

        if (req.method === "POST" && pathname === "/api/run-custom") {
            try {
                const body = await parseJsonBody(req);
                const tokens = toTokens(body.subcommand);
                if (!tokens.length) {
                    json(res, 400, { error: "subcommand is required." });
                    return;
                }
                const started = await startCommand(instance, tokens, { kind: "custom" });
                json(res, 200, started);
            } catch (error) {
                json(res, 400, { error: error.message });
            }
            return;
        }

        if (req.method === "POST" && pathname === "/api/set-cli") {
            try {
                const body = await parseJsonBody(req);
                const tokens = toTokens(body.command);
                if (!tokens.length) {
                    json(res, 400, { error: "command is required." });
                    return;
                }
                if (instance.running) {
                    json(res, 400, { error: "Cannot change CLI command while a command is running." });
                    return;
                }
                if (instance.submoduleInitPromise || instance.nodeDepsPromise) {
                    json(res, 400, { error: "Cannot change CLI command while setup checks are running." });
                    return;
                }
                instance.cliTokens = tokens;
                instance.submodulesReady = false;
                instance.nodeDepsReady = false;
                instance.submoduleInitPromise = null;
                instance.nodeDepsPromise = null;
                emitState(instance);
                json(res, 200, { cliCommand: instance.cliTokens.join(" ") });
            } catch (error) {
                json(res, 400, { error: error.message });
            }
            return;
        }

        if (req.method === "POST" && pathname === "/api/set-timeouts") {
            try {
                const body = await parseJsonBody(req);
                const next = { ...instance.timeouts };
                if (body.list != null) {
                    next.list = normalizeTimeoutSeconds(body.list);
                }
                if (body.version != null) {
                    next.version = normalizeTimeoutSeconds(body.version);
                }
                instance.timeouts = next;
                emitState(instance);
                json(res, 200, { timeouts: instance.timeouts });
            } catch (error) {
                json(res, 400, { error: error.message });
            }
            return;
        }

        if (req.method === "POST" && pathname === "/api/provision") {
            try {
                const started = await startCommand(instance, ["provision"], { kind: "provision" });
                json(res, 200, started);
            } catch (error) {
                json(res, 400, { error: error.message });
            }
            return;
        }

        if (req.method === "POST" && pathname === "/api/select-device") {
            try {
                const body = await parseJsonBody(req);
                const selected = body.id;
                if (selected == null) {
                    instance.selectedDeviceId = null;
                } else {
                    const exists = instance.devices.some((device) => device.id === selected);
                    if (!exists) {
                        json(res, 404, { error: `Unknown device id: ${escapeHtml(selected)}` });
                        return;
                    }
                    instance.selectedDeviceId = selected;
                }
                emitState(instance);
                json(res, 200, { selectedDeviceId: instance.selectedDeviceId });
            } catch (error) {
                json(res, 400, { error: error.message });
            }
            return;
        }

        if (req.method === "POST" && pathname === "/api/kill") {
            try {
                const result = await killRunningCommand(instance);
                json(res, 200, result);
            } catch (error) {
                json(res, 400, { error: error.message });
            }
            return;
        }

        if (req.method === "POST" && pathname === "/api/send-output") {
            try {
                const body = await parseJsonBody(req);
                const result = await sendOutputToSession(instance, body.commandId);
                json(res, 200, result);
            } catch (error) {
                json(res, 400, { error: error.message });
            }
            return;
        }

        json(res, 404, { error: "Not found" });
    });

    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    instance.server = server;
    instance.url = `http://127.0.0.1:${port}/`;
    return instance;
}

function requireInstance(ctx) {
    const instance = instances.get(ctx.instanceId);
    if (!instance) {
        throw new CanvasError("canvas_instance_not_found", "Canvas instance not found.");
    }
    return instance;
}

export function createEditorCanvas() {
    return createCanvas({
        id: "tessel-script-editor",
        displayName: "Tessel script editor",
        description:
            "Author Tessel scripts with syntax highlighting and run or push them to the device with streaming output, plus device diagnostics: list Tessels, read version, provision, and run arbitrary t2 commands.",
        actions: [
            {
                name: "get_state",
                description: "Return editor state: files, current file, devices, and command history.",
                handler: async (ctx) => snapshot(requireInstance(ctx)),
            },
            {
                name: "list_files",
                description: "List the script files under tessel-scripts/.",
                handler: async (ctx) => {
                    const instance = requireInstance(ctx);
                    await refreshFiles(instance);
                    emitState(instance);
                    return { files: instance.files };
                },
            },
            {
                name: "new_file",
                description: "Create a new script file preloaded with `require('tessel')`.",
                inputSchema: {
                    type: "object",
                    properties: { name: { type: "string" } },
                    required: ["name"],
                    additionalProperties: false,
                },
                handler: async (ctx) => {
                    const instance = requireInstance(ctx);
                    const name = sanitizeScriptName(ctx.input.name);
                    const full = resolveScriptPath(instance, name);
                    if (existsSync(full)) {
                        throw new CanvasError("file_exists", `File already exists: ${name}`);
                    }
                    await fs.mkdir(instance.scriptsDir, { recursive: true });
                    await fs.writeFile(full, NEW_FILE_BOILERPLATE, "utf8");
                    await refreshFiles(instance);
                    instance.currentFile = name;
                    emitState(instance);
                    return { name, content: NEW_FILE_BOILERPLATE };
                },
            },
            {
                name: "open_file",
                description: "Open a script file and return its contents.",
                inputSchema: {
                    type: "object",
                    properties: { name: { type: "string" } },
                    required: ["name"],
                    additionalProperties: false,
                },
                handler: async (ctx) => {
                    const instance = requireInstance(ctx);
                    const name = sanitizeScriptName(ctx.input.name);
                    const full = resolveScriptPath(instance, name);
                    if (!existsSync(full)) {
                        throw new CanvasError("file_not_found", `File not found: ${name}`);
                    }
                    const content = await fs.readFile(full, "utf8");
                    instance.currentFile = name;
                    emitState(instance);
                    return { name, content };
                },
            },
            {
                name: "save_file",
                description: "Write contents to a script file (creating it if needed).",
                inputSchema: {
                    type: "object",
                    properties: {
                        name: { type: "string" },
                        content: { type: "string" },
                    },
                    required: ["name", "content"],
                    additionalProperties: false,
                },
                handler: async (ctx) => {
                    const instance = requireInstance(ctx);
                    const name = sanitizeScriptName(ctx.input.name);
                    const full = resolveScriptPath(instance, name);
                    await fs.mkdir(instance.scriptsDir, { recursive: true });
                    await fs.writeFile(full, ctx.input.content, "utf8");
                    await refreshFiles(instance);
                    instance.currentFile = name;
                    emitState(instance);
                    return { saved: true, name };
                },
            },
            {
                name: "run_file",
                description: "Run a script on the device (`t2 run <file>`), streaming output.",
                inputSchema: {
                    type: "object",
                    properties: { name: { type: "string" } },
                    required: ["name"],
                    additionalProperties: false,
                },
                handler: async (ctx) => {
                    const instance = requireInstance(ctx);
                    const name = sanitizeScriptName(ctx.input.name);
                    const full = resolveScriptPath(instance, name);
                    if (!existsSync(full)) {
                        throw new CanvasError("file_not_found", `File not found: ${name}`);
                    }
                    await ensureScriptsDir(instance);
                    const args = ["run", path.join(SCRIPTS_DIRNAME, name), ...deviceTargetArgs(instance)];
                    return await startCommand(instance, args, { kind: "run" });
                },
            },
            {
                name: "push_file",
                description: "Push a script to run on boot (`t2 push <file>`), streaming output.",
                inputSchema: {
                    type: "object",
                    properties: { name: { type: "string" } },
                    required: ["name"],
                    additionalProperties: false,
                },
                handler: async (ctx) => {
                    const instance = requireInstance(ctx);
                    const name = sanitizeScriptName(ctx.input.name);
                    const full = resolveScriptPath(instance, name);
                    if (!existsSync(full)) {
                        throw new CanvasError("file_not_found", `File not found: ${name}`);
                    }
                    await ensureScriptsDir(instance);
                    const args = ["push", path.join(SCRIPTS_DIRNAME, name), ...deviceTargetArgs(instance)];
                    return await startCommand(instance, args, { kind: "push" });
                },
            },
            {
                name: "list_devices",
                description: "Run `t2 list --usb` and refresh available Tessel devices.",
                handler: async (ctx) => {
                    const instance = requireInstance(ctx);
                    return await startCommand(instance, listCommandArgs(instance), {
                        kind: "list-devices",
                        timeoutSeconds: listTimeoutSeconds(instance),
                    });
                },
            },
            {
                name: "get_version",
                description: "Run the version command against the selected Tessel (or USB default), streaming output.",
                handler: async (ctx) => {
                    const instance = requireInstance(ctx);
                    return await startCommand(instance, versionCommandArgs(instance), {
                        kind: "get-version",
                        timeoutSeconds: versionTimeoutSeconds(instance),
                    });
                },
            },
            {
                name: "run_command",
                description: "Run any t2 subcommand text for diagnostics, e.g. `list --lan` or `wifi`.",
                inputSchema: {
                    type: "object",
                    properties: { subcommand: { type: "string" } },
                    required: ["subcommand"],
                    additionalProperties: false,
                },
                handler: async (ctx) => {
                    const instance = requireInstance(ctx);
                    const tokens = toTokens(ctx.input.subcommand);
                    if (!tokens.length) {
                        throw new CanvasError("invalid_input", "subcommand cannot be empty.");
                    }
                    return await startCommand(instance, tokens, { kind: "custom" });
                },
            },
            {
                name: "set_cli_command",
                description: "Set the base CLI command, e.g. `t2` or `node repos/t2-cli/bin/tessel-2.js`.",
                inputSchema: {
                    type: "object",
                    properties: { command: { type: "string" } },
                    required: ["command"],
                    additionalProperties: false,
                },
                handler: async (ctx) => {
                    const instance = requireInstance(ctx);
                    if (instance.running) {
                        throw new CanvasError(
                            "command_running",
                            "Cannot change CLI command while a command is running.",
                        );
                    }
                    if (instance.submoduleInitPromise || instance.nodeDepsPromise) {
                        throw new CanvasError(
                            "setup_in_progress",
                            "Cannot change CLI command while setup checks are running.",
                        );
                    }
                    const tokens = toTokens(ctx.input.command);
                    if (!tokens.length) {
                        throw new CanvasError("invalid_input", "command cannot be empty.");
                    }
                    instance.cliTokens = tokens;
                    instance.submodulesReady = false;
                    instance.nodeDepsReady = false;
                    instance.submoduleInitPromise = null;
                    instance.nodeDepsPromise = null;
                    emitState(instance);
                    return { cliCommand: instance.cliTokens.join(" ") };
                },
            },
            {
                name: "set_timeouts",
                description: "Configure discovery timeouts (seconds) for the list and version scans.",
                inputSchema: {
                    type: "object",
                    properties: {
                        list: { type: "number" },
                        version: { type: "number" },
                    },
                    additionalProperties: false,
                },
                handler: async (ctx) => {
                    const instance = requireInstance(ctx);
                    const next = { ...instance.timeouts };
                    if (ctx.input.list != null) {
                        next.list = normalizeTimeoutSeconds(ctx.input.list);
                    }
                    if (ctx.input.version != null) {
                        next.version = normalizeTimeoutSeconds(ctx.input.version);
                    }
                    instance.timeouts = next;
                    emitState(instance);
                    return { timeouts: instance.timeouts };
                },
            },
            {
                name: "provision_device",
                description: "Authorize this computer to control the USB-connected Tessel (`t2 provision`).",
                handler: async (ctx) => {
                    const instance = requireInstance(ctx);
                    return await startCommand(instance, ["provision"], { kind: "provision" });
                },
            },
            {
                name: "select_device",
                description: "Select a discovered device by id to target run/push.",
                inputSchema: {
                    type: "object",
                    properties: { id: { type: "string" } },
                    required: ["id"],
                    additionalProperties: false,
                },
                handler: async (ctx) => {
                    const instance = requireInstance(ctx);
                    const exists = instance.devices.some((device) => device.id === ctx.input.id);
                    if (!exists) {
                        throw new CanvasError("device_not_found", `Device not found: ${ctx.input.id}`);
                    }
                    instance.selectedDeviceId = ctx.input.id;
                    emitState(instance);
                    return { selectedDeviceId: instance.selectedDeviceId };
                },
            },
            {
                name: "kill_command",
                description: "Kill the currently running command for this canvas instance.",
                handler: async (ctx) => killRunningCommand(requireInstance(ctx)),
            },
            {
                name: "send_output_to_chat",
                description: "Send command output from this canvas to the current chat session.",
                inputSchema: {
                    type: "object",
                    properties: { commandId: { type: "string" } },
                    required: [],
                    additionalProperties: false,
                },
                handler: async (ctx) => sendOutputToSession(requireInstance(ctx), ctx.input?.commandId),
            },
        ],
        open: async (ctx) => {
            let instance = instances.get(ctx.instanceId);
            if (!instance) {
                const runtimeWorkspacePath =
                    typeof ctx.host?.workspacePath === "string" && ctx.host.workspacePath
                        ? ctx.host.workspacePath
                        : PROJECT_REPO_ROOT;
                instance = await createInstance(ctx.instanceId, runtimeWorkspacePath);
                instances.set(ctx.instanceId, instance);
            }
            return {
                title: "Tessel script editor",
                status: instance.running
                    ? `Running ${instance.running.command}`
                    : instance.currentFile
                      ? `Editing ${instance.currentFile}`
                      : "Ready",
                url: instance.url,
            };
        },
        onClose: async (ctx) => {
            const instance = instances.get(ctx.instanceId);
            if (!instance) {
                return;
            }
            await killRunningCommand(instance);
            for (const client of instance.sseClients) {
                if (!client.writableEnded) {
                    client.end();
                }
            }
            instance.sseClients.clear();
            instances.delete(ctx.instanceId);
            await new Promise((resolve) => instance.server.close(() => resolve()));
        },
    });
}
