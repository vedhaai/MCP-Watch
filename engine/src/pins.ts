import { readFileSync } from "node:fs";
import { integrityKey, seal, tightenExisting, unseal, writePrivateAtomic } from "./fsutil.js";
import type { ToolDef } from "./rules.js";
import { hash } from "./state.js";

type PinFile = Record<string, Record<string, { hash: string; pinnedAt: string; value?: string }>>;

// Pinned under this name next to the tools: the server's own name and version (MW038).
const SERVER_PIN = "@server";

export type PinStatus = "new" | "same" | "changed" | "unpinned";

// Trust on first use: the first definition seen for each tool of a server is pinned. A later, different
// definition of that tool is a rug pull.
//
// Two options narrow what "first use" trusts:
// - `strict`: nothing new is ever pinned. A tool that isn't already in the pin file is "unpinned" and is
//   refused like a changed one. Learn the tools in a normal run, then switch strict on.
// - an integrity key (MCPWATCH_PINS_KEY): the file carries an HMAC. A file that was edited, or replaced by an
//   unsigned one, is not believed, and every tool then counts as changed until `mcpwatch pins reset`.
export class Pins {
  private data: PinFile = {};
  private tampered = false;

  constructor(private file: string, private serverKey: string, private strict = false, private key = integrityKey()) {
    try {
      const { data, status } = unseal(readFileSync(file, "utf8"), key);
      if (status !== "ok") {
        this.tampered = true;
        console.error(`[mcpwatch] ${file} ${status === "unsigned" ? "is not signed" : "does not match its signature"}: pinned tools are not trusted. Run "mcpwatch pins reset" after checking your servers`);
      } else {
        this.data = data && typeof data === "object" && !Array.isArray(data) ? (data as PinFile) : {};
      }
      tightenExisting(file);
    } catch {
      this.data = {};
    }
  }

  static fingerprint(tool: ToolDef): string {
    return hash({ description: tool.description ?? "", inputSchema: tool.inputSchema ?? {} });
  }

  // Forgets every pin (written signed, when there is a key).
  static clear(file: string, key = integrityKey()) {
    writePrivateAtomic(file, seal({}, key, true));
  }

  // New tools are pinned immediately, unless strict.
  check(tool: ToolDef): PinStatus {
    if (this.tampered) return "changed";
    const pins = (this.data[this.serverKey] ??= {});
    const fp = Pins.fingerprint(tool);
    const pin = pins[tool.name];
    if (!pin) {
      if (this.strict) return "unpinned";
      pins[tool.name] = { hash: fp, pinnedAt: new Date().toISOString() };
      this.save();
      return "new";
    }
    return pin.hash === fp ? "same" : "changed";
  }

  // "changed" carries the pinned value, e.g. "acme-files@1.2.0". A normal run pins the new value from then
  // on, so one upgrade is reported once; a strict run keeps the old one, so it is reported until reset.
  checkServer(info: { name?: unknown; version?: unknown }): { status: "new" | "same" | "changed"; was?: string; now: string } {
    const now = `${String(info.name ?? "?")}@${String(info.version ?? "?")}`;
    if (this.tampered) return { status: "changed", was: "(pins not trusted)", now };
    const pins = (this.data[this.serverKey] ??= {});
    const pin = pins[SERVER_PIN];
    if (pin?.value === now) return { status: "same", now };
    if (!this.strict) {
      pins[SERVER_PIN] = { hash: hash(now), value: now, pinnedAt: new Date().toISOString() };
      this.save();
    }
    return pin ? { status: "changed", was: pin.value, now } : { status: "new", now };
  }

  private save() {
    try {
      writePrivateAtomic(this.file, seal(this.data, this.key, true));
    } catch (e) {
      console.error(`[mcpwatch] could not save pins: ${(e as Error).message}`);
    }
  }
}
