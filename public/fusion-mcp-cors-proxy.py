#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
LLM Compare 3D & CAD Arena — Local macOS CORS & MCP Session Bridge for Autodesk Fusion 360
==========================================================================================
Bridges browser requests from LLM Compare (Cloudtop / Cloud Run) to Autodesk Fusion 360's
built-in MCP Server (http://127.0.0.1:27182/mcp) on your Mac.

Why this exists:
  Chrome blocks web pages on remote origins (e.g. ulin.c.googlers.com or *.run.app) from
  calling http://127.0.0.1:27182/mcp directly unless the local server responds to OPTIONS
  preflight requests with `Access-Control-Allow-Origin: *` and
  `Access-Control-Allow-Private-Network: true`, and exposes `Mcp-Session-Id`.

Usage on your Mac:
  curl -fsSL http://ulin.c.googlers.com:8787/fusion-mcp-cors-proxy.py | python3 -
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
    # Parse Server-Sent Events (SSE) `data: {...}` lines from Streamable HTTP MCP servers
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
        body = _parse_mcp_response(resp.read())
        return resp.status, new_sid, body


def forward_script_to_fusion_mcp(target_url, body):
    fusion_script = body.get("fusionScript") or body.get("script") or body.get("code") or ""
    if not fusion_script:
        return 400, {"ok": False, "error": "Missing fusionScript in request payload."}

    # 1. Initialize MCP session with Fusion 360 (127.0.0.1:27182/mcp)
    session_id = None
    try:
        _, session_id, init_res = _mcp_post(
            target_url,
            {
                "jsonrpc": "2.0",
                "id": 1,
                "method": "initialize",
                "params": {
                    "protocolVersion": "2024-11-05",
                    "capabilities": {},
                    "clientInfo": {"name": "llm-compare-3d-arena", "version": "1.0.56"},
                },
            },
        )
    except urllib.error.HTTPError as he:
        err_body = _parse_mcp_response(he.read()) if he.fp else {}
        return he.code, {"ok": False, "error": f"Fusion MCP initialize HTTP {he.code}", "details": err_body}
    except Exception as exc:
        return 502, {
            "ok": False,
            "error": f"Could not connect to Fusion 360 MCP at {target_url}: {exc}. Ensure Fusion 360 is open and Preferences > General > API > Fusion MCP Server is enabled.",
        }

    # 2. Send notifications/initialized (best-effort)
    try:
        _mcp_post(
            target_url,
            {"jsonrpc": "2.0", "method": "notifications/initialized", "params": {}},
            session_id=session_id,
            timeout=5,
        )
    except Exception:
        pass

    # 3. Discover available tools via tools/list
    tool_name = "fusion_mcp_execute"
    arg_key = "script"
    discovered_tools = []
    try:
        _, session_id, list_res = _mcp_post(
            target_url,
            {"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}},
            session_id=session_id,
        )
        tools = ((list_res or {}).get("result") or {}).get("tools") or []
        discovered_tools = [t.get("name") for t in tools if isinstance(t, dict) and t.get("name")]
        chosen = None
        for t in tools:
            if not isinstance(t, dict):
                continue
            tname = str(t.get("name") or "")
            if tname in ("fusion_mcp_execute", "execute_script", "run_script", "run_python_script", "fusion360_import_model"):
                chosen = t
                break
        if not chosen:
            for t in tools:
                if isinstance(t, dict) and re.search(r"exec|script|python|run|code|import", str(t.get("name") or ""), re.I):
                    chosen = t
                    break
        if not chosen and tools:
            chosen = tools[0]
        if chosen:
            tool_name = chosen.get("name") or tool_name
            schema = chosen.get("inputSchema") or {}
            props = schema.get("properties") or {}
            req_keys = schema.get("required") or []
            if len(props) == 1:
                arg_key = list(props.keys())[0]
            else:
                for candidate in ("script", "code", "python_code", "source", "command", "fusionScript"):
                    if candidate in props:
                        arg_key = candidate
                        break
                else:
                    if req_keys:
                        arg_key = req_keys[0]
    except Exception:
        pass

    # 4. Call the execution tool on Fusion 360 MCP
    tool_args = {arg_key: fusion_script}
    if tool_name == "fusion360_import_model":
        tool_args.update({
            "title": body.get("title") or "LLM_Compare_Model",
            "slot": body.get("slot") or "A",
            "stepText": body.get("stepText") or "",
            "params": body.get("params") or {},
            "fusionScript": fusion_script,
        })

    try:
        status, _, call_res = _mcp_post(
            target_url,
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
            timeout=30,
        )
        is_err = bool((call_res or {}).get("error")) or bool(((call_res or {}).get("result") or {}).get("isError"))
        return (400 if is_err else 200), {
            "ok": not is_err,
            "pushed": not is_err,
            "endpointUrl": target_url,
            "tool": tool_name,
            "argKey": arg_key,
            "discoveredTools": discovered_tools,
            "mcpResult": call_res,
        }
    except urllib.error.HTTPError as he:
        err_body = _parse_mcp_response(he.read()) if he.fp else {}
        return he.code, {"ok": False, "error": f"Fusion MCP tools/call HTTP {he.code}", "details": err_body}
    except Exception as exc:
        return 502, {"ok": False, "error": f"Fusion MCP tools/call failed: {exc}"}


class ProxyHandler(BaseHTTPRequestHandler):
    def _cors(self):
        origin = self.headers.get("Origin") or "*"
        self.send_header("Access-Control-Allow-Origin", origin)
        self.send_header("Vary", "Origin")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Accept, Mcp-Session-Id, mcp-session-id, X-Target-Mcp, X-LLMC-Internal")
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
        self._send_json(200, {
            "ok": True,
            "proxy": f"http://{LISTEN_HOST}:{LISTEN_PORT}/mcp",
            "target": DEFAULT_FUSION_MCP,
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
    srv = ThreadingHTTPServer((LISTEN_HOST, LISTEN_PORT), ProxyHandler)
    print(f"======================================================================")
    print(f"🚀 LLM Compare -> Fusion 360 Local MCP Bridge active on your Mac!")
    print(f"   Browser CORS Endpoint : http://{LISTEN_HOST}:{LISTEN_PORT}/mcp")
    print(f"   Forwarding to Fusion  : {DEFAULT_FUSION_MCP}")
    print(f"======================================================================")
    print(f"Now click '🚀 Push to Local MCP' in LLM Compare (3D & CAD Arena).")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        sys.exit(0)
