"""ASGI middleware: FastAPI, Starlette, Django (asgi.py), Quart, or the MCP SDK's own HTTP app.

    app.add_middleware(McpWatchASGI)                    # FastAPI / Starlette
    application = McpWatchASGI(get_asgi_application())  # Django asgi.py
"""

from __future__ import annotations

import asyncio
import json
from collections.abc import Iterable
from typing import Any

from .engine import Engine, Msg
from .http import HttpGuard, ResponseFilter
from .options import make_engine

# Set on the scope of every request this middleware guards, so the SDK hook doesn't check it twice.
GUARDED = "mcpwatch.guarded"


class McpWatchASGI:
    def __init__(self, app: Any, *, path: str | Iterable[str] | None = "/mcp", engine: Engine | None = None,
                 name: str = "mcp-server", **options: Any) -> None:
        self.app = app
        self.engine = engine or make_engine(name, **options)
        self.guard = HttpGuard(self.engine, path) if self.engine else None

    async def __call__(self, scope: dict[str, Any], receive: Any, send: Any) -> None:
        if scope["type"] != "http" or not self.guard or not self.guard.matches(scope.get("path", "")):
            await self.app(scope, receive, send)
            return
        guard = self.guard
        method = scope.get("method", "GET")
        body = b""
        if method == "POST":
            while True:
                message = await receive()
                body += message.get("body", b"")
                if not message.get("more_body"):
                    break
        headers = {k.decode("latin-1").lower(): v.decode("latin-1") for k, v in scope.get("headers", [])}
        client = scope.get("client")
        check = await asyncio.to_thread(guard.check_request, method, headers, body, client[0] if client else None,
                                        scope.get("scheme") == "https")
        if check.refuse:
            await _answer(send, 403, b"Refused by MCPWatch", b"text/plain")
            return
        if check.reply is not None:
            await _answer(send, 200, check.reply, b"application/json")
            return

        sent_body = False

        async def replay() -> dict[str, Any]:
            nonlocal sent_body
            if method == "POST" and not sent_body:
                sent_body = True
                return {"type": "http.request", "body": check.body, "more_body": False}
            return await receive()

        loop = asyncio.get_running_loop()

        def reply_to_server(msg: Msg) -> None:
            asyncio.run_coroutine_threadsafe(self._reply_to_server(scope, msg), loop)

        filt: ResponseFilter | None = None
        start: dict[str, Any] = {}
        held: list[bytes] = []

        async def guarded_send(message: dict[str, Any]) -> None:
            nonlocal filt
            if message["type"] == "http.response.start":
                out = {k.decode("latin-1").lower(): v.decode("latin-1") for k, v in message.get("headers", [])}
                filt = await asyncio.to_thread(guard.response, check, out, reply_to_server)
                start.update(message)
                if filt.kind == "sse":
                    await send(_without_length(message))
                elif filt.kind == "raw":
                    await send(message)
                return
            if message["type"] != "http.response.body" or filt is None:
                await send(message)
                return
            chunk, more = message.get("body", b""), message.get("more_body", False)
            if filt.kind == "json":
                held.append(chunk)
                if not more:
                    out = await asyncio.to_thread(filt.json, b"".join(held))
                    await send(_with_length(start, len(out)))
                    await send({"type": "http.response.body", "body": out})
            elif filt.kind == "sse":
                out = await asyncio.to_thread(filt.feed, chunk)
                if not more:
                    out += await asyncio.to_thread(filt.end)
                if out or not more:
                    await send({"type": "http.response.body", "body": out, "more_body": more})
            else:
                await send(message)

        try:
            await self.app({**scope, GUARDED: True}, replay, guarded_send)
        finally:
            guard.finished(check)

    # A reply the guard owes the server (a refused sampling request) goes in as its own POST.
    async def _reply_to_server(self, scope: dict[str, Any], msg: Msg) -> None:
        body = json.dumps(msg).encode()
        headers = [(k, v) for k, v in scope.get("headers", []) if k.lower() not in (b"content-length", b"content-type")]
        sub = {**scope, "method": "POST", "headers": [*headers, (b"content-type", b"application/json"),
                                                      (b"content-length", str(len(body)).encode())]}
        done = False

        async def receive() -> dict[str, Any]:
            nonlocal done
            if not done:
                done = True
                return {"type": "http.request", "body": body, "more_body": False}
            await asyncio.Event().wait()  # never disconnects
            return {"type": "http.disconnect"}

        async def discard(_: dict[str, Any]) -> None:
            pass

        await self.app({**sub, GUARDED: True}, receive, discard)


async def _answer(send: Any, status: int, body: bytes, content_type: bytes) -> None:
    await send({"type": "http.response.start", "status": status,
                "headers": [(b"content-type", content_type), (b"content-length", str(len(body)).encode())]})
    await send({"type": "http.response.body", "body": body})


def _without_length(start: dict[str, Any]) -> dict[str, Any]:
    return {**start, "headers": [(k, v) for k, v in start.get("headers", []) if k.lower() != b"content-length"]}


def _with_length(start: dict[str, Any], length: int) -> dict[str, Any]:
    headers = _without_length(start)["headers"]
    return {**start, "headers": [*headers, (b"content-length", str(length).encode())]}
