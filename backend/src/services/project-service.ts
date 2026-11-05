import { randomBytes, randomUUID } from "node:crypto";
import type { EventRepository } from "../data/event-repository.js";
import type { ProjectRepository } from "../data/project-repository.js";
import { HttpError } from "../errors.js";
import type { AiSettingsInput, AiTestResult, NewProject, ProjectPatch, ProjectView } from "../models/api.js";
import { AI_OFF, type Project } from "../models/project.js";
import type { AiService } from "./ai-service.js";

export const newKey = () => "mw_" + randomBytes(24).toString("base64url");

// How many events a list returns: 1000 unless asked, at most 5000.
export const eventLimit = (limit?: number) => Math.min(Math.max(1, Math.floor(limit ?? 1000)), 5000);

export function forBrowser(p: Project): ProjectView {
  const { apiKey, ...ai } = p.ai;
  return { ...p, ai: { ...ai, keySet: !!apiKey, keyHint: apiKey ? `…${apiKey.slice(-4)}` : "" } };
}

// A signed-in user's projects. Every call takes the user's id, and someone else's project looks the
// same as a missing one.
export class ProjectService {
  constructor(private projects: ProjectRepository, private eventRepo: EventRepository, private ai: AiService) {}

  private owned(ownerId: string, id: string): Project {
    const p = this.projects.byId(id);
    if (!p || p.ownerId !== ownerId) throw new HttpError(404, "project not found");
    return p;
  }

  list(ownerId: string): ProjectView[] {
    return this.projects.byOwner(ownerId).map(forBrowser);
  }

  get(ownerId: string, id: string): ProjectView {
    return forBrowser(this.owned(ownerId, id));
  }

  create(ownerId: string, input: NewProject): ProjectView {
    const name = input.name.trim().slice(0, 100);
    if (!name) throw new HttpError(400, "name is required");
    return forBrowser(this.projects.insert({
      id: randomUUID(), ownerId, name, kind: input.kind ?? "middleware", key: newKey(), mode: "observe", windowSeconds: 60, throttleAt: 3, blockAt: 6,
      denyTools: [], clients: { block: [], allow: [] }, allowedOrigins: [], requireAuth: false, expectedAudience: "", ai: { ...AI_OFF }, version: 1,
      createdAt: new Date().toISOString(), lastSeenAt: null,
    }));
  }

  // Each change bumps the version, which is how guards notice new settings.
  update(ownerId: string, id: string, patch: ProjectPatch): ProjectView {
    const p = this.owned(ownerId, id);
    const changes = this.checkPatch(patch, p);
    return forBrowser(this.projects.update(p.id, { ...changes, version: p.version + 1 })!);
  }

  remove(ownerId: string, id: string) {
    const p = this.owned(ownerId, id);
    this.projects.remove(p.id);
    this.eventRepo.clear(p.id);
  }

  // The old key stops working at once.
  rotateKey(ownerId: string, id: string): ProjectView {
    const p = this.owned(ownerId, id);
    return forBrowser(this.projects.update(p.id, { key: newKey() })!);
  }

  // Checks AI settings (saved, or the unsaved ones in the form) with a sample attack.
  testAi(ownerId: string, id: string, input: AiSettingsInput): Promise<AiTestResult> {
    const p = this.owned(ownerId, id);
    return this.ai.test(this.ai.fromInput(input, p.ai));
  }

  events(ownerId: string, id: string, limit?: number): unknown[] {
    return this.eventRepo.recent(this.owned(ownerId, id).id, eventLimit(limit));
  }

  clearEvents(ownerId: string, id: string) {
    this.eventRepo.clear(this.owned(ownerId, id).id);
  }

  // Projects created before accounts existed go to the given user.
  claimUnowned(ownerId: string) {
    for (const p of this.projects.all()) {
      if (!p.ownerId) this.projects.update(p.id, { ownerId });
    }
  }

  private checkPatch(body: ProjectPatch, current: Project): Partial<Project> {
    const out: Partial<Project> = {};
    if (body.name !== undefined) {
      if (!body.name.trim()) throw new HttpError(400, "name must be a non-empty string");
      out.name = body.name.trim().slice(0, 100);
    }
    if (body.mode !== undefined) out.mode = body.mode;
    for (const k of ["windowSeconds", "throttleAt", "blockAt"] as const) {
      const n = body[k];
      if (n !== undefined) {
        if (!Number.isFinite(n) || n <= 0) throw new HttpError(400, `${k} must be a positive number`);
        out[k] = n;
      }
    }
    if (body.denyTools !== undefined) out.denyTools = body.denyTools.filter(Boolean).slice(0, 200);
    if (body.allowedOrigins !== undefined) {
      const origins = body.allowedOrigins.map((o) => o.trim().replace(/\/+$/, "")).filter(Boolean).slice(0, 100);
      for (const o of origins) {
        let ok = false;
        try {
          ok = new URL(o).origin === o;
        } catch {
          // not a URL
        }
        if (!ok) throw new HttpError(400, `"${o}" is not an origin (e.g. https://app.example.com)`);
      }
      out.allowedOrigins = origins;
    }
    if (body.requireAuth !== undefined) out.requireAuth = body.requireAuth;
    if (body.ai !== undefined) out.ai = this.ai.fromInput(body.ai, current.ai);
    if (body.expectedAudience !== undefined) out.expectedAudience = body.expectedAudience.trim().slice(0, 300);
    if (body.clients !== undefined) out.clients = { block: body.clients.block.slice(0, 500), allow: body.clients.allow.slice(0, 500) };
    return out;
  }
}
