# MCPWatch for Python

The [MCPWatch](https://github.com/vedhaai/MCP-Watch) security guard for MCP servers written in Python. It checks every JSON-RPC message between any MCP client and your server, in both directions. It works with:
- the official MCP Python SDK (`MCPServer`, `FastMCP`, the low-level `Server`)
- Django
- Flask
- FastAPI and Starlette
- any ASGI or WSGI app

Clients need no changes.

The checks are the same as for Node servers. They run in the MCPWatch engine, which the package starts as a small child process (`mcpwatch engine`). The same engine also provides the AI reviewer, the dashboard reporting and the live settings. **Node.js 20+ must be installed** on the machine running the server.

```powershell
pip install vedhaai-mcpwatch
npm install -g @vedhaai/mcpwatch     # the engine; without it, the package falls back to npx
```

To see every request and change settings live, run the dashboard (a separate package) and create a project for your server; its Setup page shows these steps with your project key filled in:

```powershell
npx @vedhaai/mcpwatch-dashboard      # http://127.0.0.1:9100
```

Without a project key, events go to `~/.mcpwatch/events.jsonl`, shown under Local events on the dashboard.

## Official MCP SDK (stdio, SSE, Streamable HTTP)

```python
from mcp.server.mcpserver import MCPServer      # mcp 1.x: from mcp.server.fastmcp import FastMCP
from mcpwatch import mcpwatch

server = MCPServer("my-tools")
# ... @server.tool() as usual

mcpwatch(server)                                # ← the only line added, before run()
server.run()                                    # or uvicorn.run(server.streamable_http_app())
```

- **stdio and SSE:** every message on the server's streams is checked.
- **Streamable HTTP:** `server.streamable_http_app()` returns the app already wrapped by `McpWatchASGI`.

A blocked call gets a JSON-RPC error (`-32001` blocked, `-32002` throttled), and your tool never runs.

## Django

Add the middleware first in `settings.py`, so it sees exactly what the client sent:

```python
MIDDLEWARE = ["mcpwatch.django.McpWatchMiddleware", ...]
MCPWATCH = {"name": "my-tools", "path": "/mcp"}        # optional; project_key, mode, deny_tools, …
```

To guard at the server boundary instead, wrap the app in `wsgi.py` or `asgi.py`:

```python
application = McpWatchWSGI(get_wsgi_application(), name="my-tools")    # or McpWatchASGI(get_asgi_application())
```

## Flask

```python
from mcpwatch.flask import McpWatch

app = Flask(__name__)
McpWatch(app, path="/mcp")                    # or McpWatch().init_app(app)
```

`app.config` keys `MCPWATCH_PROJECT_KEY`, `MCPWATCH_SERVER` and `MCPWATCH_MODE` are used when set.

## FastAPI, Starlette, any ASGI or WSGI app

```python
from mcpwatch import McpWatchASGI, McpWatchWSGI

app.add_middleware(McpWatchASGI, name="my-tools", path="/mcp")      # FastAPI / Starlette
app = McpWatchWSGI(app, name="my-tools", path="/mcp")               # any WSGI app
```

Only requests under `path` (default `/mcp`) are checked. Pass a list for several endpoints, or `None` for every path. Both JSON and SSE (`text/event-stream`) responses are checked.

## Options

Every adapter takes the Node middleware's options in snake_case. Options you leave out come from the same `MCPWATCH_*` environment variables, listed in the [main README](https://github.com/vedhaai/MCP-Watch#add-it-to-your-mcp-server-middleware).

| Option | Variable | Meaning |
|---|---|---|
| `project_key` | `MCPWATCH_PROJECT_KEY` | Dashboard project key. Events go there, and the project's mode and client lists apply live |
| `server` | `MCPWATCH_SERVER` | Dashboard URL (default `http://127.0.0.1:9100`) |
| `enabled` | `MCPWATCH_ENABLED=0` | `False` leaves the server untouched |
| `mode` | `MCPWATCH_MODE` | `off`, `observe`, `protect`, `enforce` (default) |
| `deny_tools`, `allow_tools` | | Tool names that may never / only be called |
| `allowed_origins`, `allowed_hosts`, `require_auth`, `expected_audience` | `MCPWATCH_ALLOWED_ORIGINS`, … | HTTP transport checks (MW030–MW036) |
| `ai` | `MCPWATCH_AI=1`, … | AI reviewer, e.g. `{"enabled": True, "model": "qwen2.5:7b"}` |
| `fail_open` | | `True` (default): if the engine can't run, messages pass unchecked and an error is logged. `False`: requests are refused |
| `command` | `MCPWATCH_ENGINE` | How to start the engine, e.g. `node C:/path/to/MCP-Watch/engine/dist/cli.js`. Default: `mcpwatch` on PATH, else `npx -y @vedhaai/mcpwatch` |

## How it works

```
MCP client ──► your Python server ─────────────────────────────────────────────┐
               adapter (SDK hook / ASGI / WSGI / Django)                        │
                 │ each JSON-RPC message, one JSON line   ▲ forward / reply     │
                 ▼                                        │                     │
               mcpwatch engine (Node child process): rules, AI reviewer, ───────┼──► dashboard
               sessions, pins, reporting                                         │
                 allowed messages ──► your tools ───────────────────────────────┘
```

- **One engine per guarded server.** Every connection to the server shares it. A worker process started by forking (gunicorn, uwsgi) starts its own engine.
- **Order kept.** Each connection waits for each message's verdict, so messages are never reordered.
- **If the engine stops,** the next message starts it again, at most once every 10 seconds. Session scores start over.

## Tests

```powershell
cd ..; npm install; npm run build; cd python
python -m venv .venv; .venv\Scripts\pip install -e ".[test]"
.venv\Scripts\python -m pytest
```

The tests run the engine from the checkout's `engine/dist/cli.js`. They cover:
- an SDK server over stdio and Streamable HTTP
- Flask, Django, plain ASGI and WSGI apps
- options reaching the engine
- the engine being unavailable (fail open and fail closed)
