#!/usr/bin/env bash
# =============================================================================
# LLM Compare 3D & CAD Arena — Autodesk Fusion 360 Local MCP Installer (macOS)
# =============================================================================
# Installs the "LLMCompareFusionMCP" Add-In into Autodesk Fusion 360 on macOS:
#   ~/Library/Application Support/Autodesk/Autodesk Fusion 360/API/AddIns/LLMCompareFusionMCP
#
# Provides:
#   1. HTTP Loopback Bridge on http://127.0.0.1:8765/mcp (with CORS + Chrome
#      Private Network Access headers) so clicking "🚀 Push to Local MCP" in
#      LLM Compare imports the watertight ISO-10303-21 STEP solid + parametric
#      PARAMS directly into your open Fusion 360 document on your Mac.
#   2. JSON-RPC 2.0 MCP Server (HTTP POST /mcp + stdio wrapper mcp_stdio_server.py)
#      for Claude Desktop, Cursor, or Gemini CLI on macOS.
# =============================================================================
set -euo pipefail

ADDIN_NAME="LLMCompareFusionMCP"
ADDINS_BASE="$HOME/Library/Application Support/Autodesk/Autodesk Fusion 360/API/AddIns"
ADDIN_DIR="$ADDINS_BASE/$ADDIN_NAME"

mkdir -p "$ADDIN_DIR"

cat > "$ADDIN_DIR/$ADDIN_NAME.manifest" <<'EOF'
{
  "autodeskProduct": "Fusion360",
  "type": "addin",
  "id": "com.google.llmcompare.fusion360.mcp",
  "author": "LLM Compare 3D & CAD Arena",
  "description": {
    "": "Local MCP & HTTP loopback bridge (127.0.0.1:8765/mcp) for LLM Compare 3D & CAD Arena. Imports watertight STEP AP214 geometry, syncs parametric User Parameters, and executes adsk.fusion Python scripts on Fusion 360's main UI thread."
  },
  "version": "1.0.56",
  "runOnStartup": true,
  "supportedOS": "windows|mac",
  "editEnabled": true
}
EOF

cat > "$ADDIN_DIR/$ADDIN_NAME.py" <<'EOF'
# -*- coding: utf-8 -*-
"""
LLMCompareFusionMCP — Autodesk Fusion 360 Add-In (macOS / Windows)
Listens on http://127.0.0.1:8765/mcp and dispatches CAD operations safely
onto Fusion 360's main UI thread via adsk.core.CustomEvent.
"""
import adsk.core
import adsk.fusion
import adsk.cam
import json
import os
import queue
import tempfile
import threading
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HOST = "127.0.0.1"
PORT = int(os.environ.get("FUSION_MCP_PORT", "8765"))
CUSTOM_EVENT_ID = "LLMCompareFusionMCPQueueEvent_v1"

_app = None
_ui = None
_custom_event = None
_handlers = []
_http_server = None
_http_thread = None
_task_queue = queue.Queue()


def _sanitize_param_name(name):
    clean = "".join(ch if (ch.isalnum() or ch == "_") else "_" for ch in str(name or ""))
    if not clean:
        return ""
    if clean[0].isdigit():
        clean = "p_" + clean
    return clean[:48]


