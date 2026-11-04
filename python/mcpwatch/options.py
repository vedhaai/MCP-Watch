from __future__ import annotations

import os
from typing import Any

from .engine import Engine, EngineUnavailable, log


def make_engine(name: str = "mcp-server", *, enabled: bool | None = None, start: bool = True,
                **options: Any) -> Engine | None:
    """The engine for one guarded server, or None when MCPWatch is off (enabled=False or MCPWATCH_ENABLED=0).

    Options left out come from the same environment variables as the Node package (MCPWATCH_PROJECT_KEY,
    MCPWATCH_SERVER, MCPWATCH_MODE, MCPWATCH_AI, …), read by the engine itself.
    """
    on = enabled if enabled is not None else os.environ.get("MCPWATCH_ENABLED") != "0"
    if not on:
        return None
    engine = Engine(name, **options)
    if start:
        try:
            engine.start()
        except EngineUnavailable as e:
            what = "messages pass unchecked" if engine.fail_open else "requests are refused"
            log.error("[mcpwatch] %s; %s until it starts", e, what)
    return engine
