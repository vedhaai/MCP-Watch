# MCPWatch for Java

[![Maven Central](https://img.shields.io/maven-central/v/ai.vedha/mcpwatch.svg)](https://central.sonatype.com/artifact/ai.vedha/mcpwatch)

The [MCPWatch](https://github.com/vedhaai/MCP-Watch) security guard for MCP servers written in Java. It checks every JSON-RPC message between any MCP client and your server, in both directions, and blocks, throttles, strips or redacts what's dangerous: command and SQL injection, path traversal, SSRF, leaked secrets, poisoned tool definitions, rug pulls, prompt injection in tool output, and more.

Clients need no changes. It works with:

- the official [MCP Java SDK](https://github.com/modelcontextprotocol/java-sdk) — stdio and HTTP+SSE
- Spring Boot (MVC), Quarkus, Jetty, Tomcat — any servlet application, including Spring AI's MCP server
- Streamable HTTP, through the servlet filter

## Install

```xml
<dependency>
  <groupId>ai.vedha</groupId>
  <artifactId>mcpwatch</artifactId>
  <version>0.1.1</version>
</dependency>
```

```kotlin
implementation("ai.vedha:mcpwatch:0.1.1")
```

The checks themselves run in the MCPWatch engine, which this package starts as a small child process (`mcpwatch engine`). The same engine provides the AI reviewer, the dashboard reporting and the live settings, so a Java server gets exactly the verdicts a Node or Python one would. **Node.js 20+ must be installed** on the machine running the server:

```powershell
npm install -g @vedhaai/mcpwatch     # without it, the package falls back to npx (slower first start)
```

### Requirements

| | |
|---|---|
| Java | 17 or newer |
| Node.js | 20 or newer, on the same machine |
| MCP Java SDK | 2.x (`provided` — your application's version is used) |
| Servlet API | `jakarta.servlet` 5.0+ (built against 6.0) — Spring Boot 3+, Tomcat 10+, Jetty 11+ |

The package brings **no dependencies of its own beyond SLF4J**. The MCP SDK, Reactor and the servlet API are all `provided`, and JSON is handled by the package's own codec, so MCPWatch can never force a Jackson or Gson version on the application it is injected into. A guard that caused a classpath conflict would be self-defeating.

Only `slf4j-api` arrives transitively. Use whichever SLF4J binding your application already has; without one, SLF4J prints a no-op warning and the guard still works.

## Official MCP SDK (stdio, HTTP+SSE)

```java
import ai.vedha.mcpwatch.sdk.McpWatch;

var transport = new StdioServerTransportProvider();

var server = McpServer.sync(McpWatch.guard(transport))   // ← the only line changed
    .serverInfo("my-tools", "1.0.0")
    .tools(...)
    .build();
```

`McpWatch.guard` wraps the transport provider. When the server registers its session factory, each new connection gets a guarded transport (server → client) and a guarded session (client → server), so both directions pass through the engine. A blocked call gets a JSON-RPC error and your tool handler never runs.

With settings in code, and a name identifying this server in the dashboard:

```java
McpWatch.guard("my-tools", transport, McpWatchOptions.builder()
    .projectKey("mw_...")            // from the dashboard
    .mode("enforce")
    .denyTools("run_command")
    .build());
```

Three overloads:

```java
McpWatch.guard(provider);                        // settings from the environment and dashboard
McpWatch.guard(provider, options);               // name defaults to "mcp-server"
McpWatch.guard("my-tools", provider, options);   // named
```

Each returns an `McpServerTransportProvider` you pass to `McpServer.sync(...)` or `.async(...)`. When MCPWatch is off (`enabled(false)` or `MCPWATCH_ENABLED=0`) it returns **your own provider unchanged**, so the server runs untouched.

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

Register it **first** in the chain. Anything that runs before it can change the body the guard then judges.

The filter checks the client messages in each POST body, and the server's answer whether it comes back as JSON or as an SSE stream. An SSE stream keeps streaming: each event is checked and passed on as it arrives, and only an incomplete event is held back until the rest of it turns up.

Paths work like the Python adapters: `/mcp` guards `/mcp` and everything under it, several arguments guard several endpoints, and `"*"` guards every path.

```java
new McpWatchFilter("my-tools", options, "/mcp", "/sse");   // two endpoints
new McpWatchFilter(engine, "/mcp");                        // share an engine with an SDK server
```

In `web.xml` or with `@WebFilter`, everything comes from init parameters instead — `name`, `path` (comma-separated), `projectKey`, `server`, `mode`, `denyTools`, `failOpen`, `enabled`:

```xml
<filter>
  <filter-name>mcpwatch</filter-name>
  <filter-class>ai.vedha.mcpwatch.http.McpWatchFilter</filter-class>
  <init-param><param-name>projectKey</param-name><param-value>mw_...</param-value></init-param>
  <init-param><param-name>path</param-name><param-value>/mcp</param-value></init-param>
</filter>
<filter-mapping>
  <filter-name>mcpwatch</filter-name>
  <url-pattern>/*</url-pattern>
</filter-mapping>
```

## Modes

New dashboard projects start in `observe`. Without a dashboard the default is `enforce`.

| Mode | Behaviour |
|---|---|
| `off` | Pass everything through and record nothing |
| `observe` | Forward everything; events record what `enforce` would have done |
| `protect` | Block high-severity findings only |
| `enforce` | Block high severity; throttle at session score 3, block at 6 (60 s window) |

What the guard does to each message:

| | |
|---|---|
| Blocked call | Answered with a JSON-RPC error (`-32001` blocked, `-32002` throttled); never forwarded |
| Poisoned or rug-pulled tool | Removed from `tools/list` |
| Injected tool result | Replaced with an error result |
| Secrets in output | Redacted |

Changing the mode at runtime, with no restart:

```java
var guarded = (GuardedTransportProvider) McpWatch.guard(transport);
guarded.setMode("observe");
guarded.mode();     // the mode in force
guarded.engine();   // the underlying Engine
```

## Settings

Options in code are the Node middleware's, on `McpWatchOptions.builder()`. What you leave out comes from the same `MCPWATCH_*` environment variables as the Node and Python packages, read by the engine itself. **With a project key, the dashboard's settings win over both** and reach the guard within 5 seconds.

| Builder method | Environment | Default | Meaning |
|---|---|---|---|
| `projectKey(String)` | `MCPWATCH_PROJECT_KEY` | — | Dashboard project key. Events go there, and the project's mode, AI choice and client lists apply live |
| `server(String)` | `MCPWATCH_SERVER` | `http://127.0.0.1:9100` | Dashboard URL |
| `enabled(boolean)` | `MCPWATCH_ENABLED=0` | `true` | `false` leaves the server untouched |
| `mode(String)` | `MCPWATCH_MODE` | `enforce` | `off`, `observe`, `protect`, `enforce` |
| `failOpen(boolean)` | | `false` | If the engine can't run: refuse requests with `-32001` (default), or pass messages unchecked |
| `denyTools(String...)` | | — | Tools that may never be called (MW009) |
| `allowTools(String...)` | | — | If set, only these may be called |
| `allowedOrigins(String...)` | `MCPWATCH_ALLOWED_ORIGINS` | — | HTTP: web origins allowed to call the server (MW030) |
| `allowedHosts(String...)` | `MCPWATCH_ALLOWED_HOSTS` | not checked | HTTP: host names the server answers to |
| `requireAuth(boolean)` | `MCPWATCH_REQUIRE_AUTH=1` | `false` | HTTP: refuse requests with no `Authorization` or `X-API-Key` (MW031) |
| `expectedAudience(String)` | `MCPWATCH_AUDIENCE` | — | HTTP: refuse JWTs whose `aud` doesn't include this (MW036) |
| `windowSeconds(int)` | | `60` | Behaviour-rule window |
| `throttleAt(int)` | | `3` | Session score at which calls are throttled |
| `blockAt(int)` | | `6` | Session score at which calls are blocked |
| `maxCallsPerWindow(int)` | | `30` | Call flood threshold (MB001) |
| `maxArgBytes(int)` | | `100000` | Oversized arguments (MW008) |
| `maxResultBytes(int)` | | `5000000` | Oversized response, withheld (MW023) |
| `ai(boolean)` / `ai(Map)` | `MCPWATCH_AI=1` | off | AI reviewer; see below |
| `clients(List, List)` | | — | Clients to block or always allow, overriding the rules in every mode |
| `eventsFile`, `pinsFile`, `registryFile` | `MCPWATCH_EVENTS`, … | `~/.mcpwatch/…` | Local event log, pinned tool definitions, shared registry |
| `engineCommand(String...)` | `MCPWATCH_ENGINE` | `mcpwatch` on PATH, else `npx` | How to start the engine, e.g. `engineCommand("node", "/path/to/engine/dist/cli.js")` |
| `startTimeout(Duration)` | | 120 s | How long to wait for the engine to start |
| `callTimeout(Duration)` | | 60 s | How long to wait for one message to be checked |
| `option(String, Object)` | | | Any other engine option, by its own name |

### Connecting to the dashboard

1. Start the dashboard (`npx @vedhaai/mcpwatch-dashboard`) and open http://127.0.0.1:9100.
2. Create an account, click **New project**, and pick **Java MCP server**.
3. Copy the project key into `projectKey(...)` or `MCPWATCH_PROJECT_KEY`.

The Setup tab says *Waiting…* until your server first contacts the dashboard, then turns **Connected**. Every request then appears on the project's Requests tab, with its action, findings, score and redacted evidence.

Without a project key, events go to `~/.mcpwatch/events.jsonl` and show under **Local events** on the dashboard's Projects page.

### AI reviewer

With it on, a model reviews every message against the rules on top of the pattern checks, catching what patterns can't — such as instructions to the model hidden in an email body. It can **add findings, never remove them**, so a payload that talks the model into "this is safe" can't undo a rule.

```java
McpWatchOptions.builder().ai(true).build();                       // local Ollama, qwen2.5:7b
McpWatchOptions.builder().ai(Map.of(
        "enabled", true,
        "url", "http://127.0.0.1:11434/v1",
        "model", "qwen2.5:7b")).build();
```

With a project key, the project's **AI review** choice in the dashboard wins, including the model, URL and API key, and is picked up within 5 seconds with no restart. Expect about 0.4–1 s per reviewed message with a 7B model on a laptop GPU. Full details in the [main README](https://github.com/vedhaai/MCP-Watch#ai-reviewer-local-model).

## What it detects

The full catalog is the engine's; run `mcpwatch rules` for it. In summary:

- **Tool calls** — MW001 command injection · MW002 path traversal or sensitive file · MW003 SSRF · MW004 SQL injection · MW005 secret in arguments · MW006 schema violation · MW007 unknown tool · MW008 oversized · MW009 denied tool · MW010 NoSQL, LDAP, template or XXE injection
- **Tool definitions** — MW020 tool poisoning · MW021 invisible characters · MW024 rug pull · MW027 name collision · MW028 tool shadowing · MW038 server changed · MW039 over-privileged server
- **Server output** — MW022 prompt injection · MW023 oversized response · MW025 secret leak · MW026 sampling request · MW029 elicitation phishing
- **Transport, auth and sessions** (HTTP) — MW030 DNS rebinding or cross-site request · MW031 missing authentication · MW032 token passthrough · MW033 session hijacking · MW034 plain HTTP between machines · MW035 client impersonation · MW036 confused deputy · MW037 event stream abuse
- **Behaviour, over a session** — MB001 call flood · MB002 repeated blocked attempts · MB003 enumeration · MB004 exfiltration chain · MB005 replay · MB006 cross-server leakage
- **AI reviewer** — MA001 a threat no pattern rule covers · MA002 the model was unreachable while required

## How it works

```
MCP client ──► your Java server ───────────────────────────────────────────────┐
               McpWatch.guard(provider)  /  McpWatchFilter                      │
                 │ each JSON-RPC message, one JSON line   ▲ forward / reply     │
                 ▼                                        │                     │
               mcpwatch engine (Node child process): rules, AI reviewer, ───────┼──► dashboard
               sessions, pins, registry, reporting                               │
                 allowed messages ──► your tools ───────────────────────────────┘
```

- **One engine per guarded server**, shared by every connection to it, started on first use or eagerly by `Engine.start()`.
- **Order is kept.** Checks block on a pipe and can take about a second with the AI reviewer on, so each direction of each session runs them through a `Sequencer` on a shared pool, off the transport thread. A `tools/list` must never overtake its own `initialize`.
- **If the engine stops,** the next message starts it again, at most once every 10 seconds. Session scores start over.
- **If the engine can't be reached,** `failOpen` decides, and the error is logged at most once a minute rather than per message.

## Two limits

- **Streamable HTTP through the SDK wrapper.** `McpWatch.guard` covers the transports that give the server one session per connection (stdio, HTTP+SSE). Use the servlet filter for Streamable HTTP.
- **Server-to-client requests under the filter.** When the guard refuses a request the *server* sent the client (a sampling or elicitation request, MW026 / MW029), the servlet API gives no way to hand the server an answer: the request is dropped and logged, and the server sees it time out. This is the same limit the Python Django middleware has. The SDK wrapper has no such limit — there the refusal is fed back to the server as though the client had answered.

The SDK wrapper also relies on `McpServerSession` being a non-final class with public methods, since that is the only hook the SDK offers for inbound messages. It is a delegating subclass, so an SDK release that adds a public method to that class would need a matching override here.

## Troubleshooting

| Symptom | Cause |
|---|---|
| `could not start mcpwatch: No such file or directory` | Node isn't installed, or the engine isn't on the PATH. Install it, or set `engineCommand(...)` / `MCPWATCH_ENGINE` |
| Nothing appears in the dashboard | No project key, or the dashboard isn't running. Without a key, events go to `~/.mcpwatch/events.jsonl` |
| The filter never runs | Its URL pattern doesn't cover the MCP endpoint, or `path` doesn't match. The filter compares against the path **after** the context path |
| Attacks get through | The project is in `observe` mode — the default for new dashboard projects. Switch to `enforce` on the Settings tab |
| A legitimate call is blocked | The Requests tab shows the rule and the evidence. Trust the client on the Clients tab, or allow the tool |
| `NoClassDefFoundError: io/modelcontextprotocol/...` | The MCP SDK is `provided`. Using `McpWatch.guard` requires the SDK on your runtime classpath; the servlet filter alone does not |

Everything the guard logs goes through SLF4J under the logger name `mcpwatch`.

## Publishing

The npm and PyPI packages are published by hand from a maintainer's machine; this one works the same way, with two things Maven Central needs that the other two registries don't: every artifact signed, and the namespace verified once.

**The one-time setup is done.** `ai.vedha` is a verified namespace, so anything published under it from now on needs no further verification. Kept here for a new machine or a new maintainer:

1. **The namespace.** Central would not accept `ai.vedha` until control of `vedha.ai` was proven, by publishing a TXT record on the domain apex holding the key the [Central Portal](https://central.sonatype.com) issues. Add the record *before* pressing Verify: confirming first makes Central cache the failed lookup, which delays verification until that cache expires.
2. **A signing key.** Use **RSA** (4096). Central's examples are all RSA and EdDSA keys have been reported to fail validation with nothing but a generic "Signature verification failed". The key must have no *signing subkey* — Central verifies against the primary key only.
   ```powershell
   gpg --full-generate-key                     # (1) RSA and RSA, 4096 bits, 3y or longer
   gpg --keyserver keyserver.ubuntu.com --send-keys <KEY_ID>
   gpg --keyserver keys.openpgp.org   --send-keys <KEY_ID>
   ```
   Publishing the public key is not optional: Central fetches it to check the signatures, and a failed lookup is cached for about a day.
3. **`~/.m2/settings.xml`** — the Portal token under the server id `central` (from *Generate User Token*; not your login), and the key id, so the gpg plugin doesn't sign with some other default key:
   ```xml
   <servers>
     <server>
       <id>central</id>
       <username>TOKEN_USERNAME</username>
       <password>TOKEN_PASSWORD</password>
     </server>
   </servers>
   <profiles>
     <profile>
       <id>release</id>
       <properties><gpg.keyname>YOUR_RSA_KEY_ID</gpg.keyname></properties>
     </profile>
   </profiles>
   ```
   Leave the passphrase out and let `gpg-agent` prompt; `<gpg.passphrase>` would sit in plaintext and `-Dgpg.passphrase=` shows up in the process list. Add `export GPG_TTY=$(tty)` to your shell profile, or signing fails with `Inappropriate ioctl for device`.

**Each release:**

```powershell
cd java
mvn -Prelease deploy
```

That runs the tests, builds the main, sources and javadoc jars, signs all four files and uploads them. `mvn deploy` runs the tests on the way, the way `prepublishOnly` does for the npm packages, so a failing build can't ship.

The upload then **waits for you to press Publish** in the Portal, so you can check the staged files first. To skip that, set `<autoPublish>true</autoPublish>` in the `release` profile in [pom.xml](pom.xml).

Three things worth knowing:

- **A released version is permanent.** Central allows no re-upload or deletion, so bump `<version>` for every release. A deployment that *fails validation* costs nothing, though — it never publishes, and the same version can be redeployed.
- **Keep `central-publishing-maven-plugin` current.** The Central API gains fields, and older plugin builds reject what they haven't seen: 0.7.0 fails every deploy with `Unrecognized field "warnings"` while reading the status response, *after* the upload has already succeeded.
- **Watch the signing key's expiry.** Once it expires you cannot publish until you extend it and re-upload it to the keyservers:
  ```powershell
  gpg --quick-set-expire <FINGERPRINT> 3y '*'
  gpg --keyserver keyserver.ubuntu.com --send-keys <KEY_ID>
  ```

After publishing, the artifact reaches `repo1.maven.org` in 10–20 minutes and is usable immediately. The search indexes lag well behind that: `search.maven.org` by a few hours, and the third-party `mvnrepository.com` by days. A new release missing from those is normal and not a sign anything went wrong.

Everything above lives in the `release` profile, so an ordinary `mvn test` or `mvn install` needs no key and no credentials.

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

## Licence

ISC, as the rest of MCP-Watch. See [LICENSE](LICENSE).
