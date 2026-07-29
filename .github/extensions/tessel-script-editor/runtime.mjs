// Shared runtime for the Tessel canvases.
//
// This module holds every helper that both the terminal canvas and the script
// editor canvas depend on: process spawning, the submodule + npm preflight
// checks, terminal control-character normalization, the generic `startCommand`
// runner with streaming + hard-timeout handling, SSE emit helpers, device
// discovery, and sending output back to the chat session. Keeping this logic in
// one place means the two canvases share identical behavior for running t2
// commands.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const EXTENSION_FILE = fileURLToPath(import.meta.url);
export const PROJECT_REPO_ROOT = path.resolve(path.dirname(EXTENSION_FILE), "..", "..", "..");
// Long enough for an mDNS round trip, since discovery now covers LAN as well as USB.
export const LIST_DISCOVERY_TIMEOUT_SECONDS = 3;
export const VERSION_DISCOVERY_TIMEOUT_SECONDS = 4;
export const DISCOVERY_PROCESS_GRACE_MS = 4000;

let copilotSession;

export function setCopilotSession(session) {
    copilotSession = session;
}

export function escapeHtml(value) {
    return String(value)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

export function toTokens(input) {
    if (!input || typeof input !== "string") {
        return [];
    }
    return input
        .trim()
        .split(/\s+/)
        .filter(Boolean);
}

export function defaultCliTokens(workspacePath) {
    if (workspacePath) {
        return ["node", path.join(workspacePath, "repos", "t2-cli", "bin", "tessel-2.js")];
    }
    return ["node", path.join("repos", "t2-cli", "bin", "tessel-2.js")];
}

export function runProcess(command, args, options = {}) {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, options);
        let output = "";
        child.stdout.on("data", (chunk) => {
            output += String(chunk);
        });
        child.stderr.on("data", (chunk) => {
            output += String(chunk);
        });
        child.on("error", reject);
        child.on("close", (code) => {
            resolve({ code, output });
        });
    });
}

export function resolveCliScriptPath(instance) {
    const [command, scriptArg] = instance.cliTokens;
    if (!command || command.toLowerCase() !== "node" || !scriptArg) {
        return null;
    }

    if (path.isAbsolute(scriptArg)) {
        return scriptArg;
    }

    const workspaceRoot = instance.workspacePath || PROJECT_REPO_ROOT;
    return path.resolve(workspaceRoot, scriptArg);
}

export async function ensureSubmodulesInitialized(instance) {
    const cliScriptPath = resolveCliScriptPath(instance);
    if (!cliScriptPath) {
        return;
    }

    if (instance.submodulesReady) {
        return;
    }

    if (instance.submoduleInitPromise) {
        await instance.submoduleInitPromise;
        return;
    }

    instance.submoduleInitPromise = (async () => {
        if (existsSync(cliScriptPath)) {
            instance.submodulesReady = true;
            return;
        }

        const workspaceRoot = instance.workspacePath || PROJECT_REPO_ROOT;
        const result = await runProcess(
            "git",
            ["submodule", "update", "--init", "--recursive", "repos/t2-cli"],
            {
                cwd: workspaceRoot,
                windowsHide: true,
                shell: false,
            },
        );

        if (result.code !== 0) {
            const details = result.output?.trim();
            throw new Error(
                details
                    ? `Failed to initialize t2-cli submodule.\n${details}`
                    : "Failed to initialize t2-cli submodule.",
            );
        }

        if (!existsSync(cliScriptPath)) {
            throw new Error(`t2 CLI script was not found after submodule init: ${cliScriptPath}`);
        }

        instance.submodulesReady = true;
    })();

    try {
        await instance.submoduleInitPromise;
    } finally {
        instance.submoduleInitPromise = null;
    }
}

export function resolveCliRootPath(instance) {
    const cliScriptPath = resolveCliScriptPath(instance);
    if (!cliScriptPath) {
        return null;
    }
    return path.dirname(path.dirname(cliScriptPath));
}

