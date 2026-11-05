"""A hand-written MCP endpoint (JSON responses, no SDK), as a Flask or Django view would serve it."""

from __future__ import annotations

from pathlib import Path
from typing import Any

SANDBOX = Path(__file__).resolve().parent / "sandbox"

TOOLS = [
    {"name": "calculator", "description": "Evaluate a simple arithmetic expression.",
     "inputSchema": {"type": "object", "properties": {"expression": {"type": "string"}}, "required": ["expression"]}},
    {"name": "read_file", "description": "Read a text file from the sandbox.",
     "inputSchema": {"type": "object", "properties": {"path": {"type": "string"}}, "required": ["path"]}},
]


def call_tool(name: str, args: dict[str, Any]) -> str:
    if name == "calculator":
        expr = args.get("expression", "")
        return str(eval(expr)) if set(expr) <= set("0123456789+-*/(). ") else "unsupported"  # noqa: S307
    if name == "read_file":
        target = (SANDBOX / args.get("path", "")).resolve()
        return target.read_text(encoding="utf-8") if SANDBOX in target.parents else "outside the sandbox"
    raise KeyError(name)


def handle(msg: dict[str, Any]) -> dict[str, Any] | None:
    if "id" not in msg:
        return None  # notification
    method, rid = msg.get("method"), msg["id"]
    if method == "initialize":
        result: Any = {"protocolVersion": "2025-06-18", "capabilities": {"tools": {}},
                       "serverInfo": {"name": "web-tools", "version": "1.0.0"}}
    elif method == "tools/list":
        result = {"tools": TOOLS}
    elif method == "tools/call":
        text = call_tool(msg["params"]["name"], msg["params"].get("arguments", {}))
        result = {"content": [{"type": "text", "text": text}]}
    else:
        return {"jsonrpc": "2.0", "id": rid, "error": {"code": -32601, "message": "Method not found"}}
    return {"jsonrpc": "2.0", "id": rid, "result": result}


INIT = {"jsonrpc": "2.0", "id": 1, "method": "initialize",
        "params": {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "pytest", "version": "1.0"}}}


def call(rid: int, name: str, **arguments: Any) -> dict[str, Any]:
    return {"jsonrpc": "2.0", "id": rid, "method": "tools/call", "params": {"name": name, "arguments": arguments}}