def _execute_on_main_thread(payload):
    """Runs inside Fusion 360's main UI thread (invoked by CustomEventHandler)."""
    app = adsk.core.Application.get()
    design = adsk.fusion.Design.cast(app.activeProduct)
    if not design:
        doc = app.documents.add(adsk.core.DocumentTypes.FusionDesignDocumentType)
        design = adsk.fusion.Design.cast(app.activeProduct)

    root = design.rootComponent
    tool = str(payload.get("tool") or "fusion360_import_model")
    title = str(payload.get("title") or payload.get("taskTitle") or "LLM_Compare_Model")
    slot = str(payload.get("slot") or "A")
    step_text = payload.get("stepText") or ""
    params = payload.get("params") if isinstance(payload.get("params"), dict) else {}
    fusion_script = payload.get("fusionScript") or payload.get("script") or ""

    result = {
        "ok": True,
        "tool": tool,
        "slot": slot,
        "title": title,
        "importedStep": False,
        "bodiesCount": 0,
        "parametersUpdated": 0,
    }

    # 1. Sync numeric parameters into Fusion 360 User Parameters (Modify > Change Parameters)
    user_params = design.userParameters
    updated_params = 0
    for raw_k, raw_v in params.items():
        if isinstance(raw_v, bool) or not isinstance(raw_v, (int, float)):
            continue
        k = _sanitize_param_name(raw_k)
        if not k:
            continue
        val_num = float(raw_v)
        is_count = any(tok in k.lower() for tok in ("count", "teeth", "num", "bolts", "holes", "blades", "vanes", "stages", "fins", "pins", "rows", "cols"))
        unit = "" if is_count else "mm"
        expr = f"{int(round(val_num))}" if is_count else f"{val_num:.4f} mm"
        existing = user_params.itemByName(k)
        try:
            if existing:
                existing.expression = expr
            else:
                user_params.add(
                    k,
                    adsk.core.ValueInput.createByString(expr),
                    unit,
                    f"LLM Compare Slot {slot} ({title})",
                )
            updated_params += 1
        except Exception:
            pass
    result["parametersUpdated"] = updated_params

    # 2. If watertight STEP AP214 geometry is provided, import it directly into a new Occurrence
    if isinstance(step_text, str) and "ISO-10303-21;" in step_text:
        tmp_path = None
        try:
            fd, tmp_path = tempfile.mkstemp(prefix=f"llmc_slot_{slot}_", suffix=".step")
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                f.write(step_text)
            import_mgr = app.importManager
            step_opts = import_mgr.createSTEPImportOptions(tmp_path)
            import_mgr.importToTarget(step_opts, root)
            result["importedStep"] = True
            result["bodiesCount"] = root.bRepBodies.count + sum(
                occ.component.bRepBodies.count for occ in root.occurrences
            )
        finally:
            if tmp_path and os.path.exists(tmp_path):
                try:
                    os.remove(tmp_path)
                except Exception:
                    pass
    elif fusion_script and tool == "fusion360_execute_script":
        # Execute standalone adsk.fusion script if no STEP payload was attached
        ns = {"adsk": adsk, "__name__": "__main__"}
        exec(compile(fusion_script, "<llm_compare_fusion_script>", "exec"), ns, ns)
        if callable(ns.get("run")):
            ns["run"]({"isApplicationStartup": False})
        result["executedScript"] = True
        result["bodiesCount"] = root.bRepBodies.count

    try:
        if app.activeViewport:
            app.activeViewport.fit()
            app.activeViewport.refresh()
    except Exception:
        pass

    return result


class _MainThreadEventHandler(adsk.core.CustomEventHandler):
    def __init__(self):
        super().__init__()

    def notify(self, args):
        while not _task_queue.empty():
            try:
                item = _task_queue.get_nowait()
            except queue.Empty:
                break
            try:
                item["response"] = _execute_on_main_thread(item["payload"])
            except Exception as exc:
                item["response"] = {
                    "ok": False,
                    "error": str(exc),
                    "traceback": traceback.format_exc(),
                }
            finally:
                item["event"].set()


def dispatch_to_fusion_main_thread(payload, timeout=25.0):
    done_evt = threading.Event()
    item = {"payload": payload, "response": None, "event": done_evt}
    _task_queue.put(item)
    _app.fireCustomEvent(CUSTOM_EVENT_ID, "run")
    if not done_evt.wait(timeout=timeout):
        return {"ok": False, "error": "Timed out waiting for Fusion 360 main UI thread."}
    return item["response"] or {"ok": False, "error": "Empty response from Fusion 360 main thread."}


class _MCPRequestHandler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        return  # keep Fusion Text Commands console clean

    def _send_cors_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, X-LLMC-Internal, Authorization")
        self.send_header("Access-Control-Allow-Private-Network", "true")

    def _send_json(self, status_code, obj):
        raw = json.dumps(obj).encode("utf-8")
        self.send_response(status_code)
        self._send_cors_headers()
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_OPTIONS(self):
        self.send_response(204)
        self._send_cors_headers()
        self.end_headers()

    def do_GET(self):
        self._send_json(200, {
            "ok": True,
            "service": "LLMCompareFusionMCP",
            "version": "1.0.56",
            "endpoint": f"http://{HOST}:{PORT}/mcp",
            "status": "listening",
        })

    def do_POST(self):
        try:
            length = int(self.headers.get("Content-Length") or "0")
            raw_body = self.rfile.read(length) if length > 0 else b"{}"
            body = json.loads(raw_body.decode("utf-8"))
        except Exception as exc:
            self._send_json(400, {"ok": False, "error": f"Invalid JSON payload: {exc}"})
            return

        # Support both JSON-RPC 2.0 MCP calls and direct LLM Compare /mcp push payloads
        if isinstance(body, dict) and body.get("jsonrpc") == "2.0":
            method = body.get("method") or ""
            req_id = body.get("id")
            if method == "initialize":
                self._send_json(200, {
                    "jsonrpc": "2.0",
                    "id": req_id,
                    "result": {
                        "protocolVersion": "2024-11-05",
                        "capabilities": {"tools": {}},
                        "serverInfo": {"name": "fusion360-llm-compare-mcp", "version": "1.0.56"},
                    },
                })
                return
            if method == "tools/list":
                self._send_json(200, {
                    "jsonrpc": "2.0",
                    "id": req_id,
                    "result": {
                        "tools": [
                            {
                                "name": "fusion360_import_model",
                                "description": "Import a watertight ISO-10303-21 STEP solid and sync parametric User Parameters into the active Autodesk Fusion 360 design.",
                                "inputSchema": {
                                    "type": "object",
                                    "properties": {
                                        "title": {"type": "string"},
                                        "slot": {"type": "string"},
                                        "stepText": {"type": "string", "description": "ISO-10303-21 STEP AP214 text"},
                                        "params": {"type": "object", "description": "Numeric millimeter/count parameters"},
                                        "fusionScript": {"type": "string", "description": "Optional adsk.fusion Python script"},
                                    },
                                },
                            }
                        ]
                    },
                })
                return
            if method == "tools/call":
                params_obj = body.get("params") or {}
                args = params_obj.get("arguments") or {}
                args["tool"] = params_obj.get("name") or "fusion360_import_model"
                res = dispatch_to_fusion_main_thread(args)
                self._send_json(200, {
                    "jsonrpc": "2.0",
                    "id": req_id,
                    "result": {
                        "content": [{"type": "text", "text": json.dumps(res, indent=2)}],
                        "isError": not bool(res.get("ok")),
                    },
                })
                return

        res = dispatch_to_fusion_main_thread(body if isinstance(body, dict) else {})
        self._send_json(200 if res.get("ok") else 400, res)


