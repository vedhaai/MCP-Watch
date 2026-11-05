import { createHash } from "node:crypto";
import { finding, type Finding, type ToolDef } from "./rules.js";
import { OUTBOUND_TOOL } from "./patterns.js";
import type { Policy } from "./policy.js";

export function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value ?? null)).digest("hex").slice(0, 16);
}

interface Call { t: number; tool: string; argsHash: string }

export interface Pending { method: string; tool?: string; t: number }

// Everything the guard remembers about one MCP session (one stdio process, or one HTTP session id).
export class Session {
  // "name version" for display, and the bare name that block / trust lists match on.
  client = "unknown";
  clientName = "unknown";
  // Requests waiting for a response, by JSON-RPC id. Client->server and server->client ids are separate.
  pendingFromClient = new Map<string | number, Pending>();
  pendingFromServer = new Map<string | number, Pending>();
  // The tool list as last seen by the client (after the guard removed anything it blocked).
  tools: Map<string, ToolDef> | null = null;
  // Tools whose definitions changed after they were pinned. Calls to them are refused.
  rugPulled = new Set<string>();
  // HTTP: the credential and user agent that opened the session (kept in memory only, never logged).
  credential?: string;
  agent?: string;
  // HTTP proxy: ids of the SSE events relayed on this session, so a resumption can be checked (MW037).
  eventIds = new Set<string>();
  private seen = new Set<string>();
  private points: { t: number; points: number }[] = [];
  private blocked: number[] = [];
  private calls: Call[] = [];
  private taintedUntil = 0;

  constructor(public id: string, private policy: Policy) {}

  private prune(now: number) {
    const from = now - this.policy.windowSeconds * 1000;
    this.points = this.points.filter((p) => p.t >= from);
    this.blocked = this.blocked.filter((t) => t >= from);
    this.calls = this.calls.filter((c) => c.t >= from);
  }

  // True the first time `key` is seen in this session; for findings that should be reported once.
  once(key: string): boolean {
    if (this.seen.has(key)) return false;
    this.seen.add(key);
    return true;
  }

  addPoints(points: number, now = Date.now()) {
    if (points > 0) this.points.push({ t: now, points });
  }

  score(now = Date.now()): number {
    this.prune(now);
    return this.points.reduce((s, p) => s + p.points, 0);
  }

  noteBlocked(now = Date.now()) {
    this.blocked.push(now);
  }

  // Secrets came back from the server; an outbound call soon after looks like exfiltration.
  taint(now = Date.now()) {
    this.taintedUntil = now + this.policy.windowSeconds * 1000;
  }

  // MB rules: run on every tools/call, then record the call.
  checkBehavior(tool: string, args: unknown, now = Date.now()): Finding[] {
    this.prune(now);
    const out: Finding[] = [];
    const argsHash = hash(args);

    if (this.calls.length + 1 > this.policy.maxCallsPerWindow) {
      out.push(finding("MB001", `${this.calls.length + 1} calls in ${this.policy.windowSeconds}s`));
    }
    if (this.blocked.length >= 3) out.push(finding("MB002", `${this.blocked.length} blocked attempts in the window`));

    const sameTool = this.calls.filter((c) => c.tool === tool);
    const distinct = new Set(sameTool.map((c) => c.argsHash).concat(argsHash)).size;
    if (distinct >= this.policy.enumerationThreshold) {
      out.push(finding("MB003", `"${tool}" called with ${distinct} different arguments`));
    }
    const replays = sameTool.filter((c) => c.argsHash === argsHash).length + 1;
    if (replays >= this.policy.replayThreshold) out.push(finding("MB005", `Same "${tool}" call ${replays} times`));

    if (now < this.taintedUntil && OUTBOUND_TOOL.test(tool)) {
      out.push(finding("MB004", `"${tool}" called after the server returned secrets`));
    }

    this.calls.push({ t: now, tool, argsHash });
    return out;
  }
}
