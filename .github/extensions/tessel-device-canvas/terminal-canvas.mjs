// Tessel device terminal canvas.
//
// Lists connected Tessels, lets the user select one, runs arbitrary t2 commands,
// streams output, and kills hung commands. All of the process/streaming logic
// lives in runtime.mjs; this module owns the terminal UI and its HTTP routes.

import { createServer } from "node:http";
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
} from "./runtime.mjs";

const instances = new Map();

function renderHtml(instanceId) {
    return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Tessel device terminal</title>
    <style>
      :root {
        color-scheme: light dark;
      }
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
        grid-template-rows: auto auto 1fr;
        gap: 10px;
        padding: 12px;
        height: 100vh;
        box-sizing: border-box;
      }
      .row {
        display: flex;
        gap: 8px;
        flex-wrap: wrap;
        align-items: center;
      }
      button, input, select {
        border: 1px solid var(--border-color-default, #d1d9e0);
        background: var(--background-color-default, #fff);
        color: var(--text-color-default, #1f2328);
        border-radius: 6px;
        padding: 6px 10px;
        font: inherit;
      }
      button { cursor: pointer; }
      .status {
        color: var(--text-color-muted, #59636e);
      }
      .terminal {
        border: 1px solid var(--border-color-default, #d1d9e0);
        border-radius: 8px;
        padding: 10px;
        overflow: auto;
        font-family: var(--font-mono, Consolas, monospace);
        white-space: pre-wrap;
        word-break: break-word;
      }
      .entry {
        border-top: 1px solid var(--border-color-default, #d1d9e0);
        margin-top: 10px;
        padding-top: 10px;
      }
      .entry:first-child {
        border-top: 0;
        margin-top: 0;
        padding-top: 0;
      }
      .meta {
        color: var(--text-color-muted, #59636e);
      }
    </style>
  </head>
  <body>
    <div class="layout">
      <div class="row">
        <button id="listDevicesBtn">List connected Tessels</button>
        <select id="deviceSelect"></select>
        <button id="versionBtn">Get version</button>
        <button id="killBtn">Kill running command</button>
        <span id="status" class="status">Ready</span>
      </div>
      <div class="row">
        <input id="cliCommand" placeholder="CLI command, e.g. t2 or node repos\\t2-cli\\bin\\tessel-2.js" style="min-width:420px;flex:1" />
        <button id="saveCliBtn">Set CLI command</button>
      </div>
      <div class="row">
        <input id="customCmd" placeholder="t2 subcommand, e.g. run app.js --usb" style="min-width:420px;flex:1" />
        <button id="runBtn">Run</button>
      </div>
      <div id="terminal" class="terminal">No commands run yet.</div>
    </div>
    <script>
      const instanceId = ${JSON.stringify(instanceId)};
      const terminal = document.getElementById("terminal");
      const deviceSelect = document.getElementById("deviceSelect");
      const statusEl = document.getElementById("status");
      const listDevicesBtn = document.getElementById("listDevicesBtn");
      const versionBtn = document.getElementById("versionBtn");
      const runBtn = document.getElementById("runBtn");
      const killBtn = document.getElementById("killBtn");
      const customCmd = document.getElementById("customCmd");
      const cliCommand = document.getElementById("cliCommand");
      const saveCliBtn = document.getElementById("saveCliBtn");
      let latestState = null;

      function setStatus(text) {
        statusEl.textContent = text;
      }

      async function post(path, payload = {}) {
        const response = await fetch(path, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        if (!response.ok) {
          const err = await response.text();
          throw new Error(err || "Request failed");
        }
        return response.json();
      }

      function renderState(state) {
        latestState = state;
        deviceSelect.innerHTML = "";
        const blank = document.createElement("option");
        blank.value = "";
        blank.textContent = "No selected Tessel";
        deviceSelect.appendChild(blank);

        for (const device of state.devices || []) {
          const option = document.createElement("option");
          option.value = device.id;
          option.textContent = device.transport + "  " + device.name;
          deviceSelect.appendChild(option);
        }
        deviceSelect.value = state.selectedDeviceId || "";
        cliCommand.value = state.cliCommand || "";

        const history = state.history || [];
        if (!history.length) {
          terminal.textContent = "No commands run yet.";
          setStatus(state.running ? "Running: " + state.running.command : "Ready");
          return;
        }

        terminal.innerHTML = history
          .map((entry) => {
            const safeOutput = (entry.output || "").replace(/[&<>]/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[m]));
            return (
              '<div class="entry">' +
              '<div><strong>' + entry.command + '</strong></div>' +
              '<div class="meta">status=' + entry.status + ', exit=' + (entry.exitCode ?? "n/a") + '</div>' +
              '<div><button data-send="' + entry.id + '">Send output to chat</button></div>' +
              '<pre style="white-space:pre-wrap;margin:8px 0 0">' + safeOutput + '</pre>' +
              '</div>'
            );
          })
          .join("");

        setStatus(state.running ? "Running: " + state.running.command : "Ready");
      }

      async function refreshState() {
        const response = await fetch("/api/state");
        const state = await response.json();
        renderState(state);
      }

      listDevicesBtn.addEventListener("click", async () => {
        try {
          await post("/api/list-devices");
        } catch (error) {
          setStatus(error.message);
        }
      });

      versionBtn.addEventListener("click", async () => {
        try {
          await post("/api/get-version");
        } catch (error) {
          setStatus(error.message);
        }
      });

      runBtn.addEventListener("click", async () => {
        const value = customCmd.value.trim();
        if (!value) {
          setStatus("Enter a subcommand first.");
          return;
        }
        try {
          await post("/api/run-custom", { subcommand: value });
          customCmd.value = "";
        } catch (error) {
          setStatus(error.message);
        }
      });

      saveCliBtn.addEventListener("click", async () => {
        const value = cliCommand.value.trim();
        if (!value) {
          setStatus("Enter a CLI command first.");
          return;
        }
        try {
          await post("/api/set-cli", { command: value });
          setStatus("CLI command updated.");
        } catch (error) {
          setStatus(error.message);
        }
      });

      killBtn.addEventListener("click", async () => {
        try {
          await post("/api/kill");
        } catch (error) {
          setStatus(error.message);
        }
      });

      deviceSelect.addEventListener("change", async () => {
        try {
          await post("/api/select-device", { id: deviceSelect.value || null });
        } catch (error) {
          setStatus(error.message);
        }
      });

      terminal.addEventListener("click", async (event) => {
        const id = event.target?.dataset?.send;
        if (!id) {
          return;
        }
        try {
          await post("/api/send-output", { commandId: id });
          setStatus("Output sent to chat.");
        } catch (error) {
          setStatus(error.message);
        }
      });

      const events = new EventSource("/events");
      events.addEventListener("state", (event) => {
        renderState(JSON.parse(event.data));
      });
      events.addEventListener("output", (event) => {
        const payload = JSON.parse(event.data);
        if (!latestState) {
          return;
        }
        const history = latestState.history || [];
        const target = history.find((entry) => entry.id === payload.entryId);
        if (target) {
          target.output = payload.output || "";
        }
        renderState(latestState);
        if (latestState?.running) {
          setStatus("Running: " + latestState.running.command);
        }
      });
      events.onerror = () => {
        setStatus("Waiting for updates...");
      };

      refreshState().catch((error) => {
        setStatus(error.message);
      });
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
    };

    const server = createServer(async (req, res) => {
        const requestUrl = new URL(req.url ?? "/", "http://127.0.0.1");

        if (req.method === "GET" && requestUrl.pathname === "/") {
            res.statusCode = 200;
            res.setHeader("Content-Type", "text/html; charset=utf-8");
            res.end(renderHtml(instanceId));
            return;
        }

        if (req.method === "GET" && requestUrl.pathname === "/api/state") {
            json(res, 200, snapshot(instance));
            return;
        }

        if (req.method === "GET" && requestUrl.pathname === "/events") {
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

        if (req.method === "POST" && requestUrl.pathname === "/api/list-devices") {
            try {
                const started = await startCommand(instance, listCommandArgs(), {
                    kind: "list-devices",
                    timeoutSeconds: LIST_DISCOVERY_TIMEOUT_SECONDS,
                });
                json(res, 200, started);
            } catch (error) {
                json(res, 400, { error: error.message });
            }
            return;
        }

        if (req.method === "POST" && requestUrl.pathname === "/api/get-version") {
            try {
                const args = versionCommandArgs(instance);
                const started = await startCommand(instance, args, {
                    kind: "get-version",
                    timeoutSeconds: VERSION_DISCOVERY_TIMEOUT_SECONDS,
                });
                json(res, 200, started);
            } catch (error) {
                json(res, 400, { error: error.message });
            }
            return;
        }

        if (req.method === "POST" && requestUrl.pathname === "/api/run-custom") {
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

        if (req.method === "POST" && requestUrl.pathname === "/api/set-cli") {
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

        if (req.method === "POST" && requestUrl.pathname === "/api/select-device") {
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

        if (req.method === "POST" && requestUrl.pathname === "/api/kill") {
            try {
                const result = await killRunningCommand(instance);
                json(res, 200, result);
            } catch (error) {
                json(res, 400, { error: error.message });
            }
            return;
        }

        if (req.method === "POST" && requestUrl.pathname === "/api/send-output") {
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

export function createTerminalCanvas() {
    return createCanvas({
        id: "tessel-device-canvas",
        displayName: "Tessel device terminal",
        description:
            "List connected Tessels, select one, run t2 commands, view output, and kill hung commands.",
        actions: [
            {
                name: "get_state",
                description: "Return canvas state including selected device and command history.",
                handler: async (ctx) => {
                    const instance = instances.get(ctx.instanceId);
                    if (!instance) {
                        throw new CanvasError("canvas_instance_not_found", "Canvas instance not found.");
                    }
                    return snapshot(instance);
                },
            },
            {
                name: "list_devices",
                description: "Run `t2 list --usb` and refresh available Tessel devices.",
                handler: async (ctx) => {
                    const instance = instances.get(ctx.instanceId);
                    if (!instance) {
                        throw new CanvasError("canvas_instance_not_found", "Canvas instance not found.");
                    }
                    return await startCommand(instance, listCommandArgs(), {
                        kind: "list-devices",
                        timeoutSeconds: LIST_DISCOVERY_TIMEOUT_SECONDS,
                    });
                },
            },
            {
                name: "select_device",
                description: "Select a discovered device by id for version checks.",
                inputSchema: {
                    type: "object",
                    properties: {
                        id: { type: "string" },
                    },
                    required: ["id"],
                    additionalProperties: false,
                },
                handler: async (ctx) => {
                    const instance = instances.get(ctx.instanceId);
                    if (!instance) {
                        throw new CanvasError("canvas_instance_not_found", "Canvas instance not found.");
                    }
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
                name: "get_version",
                description: "Run version command against the selected Tessel (or USB default).",
                handler: async (ctx) => {
                    const instance = instances.get(ctx.instanceId);
                    if (!instance) {
                        throw new CanvasError("canvas_instance_not_found", "Canvas instance not found.");
                    }
                    const args = versionCommandArgs(instance);
                    return await startCommand(instance, args, {
                        kind: "get-version",
                        timeoutSeconds: VERSION_DISCOVERY_TIMEOUT_SECONDS,
                    });
                },
            },
            {
                name: "run_command",
                description: "Run any t2 subcommand text, e.g. `run app.js --usb`.",
                inputSchema: {
                    type: "object",
                    properties: {
                        subcommand: { type: "string" },
                    },
                    required: ["subcommand"],
                    additionalProperties: false,
                },
                handler: async (ctx) => {
                    const instance = instances.get(ctx.instanceId);
                    if (!instance) {
                        throw new CanvasError("canvas_instance_not_found", "Canvas instance not found.");
                    }
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
                    properties: {
                        command: { type: "string" },
                    },
                    required: ["command"],
                    additionalProperties: false,
                },
                handler: async (ctx) => {
                    const instance = instances.get(ctx.instanceId);
                    if (!instance) {
                        throw new CanvasError("canvas_instance_not_found", "Canvas instance not found.");
                    }
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
                name: "kill_command",
                description: "Kill the currently running command for this canvas instance.",
                handler: async (ctx) => {
                    const instance = instances.get(ctx.instanceId);
                    if (!instance) {
                        throw new CanvasError("canvas_instance_not_found", "Canvas instance not found.");
                    }
                    return killRunningCommand(instance);
                },
            },
            {
                name: "send_output_to_chat",
                description: "Send command output from this canvas to the current chat session.",
                inputSchema: {
                    type: "object",
                    properties: {
                        commandId: { type: "string" },
                    },
                    required: [],
                    additionalProperties: false,
                },
                handler: async (ctx) => {
                    const instance = instances.get(ctx.instanceId);
                    if (!instance) {
                        throw new CanvasError("canvas_instance_not_found", "Canvas instance not found.");
                    }
                    return sendOutputToSession(instance, ctx.input?.commandId);
                },
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
                title: "Tessel device terminal",
                status: instance.running ? `Running ${instance.running.command}` : "Ready",
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