def run(context):
    global _app, _ui, _custom_event, _http_server, _http_thread
    try:
        _app = adsk.core.Application.get()
        _ui = _app.userInterface
        try:
            _app.unregisterCustomEvent(CUSTOM_EVENT_ID)
        except Exception:
            pass
        _custom_event = _app.registerCustomEvent(CUSTOM_EVENT_ID)
        on_evt = _MainThreadEventHandler()
        _custom_event.add(on_evt)
        _handlers.append(on_evt)

        _http_server = ThreadingHTTPServer((HOST, PORT), _MCPRequestHandler)
        _http_thread = threading.Thread(target=_http_server.serve_forever, daemon=True)
        _http_thread.start()
        _app.log(f"[LLMCompareFusionMCP] Listening on http://{HOST}:{PORT}/mcp")
    except Exception:
        if _ui:
            _ui.messageBox("LLMCompareFusionMCP failed to start:\n" + traceback.format_exc())


def stop(context):
    global _http_server, _custom_event
    try:
        if _http_server:
            _http_server.shutdown()
            _http_server.server_close()
            _http_server = None
        if _custom_event and _app:
            _app.unregisterCustomEvent(CUSTOM_EVENT_ID)
            _custom_event = None
    except Exception:
        pass
EOF

cat > "$ADDIN_DIR/mcp_stdio_server.py" <<'EOF'
#!/usr/bin/env python3
"""
Stdio-to-HTTP MCP Proxy for Claude Desktop / Cursor / Gemini CLI on macOS.
Forwards JSON-RPC 2.0 messages over stdio to the running Fusion 360 Add-In
at http://127.0.0.1:8765/mcp.
"""
import json
import sys
import urllib.request

ENDPOINT = "http://127.0.0.1:8765/mcp"

for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    try:
        msg = json.loads(line)
    except Exception:
        continue
    if "id" not in msg:
        continue
    try:
        req = urllib.request.Request(
            ENDPOINT,
            data=json.dumps(msg).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=25) as resp:
            sys.stdout.write(resp.read().decode("utf-8").strip() + "\n")
            sys.stdout.flush()
    except Exception as exc:
        err_resp = {
            "jsonrpc": "2.0",
            "id": msg.get("id"),
            "error": {"code": -32000, "message": f"Fusion 360 MCP Add-In unreachable at {ENDPOINT}: {exc}"},
        }
        sys.stdout.write(json.dumps(err_resp) + "\n")
        sys.stdout.flush()
EOF
chmod +x "$ADDIN_DIR/mcp_stdio_server.py"

echo ""
echo "✅ Installed LLMCompareFusionMCP Add-In into:"
echo "   $ADDIN_DIR"
echo ""
echo "Next steps in Autodesk Fusion 360 on your Mac:"
echo "  1. Open Fusion 360 -> click UTILITIES tab -> ADD-INS (or press Shift+S)."
echo "  2. Select the 'Add-Ins' tab -> click 'LLMCompareFusionMCP' -> click 'Run' (and check 'Run on Startup')."
echo "  3. Verify the bridge is live: curl http://127.0.0.1:8765/mcp"
echo "  4. In LLM Compare (3D & CAD Arena), click '🔌 Fusion 360' -> '🚀 Push to Local MCP'!"
