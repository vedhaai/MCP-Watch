"""The MCPWatch engine, run as a Node sidecar (`mcpwatch engine`).

Every rule, the AI reviewer and dashboard reporting live in the Node package; this module starts it as
a child process and asks it about each JSON-RPC message, one JSON object per line each way. Python
guards stay thin, and a server in Python gets exactly the verdicts a Node server would.
"""

from __future__ import annotations

import asyncio
import itertools
import json
import logging
import os
import shlex
import shutil
import subprocess
import threading
import time
from concurrent.futures import Future
from typing import Any

log = logging.getLogger("mcpwatch")

Msg = dict[str, Any]
# What to pass on (possibly changed, or None to drop it) and what to answer the sender with.
Outcome = tuple[Msg | None, Msg | None]

BLOCKED = -32001
NPM_PACKAGE = "@vedhaai/mcpwatch@beta"

# Options the Python API takes in snake_case, as the engine's policy and reporting fields.
_OPTION_NAMES = {
    "project_key": "key", "server": "server", "local_log": "localLog", "poll_ms": "pollMs",
    "mode": "mode", "events_file": "eventsFile", "pins_file": "pinsFile", "registry_file": "registryFile",
    "window_seconds": "windowSeconds", "throttle_at": "throttleAt", "block_at": "blockAt",
    "max_calls_per_window": "maxCallsPerWindow", "max_arg_bytes": "maxArgBytes", "max_result_bytes": "maxResultBytes",
    "allow_tools": "allowTools", "deny_tools": "denyTools", "clients": "clients",
    "allowed_origins": "allowedOrigins", "allowed_hosts": "allowedHosts", "require_auth": "requireAuth",
    "expected_audience": "expectedAudience", "fail_open": "failOpen", "ai": "ai",
}


def engine_command(command: str | list[str] | None = None) -> list[str]:
    """How to start the engine: the given command, MCPWATCH_ENGINE, `mcpwatch` on PATH, else npx."""
    command = command or os.environ.get("MCPWATCH_ENGINE")
    if isinstance(command, list):
        return [*command, "engine"]
    if command:
        # Windows paths keep their backslashes; quotes around a path with spaces are removed.
        parts = shlex.split(command, posix=os.name != "nt")
        return [p.strip('"') for p in parts] + ["engine"]
    found = shutil.which("mcpwatch")
    if found:
        return [found, "engine"]
    npx = shutil.which("npx")
    if npx:
        return [npx, "-y", NPM_PACKAGE, "engine"]
    raise EngineUnavailable("Node.js 20+ is needed: install it, then `npm install -g @vedhaai/mcpwatch@beta`")


class EngineUnavailable(RuntimeError):
    pass