export async function ensureNodeDependencies(instance) {
    const cliRootPath = resolveCliRootPath(instance);
    if (!cliRootPath) {
        return;
    }

    if (instance.nodeDepsReady) {
        return;
    }

    if (instance.nodeDepsPromise) {
        await instance.nodeDepsPromise;
        return;
    }

    instance.nodeDepsPromise = (async () => {
        const packageJsonPath = path.join(cliRootPath, "package.json");
        if (!existsSync(packageJsonPath)) {
            throw new Error(`package.json was not found for t2-cli: ${packageJsonPath}`);
        }

        const verify = await runProcess("node", ["-e", "require.resolve('nomnom')"], {
            cwd: cliRootPath,
            windowsHide: true,
            shell: false,
        });
        if (verify.code === 0) {
            instance.nodeDepsReady = true;
            return;
        }

        const install = await runProcess("npm", ["install", "--no-audit", "--no-fund"], {
            cwd: cliRootPath,
            windowsHide: true,
            shell: process.platform === "win32",
        });
        if (install.code !== 0) {
            const details = install.output?.trim();
            throw new Error(
                details
                    ? `Failed to install npm dependencies for t2-cli.\n${details}`
                    : "Failed to install npm dependencies for t2-cli.",
            );
        }

        const reverify = await runProcess("node", ["-e", "require.resolve('nomnom')"], {
            cwd: cliRootPath,
            windowsHide: true,
            shell: false,
        });
        if (reverify.code !== 0) {
            const details = reverify.output?.trim();
            throw new Error(
                details
                    ? `npm install completed but dependency resolution still fails.\n${details}`
                    : "npm install completed but dependency resolution still fails.",
            );
        }

        instance.nodeDepsReady = true;
    })();

    try {
        await instance.nodeDepsPromise;
    } finally {
        instance.nodeDepsPromise = null;
    }
}

export function parseJsonBody(req) {
    return new Promise((resolve, reject) => {
        let body = "";
        req.on("data", (chunk) => {
            body += chunk;
            if (body.length > 5_000_000) {
                reject(new Error("Request body too large"));
            }
        });
        req.on("end", () => {
            if (!body) {
                resolve({});
                return;
            }
            try {
                resolve(JSON.parse(body));
            } catch {
                reject(new Error("Invalid JSON body"));
            }
        });
        req.on("error", reject);
    });
}

export function json(res, code, payload) {
    res.statusCode = code;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify(payload));
}

export function sseWrite(res, event, data) {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
}

export function stripAnsiCodes(input) {
    return input.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "");
}

export function applyTerminalControls(current, chunk) {
    const text = stripAnsiCodes(String(chunk));
    let output = current;

    for (const char of text) {
        if (char === "\r") {
            const lastNewline = output.lastIndexOf("\n");
            output = output.slice(0, lastNewline + 1);
            continue;
        }

        if (char === "\b") {
            if (output.length > 0) {
                output = output.slice(0, -1);
            }
            continue;
        }

        if (char === "\u0007") {
            continue;
        }

        output += char;
    }

    return output;
}

export function snapshot(instance) {
    return {
        cliCommand: instance.cliTokens.join(" "),
        selectedDeviceId: instance.selectedDeviceId,
        devices: instance.devices,
        // Configurable discovery timeouts (seconds) for list/version scans.
        timeouts: instance.timeouts,
        // Optional editor-only fields; omitted from JSON for terminal instances.
        files: instance.files,
        currentFile: instance.currentFile,
        running:
            instance.running == null
                ? null
                : {
                      id: instance.running.id,
                      command: instance.running.command,
                      startedAt: instance.running.startedAt,
                      kind: instance.running.kind,
                  },
        history: instance.history.map((entry) => ({
            id: entry.id,
            command: entry.command,
            status: entry.status,
            exitCode: entry.exitCode,
            startedAt: entry.startedAt,
            endedAt: entry.endedAt,
            output: entry.output,
        })),
    };
}

export function emitState(instance) {
    const state = snapshot(instance);
    for (const client of instance.sseClients) {
        sseWrite(client, "state", state);
    }
}

export function emitOutput(instance, entryId, output) {
    for (const client of instance.sseClients) {
        sseWrite(client, "output", { entryId, output });
    }
}

export function hardTimeoutMs(meta) {
    if (meta.kind === "list-devices" || meta.kind === "get-version") {
        const timeoutSeconds =
            typeof meta.timeoutSeconds === "number" ? meta.timeoutSeconds : LIST_DISCOVERY_TIMEOUT_SECONDS;
        return timeoutSeconds * 1000 + DISCOVERY_PROCESS_GRACE_MS;
    }
    return null;
}

