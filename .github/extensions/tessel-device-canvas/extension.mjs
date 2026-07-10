// Extension: tessel-device-canvas
//
// Wiring entry point. Two canvases are declared:
//   - tessel-device-canvas  (terminal-canvas.mjs) — list/select devices, run t2
//     commands, stream output, kill hung commands.
//   - tessel-script-editor  (editor-canvas.mjs)   — author scripts with syntax
//     highlighting, create files, run/push to the device with streaming output.
//
// All shared process/streaming logic lives in runtime.mjs. Keep this file focused
// on joining the session and registering the canvases.

import { joinSession } from "@github/copilot-sdk/extension";
import { setCopilotSession } from "./runtime.mjs";
import { createTerminalCanvas } from "./terminal-canvas.mjs";
import { createEditorCanvas } from "./editor-canvas.mjs";

const session = await joinSession({
    canvases: [createTerminalCanvas(), createEditorCanvas()],
});

setCopilotSession(session);
