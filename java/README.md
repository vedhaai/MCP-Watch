# MCPWatch for Java

The [MCPWatch](https://github.com/vedhaai/MCP-Watch) security guard for MCP servers written in Java. It checks every JSON-RPC message between any MCP client and your server, in both directions. It works with:
- the official [MCP Java SDK](https://github.com/modelcontextprotocol/java-sdk) (stdio and HTTP+SSE)
- Spring Boot (MVC), Quarkus, Jetty, Tomcat — any servlet application, including Spring AI's MCP server
- any MCP endpoint reachable through a `jakarta.servlet` filter

Clients need no changes.

The checks are the same as for Node and Python servers. They run in the MCPWatch engine, which this package starts as a small child process (`mcpwatch engine`). The same engine also provides the AI reviewer, the dashboard reporting and the live settings. **Node.js 20+ must be installed** on the machine running the server.

```xml
<dependency>
  <groupId>ai.vedha</groupId>
  <artifactId>mcpwatch</artifactId>
  <version>0.1.0</version>
</dependency>
```

```powershell
npm install -g @vedhaai/mcpwatch     # the engine; without it, the package falls back to npx
```

Needs Java 17+. The package brings **no dependencies of its own** beyond SLF4J: the MCP SDK, Reactor and the servlet API are all `provided`, and JSON is handled by the package's own codec, so it can never force a Jackson or Gson version on your application.

## Official MCP SDK (stdio, HTTP+SSE)

```java
import ai.vedha.mcpwatch.sdk.McpWatch;

var transport = new StdioServerTransportProvider();

var server = McpServer.sync(McpWatch.guard(transport))   // ← the only line changed
    .serverInfo("my-tools", "1.0.0")
    .tools(...)
    .build();
```

`McpWatch.guard` wraps the transport provider: every message the client sends is checked before your tool handlers see it, and every message the server sends is checked before it reaches the client. A blocked call gets a JSON-RPC error (`-32001` blocked, `-32002` throttled) and your tool never runs.

With settings in code:

```java
McpWatch.guard("my-tools", transport, McpWatchOptions.builder()
    .projectKey("mw_...")            // from the dashboard
    .mode("enforce")
    .denyTools("run_command")
    .build());
```

**Streamable HTTP** is guarded with the servlet filter below, not with `guard(...)`. That transport serves MCP over ordinary HTTP requests, and the filter sits where the request headers the transport rules need (MW030–MW036: origin, host, auth, token audience) are still available.

## Spring Boot, Quarkus, Jetty, Tomcat (servlet filter)

```java
@Bean
FilterRegistrationBean<McpWatchFilter> mcpwatch() {
    var filter = new McpWatchFilter("my-tools",
            McpWatchOptions.builder().projectKey("mw_...").build(), "/mcp");
    var registration = new FilterRegistrationBean<>(filter);
    registration.addUrlPatterns("/mcp/*");
    registration.setOrder(Ordered.HIGHEST_PRECEDENCE);   // see exactly what the client sent
    return registration;
}
```

The filter checks the client messages in each POST body, and the server's answer whether it comes back as JSON or as an SSE stream. An SSE stream keeps streaming: each event is checked and passed on as it arrives, and only an incomplete event is held back.

In `web.xml` or with `@WebFilter`, everything comes from init parameters instead — `projectKey`, `server`, `mode`, `path`, `name`, `denyTools`, `failOpen`, `enabled`:

```xml
<filter>
  <filter-name>mcpwatch</filter-name>
  <filter-class>ai.vedha.mcpwatch.http.McpWatchFilter</filter-class>
  <init-param><param-name>projectKey</param-name><param-value>mw_...</param-value></init-param>
  <init-param><param-name>path</param-name><param-value>/mcp</param-value></init-param>
</filter>
```

To share one engine between a filter and an SDK server, build it once and pass it in: `new McpWatchFilter(engine, "/mcp")`.

## Settings

Options in code are the Node middleware's, on `McpWatchOptions.builder()`: `projectKey`, `server`, `mode`, `denyTools`, `allowTools`, `allowedOrigins`, `allowedHosts`, `requireAuth`, `expectedAudience`, `windowSeconds`, `throttleAt`, `blockAt`, `failOpen`, `ai`, and `option(name, value)` for anything else the engine takes.

What you leave out comes from the same `MCPWATCH_*` environment variables as the Node and Python packages, read by the engine itself. With a project key, the project's settings in the dashboard win over both and reach the guard within 5 seconds, with no restart.

| Setting | What it does |
|---|---|
| `MCPWATCH_PROJECT_KEY` | Project key from the dashboard. Events go to that project, and its mode and client lists apply live |
| `MCPWATCH_SERVER` | Dashboard URL (default `http://127.0.0.1:9100`) |
| `MCPWATCH_ENABLED=0` | Disconnect: the server runs untouched, and `guard(...)` hands back your own provider |
| `MCPWATCH_MODE` | `off`, `observe`, `protect`, `enforce` (default) |
| `MCPWATCH_ENGINE` | How to start the engine, when it isn't `mcpwatch` on the PATH (e.g. `node /path/to/cli.js`) |

`failOpen` (true by default) decides what happens while the engine can't be reached: messages pass unchecked, or requests are refused with `-32001`.

The mode can be changed at runtime without a restart:

```java
var guarded = (GuardedTransportProvider) McpWatch.guard(transport);
guarded.setMode("observe");
```

## Two limits

- **Streamable HTTP through the SDK wrapper.** `McpWatch.guard` covers the transports that give the server one session per connection (stdio, HTTP+SSE). Use the servlet filter for Streamable HTTP.
- **Server-to-client requests under the filter.** When the guard refuses a request the *server* sent the client (a sampling or elicitation request, MW026 / MW029), the servlet API gives no way to hand the server an answer: the request is dropped and logged, and the server sees it time out. This is the same limit the Python Django middleware has. The SDK wrapper has no such limit — there the refusal is fed back to the server as though the client had answered.

## Tests

```powershell
cd java
mvn test
```

59 tests. They run against the **real engine** built in this repository (`engine/dist/cli.js`), so they check actual verdicts rather than a stand-in; build it first with `npm run build -w engine` in the repository root. Without it, the tests that need verdicts are skipped rather than failed.

| File | What it covers |
|---|---|
| `JsonTest` | The package's own JSON codec: round trips, number and escape fidelity, hostile and malformed input, the nesting limit |
| `EngineTest` | The sidecar protocol: real MW001/002/003/009/030 verdicts, tool stripping, withheld results, mode changes at runtime, `failOpen` both ways, concurrent callers |
| `HttpGuardTest` | Path matching, blocked and batched POST bodies, JSON and SSE responses, events split across chunks, multi-line `data:`, session rename |
| `McpWatchFilterTest` | The filter end to end through a real Jetty server and HTTP client: blocked calls never reaching the servlet, `Content-Length` after a rewrite, SSE still streaming, 403 on a foreign origin |
| `McpWatchSdkTest` | The transport and session wrapper driven as the real transports drive it: blocked calls, stripped tools, withheld results, message ordering, the session id, and the behaviour rules building up over a session |
