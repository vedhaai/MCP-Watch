"""A small MCP server built with the official Python SDK, guarded by mcpwatch(server).

    python demo_server.py            # stdio
    python demo_server.py --http 3002  # Streamable HTTP on http://127.0.0.1:3002/mcp

File tools are confined to tests/sandbox; run_command is simulated.
"""

from __future__ import annotations

import sys
from pathlib import Path

try:
    from mcp.server.mcpserver import MCPServer as Server  # mcp 2.x
except ImportError:
    from mcp.server.fastmcp import FastMCP as Server  # mcp 1.x

from mcpwatch import mcpwatch

SANDBOX = Path(__file__).resolve().parent / "sandbox"

server = Server("py-demo-tools")


@server.tool()
def calculator(expression: str) -> str:
    """Evaluate a simple arithmetic expression."""
    if not set(expression) <= set("0123456789+-*/(). "):
        return "unsupported expression"
    return str(eval(expression))  # noqa: S307 - digits and operators only


@server.tool()
def read_file(path: str) -> str:
    """Read a text file from the sandbox."""
    target = (SANDBOX / path).resolve()
    if SANDBOX not in target.parents:
        return "outside the sandbox"
    return target.read_text(encoding="utf-8")


@server.tool()
def run_command(command: str) -> str:
    """Run a shell command (simulated)."""
    return f"(simulated) ran: {command}"


guard = mcpwatch(server)

if __name__ == "__main__":
    if "--http" in sys.argv:
        import uvicorn

        port = int(sys.argv[sys.argv.index("--http") + 1])
        uvicorn.run(server.streamable_http_app(), host="127.0.0.1", port=port, log_level="warning")
    else:
        server.run()
