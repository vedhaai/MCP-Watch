"""WSGI middleware: Flask, Django (wsgi.py), Bottle, Falcon, or any WSGI app serving MCP over HTTP.

    app.wsgi_app = McpWatchWSGI(app.wsgi_app)          # Flask
    application = McpWatchWSGI(get_wsgi_application())  # Django wsgi.py
"""

from __future__ import annotations

import io
import json
from collections.abc import Iterable, Iterator
from typing import Any

from .engine import Engine, Msg
from .http import HttpGuard, RequestCheck, ResponseFilter
from .options import make_engine

_PASS = object()


class McpWatchWSGI:
    def __init__(self, app: Any, *, path: str | Iterable[str] | None = "/mcp", engine: Engine | None = None,
                 name: str = "mcp-server", **options: Any) -> None:
        self.app = app
        self.engine = engine or make_engine(name, **options)
        self.guard = HttpGuard(self.engine, path) if self.engine else None

    def __call__(self, environ: dict[str, Any], start_response: Any) -> Iterable[bytes]:
        if not self.guard or not self.guard.matches(environ.get("PATH_INFO", "")):
            return self.app(environ, start_response)
        method = environ.get("REQUEST_METHOD", "GET")
        body = _read_body(environ) if method == "POST" else b""
        check = self.guard.check_request(method, _headers(environ), body, environ.get("REMOTE_ADDR"),
                                         environ.get("wsgi.url_scheme") == "https")
        if check.refuse:
            start_response("403 Forbidden", [("Content-Type", "text/plain")])
            return [b"Refused by MCPWatch"]
        if check.reply is not None:
            start_response("200 OK", [("Content-Type", "application/json"), ("Content-Length", str(len(check.reply)))])
            return [check.reply]
        environ = {**environ, "wsgi.input": io.BytesIO(check.body), "CONTENT_LENGTH": str(len(check.body))}
        return self._respond(environ, start_response, check)

    def _respond(self, environ: dict[str, Any], start_response: Any, check: RequestCheck) -> Iterable[bytes]:
        started: list[Any] = []
        written: list[bytes] = []

        def capture(status: str, headers: list[tuple[str, str]], exc_info: Any = None) -> Any:
            started[:] = [status, headers, exc_info]
            return written.append

        result = self.app(environ, capture)
        chunks = iter(result)
        # The app may start its response lazily, on the first chunk.
        first = next(chunks, _PASS) if not started else _PASS
        status, headers, exc_info = started
        filt = self.guard.response(check, dict(headers), lambda m: self._reply_to_server(environ, m))

        def rest() -> Iterator[bytes]:
            yield from written
            if first is not _PASS:
                yield first
            yield from chunks

        if filt.kind == "json":
            try:
                body = filt.json(b"".join(rest()))
            finally:
                _close(result)
                self.guard.finished(check)
            start_response(status, _with_length(headers, len(body)), exc_info)
            return [body]
        if filt.kind == "sse":
            start_response(status, _with_length(headers, None), exc_info)
            return _sse(filt, rest(), result, lambda: self.guard.finished(check))
        start_response(status, headers, exc_info)
        return _passthrough(rest(), result, lambda: self.guard.finished(check))

    # A reply the guard owes the server (a refused sampling request) goes in as its own POST.
    def _reply_to_server(self, environ: dict[str, Any], msg: Msg) -> None:
        body = json.dumps(msg).encode()
        env = {**environ, "REQUEST_METHOD": "POST", "CONTENT_TYPE": "application/json",
               "CONTENT_LENGTH": str(len(body)), "wsgi.input": io.BytesIO(body)}
        _close(self.app(env, lambda *a: (lambda _: None)))


def _sse(filt: ResponseFilter, chunks: Iterator[bytes], result: Any, done: Any) -> Iterator[bytes]:
    try:
        for chunk in chunks:
            out = filt.feed(chunk)
            if out:
                yield out
        tail = filt.end()
        if tail:
            yield tail
    finally:
        _close(result)
        done()


def _passthrough(chunks: Iterator[bytes], result: Any, done: Any) -> Iterator[bytes]:
    try:
        yield from chunks
    finally:
        _close(result)
        done()


def _headers(environ: dict[str, Any]) -> dict[str, str]:
    out = {k[5:].replace("_", "-").lower(): v for k, v in environ.items() if k.startswith("HTTP_")}
    if environ.get("CONTENT_TYPE"):
        out["content-type"] = environ["CONTENT_TYPE"]
    return out


def _read_body(environ: dict[str, Any]) -> bytes:
    stream = environ.get("wsgi.input")
    if stream is None:
        return b""
    try:
        length = int(environ.get("CONTENT_LENGTH") or -1)
    except ValueError:
        length = -1
    return stream.read(length) if length >= 0 else stream.read()


def _with_length(headers: list[tuple[str, str]], length: int | None) -> list[tuple[str, str]]:
    out = [(k, v) for k, v in headers if k.lower() != "content-length"]
    return out + [("Content-Length", str(length))] if length is not None else out


def _close(result: Any) -> None:
    close = getattr(result, "close", None)
    if close:
        close()
