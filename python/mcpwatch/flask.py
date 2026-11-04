"""Flask: guard the MCP endpoint of a Flask app.

    app = Flask(__name__)
    McpWatch(app, name="my-tools")       # or McpWatch().init_app(app)

Options left out come from app.config (MCPWATCH_PROJECT_KEY, MCPWATCH_MODE, …), then the environment.
"""

from __future__ import annotations

from collections.abc import Iterable
from typing import Any

from .wsgi import McpWatchWSGI

_CONFIG = {"MCPWATCH_PROJECT_KEY": "project_key", "MCPWATCH_SERVER": "server", "MCPWATCH_MODE": "mode",
           "MCPWATCH_DENY_TOOLS": "deny_tools", "MCPWATCH_ENABLED": "enabled"}


class McpWatch:
    def __init__(self, app: Any = None, *, path: str | Iterable[str] | None = "/mcp", **options: Any) -> None:
        self.path = path
        self.options = options
        self.middleware: McpWatchWSGI | None = None
        if app is not None:
            self.init_app(app)

    def init_app(self, app: Any) -> None:
        options = {opt: app.config[key] for key, opt in _CONFIG.items() if key in app.config}
        options.update(self.options)
        options.setdefault("name", app.name)
        self.middleware = McpWatchWSGI(app.wsgi_app, path=self.path, **options)
        app.wsgi_app = self.middleware
        app.extensions["mcpwatch"] = self

    @property
    def engine(self) -> Any:
        return self.middleware.engine if self.middleware else None
