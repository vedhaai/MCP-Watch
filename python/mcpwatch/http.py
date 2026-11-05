"""Guarding MCP over HTTP (Streamable HTTP and SSE), whatever the web framework.

The WSGI, ASGI and Django adapters only move bytes; this module decides. It mirrors the Node HTTP
proxy: the POST body carries client messages, the response is JSON or an SSE stream of server
messages. It is synchronous; the async adapters run it in a worker thread.
"""

from __future__ import annotations

import codecs
import json
import re
from collections.abc import Callable, Iterable, Mapping
from dataclasses import dataclass, field
from typing import Any

from .engine import BLOCKED, Engine, Msg, log

ReplyToServer = Callable[[Msg], None]

_EVENT_END = re.compile(r"\r?\n\r?\n")


def path_matcher(paths: str | Iterable[str] | None) -> Callable[[str], bool]:
    """'/mcp' guards /mcp and anything under it; None or '*' guards every path."""
    if paths is None or paths == "*":
        return lambda _: True
    prefixes = [p.rstrip("/") or "/" for p in ([paths] if isinstance(paths, str) else paths)]
    return lambda path: any(path.rstrip("/") == p or path.startswith(p + "/") or p == "/" for p in prefixes)


@dataclass
class RequestCheck:
    session: str
    # The request carried a session id: a server message answering nothing the client asked is forged.
    strict: bool
    method: str
    headers: dict[str, str]
    # 403 without passing the request on (GET or DELETE refused by the transport rules).
    refuse: bool = False
    # JSON to answer the POST with ourselves (blocked calls); the app never sees the request.
    reply: bytes | None = None
    # The body to pass on, possibly with messages changed.
    body: bytes = b""
    changed: bool = False
    extra: dict[str, Any] = field(default_factory=dict)


class HttpGuard:
    def __init__(self, engine: Engine, paths: str | Iterable[str] | None = "/mcp") -> None:
        self.engine = engine
        self.matches = path_matcher(paths)

    def check_request(self, method: str, headers: Mapping[str, str], body: bytes,
                      remote: str | None = None, https: bool = False) -> RequestCheck:
        headers = {k.lower(): v for k, v in headers.items()}
        session = headers.get("mcp-session-id") or f"http-{remote}"
        info = {"headers": headers, "remoteAddress": remote, "encrypted": https}
        check = RequestCheck(session, "mcp-session-id" in headers, method.upper(), headers, body=body)
        if check.method != "POST":
            check.refuse = self.engine.from_http(session, info, check.method)
            return check
        try:
            parsed = json.loads(body)
        except ValueError:
            return check  # Not JSON: not ours to judge.
        batch = isinstance(parsed, list)
        msgs = parsed if batch else [parsed]
        outcomes = [self.engine.from_client(session, m, info) for m in msgs]
        replies = [r for _, r in outcomes if r]
        if replies:
            # Answer blocked calls ourselves. In a batch, the rest are refused too so nothing waits forever.
            if batch:
                by_id = {json.dumps(r.get("id")): r for r in replies}
                refused = {"code": BLOCKED, "message": "Batch refused by MCPWatch"}
                out: Any = [by_id.get(json.dumps(m.get("id"))) or {"jsonrpc": "2.0", "id": m.get("id"), "error": refused}
                            for m in msgs if isinstance(m, dict) and m.get("id") is not None]
            else:
                out = replies[0]
            check.reply = json.dumps(out).encode()
            return check
        forwards = [f for f, _ in outcomes if f is not None]
        if forwards != msgs:
            check.body = json.dumps(forwards if batch else (forwards[0] if forwards else {})).encode()
            check.changed = True
        return check

    def response(self, check: RequestCheck, headers: Mapping[str, str],
                 reply_to_server: ReplyToServer | None = None) -> ResponseFilter:
        """Call once the app has started its response; the filter checks the server's messages in it."""
        headers = {k.lower(): v for k, v in headers.items()}
        new_session = headers.get("mcp-session-id")
        if new_session and new_session != check.session:
            self.engine.note("rename", **{"from": check.session, "to": new_session})
            check.session = new_session
        return ResponseFilter(self, check, headers.get("content-type", ""), reply_to_server)

    def finished(self, check: RequestCheck) -> None:
        if check.method == "DELETE":
            self.engine.note("drop", session=check.session)


class ResponseFilter:
    """Checks the server's messages in a response body: a JSON body whole, an SSE stream event by event."""

    def __init__(self, guard: HttpGuard, check: RequestCheck, content_type: str,
                 reply_to_server: ReplyToServer | None) -> None:
        self.guard, self.check = guard, check
        self.kind = "sse" if "text/event-stream" in content_type else "json" if "application/json" in content_type else "raw"
        self._reply_to_server = reply_to_server
        self._decoder = codecs.getincrementaldecoder("utf-8")(errors="replace")
        self._buf = ""

    def _guard(self, msg: Msg) -> Msg | None:
        forward, reply = self.guard.engine.from_server(self.check.session, msg, self.check.strict)
        if reply:
            if self._reply_to_server:
                self._reply_to_server(reply)
            else:
                log.warning("[mcpwatch] refused %s from the server; it gets no answer here", msg.get("method"))
        return forward

    def json(self, body: bytes) -> bytes:
        if self.kind != "json":
            return body
        try:
            parsed = json.loads(body)
        except ValueError:
            return body
        batch = isinstance(parsed, list)
        out = [f for f in (self._guard(m) for m in (parsed if batch else [parsed])) if f is not None]
        return json.dumps(out if batch else (out[0] if out else {})).encode()

    def feed(self, chunk: bytes) -> bytes:
        """SSE: the complete events in `chunk` (and before it), checked. Partial events wait."""
        if self.kind != "sse":
            return chunk
        self._buf += self._decoder.decode(chunk)
        out = []
        while m := _EVENT_END.search(self._buf):
            event, self._buf = self._buf[:m.start()], self._buf[m.end():]
            out.append(self._event(event))
        return "".join(out).encode()

    def end(self) -> bytes:
        if self.kind != "sse":
            return b""
        self._buf += self._decoder.decode(b"", final=True)
        rest, self._buf = self._buf, ""
        return self._event(rest).encode() if rest.strip() else b""

    def _event(self, event: str) -> str:
        lines = re.split(r"\r?\n", event)
        event_id = next((l[3:].strip() for l in lines if l.startswith("id:")), None)
        if event_id:
            self.guard.engine.note("eventId", session=self.check.session, eventId=event_id)
        data = "\n".join(re.sub(r"^ ", "", l[5:]) for l in lines if l.startswith("data:"))
        if not data:
            return event + "\n\n"
        try:
            msg = json.loads(data)
        except ValueError:
            return event + "\n\n"
        forward = self._guard(msg)
        if forward is None:
            return ""
        keep = [l for l in lines if not l.startswith("data:")]
        return "\n".join([*keep, f"data: {json.dumps(forward)}"]) + "\n\n"
