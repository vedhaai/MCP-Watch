import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { ToolDef } from "./rules.js";
import { hash } from "./state.js";

type PinFile = Record<string, Record<string, { hash: string; pinnedAt: string; value?: string }>>;

// Pinned under this name next to the tools: the server's own name and version (MW038).
const SERVER_PIN = "@server";

// Trust on first use: the first definition seen for each tool of a server is pinned.
// A later, different definition of that tool is a rug pull.
export class Pins {
  private data: PinFile = {};

  constructor(private file: string, private serverKey: string) {
    try {
      this.data = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      this.data = {};
    }
  }

  static fingerprint(tool: ToolDef): string {
    return hash({ description: tool.description ?? "", inputSchema: tool.inputSchema ?? {} });
  }

  // Returns "new", "same" or "changed". New tools are pinned immediately.
  check(tool: ToolDef): "new" | "same" | "changed" {
    const pins = (this.data[this.serverKey] ??= {});
    const fp = Pins.fingerprint(tool);
    const pin = pins[tool.name];
    if (!pin) {
      pins[tool.name] = { hash: fp, pinnedAt: new Date().toISOString() };
      this.save();
      return "new";
    }
    return pin.hash === fp ? "same" : "changed";
  }

  // "changed" carries the pinned value, e.g. "acme-files@1.2.0". The new value is pinned from then on,
  // so one upgrade is reported once.
  checkServer(info: { name?: unknown; version?: unknown }): { status: "new" | "same" | "changed"; was?: string; now: string } {
    const pins = (this.data[this.serverKey] ??= {});
    const now = `${String(info.name ?? "?")}@${String(info.version ?? "?")}`;
    const pin = pins[SERVER_PIN];
    if (pin?.value === now) return { status: "same", now };
    pins[SERVER_PIN] = { hash: hash(now), value: now, pinnedAt: new Date().toISOString() };
    this.save();
    return pin ? { status: "changed", was: pin.value, now } : { status: "new", now };
  }

  private save() {
    try {
      mkdirSync(path.dirname(this.file), { recursive: true });
      writeFileSync(this.file, JSON.stringify(this.data, null, 2));
    } catch (e) {
      console.error(`[mcpwatch] could not save pins: ${(e as Error).message}`);
    }
  }
}
