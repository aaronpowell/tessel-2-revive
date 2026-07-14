// Extension: tessel-device-canvas
//
// Wiring entry point. A single canvas is declared:
//   - tessel-script-editor (editor-canvas.mjs) — author scripts with syntax
//     highlighting, create files, run/push to the device with streaming output,
//     and device diagnostics (list, version, provision, custom t2 commands,
//     configurable discovery timeouts).
//
// All shared process/streaming logic lives in runtime.mjs. Keep this file focused
// on joining the session and registering the canvas.

import { joinSession } from "@github/copilot-sdk/extension";
import { setCopilotSession } from "./runtime.mjs";
import { createEditorCanvas } from "./editor-canvas.mjs";

const session = await joinSession({
    canvases: [createEditorCanvas()],
});

setCopilotSession(session);