class Engine:
    """One engine process per guarded server, shared by every connection to it. Thread-safe.

    Checks never raise: if the engine can't be reached, a message is passed on unchanged when
    `fail_open` (the default), else a request is refused with -32001.
    """

    def __init__(self, name: str = "mcp-server", *, command: str | list[str] | None = None,
                 start_timeout: float = 120.0, call_timeout: float = 60.0, **options: Any) -> None:
        unknown = set(options) - set(_OPTION_NAMES)
        if unknown:
            raise TypeError(f"Unknown MCPWatch option(s): {', '.join(sorted(unknown))}")
        self.name = name
        self.fail_open = options.get("fail_open", True)
        self._options = {"name": name, **{_OPTION_NAMES[k]: v for k, v in options.items() if v is not None}}
        self._command = command
        self._start_timeout = start_timeout
        self._call_timeout = call_timeout
        self._ids = itertools.count(1)
        self._pending: dict[int, Future[Msg]] = {}
        self._lock = threading.Lock()
        self._proc: subprocess.Popen[str] | None = None
        self._pid = 0
        self._last_start = 0.0
        self._last_warning = 0.0
        self.mode = options.get("mode") or os.environ.get("MCPWATCH_MODE") or "enforce"

    # ---- process -------------------------------------------------------------------------------

    def start(self) -> None:
        """Starts the engine now rather than on the first message (that one would wait for it)."""
        with self._lock:
            self._ensure_started()

    def _ensure_started(self) -> subprocess.Popen[str]:
        # A forked worker (gunicorn, Django's reloader) can't share its parent's pipes: start its own.
        if self._proc and self._pid == os.getpid():
            if self._proc.poll() is None:
                return self._proc
            if time.monotonic() - self._last_start < 10:
                raise EngineUnavailable("the engine stopped; retrying shortly")
        self._last_start = time.monotonic()
        env = {**os.environ, "MCPWATCH_ENGINE_OPTIONS": json.dumps(self._options)}
        cmd = engine_command(self._command)
        try:
            proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=None, env=env,
                                    text=True, encoding="utf-8", bufsize=1)
        except OSError as e:
            raise EngineUnavailable(f"could not start {cmd[0]}: {e}") from e
        ready: Future[Msg] = Future()
        self._pending = {0: ready}
        self._proc, self._pid = proc, os.getpid()
        threading.Thread(target=self._read, args=(proc, self._pending), name="mcpwatch-engine", daemon=True).start()
        try:
            hello = ready.result(self._start_timeout)
        except Exception as e:
            proc.kill()
            raise EngineUnavailable(f"the engine did not start: {e}") from e
        self.mode = hello.get("mode", self.mode)
        return proc

    def _read(self, proc: subprocess.Popen[str], pending: dict[int, Future[Msg]]) -> None:
        assert proc.stdout
        for line in proc.stdout:
            try:
                answer = json.loads(line)
            except ValueError:
                continue
            fut = pending.pop(answer.get("id"), None)
            if fut and not fut.done():
                fut.set_result(answer)
        for fut in list(pending.values()):
            if not fut.done():
                fut.set_exception(EngineUnavailable(f"the engine exited (code {proc.wait()})"))
        pending.clear()

    def _send(self, op: str, fields: dict[str, Any]) -> Future[Msg]:
        with self._lock:
            proc = self._ensure_started()
            rid = next(self._ids)
            fut: Future[Msg] = Future()
            self._pending[rid] = fut
            try:
                assert proc.stdin
                proc.stdin.write(json.dumps({"id": rid, "op": op, **fields}) + "\n")
                proc.stdin.flush()
            except OSError as e:
                self._pending.pop(rid, None)
                raise EngineUnavailable(f"the engine stopped: {e}") from e
        return fut

    def call(self, op: str, **fields: Any) -> Msg:
        answer = self._send(op, fields).result(self._call_timeout)
        if "error" in answer and "forward" not in answer:
            raise RuntimeError(answer["error"])
        return answer

    async def acall(self, op: str, **fields: Any) -> Msg:
        fut = self._send(op, fields)
        answer = await asyncio.wait_for(asyncio.wrap_future(fut), self._call_timeout)
        if "error" in answer and "forward" not in answer:
            raise RuntimeError(answer["error"])
        return answer

    def close(self) -> None:
        """Lets the engine send its queued events and exit."""
        proc = self._proc
        if proc and proc.poll() is None and self._pid == os.getpid():
            try:
                assert proc.stdin
                proc.stdin.close()
                proc.wait(5)
            except Exception:
                proc.kill()

    # ---- checks ----------------------------------------------------------------------------------

    def _failed(self, msg: Msg, e: Exception) -> Outcome:
        if time.monotonic() - self._last_warning > 60:
            self._last_warning = time.monotonic()
            log.error("[mcpwatch] guard error: %s", e)
        if self.fail_open or not isinstance(msg, dict) or msg.get("id") is None or msg.get("method") is None:
            return msg, None
        return None, {"jsonrpc": "2.0", "id": msg["id"], "error": {"code": BLOCKED, "message": "MCPWatch failed closed"}}

    def from_client(self, session: str, msg: Msg, http: Msg | None = None) -> Outcome:
        try:
            a = self.call("client", session=session, msg=msg, **({"http": http} if http else {}))
            return a.get("forward"), a.get("reply")
        except Exception as e:
            return self._failed(msg, e)

    def from_server(self, session: str, msg: Msg, strict: bool = False) -> Outcome:
        try:
            a = self.call("server", session=session, msg=msg, strict=strict)
            return a.get("forward"), a.get("reply")
        except Exception as e:
            return self._failed(msg, e)

    async def afrom_client(self, session: str, msg: Msg, http: Msg | None = None) -> Outcome:
        try:
            a = await self.acall("client", session=session, msg=msg, **({"http": http} if http else {}))
            return a.get("forward"), a.get("reply")
        except Exception as e:
            return self._failed(msg, e)

    async def afrom_server(self, session: str, msg: Msg, strict: bool = False) -> Outcome:
        try:
            a = await self.acall("server", session=session, msg=msg, strict=strict)
            return a.get("forward"), a.get("reply")
        except Exception as e:
            return self._failed(msg, e)

    def from_http(self, session: str, http: Msg, method: str) -> bool:
        """True when a request without a JSON-RPC body (GET, DELETE) must be refused."""
        try:
            return bool(self.call("http", session=session, http=http, method=method).get("refuse"))
        except Exception as e:
            self._failed({}, e)
            return not self.fail_open

    def note(self, op: str, **fields: Any) -> None:
        """Session bookkeeping (rename, drop, eventId) that nobody waits for."""
        try:
            self._send(op, fields)
        except Exception as e:
            self._failed({}, e)

    def set_mode(self, mode: str) -> None:
        self.mode = self.call("mode", mode=mode).get("mode", mode)
