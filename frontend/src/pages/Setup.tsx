import type { ReactNode } from "react";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Card from "@mui/material/Card";
import Typography from "@mui/material/Typography";
import { CopyBlock, Label } from "../components/ui";
import { useApp } from "../context";
import { MODES, status } from "../lib";
import { ACCENT, MONO } from "../theme";
import type { Meta, Project } from "../types";

const P = ({ children }: { children: ReactNode }) => <Typography sx={{ color: "text.secondary", fontSize: 13, my: 0.5 }}>{children}</Typography>;
const M = ({ children }: { children: ReactNode }) => <Box component="span" sx={{ fontFamily: MONO, fontSize: 12 }}>{children}</Box>;

// The engine package; the proxies run from it with npx, so the steps work on any machine.
const ENGINE = "@vedhaai/mcpwatch";

function steps(p: Project, meta: Meta): [string, ReactNode][] {
  const server = meta.server;
  const env = `$env:MCPWATCH_PROJECT_KEY = "${p.key}"\n$env:MCPWATCH_SERVER = "${server}"`;
  const start: [string, ReactNode] = ["Start your server and connect any MCP client", <P>Nothing changes on the client side. Every request from any client shows up on the Requests tab.</P>];
  if (p.kind === "middleware") {
    return [
      ["Install MCPWatch in your MCP server project", <CopyBlock text="npm install @vedhaai/mcpwatch" />],
      ["Add one line before connect()", <CopyBlock text={`import { mcpwatch } from "@vedhaai/mcpwatch";

const server = new McpServer({ name: "my-tools", version: "1.0.0" });
// ... server.registerTool(...) as usual

mcpwatch(server);   // ← add this line
await server.connect(transport);`} />],
      ["Give it your project key", <><P>Set these where your server runs (PowerShell shown). Or pass them in code: <M>mcpwatch(server, {"{ projectKey, server }"})</M>.</P><CopyBlock text={env} /></>],
      start,
    ];
  }
  if (p.kind === "middleware-python") {
    return [
      ["Install MCPWatch in your server's Python environment", <>
        <CopyBlock text="pip install vedhaai-mcpwatch" />
        <P>The checks run in the MCPWatch engine, which needs Node 20+. The package starts it for you (the first start downloads it with npx). To skip that download, install it once:</P>
        <CopyBlock text="npm install -g @vedhaai/mcpwatch" />
      </>],
      ["Add one line to your server", <CopyBlock text={`# MCP SDK (MCPServer / FastMCP): stdio, SSE and Streamable HTTP
from mcpwatch import mcpwatch
mcpwatch(server)                     # ← before server.run()

# Django, settings.py
MIDDLEWARE = ["mcpwatch.django.McpWatchMiddleware", ...]

# Flask
from mcpwatch.flask import McpWatch
McpWatch(app, path="/mcp")

# FastAPI / Starlette
from mcpwatch import McpWatchASGI
app.add_middleware(McpWatchASGI, name="my-tools", path="/mcp")`} />],
      ["Give it your project key", <><P>Set these where your server runs (PowerShell shown). Or pass them in code: <M>mcpwatch(server, project_key=…, server=…)</M>.</P><CopyBlock text={env} /></>],
      start,
    ];
  }
  if (p.kind === "middleware-java") {
    return [
      ["Add MCPWatch to your server's build", <>
        <CopyBlock text={`<dependency>
  <groupId>ai.vedha</groupId>
  <artifactId>mcpwatch</artifactId>
  <version>0.1.0</version>
</dependency>`} />
        <P>Needs Java 17+. The checks run in the MCPWatch engine, which needs Node 20+. The package starts it for you (the first start downloads it with npx). To skip that download, install it once:</P>
        <CopyBlock text="npm install -g @vedhaai/mcpwatch" />
      </>],
      ["Add one line to your server", <CopyBlock text={`// MCP Java SDK (stdio, HTTP+SSE)
import ai.vedha.mcpwatch.sdk.McpWatch;

var server = McpServer.sync(McpWatch.guard(transport))   // ← wrap your transport provider
    .serverInfo("my-tools", "1.0.0")
    .tools(...)
    .build();

// Spring Boot, Quarkus, Jetty, Tomcat — and Streamable HTTP
@Bean
FilterRegistrationBean<McpWatchFilter> mcpwatch() {
    var r = new FilterRegistrationBean<>(new McpWatchFilter("my-tools", null, "/mcp"));
    r.addUrlPatterns("/mcp/*");
    r.setOrder(Ordered.HIGHEST_PRECEDENCE);
    return r;
}`} />],
      ["Give it your project key", <><P>Set these where your server runs (PowerShell shown). Or pass them in code: <M>McpWatchOptions.builder().projectKey(…).server(…).build()</M>.</P><CopyBlock text={env} /></>],
      start,
    ];
  }
  if (p.kind === "proxy-stdio") {
    const cfg = JSON.stringify({ "my-server": { command: "npx", args: ["-y", ENGINE, "--project-key", p.key, "--server", server, "--", "npx", "-y", "@modelcontextprotocol/server-filesystem", "C:/mcp-test"] } }, null, 2);
    return [
      ["Put MCPWatch in front of your server's command", <><P>In your MCP client's config (Claude Desktop, Cursor…), the command becomes <M>npx -y {ENGINE} … --</M> followed by your server's usual command. Example with the filesystem server:</P><CopyBlock text={cfg} /></>],
      ["Or with Claude Code", <CopyBlock text={`claude mcp add my-server -- npx -y ${ENGINE} --project-key ${p.key} --server ${server} -- npx -y @modelcontextprotocol/server-filesystem C:/mcp-test`} />],
      ["Restart the client and use the server", <P>The proxy starts with the client and reports every request here. Needs Node 20+; npx downloads MCPWatch the first time.</P>],
    ];
  }
  return [
    ["Run the proxy in front of your server's URL", <CopyBlock text={`npx -y ${ENGINE} http --listen 8800 --upstream https://your-server.example/mcp --project-key ${p.key} --server ${server}`} />],
    ["Point your MCP client at the proxy", <><CopyBlock text="http://127.0.0.1:8800/mcp" /><P>Use this URL in place of the server's real URL.</P></>],
    ["Use the server", <P>Every request through the proxy shows up on the Requests tab.</P>],
  ];
}

export function SetupTab({ project: p }: { project: Project }) {
  const { meta } = useApp();
  const on = status(p).on;
  return (
    <Box sx={{ maxWidth: 960 }}>
      <Alert severity={on ? "success" : "warning"} variant="outlined" sx={{ mb: 2, bgcolor: "background.paper", alignItems: "center" }}>
        <b>{on ? "Connected" : "Waiting for your MCP server…"}</b>{" "}
        {on ? "Your guard is reporting to this project." : "This turns green when the guard first contacts the dashboard."}
      </Alert>
      <Card sx={{ p: { xs: 2, md: 3 }, mb: 2 }}>
        <Label>Project key</Label>
        <CopyBlock text={p.key} />
        <Typography sx={{ fontSize: 12, color: "text.secondary", mt: 0.75 }}>
          Keep it secret, like a password. New projects start in <b>{p.mode}</b> mode: {MODES[p.mode]} Change it under Settings.
        </Typography>
      </Card>
      <Card sx={{ p: { xs: 2, md: 3 }, mb: 2 }}>
        <Label sx={{ mb: 2 }}>Connect your MCP server</Label>
        {steps(p, meta).map(([title, body], i) => (
          <Box key={title} sx={{ display: "grid", gridTemplateColumns: "28px 1fr", gap: 1.5, mb: 2.25, minWidth: 0 }}>
            <Box sx={{ width: 28, height: 28, borderRadius: "50%", background: ACCENT, color: "#2b1a12", fontWeight: 700, display: "grid", placeItems: "center" }}>{i + 1}</Box>
            <Box sx={{ minWidth: 0 }}>
              <Typography sx={{ fontWeight: 600, mt: 0.4, mb: 0.75 }}>{title}</Typography>
              {body}
            </Box>
          </Box>
        ))}
      </Card>
    </Box>
  );
}
