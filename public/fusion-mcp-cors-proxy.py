#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
LLM Compare 3D & CAD Arena — Local macOS CORS & MCP Session Bridge for Autodesk Fusion 360
==========================================================================================
Bridges browser requests from LLM Compare (Cloud Run / Cloudtop) to Autodesk Fusion 360's
built-in MCP Server (http://127.0.0.1:27182/mcp) on your Mac.

Why this exists:
  1. Chrome blocks web pages on remote origins (*.run.app / ulin.c.googlers.com) from calling
     http://127.0.0.1:27182/mcp directly unless OPTIONS preflight returns
     `Access-Control-Allow-Origin` and `Access-Control-Allow-Private-Network: true`.
  2. Autodesk Fusion 360's local MCP HTTP server (:27182) enforces a tight HTTP request body
     limit (returning HTTP 413 if a 1 MB STEP solid is embedded inline in the JSON-RPC call).
     This local Mac bridge writes the watertight `.step` solid to disk on your Mac first and
     sends a compact ~2 KB `fusion_mcp_execute` (`featureType: "script"`) payload to Fusion 360
     that imports the local `.step` file directly via `app.importManager`.

Usage on your Mac:
  curl -fsSL https://llm-compare-87624372578.us-central1.run.app/fusion-mcp-cors-proxy.py | python3 -
"""
import base64
import json
import os
import re
import struct
import sys
import urllib.error
import urllib.request
import zlib
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
        if "id" not in payload_obj or resp.status in (202, 204):
            return resp.status, new_sid, {}
        if "text/event-stream" in ctype:
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


def _extract_step_text(body, fusion_script):
    """Extract ISO-10303-21 STEP solid from body['stepText'] or embedded STEP_ZLIB_B64 in fusion_script."""
    step_text = str(body.get("stepText") or "")
    if step_text and "ISO-10303-21" in step_text:
        return step_text
    m = re.search(r'STEP_ZLIB_B64\s*=\s*"([A-Za-z0-9+/=]+)"', fusion_script)
    if m and m.group(1):
        try:
            raw_bytes = zlib.decompress(base64.b64decode(m.group(1)))
            decoded = raw_bytes.decode("utf-8", errors="replace")
            if "ISO-10303-21" in decoded:
                return decoded
        except Exception:
            pass
    return ""


def _step_to_part_stls(step_text, out_dir):
    """Extract each CLOSED_SHELL / OPEN_SHELL from STEP into a binary .stl file on the Mac."""
    pts = {}
    for m in re.finditer(r"#(\d+)\s*=\s*CARTESIAN_POINT\s*\(\s*'[^']*'\s*,\s*\(\s*([^,]+)\s*,\s*([^,]+)\s*,\s*([^)]+)\s*\)\s*\)", step_text):
        pts[int(m.group(1))] = (float(m.group(2)), float(m.group(3)), float(m.group(4)))
    vmap = {}
    for m in re.finditer(r"#(\d+)\s*=\s*VERTEX_POINT\s*\(\s*'[^']*'\s*,\s*#(\d+)\s*\)", step_text):
        vmap[int(m.group(1))] = int(m.group(2))
    loops = {}
    for m in re.finditer(r"#(\d+)\s*=\s*POLY_LOOP\s*\(\s*'[^']*'\s*,\s*\(\s*#(\d+)\s*,\s*#(\d+)\s*,\s*#(\d+)\s*\)\s*\)", step_text):
        a, b, c = int(m.group(2)), int(m.group(3)), int(m.group(4))
        loops[int(m.group(1))] = (vmap.get(a, a), vmap.get(b, b), vmap.get(c, c))
    bounds = {}
    for m in re.finditer(r"#(\d+)\s*=\s*FACE_OUTER_BOUND\s*\(\s*'[^']*'\s*,\s*#(\d+)", step_text):
        bounds[int(m.group(1))] = int(m.group(2))
    faces = {}
    for m in re.finditer(r"#(\d+)\s*=\s*ADVANCED_FACE\s*\(\s*'[^']*'\s*,\s*\(\s*#(\d+)\s*\)", step_text):
        lid = bounds.get(int(m.group(2)))
        if lid in loops:
            faces[int(m.group(1))] = loops[lid]
    shells = []
    for m in re.finditer(r"#(\d+)\s*=\s*(?:CLOSED_SHELL|OPEN_SHELL)\s*\(\s*'([^']*)'\s*,\s*\(([^)]+)\)\s*\)", step_text):
        sname = m.group(2).strip() or f"Part_{len(shells) + 1}"
        fids = [int(x) for x in re.findall(r"#(\d+)", m.group(3))]
        tris = [faces[fid] for fid in fids if fid in faces]
        if tris:
            shells.append((sname, tris))
    if not shells and faces:
        shells.append(("Body_1", list(faces.values())))
    os.makedirs(out_dir, exist_ok=True)
    stl_files = []
    for idx, (sname, tris) in enumerate(shells):
        safe = re.sub(r"[^A-Za-z0-9_]+", "_", sname).strip("_") or f"Part_{idx + 1}"
        stl_path = os.path.join(out_dir, f"{idx + 1:02d}_{safe}.stl")
        with open(stl_path, "wb") as f:
            hdr = f"LLMCompare {safe}".encode("ascii", errors="ignore")[:80].ljust(80, b"\x00")
            f.write(hdr)
            f.write(struct.pack("<I", len(tris)))
            for p0_id, p1_id, p2_id in tris:
                p0 = pts.get(p0_id, (0.0, 0.0, 0.0))
                p1 = pts.get(p1_id, (0.0, 0.0, 0.0))
                p2 = pts.get(p2_id, (0.0, 0.0, 0.0))
                ux, uy, uz = p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]
                vx, vy, vz = p2[0] - p0[0], p2[1] - p0[1], p2[2] - p0[2]
                nx, ny, nz = uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx
                nl = (nx * nx + ny * ny + nz * nz) ** 0.5 or 1.0
                f.write(
                    struct.pack(
                        "<12fH",
                        nx / nl, ny / nl, nz / nl,
                        p0[0], p0[1], p0[2],
                        p1[0], p1[1], p1[2],
                        p2[0], p2[1], p2[2],
                        0,
                    )
                )
        stl_files.append((sname, stl_path))
    return stl_files


def _save_local_fusion_script_and_step(body, fusion_script):
    """Save the STEP AP214 solid + per-part binary STLs to ~/Downloads and the standalone Script to Fusion's API/Scripts folder."""
    saved_paths = {}
    raw_title = str(body.get("title") or "LLMCompare_3D_Model")
    safe_name = re.sub(r"[^A-Za-z0-9_]+", "_", raw_title).strip("_") or "LLMCompare_3D_Model"
    step_text = _extract_step_text(body, fusion_script)
    part_stl_files = []
    try:
        if step_text and "ISO-10303-21" in step_text:
            dl_dir = os.path.expanduser("~/Downloads")
            os.makedirs(dl_dir, exist_ok=True)
            step_path = os.path.join(dl_dir, f"{safe_name}.step")
            with open(step_path, "w", encoding="utf-8") as f:
                f.write(step_text)
            saved_paths["stepPath"] = step_path
            stl_dir = os.path.join(dl_dir, "LLMCompare_Fusion360", safe_name)
            part_stl_files = _step_to_part_stls(step_text, stl_dir)
            saved_paths["partStlCount"] = len(part_stl_files)
            saved_paths["partStlDir"] = stl_dir
    except Exception as exc:
        print(f"[Fusion MCP] Warning while extracting STEP/STL files: {exc}")

    saved_paths["partStlFiles"] = part_stl_files

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


def _build_compact_mcp_script(fusion_script, step_path, part_stl_files=None, raw_title="LLMCompare_3D_Model", params=None):
    """
    Build a compact ~1.8 KB Fusion 360 Python script (`def run(_context: str = None):`) that:
      1. Deletes any empty 0-body `llm-compare*` placeholder components from prior runs
      2. Creates a new component for this slot/model
      3. Imports every pre-extracted binary `.stl` part in `part_stl_files` via
         `comp.meshBodies.add(stl_path, adsk.fusion.MeshUnits.MillimeterMeshUnit)` so all
         parts appear inside the component's `Bodies` folder in <50ms at 1:1 mm scale
      4. Registers parametric userParameters and fits the active viewport.
    """
    part_stl_files = part_stl_files or []
    safe_title = re.sub(r"[^A-Za-z0-9_-]+", "_", str(raw_title or "LLMCompare_3D_Model")).strip("_")[:48] or "LLMCompare_3D_Model"
    if not isinstance(params, dict):
        m_params = re.search(r"PARAMS\s*=\s*(\{[^\n]+\})", fusion_script)
        if m_params:
            try:
                params = json.loads(m_params.group(1))
            except Exception:
                params = {}
        else:
            params = {}

    if part_stl_files:
        return (
            "import adsk.core, adsk.fusion, os, traceback\n\n"
            f"MODEL_NAME = {json.dumps(safe_title)}\n"
            f"PART_STL_FILES = {json.dumps(part_stl_files)}\n"
            f"STEP_FILE_PATH = {json.dumps(step_path or '')}\n"
            f"PARAMS = {json.dumps(params)}\n\n"
            "def run(_context: str = None):\n"
            "    app = adsk.core.Application.get()\n"
            "    try:\n"
            "        design = adsk.fusion.Design.cast(app.activeProduct)\n"
            "        if not design:\n"
            "            doc = app.documents.add(adsk.core.DocumentTypes.FusionDesignDocumentType)\n"
            "            design = adsk.fusion.Design.cast(app.activeProduct)\n"
            "        root = design.rootComponent\n"
            "        for i in range(root.occurrences.count - 1, -1, -1):\n"
            "            occ = root.occurrences.item(i)\n"
            "            c = occ.component\n"
            "            if c.name.lower().startswith('llm-compare') and c.meshBodies.count == 0 and c.bRepBodies.count == 0:\n"
            "                occ.deleteMe()\n"
            "        occ = root.occurrences.addNewComponent(adsk.core.Matrix3D.create())\n"
            "        comp = occ.component\n"
            "        comp.name = MODEL_NAME\n"
            "        mm_unit = adsk.fusion.MeshUnits.MillimeterMeshUnit\n"
            "        imported = 0\n"
            "        for part_name, stl_path in PART_STL_FILES:\n"
            "            if os.path.exists(stl_path):\n"
            "                added = comp.meshBodies.add(stl_path, mm_unit)\n"
            "                for m_idx in range(added.count):\n"
            "                    added.item(m_idx).name = part_name\n"
            "                    imported += 1\n"
            "        if imported == 0 and STEP_FILE_PATH and os.path.exists(STEP_FILE_PATH):\n"
            "            step_opts = app.importManager.createSTEPImportOptions(STEP_FILE_PATH)\n"
            "            app.importManager.importToTarget(step_opts, comp)\n"
            "        user_params = design.userParameters\n"
            "        for k, v in PARAMS.items():\n"
            "            if isinstance(v, (int, float)):\n"
            "                existing = user_params.itemByName(k)\n"
            "                val_input = adsk.core.ValueInput.createByReal(float(v) * 0.1)\n"
            "                if existing:\n"
            "                    existing.expression = f'{float(v)} mm'\n"
            "                else:\n"
            "                    user_params.add(k, val_input, 'mm', 'LLM Compare CAD Arena parameter')\n"
            "        if app.activeViewport:\n"
            "            app.activeViewport.fit()\n"
            "        adsk.doEvents()\n"
            "        print(f\"Imported {imported} 3D bodies into component '{comp.name}' (meshBodies={comp.meshBodies.count}, bRepBodies={comp.bRepBodies.count}).\")\n"
            "    except Exception:\n"
            "        if app and app.userInterface:\n"
            "            app.userInterface.messageBox('LLM Compare Import Failed:\\n' + traceback.format_exc())\n"
        )

    compact = re.sub(
        r'STEP_ZLIB_B64\s*=\s*"[^"]*"',
        'STEP_ZLIB_B64 = ""',
        fusion_script,
    )
    if step_path:
        escaped_path = json.dumps(step_path)
        if "STEP_FILE_PATH =" in compact:
            compact = re.sub(
                r'STEP_FILE_PATH\s*=\s*"[^"]*"',
                f"STEP_FILE_PATH = {escaped_path}",
                compact,
            )
    compact = re.sub(r"def\s+run\s*\([^)]*\)\s*:", "def run(_context: str = None):", compact, count=1)
    return compact


def _build_candidate_tool_args(chosen_tool, compact_script):
    """
    Inspect `chosen_tool['inputSchema']` from Autodesk Fusion MCP (`fusion_mcp_execute`)
    and produce ordered candidate argument dicts so we match the exact schema on the first try.
    """
    candidates = []
    seen = set()

    def _add(obj):
        key = json.dumps(obj, sort_keys=True)
        if key not in seen:
            seen.add(key)
            candidates.append(obj)

    schema = (chosen_tool or {}).get("inputSchema") or {}
    tname = str((chosen_tool or {}).get("name") or "")

    # Gather properties from top-level and any oneOf / anyOf / allOf branches
    prop_maps = []
    if isinstance(schema.get("properties"), dict):
        prop_maps.append(schema["properties"])
    for branch_key in ("oneOf", "anyOf", "allOf"):
        for sub in schema.get(branch_key) or []:
            if isinstance(sub, dict) and isinstance(sub.get("properties"), dict):
                prop_maps.append(sub["properties"])

    for props in prop_maps:
        ft_key = "featureType" if "featureType" in props else ("feature_type" if "feature_type" in props else None)
        other_keys = [k for k in props.keys() if k not in ("featureType", "feature_type")]

        if ft_key:
            # Look for direct script/code string property alongside featureType
            for k in ("script", "code", "python_code", "python", "source", "body", "command", "content"):
                if k in props:
                    _add({ft_key: "script", k: compact_script})
            # Inspect other properties alongside featureType (e.g. `object`, `feature`, `parameters`, `input`, `data`)
            for k in other_keys:
                ps = props.get(k) or {}
                if not isinstance(ps, dict):
                    continue
                ptype = ps.get("type")
                sub_props = ps.get("properties") if isinstance(ps.get("properties"), dict) else {}
                for bk in ("oneOf", "anyOf", "allOf"):
                    for sub in ps.get(bk) or []:
                        if isinstance(sub, dict) and isinstance(sub.get("properties"), dict):
                            sub_props = {**sub_props, **sub["properties"]}
                if sub_props:
                    for sk in ("script", "code", "python_code", "python", "source", "body", "command", "content"):
                        if sk in sub_props:
                            _add({ft_key: "script", k: {sk: compact_script}})
                    if len(sub_props) == 1:
                        only_k = list(sub_props.keys())[0]
                        _add({ft_key: "script", k: {only_k: compact_script}})
                if ptype == "string":
                    _add({ft_key: "script", k: compact_script})
                elif ptype == "object" or not ptype:
                    _add({ft_key: "script", k: {"script": compact_script}})
                    _add({ft_key: "script", k: compact_script})
        else:
            if len(props) == 1:
                only_k = list(props.keys())[0]
                if only_k not in ("featureType", "feature_type"):
                    _add({only_k: compact_script})
            for k in ("script", "code", "python_code", "python", "source", "command", "fusionScript"):
                if k in props:
                    _add({k: compact_script})

    # Standard Autodesk Fusion MCP `fusion_mcp_execute` argument shapes
    if tname == "fusion_mcp_execute" or not candidates:
        _add({"featureType": "script", "script": compact_script})
        _add({"featureType": "script", "object": {"script": compact_script}})
        _add({"featureType": "script", "feature": {"script": compact_script}})
        _add({"featureType": "script", "object": compact_script})
        _add({"featureType": "script", "feature": compact_script})
        _add({"featureType": "script", "code": compact_script})
        _add({"feature_type": "script", "feature": {"script": compact_script}})
        _add({"feature_type": "script", "script": compact_script})
        _add({"script": compact_script})

    return candidates


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
                        "clientInfo": {"name": "llm-compare-3d-arena", "version": "1.0.59"},
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


def _extract_mcp_error_text(call_res):
    if not isinstance(call_res, dict):
        return ""
    if call_res.get("error"):
        err = call_res["error"]
        return str(err.get("message") if isinstance(err, dict) else err)
    res = call_res.get("result")
    if isinstance(res, dict) and res.get("isError"):
        content = res.get("content") or []
        parts = [str(c.get("text") or "") for c in content if isinstance(c, dict)]
        return " ".join(p for p in parts if p).strip() or "Tool returned isError=true"
    return ""


def forward_script_to_fusion_mcp(target_url, body):
    fusion_script = body.get("fusionScript") or body.get("script") or body.get("code") or ""
    if not fusion_script:
        return 400, {"ok": False, "error": "Missing fusionScript in request payload."}

    # 1. Save STEP file + per-part binary STLs & standalone script locally on the Mac first
    saved_paths = _save_local_fusion_script_and_step(body, fusion_script)
    step_path = saved_paths.get("stepPath") or ""
    part_stl_files = saved_paths.get("partStlFiles") or []
    raw_title = str(body.get("title") or "LLMCompare_3D_Model")

    # 2. Build compact ~1.8 KB script that imports all per-part binary STLs directly into comp.meshBodies
    compact_script = _build_compact_mcp_script(
        fusion_script,
        step_path,
        part_stl_files=part_stl_files,
        raw_title=raw_title,
        params=body.get("params"),
    )
    if saved_paths.get("fusionScriptPath"):
        try:
            with open(saved_paths["fusionScriptPath"], "w", encoding="utf-8") as f:
                f.write(compact_script)
        except Exception:
            pass

    # 3. Connect to Fusion 360 MCP and list tools
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

    # Handle non-JSON-RPC local REST bridge
    if isinstance(init_res, dict) and not init_res.get("jsonrpc") and init_res.get("ok"):
        try:
            _, _, direct_res = _mcp_post(
                resolved_url,
                {
                    "tool": "fusion360_import_model",
                    "slot": body.get("slot") or "A",
                    "title": body.get("title") or "LLM_Compare_Model",
                    "stepPath": step_path,
                    "params": body.get("params") or {},
                    "fusionScript": compact_script,
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

    preferred_names = (
        "fusion_mcp_execute",
        "execute_python",
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
            if isinstance(t, dict) and re.search(r"exec|python|script|run|code|eval|import", str(t.get("name") or ""), re.I):
                chosen = t
                break
    if not chosen and tools:
        chosen = tools[0]

    tool_name = (chosen.get("name") if chosen else None) or "fusion_mcp_execute"
    if chosen and chosen.get("inputSchema"):
        schema_props = list(((chosen["inputSchema"].get("properties")) or {}).keys())
        schema_req = chosen["inputSchema"].get("required") or []
        print(f"[Fusion MCP] Tool '{tool_name}' schema properties={schema_props} required={schema_req}")

    candidate_args_list = _build_candidate_tool_args(chosen, compact_script)

    last_call_res = None
    last_err_msg = ""
    for idx, tool_args in enumerate(candidate_args_list):
        arg_summary = {k: (f"<{len(v)} chars>" if isinstance(v, str) and len(v) > 60 else (
            {sk: f"<{len(sv)} chars>" if isinstance(sv, str) and len(sv) > 60 else sv for sk, sv in v.items()}
            if isinstance(v, dict) else v
        )) for k, v in tool_args.items()}
        print(f"[Fusion MCP] Attempt {idx + 1}: tools/call '{tool_name}' args={arg_summary} (parts={len(part_stl_files)}, STEP={step_path or 'none'})...")
        try:
            status, _, call_res = _mcp_post(
                resolved_url,
                {
                    "jsonrpc": "2.0",
                    "id": 10 + idx,
                    "method": "tools/call",
                    "params": {
                        "name": tool_name,
                        "arguments": tool_args,
                    },
                },
                session_id=session_id,
                timeout=35,
            )
            last_call_res = call_res
            err_text = _extract_mcp_error_text(call_res)
            is_err = bool(err_text) or bool((call_res or {}).get("error")) or bool(((call_res or {}).get("result") or {}).get("isError"))
            if not is_err:
                print(f"[Fusion MCP] ✓ Successfully executed '{tool_name}' in Fusion 360! Result: {call_res}")
                return 200, {
                    "ok": True,
                    "pushed": True,
                    "endpointUrl": resolved_url,
                    "tool": tool_name,
                    "discoveredTools": discovered_tools,
                    "mcpResult": call_res,
                    "savedPaths": saved_paths,
                }
            last_err_msg = err_text or str(call_res)
            print(f"[Fusion MCP] Attempt {idx + 1} returned error: {last_err_msg}")
            # If the error is a parameter/schema mismatch, try the next candidate argument shape
            if re.search(r"missing required|required parameter|invalid|unexpected|property|schema|argument|feature_type|featureType|-32602", last_err_msg, re.I):
                continue
            # Otherwise it's a runtime message from Fusion 360 itself (e.g. dialog open), so stop and report it
            break
        except urllib.error.HTTPError as he:
            err_body = _parse_mcp_response(he.read()) if he.fp else {}
            last_err_msg = f"Fusion MCP tools/call HTTP {he.code}: {err_body}"
            print(f"[Fusion MCP] Attempt {idx + 1} HTTP error: {last_err_msg}")
            if he.code in (400, 422):
                continue
            return he.code, {"ok": False, "error": last_err_msg, "details": err_body, "savedPaths": saved_paths}
        except Exception as exc:
            last_err_msg = f"Fusion MCP tools/call failed: {exc}"
            print(f"[Fusion MCP] Attempt {idx + 1} exception: {last_err_msg}")
            break

    return 400, {
        "ok": False,
        "pushed": False,
        "endpointUrl": resolved_url,
        "tool": tool_name,
        "error": last_err_msg or "Fusion MCP rejected tool call",
        "discoveredTools": discovered_tools,
        "mcpResult": last_call_res,
        "savedPaths": saved_paths,
    }


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
    print("🚀 LLM Compare -> Fusion 360 Local MCP Bridge (v1.0.59) active on Mac!")
    print(f"   Browser CORS Endpoint : http://{LISTEN_HOST}:{LISTEN_PORT}/mcp")
    print(f"   Forwarding to Fusion  : {DEFAULT_FUSION_MCP}")
    resolved, _, _, startup_tools, startup_err = _connect_and_list_tools(DEFAULT_FUSION_MCP)
    if startup_err is None:
        t_names = [t.get("name") for t in startup_tools if isinstance(t, dict) and t.get("name")]
        print(f"   ✓ Fusion 360 MCP Live : {resolved} (Tools: {t_names})")
        for t in startup_tools:
            if isinstance(t, dict) and t.get("name") == "fusion_mcp_execute":
                sch = t.get("inputSchema") or {}
                print(f"   ✓ fusion_mcp_execute  : required={sch.get('required')} properties={list((sch.get('properties') or {}).keys())}")
    else:
        print(f"   ⚠ Fusion 360 MCP Note : {startup_err}")
    print("======================================================================")
    print("Now click '🚀 Push to Local MCP' in LLM Compare (3D & CAD Arena).")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        sys.exit(0)
