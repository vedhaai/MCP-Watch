import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

// What every guard on this machine shares through one small file: the tools each server offers,
// and fingerprints of lines of sensitive output. One guard only ever sees its own server; this is
// how it learns about the others (tool collisions, shadowing, data moving between servers).

interface Data {
  servers: Record<string, { tools: string[]; seenAt: number }>;
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

export class Registry {
  private data: Data = { servers: {}, lines: {} };
  private mtime = -1;

  constructor(private file: string) {}

  // Re-read only when another guard changed the file.
  private load(): Data {
    try {
      const m = statSync(this.file).mtimeMs;
      if (m !== this.mtime) {
        const d = JSON.parse(readFileSync(this.file, "utf8"));
        this.data = { servers: d.servers ?? {}, lines: d.lines ?? {} };
        this.mtime = m;
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
      mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(d));
      renameSync(tmp, this.file);
      this.mtime = statSync(this.file).mtimeMs;
    } catch (e) {
      console.error(`[mcpwatch] could not save the registry: ${(e as Error).message}`);
    }
  }

  recordTools(server: string, tools: string[]) {
    const d = this.load();
    d.servers[server] = { tools: [...new Set(tools)].sort(), seenAt: Date.now() };
    this.save(d);
  }

  // Tool name -> the other servers that offer a tool with that name.
  otherTools(server: string): Map<string, string[]> {
    const out = new Map<string, string[]>();
    for (const [name, s] of Object.entries(this.load().servers)) {
      if (name === server) continue;
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
