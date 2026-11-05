import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ValidateError } from "@tsoa/runtime";
import express, { type ErrorRequestHandler, type Response } from "express";
import { HttpError } from "./errors.js";
import { RegisterRoutes } from "./generated/routes.js";
import { createServices, type DashboardConfig } from "./services/index.js";

// The MCPWatch dashboard server. People create projects here and copy a project key into their MCP
// server (middleware) or proxy; guards then report events and fetch settings through the agent API.
// Routes live in controllers/ (tsoa generates generated/routes.ts from them), rules in services/,
// storage in data/.

const here = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.join(here, "..", "public");

export function createApp(config: DashboardConfig): express.Express {
  const app = express();
  app.disable("x-powered-by");
  app.locals.services = createServices(config);

  // Dashboard writes must be JSON: a cross-site form can't send that without a CORS preflight we never allow.
  app.use("/api", (req, res, next) => {
    if (req.method === "GET" || req.path.startsWith("/agent/")) return next();
    if (!(req.headers["content-type"] ?? "").startsWith("application/json")) return send(res, 415, "send JSON");
    next();
  });

  // Bodies are parsed as JSON whatever their content type: guards don't always send one.
  app.use(express.json({ limit: "10mb", type: () => true }));

  RegisterRoutes(app);

  app.use("/api", (_req, res) => send(res, 404, "not found"));

  // The built web app (frontend/ -> public/). Files under assets/ have a content hash in their name, so
  // they can be cached for good; any other path gets index.html (routes live in the hash).
  app.use(express.static(WEB, {
    redirect: false,
    setHeaders(res, file) {
      const immutable = file.startsWith(path.join(WEB, "assets") + path.sep);
      res.setHeader("cache-control", immutable ? "public, max-age=31536000, immutable" : "no-cache");
      res.setHeader("x-content-type-options", "nosniff");
    },
  }));
  app.get("/{*path}", (_req, res) => {
    const index = path.join(WEB, "index.html");
    if (!existsSync(index)) return res.status(500).type("text/plain").send("The dashboard web app isn't built. Run: npm run build");
    res.setHeader("cache-control", "no-cache");
    res.setHeader("x-content-type-options", "nosniff");
    res.sendFile(index);
  });
  app.use((_req, res) => send(res, 404, "not found"));

  app.use(errorHandler);
  return app;
}

function send(res: Response, status: number, error: string) {
  res.status(status).json({ error });
}

// Every error answers { error: message }: the services' HttpErrors, tsoa's request checks, bad JSON.
const errorHandler: ErrorRequestHandler = (err, _req, res, next) => {
  if (res.headersSent) return next(err);
  if (err instanceof ValidateError) {
    const problems = Object.entries(err.fields).map(([field, f]) => problem(field.replace(/^[^.]+\./, ""), f.message));
    return send(res, 400, problems.join("; ") || "invalid request");
  }
  if (err instanceof HttpError) return send(res, err.status, err.message);
  const status = typeof err?.status === "number" && err.status >= 400 && err.status < 500 ? err.status : 500;
  if (status === 500) console.error(err);
  send(res, status, status === 500 ? "internal error" : (err as Error).message);
};

// tsoa reports a value outside a set of strings (like mode) as one failed match per string; list them instead.
function problem(field: string, message: string): string {
  const allowed = [...message.matchAll(/one of the following; \['([^']*)'\]/g)].map((m) => m[1]);
  return allowed.length ? `${field} must be one of ${allowed.join(", ")}` : `${field}: ${message}`;
}

export function runDashboard(port: number, dataDir: string, localEventsFile: string) {
  createApp({ port, dataDir, localEventsFile }).listen(port, "127.0.0.1", (err?: Error) => {
    // Express 5 hands listen errors (such as the port being in use) to this callback.
    if (err) {
      console.error(`MCPWatch dashboard can't listen on 127.0.0.1:${port}: ${err.message}`);
      process.exit(1);
    }
    console.log(`MCPWatch dashboard: http://127.0.0.1:${port}  (data: ${dataDir})`);
  });
}
