import path from "node:path";
import { AI_OFF, type Project } from "../models/project.js";
import { readJson, writeJson } from "./json-files.js";
import { SecretBox } from "./secret-box.js";

const PROJECT_DEFAULTS: Partial<Project> = { allowedOrigins: [], requireAuth: false, expectedAudience: "", ai: AI_OFF };

// All projects in one JSON file (projects.json), kept in memory and written on every change.
export class ProjectRepository {
  private projects: Project[];
  private readonly file: string;
  private readonly box: SecretBox;

  constructor(dir: string) {
    this.file = path.join(dir, "projects.json");
    this.box = new SecretBox(dir);
    const stored = readJson<(Project & { aiReview?: boolean })[]>(this.file, []);
    // Projects saved before a setting existed get its default. Secrets are encrypted on disk and plain in memory.
    this.projects = stored
      .map(({ aiReview, ...p }) => ({ ...PROJECT_DEFAULTS, ...(aiReview ? { ai: { ...AI_OFF, provider: "local" as const } } : {}), ...p }))
      .map((p) => ({ ...p, key: this.box.open(p.key), ai: { ...p.ai, ...(p.ai.apiKey ? { apiKey: this.box.open(p.ai.apiKey) } : {}) } }));
    // Keys written by an older version are in the clear: encrypt them now.
    if (stored.some((p) => (p.key && !this.box.isSealed(p.key)) || (p.ai?.apiKey && !this.box.isSealed(p.ai.apiKey)))) this.save();
  }

  private save() {
    writeJson(this.file, this.projects.map((p) => ({ ...p, key: this.box.seal(p.key), ai: { ...p.ai, ...(p.ai.apiKey ? { apiKey: this.box.seal(p.ai.apiKey) } : {}) } })));
  }

  all(): Project[] {
    return this.projects;
  }

  byOwner(ownerId: string): Project[] {
    return this.projects.filter((p) => p.ownerId === ownerId);
  }

  byId(id: string): Project | undefined {
    return this.projects.find((p) => p.id === id);
  }

  byKey(key: string): Project | undefined {
    return key ? this.projects.find((p) => p.key === key) : undefined;
  }

  // New projects go first, so lists show the newest on top.
  insert(p: Project): Project {
    this.projects.unshift(p);
    this.save();
    return p;
  }

  // Writes the given changes to the stored project.
  update(id: string, changes: Partial<Project>): Project | undefined {
    const p = this.byId(id);
    if (!p) return undefined;
    Object.assign(p, changes);
    this.save();
    return p;
  }

  remove(id: string) {
    this.projects = this.projects.filter((p) => p.id !== id);
    this.save();
  }
}