export function inferDevices(output) {
    const devices = [];
    const lines = output.split(/\r?\n/);
    for (const line of lines) {
        const match = line.match(/^\s*(USB|LAN)\s+(.+?)\s*$/i);
        if (!match) {
            continue;
        }
        const transport = match[1].toUpperCase();
        // t2 appends tab-separated annotations to LAN rows, e.g.
        // "(USB connect and run `t2 provision` to authorize)". Only the first
        // field is the device name — the rest must never reach --name.
        const fields = match[2].split("\t");
        const name = fields[0].trim();
        if (!name) {
            continue;
        }
        const note = fields.slice(1).join(" ").trim();
        const id = `${transport}:${name}`;
        devices.push({
            id,
            transport,
            name,
            authorized: !/authorize/i.test(note),
            note,
        });
    }
    return devices;
}

export function resolveT2Invocation(instance, args) {
    const base = instance.cliTokens.length ? instance.cliTokens : ["t2"];
    const command = base[0];
    const commandArgs = [...base.slice(1), ...args];
    const useShell =
        process.platform === "win32" &&
        (command.toLowerCase() === "t2" || command.toLowerCase().endsWith(".cmd"));
    return {
        command,
        args: commandArgs,
        display: [...base, ...args].join(" ").trim(),
        shell: useShell,
    };
}

export function listTimeoutSeconds(instance) {
    const value = instance?.timeouts?.list;
    return typeof value === "number" && value > 0 ? value : LIST_DISCOVERY_TIMEOUT_SECONDS;
}

export function versionTimeoutSeconds(instance) {
    const value = instance?.timeouts?.version;
    return typeof value === "number" && value > 0 ? value : VERSION_DISCOVERY_TIMEOUT_SECONDS;
}

export function normalizeTimeoutSeconds(value) {
    const num = Number(value);
    if (!Number.isFinite(num) || num <= 0) {
        throw new Error("Timeout must be a positive number of seconds.");
    }
    // Guard against runaway values that would keep a discovery scan alive forever.
    return Math.min(Math.round(num * 10) / 10, 120);
}

export function listCommandArgs(instance) {
    // No transport flag: `t2 list` finds USB *and* LAN devices, and inferDevices
    // parses both. A board that has just been put on Wi-Fi is often LAN-only
    // (USB does not always re-enumerate after a flash), and a USB-only scan
    // would leave it unselectable — and every device-targeted command with it.
    return ["list", "--timeout", String(listTimeoutSeconds(instance))];
}

export function versionCommandArgs(instance) {
    const device = selectedDevice(instance);
    const baseArgs = device ? ["version", "--name", device.name] : ["version"];
    return [...baseArgs, "--timeout", String(versionTimeoutSeconds(instance))];
}

export function deviceTargetArgs(instance) {
    const device = selectedDevice(instance);
    // With nothing selected, let t2 pick whatever transport it can find rather
    // than forcing --usb, which fails outright on a LAN-only board.
    return device ? ["--name", device.name] : [];
}

export async function terminateChildProcess(child) {
    if (!child || child.exitCode != null) {
        return;
    }

    if (process.platform === "win32") {
        await new Promise((resolve) => {
            const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
                windowsHide: true,
            });
            killer.on("close", () => resolve());
            killer.on("error", () => resolve());
        });
        return;
    }

    child.kill("SIGTERM");
    await new Promise((resolve) => setTimeout(resolve, 500));
    if (child.exitCode == null) {
        child.kill("SIGKILL");
    }
}

