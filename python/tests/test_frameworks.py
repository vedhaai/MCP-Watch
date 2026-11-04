"""Flask, Django and plain ASGI apps serving MCP over HTTP, guarded by the middleware."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from conftest import read_events
from jsonrpc_app import INIT, call, handle
from mcpwatch import McpWatchASGI, McpWatchWSGI

ATTACK = call(3, "read_file", path="../../../.ssh/id_rsa")


def check_guarded(post: Any) -> None:
    """`post(msg)` sends one JSON-RPC message to the app's /mcp and returns the parsed JSON answer."""
    assert post(INIT)["result"]["serverInfo"]["name"] == "web-tools"
    assert post(call(2, "calculator", expression="6*7"))["result"]["content"][0]["text"] == "42"
    blocked = post(ATTACK)
    assert blocked["error"]["code"] == -32001 and "MW002" in blocked["error"]["message"]
    out = post(call(4, "read_file", path="docs/deploy-notes.txt"))
    assert "[REDACTED:aws-access-key]" in out["result"]["content"][0]["text"]


def flask_app(**options: Any) -> Any:
    from flask import Flask, jsonify, request

    from mcpwatch.flask import McpWatch

    app = Flask("flask-tools")

    @app.post("/mcp")
    def mcp() -> Any:
        answer = handle(request.get_json())
        return (jsonify(answer), 200) if answer else ("", 202)

    @app.get("/health")
    def health() -> str:
        return "ok"

    McpWatch(app, **options)
    return app


def test_flask(files: dict[str, Path]) -> None:
    app = flask_app()
    client = app.test_client()
    try:
        check_guarded(lambda msg: client.post("/mcp", json=msg).get_json())
        assert client.get("/health").text == "ok"  # other routes are untouched
        # Batches: a blocked call refuses the whole batch, so no request waits forever.
        answers = client.post("/mcp", json=[call(5, "calculator", expression="1+1"), ATTACK]).get_json()
        assert [a["error"]["code"] for a in answers] == [-32001, -32001]
    finally:
        app.extensions["mcpwatch"].engine.close()
    events = read_events(files["events"])
    assert all(e["server"] == "flask-tools" for e in events)
    assert any(e.get("tool") == "read_file" and e["action"] == "block" for e in events)


def test_django(files: dict[str, Path]) -> None:
    import django
    from django.conf import settings

    if not settings.configured:
        settings.configure(
            DEBUG=False, SECRET_KEY="test", ALLOWED_HOSTS=["*"], ROOT_URLCONF=__name__,
            MIDDLEWARE=["mcpwatch.django.McpWatchMiddleware"], MCPWATCH={"name": "django-tools"},
        )
        django.setup()
    from django.test import Client

    client = Client()
    check_guarded(lambda msg: client.post("/mcp", data=json.dumps(msg), content_type="application/json").json())
    events = read_events(files["events"])
    assert all(e["server"] == "django-tools" for e in events)
    assert any(e.get("tool") == "read_file" and e["action"] == "block" for e in events)


def _django_view(request: Any) -> Any:
    from django.http import HttpResponse, JsonResponse

    answer = handle(json.loads(request.body))
    return JsonResponse(answer) if answer else HttpResponse(status=202)


def _urlpatterns() -> list[Any]:
    try:
        from django.urls import path
        from django.views.decorators.csrf import csrf_exempt
    except ImportError:
        return []
    return [path("mcp", csrf_exempt(_django_view))]


urlpatterns = _urlpatterns()


def asgi_app(**options: Any) -> Any:
    async def app(scope: dict[str, Any], receive: Any, send: Any) -> None:
        if scope["type"] != "http":
            return
        body = b""
        while True:
            message = await receive()
            body += message.get("body", b"")
            if not message.get("more_body"):
                break
        answer = json.dumps(handle(json.loads(body))).encode()
        await send({"type": "http.response.start", "status": 200, "headers": [(b"content-type", b"application/json")]})
        await send({"type": "http.response.body", "body": answer})

    return McpWatchASGI(app, name="asgi-tools", **options)


def test_asgi(files: dict[str, Path]) -> None:
    from starlette.testclient import TestClient

    app = asgi_app()
    try:
        client = TestClient(app)
        check_guarded(lambda msg: client.post("/mcp", json=msg).json())
    finally:
        app.engine.close()
    assert any(e["server"] == "asgi-tools" and e["action"] == "block" for e in read_events(files["events"]))


def wsgi_app(**options: Any) -> McpWatchWSGI:
    def app(environ: dict[str, Any], start_response: Any) -> list[bytes]:
        body = environ["wsgi.input"].read(int(environ.get("CONTENT_LENGTH") or 0))
        answer = json.dumps(handle(json.loads(body))).encode()
        start_response("200 OK", [("Content-Type", "application/json"), ("Content-Length", str(len(answer)))])
        return [answer]

    return McpWatchWSGI(app, name="wsgi-tools", **options)


def wsgi_post(app: McpWatchWSGI, msg: dict[str, Any]) -> dict[str, Any]:
    from werkzeug.test import Client

    return json.loads(Client(app).post("/mcp", json=msg).data)


@pytest.mark.parametrize("fail_open", [True, False])
def test_engine_unavailable(files: dict[str, Path], monkeypatch: Any, fail_open: bool) -> None:
    monkeypatch.setenv("MCPWATCH_ENGINE", "no-such-mcpwatch-engine")
    app = wsgi_app(fail_open=fail_open)
    answer = wsgi_post(app, ATTACK)
    if fail_open:
        assert answer["result"]["content"][0]["text"] == "outside the sandbox"  # the server keeps working
    else:
        assert answer["error"]["code"] == -32001 and "failed closed" in answer["error"]["message"]


def test_options_reach_the_engine(files: dict[str, Path]) -> None:
    app = wsgi_app(deny_tools=["calculator"])
    try:
        answer = wsgi_post(app, call(2, "calculator", expression="1+1"))
        assert answer["error"]["code"] == -32001 and "MW009" in answer["error"]["message"]
    finally:
        app.engine.close()
