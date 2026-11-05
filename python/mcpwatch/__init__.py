"""MCPWatch for Python: a security guard for MCP servers.

    mcpwatch(server)                         # official MCP SDK (MCPServer / FastMCP / low-level Server)
    McpWatchASGI(app) / McpWatchWSGI(app)    # any ASGI or WSGI app serving MCP over HTTP
    mcpwatch.django.McpWatchMiddleware       # Django MIDDLEWARE
    mcpwatch.flask.McpWatch(app)             # Flask

The checks run in the MCPWatch engine (Node 20+), started as a child process.
"""

from .asgi import McpWatchASGI
from .engine import Engine, EngineUnavailable
from .http import HttpGuard
from .wsgi import McpWatchWSGI


def mcpwatch(server, **options):  # type: ignore[no-untyped-def]
    """Guards a server built with the official MCP Python SDK. See mcpwatch.sdk.mcpwatch."""
    from .sdk import mcpwatch as guard

    return guard(server, **options)


__all__ = ["Engine", "EngineUnavailable", "HttpGuard", "McpWatchASGI", "McpWatchWSGI", "mcpwatch"]
__version__ = "0.1.0"
