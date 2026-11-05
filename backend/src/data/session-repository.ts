import path from "node:path";
import type { Session } from "../models/user.js";
import { readJson, writeJson } from "./json-files.js";

// Signed-in sessions by token in sessions.json, so they survive a restart of the dashboard.
export class SessionRepository {
  private sessions = new Map<string, Session>();
  private readonly file: string;

  constructor(dir: string) {
    this.file = path.join(dir, "sessions.json");
    const now = Date.now();
    for (const [token, s] of Object.entries(readJson<Record<string, Session>>(this.file, {}))) {
      if (s.expires > now) this.sessions.set(token, s);
    }
  }

  private save() {
    writeJson(this.file, Object.fromEntries(this.sessions), false);
  }

  get(token: string): Session | undefined {
    return this.sessions.get(token);
  }

  set(token: string, session: Session) {
    this.sessions.set(token, session);
    this.save();
  }

  delete(token: string) {
    if (this.sessions.delete(token)) this.save();
  }
}
