"""Guards a server built with the official MCP Python SDK (`mcp`, 1.x and 2.x): FastMCP / MCPServer or
the low-level Server.

    server = MCPServer("my-tools")      # FastMCP("my-tools") on mcp 1.x
    mcpwatch(server)                     # the only line added, before run()

stdio and SSE: every message on the connection's streams is checked (`Server.run` is wrapped).
Streamable HTTP: the app from `server.streamable_http_app()` comes back wrapped in McpWatchASGI.
"""

from __future__ import annotations

import hashlib
import uuid
from dataclasses import dataclass
from typing import Any

import anyio
from pydantic import TypeAdapter

from .asgi import GUARDED, McpWatchASGI
from .engine import Engine, Msg, log
from .options import make_engine

try:  # mcp 2.x
    from mcp_types import JSONRPCMessage
except ImportError:  # mcp 1.x
    from mcp.types import JSONRPCMessage
from mcp.shared.message import SessionMessage

_messages: TypeAdapter[Any] = TypeAdapter(JSONRPCMessage)


@dataclass
class McpWatchHandle:
    engine: Engine | None

    @property
    def enabled(self) -> bool:
        return self.engine is not None

    @property
    def mode(self) -> str:
        return self.engine.mode if self.engine else "off"

    def set_mode(self, mode: str) -> None:
        """Change the mode at runtime; "off" passes everything through."""
        if self.engine:
            self.engine.set_mode(mode)


def mcpwatch(server: Any, *, name: str | None = None, enabled: bool | None = None, **options: Any) -> McpWatchHandle:
    """Guards an MCP server: every message between any client and it is checked by MCPWatch.

    Call it once, before running the server. Clients need no changes. Options are those of the Node
    middleware in snake_case (project_key, server, mode, deny_tools, allowed_origins, require_auth, ai, …);
    left out, they come from the MCPWATCH_* environment variables.
    """
    low = getattr(server, "_lowlevel_server", None) or getattr(server, "_mcp_server", None) or server
    engine = make_engine(name or getattr(low, "name", None) or "mcp-server", enabled=enabled, **options)
    if engine is None:
        return McpWatchHandle(None)

    run = low.run

    async def guarded_run(read_stream: Any, write_stream: Any, *args: Any, **kwargs: Any) -> Any:
        return await _GuardedConnection(engine).run(run, read_stream, write_stream, *args, **kwargs)

    low.run = guarded_run

    build = getattr(server, "streamable_http_app", None)
    if callable(build):
        def guarded_app(*args: Any, **kwargs: Any) -> Any:
            app = build(*args, **kwargs)
            path = kwargs.get("streamable_http_path") or getattr(getattr(server, "settings", None), "streamable_http_path", None) or "/mcp"
            return McpWatchASGI(app, engine=engine, path=path)

        server.streamable_http_app = guarded_app

    log.warning("[mcpwatch] guarding \"%s\"", engine.name)
    return McpWatchHandle(engine)


class _GuardedConnection:
    """One run() of the server: sits between the transport's streams and the server's session."""

    def __init__(self, engine: Engine) -> None:
        self.engine = engine
        self.conn_id = f"conn-{uuid.uuid4().hex[:8]}"
        self.session = self.conn_id
        # Requests that came through McpWatchASGI were checked there already.
        self.bypass = False

    async def run(self, run: Any, read_stream: Any, write_stream: Any, *args: Any, **kwargs: Any) -> Any:
        to_server, server_reads = anyio.create_memory_object_stream(0)
        server_writes, to_client = anyio.create_memory_object_stream(0)
        inbound = anyio.CancelScope()

        async def pump_in() -> None:
            with inbound:
                try:
                    async for item in read_stream:
                        await self._from_client(item, to_server, write_stream)
                finally:
                    to_server.close()

        async def pump_out() -> None:
            async for item in to_client:
                await self._from_server(item, write_stream, to_server)

        try:
            async with anyio.create_task_group() as tg:
                tg.start_soon(pump_in)
                tg.start_soon(pump_out)
                try:
                    return await run(server_reads, server_writes, *args, **kwargs)
                finally:
                    # Messages the server already wrote still go out; then both pumps stop.
                    server_writes.close()
                    inbound.cancel()
                    self._closed()
        finally:
            # The server closes the streams it was given when it's done; the transport waits for that
            # on its own (stdio's writer only stops when its stream closes).
            await write_stream.aclose()

    async def _from_client(self, item: Any, to_server: Any, write_stream: Any) -> None:
        if not isinstance(item, SessionMessage) or self._bypassed(item):
            await to_server.send(item)
            return
        headers = self._headers(item)
        self.session = self._session_for(headers)
        msg = _dump(item.message)
        forward, reply = await self.engine.afrom_client(self.session, msg, {"headers": headers} if headers else None)
        if reply:
            await write_stream.send(SessionMessage(_messages.validate_python(reply)))
        if forward is not None:
            await to_server.send(item if forward == msg else SessionMessage(_messages.validate_python(forward), metadata=item.metadata))

    async def _from_server(self, item: Any, write_stream: Any, to_server: Any) -> None:
        if self.bypass or not isinstance(item, SessionMessage):
            await write_stream.send(item)
            return
        msg = _dump(item.message)
        forward, reply = await self.engine.afrom_server(self.session, msg)
        # A reply owed to the server itself (a refused sampling request) goes back in as a client message.
        if reply:
            try:
                await to_server.send(SessionMessage(_messages.validate_python(reply)))
            except anyio.ClosedResourceError:
                pass
        if forward is not None:
            await write_stream.send(item if forward == msg else SessionMessage(_messages.validate_python(forward), metadata=item.metadata))

    def _bypassed(self, item: SessionMessage) -> bool:
        request = getattr(item.metadata, "request_context", None)
        if request is not None and getattr(request, "scope", {}).get(GUARDED):
            self.bypass = True
        return self.bypass

    @staticmethod
    def _headers(item: SessionMessage) -> dict[str, str] | None:
        request = getattr(item.metadata, "request_context", None)
        headers = getattr(request, "headers", None)
        return {k.lower(): v for k, v in headers.items()} if headers is not None else None

    # stdio: one session per connection. HTTP: the MCP session id, else the caller's token, else one
    # shared bucket (stateless servers serve each request on a new connection).
    def _session_for(self, headers: dict[str, str] | None) -> str:
        if not headers:
            return self.session
        sid = headers.get("mcp-session-id")
        if sid:
            new = f"http-session-{sid}"
            if self.session == self.conn_id:
                self.engine.note("rename", **{"from": self.conn_id, "to": new})
            return new
        auth = headers.get("authorization") or headers.get("x-api-key")
        if auth:
            return f"tok-{hashlib.sha256(auth.encode()).hexdigest()[:12]}"
        return self.session if self.session.startswith("http-session-") else "http-anonymous"

    def _closed(self) -> None:
        if self.session == self.conn_id or self.session.startswith("http-session-"):
            self.engine.note("drop", session=self.session)


def _dump(message: Any) -> Msg:
    return _messages.dump_python(message, by_alias=True, mode="json", exclude_none=True)
