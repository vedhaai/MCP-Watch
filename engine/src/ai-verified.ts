import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

// Which models have passed `mcpwatch ai`, kept in a small file so a guard can tell a checked model from one
// nobody has tried. Only used when the policy asks for it (requireVerified).
export interface Verified {
  recall: number;
  falseAlarmRate: number;
  samples: number;
  at: string;
}

export const verifiedKey = (url: string, model: string) => `${url.replace(/\/+$/, "")}|${model}`;

export function readVerified(file: string): Record<string, Verified> {
  try {
    const raw = JSON.parse(readFileSync(file, "utf8"));
    return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  } catch {
    return {};
  }
}

export function recordVerified(file: string, url: string, model: string, result: Omit<Verified, "at">) {
  const all = readVerified(file);
  all[verifiedKey(url, model)] = { ...result, at: new Date().toISOString() };
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(all, null, 2));
}

export function isVerified(file: string, url: string, model: string): boolean {
  return verifiedKey(url, model) in readVerified(file);
}
