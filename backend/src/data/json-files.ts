import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

const MAX_READ = 5 * 1024 * 1024;

// The data dir holds password hashes, live session tokens and project keys (including the AI
// provider's API key). None of it is readable by other users on the machine.
export const FILE_MODE = 0o600;
export const DIR_MODE = 0o700;

export function readJson<T>(file: string, fallback: T): T {
  return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as T) : fallback;
}

export function writeJson(file: string, value: unknown, pretty = true) {
  writeFileSync(file, pretty ? JSON.stringify(value, null, 2) : JSON.stringify(value), { mode: FILE_MODE });
}

// `mode` on writeFileSync/mkdirSync only applies when the path is created, so anything an older
// version left behind as 0644 needs chmod as well. Failures are ignored: the path may not exist, or
// may belong to another user, and neither is worth refusing to start over.
export function secureDir(dir: string) {
  mkdirSync(dir, { recursive: true, mode: DIR_MODE });
  try {
    chmodSync(dir, DIR_MODE);
  } catch {
    // not ours to change
  }
}

export function secureFile(file: string) {
  try {
    chmodSync(file, FILE_MODE);
  } catch {
    // not there, or not ours to change
  }
}

// Tightens the data dir and everything under it, once, at startup.
export function secureTree(dir: string) {
  secureDir(dir);
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) secureTree(p);
    else if (entry.isFile()) secureFile(p);
  }
}

// The last `limit` JSON lines of a file, reading at most its last 5 MB.
export function tailJsonLines(file: string, limit: number): unknown[] {
  let size: number;
  try {
    size = statSync(file).size;
  } catch {
    return [];
  }
  const start = Math.max(0, size - MAX_READ);
  const buf = Buffer.alloc(size - start);
  const fd = openSync(file, "r");
  try {
    readSync(fd, buf, 0, buf.length, start);
  } finally {
    closeSync(fd);
  }
  const lines = buf.toString("utf8").split("\n").filter(Boolean);
  if (start > 0) lines.shift(); // first line may be cut
  const out: unknown[] = [];
  for (const l of lines.slice(-limit)) {
    try {
      out.push(JSON.parse(l));
    } catch {
      // skip a partial line
    }
  }
  return out;
}
