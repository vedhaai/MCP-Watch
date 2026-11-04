"""Django middleware for MCP servers served by Django views.

    MIDDLEWARE = ["mcpwatch.django.McpWatchMiddleware", ...]   # first, so it sees what the client sent
    MCPWATCH = {"name": "my-tools", "path": "/mcp", "project_key": "mw_..."}   # optional

Options left out come from the MCPWATCH_* environment variables. To guard at the server boundary
instead, wrap the app in wsgi.py or asgi.py with McpWatchWSGI / McpWatchASGI.
"""

from __future__ import annotations

import asyncio
import io
from collections.abc import AsyncIterator, Iterator
from typing import Any

from django.conf import settings
from django.http import HttpRequest, HttpResponse

from .http import HttpGuard, ResponseFilter
from .options import make_engine


class McpWatchMiddleware:
    sync_capable = True
    async_capable = False

    def __init__(self, get_response: Any) -> None:
        self.get_response = get_response
        options = dict(getattr(settings, "MCPWATCH", {}))
        path = options.pop("path", "/mcp")
        engine = make_engine(options.pop("name", "mcp-server"), **options)
        self.guard = HttpGuard(engine, path) if engine else None

    def __call__(self, request: HttpRequest) -> Any:
        if not self.guard or not self.guard.matches(request.path):
            return self.get_response(request)
        guard = self.guard
        body = request.body if request.method == "POST" else b""
        headers = {k.lower(): v for k, v in request.headers.items()}
        check = guard.check_request(request.method or "GET", headers, body, request.META.get("REMOTE_ADDR"), request.is_secure())
        if check.refuse:
            return HttpResponse(b"Refused by MCPWatch", status=403, content_type="text/plain")
        if check.reply is not None:
            return HttpResponse(check.reply, content_type="application/json")
        if check.changed:
            request._body = check.body  # type: ignore[attr-defined]
            request._stream = io.BytesIO(check.body)  # type: ignore[attr-defined]
            request.META["CONTENT_LENGTH"] = str(len(check.body))

        response = self.get_response(request)
        filt = guard.response(check, dict(response.items()))
        if filt.kind == "json" and not response.streaming:
            response.content = filt.json(response.content)
            if response.has_header("Content-Length"):
                response["Content-Length"] = str(len(response.content))
            guard.finished(check)
        elif filt.kind == "sse" and response.streaming:
            if response.has_header("Content-Length"):
                del response["Content-Length"]
            content = response.streaming_content
            response.streaming_content = (_async_sse(filt, content) if hasattr(content, "__aiter__")
                                          else _sse(filt, content))
            guard.finished(check)
        else:
            guard.finished(check)
        return response


def _sse(filt: ResponseFilter, content: Iterator[bytes]) -> Iterator[bytes]:
    for chunk in content:
        out = filt.feed(bytes(chunk))
        if out:
            yield out
    tail = filt.end()
    if tail:
        yield tail


async def _async_sse(filt: ResponseFilter, content: AsyncIterator[bytes]) -> AsyncIterator[bytes]:
    async for chunk in content:
        out = await asyncio.to_thread(filt.feed, bytes(chunk))
        if out:
            yield out
    tail = await asyncio.to_thread(filt.end)
    if tail:
        yield tail
