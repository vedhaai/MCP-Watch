import { appendFileSync, renameSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import type { McpEvent } from "@vedhaai/mcpwatch";
import { FILE_MODE, secureDir, tailJsonLines } from "./json-files.js";

const MAX_EVENTS_FILE = 20 * 1024 * 1024;

// Each project's events in its own JSON-lines file (events/<id>.jsonl), plus the local events file
// that guards without a project key write to.
export class EventRepository {
  private readonly dir: string;

  constructor(dataDir: string, private readonly localFile: string) {
    this.dir = path.join(dataDir, "events");
    secureDir(this.dir);
  }

  private file(projectId: string) {
    return path.join(this.dir, `${projectId}.jsonl`);
  }

  // When the file passes 20 MB it becomes <id>.jsonl.old and a new one starts.
  append(projectId: string, events: McpEvent[]) {
    if (!events.length) return;
    const file = this.file(projectId);
    appendFileSync(file, events.map((e) => JSON.stringify(e)).join("\n") + "\n", { mode: FILE_MODE });
    if (statSync(file).size > MAX_EVENTS_FILE) renameSync(file, file + ".old");
  }

  recent(projectId: string, limit: number): unknown[] {
    return tailJsonLines(this.file(projectId), limit);
  }

  clear(projectId: string) {
    rmSync(this.file(projectId), { force: true });
  }

  recentLocal(limit: number): unknown[] {
    return tailJsonLines(this.localFile, limit);
  }
}
