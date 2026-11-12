import path from "node:path";
import { appendPrivate, privateDir, tightenExisting } from "./fsutil.js";
import type { Finding } from "./rules.js";

export type Action = "allow" | "block" | "throttle" | "redact" | "strip";

export interface McpEvent {
  time: string;
  server: string;
  session: string;
  client: string;
  clientName: string;
  // "local": found by `mcpwatch scan` on the machine, not in an MCP message.
  direction: "client->server" | "server->client" | "local";
  method: string;
  tool?: string;
  id?: string | number;
  mode: string;
  action: Action;
  // What enforce mode would have done; differs from action in observe / protect.
  enforceAction: Action;
  // Set when a person's block / trust decision about the client decided the action.
  clientRule?: "block" | "allow";
  score: number;
  findings: Finding[];
  // Short, secret-redacted excerpt of the arguments or output.
  snippet?: string;
  // What the AI reviewer said, when it reviewed this message.
  ai?: AiSummary;
}

// timeout: no answer in time. unreachable: connection failed. http: the server answered with an error.
// auth: key refused. parse: answer was not usable. busy / budget / circuit: skipped without calling the model.
// consent: the model is on another machine and the policy doesn't allow sending messages there (allowHosted).
export type AiFailure = "timeout" | "unreachable" | "http" | "auth" | "parse" | "busy" | "budget" | "circuit" | "consent";

export interface AiSummary {
  model: string;
  verdict: "allow" | "suspicious" | "block" | "error";
  ms: number;
  cached?: boolean;
  error?: string;
  // Why no review happened, so failures can be counted by kind. Set together with `error`.
  failure?: AiFailure;
  // Tokens this review used, as the model server reported them (or estimated, see `tokensEstimated`).
  // Absent for cached answers and for reviews that never reached the model.
  promptTokens?: number;
  completionTokens?: number;
  tokensEstimated?: true;
  // Cost in US dollars, only when the policy sets a price per million tokens.
  costUsd?: number;
  // One plain sentence from the model on what the message does.
  summary?: string;
}

export interface EventSink {
  write(event: McpEvent): void;
  // Send anything still queued (sinks that batch over the network).
  flush?(): Promise<void>;
}

// Appends one JSON line per event. Synchronous appends keep lines whole when several proxies share the file.
export class EventLog implements EventSink {
  constructor(private file: string) {
    privateDir(path.dirname(file));
    tightenExisting(file);
  }

  write(event: McpEvent) {
    try {
      appendPrivate(this.file, JSON.stringify(event) + "\n");
    } catch (e) {
      console.error(`[mcpwatch] could not write event: ${(e as Error).message}`);
    }
    if (event.findings.length) {
      const rules = event.findings.map((f) => f.rule).join(",");
      console.error(`[mcpwatch] ${event.action.toUpperCase()} ${event.method}${event.tool ? ` ${event.tool}` : ""} [${rules}]`);
    }
  }
}