export async function startCommand(instance, args, meta = {}) {
    if (instance.running) {
        throw new Error("A command is already running for this canvas instance.");
    }

    await ensureSubmodulesInitialized(instance);
    await ensureNodeDependencies(instance);

    const invocation = resolveT2Invocation(instance, args);
    const id = `cmd-${++instance.commandCounter}`;
    const entry = {
        id,
        command: invocation.display,
        status: "running",
        exitCode: null,
        startedAt: new Date().toISOString(),
        endedAt: null,
        output: "",
        meta,
    };
    instance.history.push(entry);

    const spawnOptions = {
        windowsHide: true,
        shell: invocation.shell,
        env: {
            ...process.env,
            CI: "1",
            NO_UPDATE_NOTIFIER: "1",
            npm_config_update_notifier: "false",
        },
    };
    if (instance.workspacePath) {
        spawnOptions.cwd = instance.workspacePath;
    }
    const child = spawn(invocation.command, invocation.args, spawnOptions);

    instance.running = {
        id,
        command: invocation.display,
        startedAt: entry.startedAt,
        kind: meta.kind,
        child,
        entry,
    };
    emitState(instance);
    let timedOut = false;
    let timeoutHandle = null;

    const appendChunk = (chunk) => {
        entry.output = applyTerminalControls(entry.output, chunk);
        emitOutput(instance, id, entry.output);
    };

    child.stdout.on("data", appendChunk);
    child.stderr.on("data", appendChunk);

    child.on("error", (error) => {
        if (timeoutHandle) {
            clearTimeout(timeoutHandle);
        }
        entry.status = "failed";
        entry.exitCode = null;
        entry.endedAt = new Date().toISOString();
        entry.output = applyTerminalControls(entry.output, `\n[spawn error] ${error.message}\n`);
        instance.running = null;
        emitState(instance);
    });

    child.on("close", (code) => {
        if (timeoutHandle) {
            clearTimeout(timeoutHandle);
        }
        if (entry.status === "killed") {
            // Preserve explicit kill state from killRunningCommand.
        } else if (timedOut) {
            entry.status = "timed_out";
        } else {
            entry.status = code === 0 ? "succeeded" : "failed";
        }
        entry.exitCode = code;
        entry.endedAt = new Date().toISOString();
        if (meta.kind === "list-devices") {
            const discoveredDevices = inferDevices(entry.output);
            instance.devices = discoveredDevices;
            if (
                instance.selectedDeviceId &&
                !instance.devices.some((device) => device.id === instance.selectedDeviceId)
            ) {
                instance.selectedDeviceId = null;
            }
        }
        instance.running = null;
        emitState(instance);
    });

    const maxRunMs = hardTimeoutMs(meta);
    if (maxRunMs != null) {
        timeoutHandle = setTimeout(() => {
            timedOut = true;
            entry.output = applyTerminalControls(
                entry.output,
                `\n[canvas timeout] Command exceeded ${maxRunMs}ms and was terminated.\n`,
            );
            emitOutput(instance, id, entry.output);
            void terminateChildProcess(child);
        }, maxRunMs);
    }

    return { commandId: id };
}

export async function killRunningCommand(instance) {
    if (!instance.running) {
        return { killed: false, message: "No running command." };
    }

    const { child, entry } = instance.running;
    await terminateChildProcess(child);

    entry.status = "killed";
    entry.endedAt = new Date().toISOString();
    instance.running = null;
    emitState(instance);
    return { killed: true, commandId: entry.id };
}

// Feed a line of input to the currently running command's stdin. Used by the
// interactive SSH session: the spawned `t2 root` process inherits its stdio to
// the underlying `ssh` child, so writing here lands on the remote shell.
export function writeStdin(instance, data) {
    if (!instance.running || !instance.running.child) {
        throw new Error("No interactive command is running.");
    }
    const child = instance.running.child;
    if (!child.stdin || child.stdin.destroyed || child.stdin.writableEnded) {
        throw new Error("The running command is not accepting input.");
    }
    const text = typeof data === "string" ? data : "";
    child.stdin.write(text.endsWith("\n") ? text : `${text}\n`);
    return { written: true, commandId: instance.running.id };
}

export async function sendOutputToSession(instance, commandId) {
    const target =
        commandId != null
            ? instance.history.find((entry) => entry.id === commandId)
            : [...instance.history].reverse().find((entry) => entry.status !== "running");

    if (!target) {
        throw new Error("No command output is available to send.");
    }

    if (!copilotSession) {
        throw new Error("Chat session is not available yet.");
    }

    const output = target.output?.trim() ? target.output : "(no output)";
    await copilotSession.send(
        `Tessel output from canvas instance \`${instance.instanceId}\`:\n\n` +
            `Command: \`${target.command}\`\n\n` +
            "```text\n" +
            `${output}\n` +
            "```",
    );
    return { sent: true, commandId: target.id };
}

export function selectedDevice(instance) {
    if (!instance.selectedDeviceId) {
        return null;
    }
    return instance.devices.find((device) => device.id === instance.selectedDeviceId) ?? null;
}
