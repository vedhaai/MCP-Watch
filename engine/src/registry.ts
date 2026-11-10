import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { integrityKey, seal, tightenExisting, unseal, writePrivateAtomic } from "./fsutil.js";

// What every guard on this machine shares through one small file: the tools each server offers,
// and fingerprints of lines of sensitive output. One guard only ever sees its own server; this is
// how it learns about the others (tool collisions, shadowing, data moving between servers).

interface Data {
  // fp: digest of the whole tool list, to recognize the same server under another name.
  servers: Record<string, { tools: string[]; fp?: string; seenAt: number }>;
  // sha256 of a normalized line of sensitive output -> the server it came from.
  lines: Record<string, { server: string; t: number }>;
}

const SERVER_TTL = 30 * 24 * 3600_000;
const LINE_TTL = 3600_000;
const MAX_LINES = 20_000;
const MIN_LINE = 24;

const normalize = (line: string) => line.trim().replace(/\s+/g, " ");
const digest = (line: string) => createHash("sha256").update(line).digest("hex").slice(0, 32);

// The distinctive lines of a text: long enough that a match isn't a coincidence.
export function linesOf(text: string): string[] {
  return text.split(/\r?\n/).map(normalize).filter((l) => l.length >= MIN_LINE && l.length <= 2000);
}

// The same tool list (names, descriptions, schemas) gives the same digest, whatever the server is called.
export function toolsDigest(tools: { name: string; description?: string; inputSchema?: unknown }[]): string {
  const list = tools.map((t) => [t.name, t.description ?? "", t.inputSchema ?? {}]).sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  return digest(JSON.stringify(list));
}

// The file is shared and lives on disk, so nothing in it is trusted to have the right shape.
function sanitize(d: unknown): Data {
  const out: Data = { servers: {}, lines: {} };
  const obj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
  if (!obj(d)) return out;
  if (obj(d.servers)) {
    for (const [name, s] of Object.entries(d.servers)) {
      if (!obj(s) || !Array.isArray(s.tools) || typeof s.seenAt !== "number") continue;
      out.servers[name] = {
        tools: s.tools.filter((t): t is string => typeof t === "string"), seenAt: s.seenAt, fp: typeof s.fp === "string" ? s.fp : undefined,
      };
    }
  }
  if (obj(d.lines)) {
    for (const [k, v] of Object.entries(d.lines)) {
      if (obj(v) && typeof v.server === "string" && typeof v.t === "number") out.lines[k] = { server: v.server, t: v.t };
    }
  }
  return out;
}

export class Registry {
  private data: Data = { servers: {}, lines: {} };
  private mtime = -1;

  constructor(private file: string, private key = integrityKey()) {}

  // Re-read only when another guard changed the file.
  private load(): Data {
    try {
      const m = statSync(this.file).mtimeMs;
      if (m !== this.mtime) {
        const { data, status } = unseal(readFileSync(this.file, "utf8"), this.key);
        this.mtime = m;
        if (status !== "ok") {
          // Not written by a guard holding the key: ignored, and overwritten by the next save.
          console.error(`[mcpwatch] ${this.file} ${status === "unsigned" ? "is not signed" : "does not match its signature"}; ignoring it`);
          return this.data;
        }
        this.data = sanitize(data);
        tightenExisting(this.file);
      }
    } catch {
      // no registry yet, or a partial write by another guard: keep what we have
    }
    return this.data;
  }

  private save(d: Data) {
    const now = Date.now();
    for (const [k, v] of Object.entries(d.servers)) if (now - v.seenAt > SERVER_TTL) delete d.servers[k];
    const lines = Object.entries(d.lines).filter(([, v]) => now - v.t <= LINE_TTL);
    d.lines = Object.fromEntries(lines.slice(-MAX_LINES));
    try {
      writePrivateAtomic(this.file, seal(d, this.key));
      this.mtime = statSync(this.file).mtimeMs;
    } catch (e) {
      console.error(`[mcpwatch] could not save the registry: ${(e as Error).message}`);
    }
  }

  recordTools(server: string, tools: string[], fp?: string) {
    const d = this.load();
    d.servers[server] = { tools: [...new Set(tools)].sort(), fp, seenAt: Date.now() };
    this.save(d);
  }

  // Tool name -> the other servers that offer a tool with that name. A server with the exact same
  // tool list (fp) is this server under another name, e.g. after renaming it, so it is left out.
  otherTools(server: string, fp?: string): Map<string, string[]> {
    const out = new Map<string, string[]>();
    for (const [name, s] of Object.entries(this.load().servers)) {
      if (name === server || (fp && s.fp === fp)) continue;
      for (const t of s.tools) out.set(t, [...(out.get(t) ?? []), name]);
    }
    return out;
  }

  recordSensitive(server: string, texts: string[]) {
    const d = this.load();
    const t = Date.now();
    let added = 0;
    for (const text of texts) {
      for (const line of linesOf(text)) {
        d.lines[digest(line)] = { server, t };
        added++;
      }
    }
    if (added) this.save(d);
  }

  // The server a line of `text` came from, if it's sensitive output of a different server.
  leakSource(server: string, text: string): string | undefined {
    const d = this.load();
    if (!Object.keys(d.lines).length) return undefined;
    for (const line of linesOf(text)) {
      const hit = d.lines[digest(line)];
      if (hit && hit.server !== server && Date.now() - hit.t <= LINE_TTL) return hit.server;
    }
    return undefined;
  }
}
