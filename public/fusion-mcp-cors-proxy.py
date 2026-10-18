#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
LLM Compare 3D & CAD Arena — Local macOS CORS & MCP Session Bridge for Autodesk Fusion 360
==========================================================================================
Bridges browser requests from LLM Compare (Cloud Run / Cloudtop) to Autodesk Fusion 360's
built-in MCP Server (http://127.0.0.1:27182/mcp) on your Mac.

Why this exists:
  Chrome blocks web pages on remote origins (e.g. *.run.app or ulin.c.googlers.com) from
  calling http://127.0.0.1:27182/mcp directly unless the local server responds to OPTIONS
  preflight requests with `Access-Control-Allow-Origin` and
  `Access-Control-Allow-Private-Network: true`, and exposes `Mcp-Session-Id`.

Usage on your Mac:
  curl -fsSL https://llm-compare-87624372578.us-central1.run.app/fusion-mcp-cors-proxy.py | python3 -
"""
import json
import os
import re
import sys
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

LISTEN_HOST = "127.0.0.1"
LISTEN_PORT = int(os.environ.get("LLMC_FUSION_PROXY_PORT", "27183"))
DEFAULT_FUSION_MCP = os.environ.get("FUSION_MCP_URL", "http://127.0.0.1:27182/mcp")


def _parse_mcp_response(raw_bytes):
    text = raw_bytes.decode("utf-8", errors="replace").strip()
    if not text:
        return {}
    try:
        return json.loads(text)
    except Exception:
        pass
    last_json = None
    for line in text.splitlines():
        line = line.strip()
        if line.startswith("data:"):
            payload = line[5:].strip()
            if payload:
                try:
                    last_json = json.loads(payload)
                except Exception:
                    pass
    return last_json if last_json is not None else {"raw": text}


def _mcp_post(url, payload_obj, session_id=None, timeout=25):
    data = json.dumps(payload_obj).encode("utf-8")
    headers = {
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
    }
    if session_id:
        headers["Mcp-Session-Id"] = session_id
        headers["mcp-session-id"] = session_id
    req = urllib.request.Request(url, data=data, headers=headers, method="POST")
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        new_sid = (
            resp.headers.get("Mcp-Session-Id")
            or resp.headers.get("mcp-session-id")
            or session_id
        )
        ctype = (resp.headers.get("Content-Type") or "").lower()
        # Notifications (no "id") may return 202/204 with empty body
        if "id" not in payload_obj or resp.status in (202, 204):
            return resp.status, new_sid, {}
        if "text/event-stream" in ctype:
            # Read SSE stream line-by-line and return as soon as the JSON-RPC response arrives
            last_obj = None
            while True:
                raw_line = resp.fp.readline()
                if not raw_line:
                    break
                line = raw_line.decode("utf-8", errors="replace").strip()
                if line.startswith("data:"):
                    chunk = line[5:].strip()
                    if chunk:
                        try:
                            obj = json.loads(chunk)
                            last_obj = obj
                            if isinstance(obj, dict) and ("result" in obj or "error" in obj):
                                return resp.status, new_sid, obj
                        except Exception:
                            pass
            return resp.status, new_sid, (last_obj or {})
        body = _parse_mcp_response(resp.read())
        return resp.status, new_sid, body


def _save_local_fusion_script_and_step(body, fusion_script):
    """Also save the generated script into Fusion 360's local macOS API/Scripts folder & STEP file."""
    saved_paths = {}
    raw_title = str(body.get("title") or "LLMCompare_3D_Model")
    safe_name = re.sub(r"[^A-Za-z0-9_]+", "_", raw_title).strip("_") or "LLMCompare_3D_Model"
    step_text = str(body.get("stepText") or "")
    try:
        if step_text and "ISO-10303-21" in step_text:
            dl_dir = os.path.expanduser("~/Downloads")
            os.makedirs(dl_dir, exist_ok=True)
            step_path = os.path.join(dl_dir, f"{safe_name}.step")
            with open(step_path, "w", encoding="utf-8") as f:
                f.write(step_text)
            saved_paths["stepPath"] = step_path
    except Exception:
        pass

    try:
        scripts_root = os.path.expanduser(
            "~/Library/Application Support/Autodesk/Autodesk Fusion 360/API/Scripts"
        )
        script_dir = os.path.join(scripts_root, safe_name)
        os.makedirs(script_dir, exist_ok=True)
        py_path = os.path.join(script_dir, f"{safe_name}.py")
        with open(py_path, "w", encoding="utf-8") as f:
            f.write(fusion_script)
        manifest_path = os.path.join(script_dir, f"{safe_name}.manifest")
        with open(manifest_path, "w", encoding="utf-8") as f:
            json.dump(
                {
                    "autodeskProduct": "Fusion360",
                    "type": "script",
                    "author": "LLM Compare 3D & CAD Arena",
                    "description": {"": f"LLM Compare 3D & CAD Arena: {raw_title}"},
                    "supportedOS": "windows|mac",
                    "editEnabled": True,
                },
                f,
                indent=2,
            )
        saved_paths["fusionScriptPath"] = py_path
    except Exception:
        pass
    return saved_paths


def _connect_and_list_tools(target_url):
    """Initialize MCP session with Fusion 360 (trying /mcp and root fallback) and list tools."""
    candidates = [target_url]
    if target_url.endswith("/mcp"):
        candidates.append(target_url[:-4] or "http://127.0.0.1:27182")
    elif not target_url.endswith("/mcp"):
        candidates.append(target_url.rstrip("/") + "/mcp")

    last_err = None
    for url in candidates:
        try:
            _, session_id, init_res = _mcp_post(
                url,
                {
                    "jsonrpc": "2.0",
                    "id": 1,
                    "method": "initialize",
                    "params": {
                        "protocolVersion": "2024-11-05",
                        "capabilities": {},
                        "clientInfo": {"name": "llm-compare-3d-arena", "version": "1.0.57"},
                    },
                },
                timeout=10,
            )
            try:
                _mcp_post(
                    url,
                    {"jsonrpc": "2.0", "method": "notifications/initialized", "params": {}},
                    session_id=session_id,
                    timeout=4,
                )
            except Exception:
                pass
            _, session_id, list_res = _mcp_post(
                url,
                {"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}},
                session_id=session_id,
                timeout=10,
            )
            tools = ((list_res or {}).get("result") or {}).get("tools") or []
            return url, session_id, init_res, tools, None
        except Exception as exc:
            last_err = exc
    return target_url, None, None, [], last_err


def forward_script_to_fusion_mcp(target_url, body):
    fusion_script = body.get("fusionScript") or body.get("script") or body.get("code") or ""
    if not fusion_script:
        return 400, {"ok": False, "error": "Missing fusionScript in request payload."}

    saved_paths = _save_local_fusion_script_and_step(body, fusion_script)

    resolved_url, session_id, init_res, tools, conn_err = _connect_and_list_tools(target_url)
    if conn_err is not None and not tools and init_res is None:
        return 502, {
            "ok": False,
            "error": (
                f"Could not connect to Fusion 360 MCP at {target_url}: {conn_err}. "
                "Verify Fusion 360 is open and Preferences > General > API > Fusion MCP Server is enabled."
            ),
            "savedPaths": saved_paths,
        }

    # Handle non-JSON-RPC local REST bridge (e.g. LLMCompareFusionMCP Add-In direct POST)
    if isinstance(init_res, dict) and not init_res.get("jsonrpc") and init_res.get("ok"):
        try:
            status, _, direct_res = _mcp_post(
                resolved_url,
                {
                    "tool": "fusion360_import_model",
                    "slot": body.get("slot") or "A",
                    "title": body.get("title") or "LLM_Compare_Model",
                    "stepText": body.get("stepText") or "",
                    "params": body.get("params") or {},
                    "fusionScript": fusion_script,
                },
                timeout=25,
            )
            return 200, {
                "ok": True,
                "pushed": True,
                "endpointUrl": resolved_url,
                "tool": "fusion360_import_model",
                "mcpResult": direct_res,
                "savedPaths": saved_paths,
            }
        except Exception as exc:
            return 502, {"ok": False, "error": f"Direct Fusion bridge failed: {exc}", "savedPaths": saved_paths}

    discovered_tools = [t.get("name") for t in tools if isinstance(t, dict) and t.get("name")]
    print(f"[Fusion MCP] Connected to {resolved_url} | Discovered tools: {discovered_tools}")

    # Select best execution tool from discovered tools
    preferred_names = (
        "execute_python",
        "fusion_mcp_execute",
        "execute_script",
        "run_script",
        "run_python_script",
        "run_python",
        "eval_python",
        "execute_code",
        "fusion360_import_model",
    )
    chosen = None
    for name in preferred_names:
        for t in tools:
            if isinstance(t, dict) and str(t.get("name") or "") == name:
                chosen = t
                break
        if chosen:
            break
    if not chosen:
        for t in tools:
            if isinstance(t, dict) and re.search(r"python|exec|script|run|code|eval|import", str(t.get("name") or ""), re.I):
                chosen = t
                break
    if not chosen and tools:
        chosen = tools[0]

    tool_name = (chosen.get("name") if chosen else None) or "execute_python"
    arg_key = "script"
    if chosen:
        schema = chosen.get("inputSchema") or {}
        props = schema.get("properties") or {}
        req_keys = schema.get("required") or []
        if len(props) == 1:
            arg_key = list(props.keys())[0]
        else:
            for candidate in ("code", "script", "python_code", "python", "source", "command", "fusionScript"):
                if candidate in props:
                    arg_key = candidate
                    break
            else:
                if req_keys:
                    arg_key = req_keys[0]

    tool_args = {arg_key: fusion_script}
    if tool_name == "fusion360_import_model":
        tool_args.update({
            "title": body.get("title") or "LLM_Compare_Model",
            "slot": body.get("slot") or "A",
            "stepText": body.get("stepText") or "",
            "params": body.get("params") or {},
            "fusionScript": fusion_script,
        })

    print(f"[Fusion MCP] Calling tool '{tool_name}' (arg '{arg_key}', {len(fusion_script)} chars)...")
    try:
        status, _, call_res = _mcp_post(
            resolved_url,
            {
                "jsonrpc": "2.0",
                "id": 3,
                "method": "tools/call",
                "params": {
                    "name": tool_name,
                    "arguments": tool_args,
                },
            },
            session_id=session_id,
            timeout=35,
        )
        is_err = bool((call_res or {}).get("error")) or bool(((call_res or {}).get("result") or {}).get("isError"))
        if is_err:
            print(f"[Fusion MCP] Tool '{tool_name}' returned error: {call_res}")
        else:
            print(f"[Fusion MCP] ✓ Successfully executed '{tool_name}' in Fusion 360!")
        return (400 if is_err else 200), {
            "ok": not is_err,
            "pushed": not is_err,
            "endpointUrl": resolved_url,
            "tool": tool_name,
            "argKey": arg_key,
            "discoveredTools": discovered_tools,
            "mcpResult": call_res,
            "savedPaths": saved_paths,
        }
    except urllib.error.HTTPError as he:
        err_body = _parse_mcp_response(he.read()) if he.fp else {}
        return he.code, {"ok": False, "error": f"Fusion MCP tools/call HTTP {he.code}", "details": err_body, "savedPaths": saved_paths}
    except Exception as exc:
        return 502, {"ok": False, "error": f"Fusion MCP tools/call failed: {exc}", "savedPaths": saved_paths}


class ReusableThreadingHTTPServer(ThreadingHTTPServer):
    allow_reuse_address = True


class ProxyHandler(BaseHTTPRequestHandler):
    def _cors(self):
        origin = self.headers.get("Origin") or "*"
        req_headers = self.headers.get("Access-Control-Request-Headers")
        allow_headers = "Content-Type, Accept, Mcp-Session-Id, mcp-session-id, X-Target-Mcp, X-LLMC-Internal"
        if req_headers:
            allow_headers = f"{allow_headers}, {req_headers}"
        self.send_header("Access-Control-Allow-Origin", origin)
        self.send_header("Vary", "Origin")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", allow_headers)
        self.send_header("Access-Control-Expose-Headers", "Mcp-Session-Id, mcp-session-id")
        self.send_header("Access-Control-Allow-Private-Network", "true")

    def _send_json(self, code, obj):
        raw = json.dumps(obj).encode("utf-8")
        self.send_response(code)
        self._cors()
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_GET(self):
        resolved_url, _, _, tools, err = _connect_and_list_tools(DEFAULT_FUSION_MCP)
        self._send_json(200, {
            "ok": True,
            "proxy": f"http://{LISTEN_HOST}:{LISTEN_PORT}/mcp",
            "target": resolved_url,
            "fusionConnected": err is None,
            "discoveredTools": [t.get("name") for t in tools if isinstance(t, dict) and t.get("name")],
            "error": str(err) if err else None,
        })

    def do_POST(self):
        try:
            length = int(self.headers.get("Content-Length") or "0")
            raw = self.rfile.read(length) if length > 0 else b"{}"
            body = json.loads(raw.decode("utf-8"))
        except Exception as exc:
            self._send_json(400, {"ok": False, "error": f"Invalid JSON: {exc}"})
            return

        target_url = str(body.get("targetUrl") or self.headers.get("X-Target-Mcp") or DEFAULT_FUSION_MCP).strip()
        if not re.match(r"^https?://(127\.0\.0\.1|localhost)(:\d+)?(/.*)?$", target_url, re.I):
            self._send_json(400, {"ok": False, "error": "Target MCP URL must be on localhost / 127.0.0.1."})
            return

        code, resp_obj = forward_script_to_fusion_mcp(target_url, body)
        self._send_json(code, resp_obj)


if __name__ == "__main__":
    srv = ReusableThreadingHTTPServer((LISTEN_HOST, LISTEN_PORT), ProxyHandler)
    print("======================================================================")
    print("🚀 LLM Compare -> Fusion 360 Local MCP Bridge active on your Mac!")
    print(f"   Browser CORS Endpoint : http://{LISTEN_HOST}:{LISTEN_PORT}/mcp")
    print(f"   Forwarding to Fusion  : {DEFAULT_FUSION_MCP}")
    resolved, _, _, startup_tools, startup_err = _connect_and_list_tools(DEFAULT_FUSION_MCP)
    if startup_err is None:
        t_names = [t.get("name") for t in startup_tools if isinstance(t, dict) and t.get("name")]
        print(f"   ✓ Fusion 360 MCP Live : {resolved} (Tools: {t_names})")
    else:
        print(f"   ⚠ Fusion 360 MCP Note : {startup_err}")
    print("======================================================================")
    print("Now click '🚀 Push to Local MCP' in LLM Compare (3D & CAD Arena).")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        sys.exit(0)
