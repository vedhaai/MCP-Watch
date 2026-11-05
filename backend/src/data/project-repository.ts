import path from "node:path";
import { AI_OFF, type Project } from "../models/project.js";
import { readJson, writeJson } from "./json-files.js";

const PROJECT_DEFAULTS: Partial<Project> = { allowedOrigins: [], requireAuth: false, expectedAudience: "", ai: AI_OFF };

// All projects in one JSON file (projects.json), kept in memory and written on every change.
export class ProjectRepository {
  private projects: Project[];
  private readonly file: string;

  constructor(dir: string) {
    this.file = path.join(dir, "projects.json");
    // Projects saved before a setting existed get its default.
    this.projects = readJson<(Project & { aiReview?: boolean })[]>(this.file, [])
      .map(({ aiReview, ...p }) => ({ ...PROJECT_DEFAULTS, ...(aiReview ? { ai: { ...AI_OFF, provider: "local" as const } } : {}), ...p }));
  }

  private save() {
    writeJson(this.file, this.projects);
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
