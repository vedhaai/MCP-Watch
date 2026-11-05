import { closeSync, existsSync, openSync, readFileSync, readSync, statSync, writeFileSync } from "node:fs";

const MAX_READ = 5 * 1024 * 1024;

export function readJson<T>(file: string, fallback: T): T {
  return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as T) : fallback;
}

export function writeJson(file: string, value: unknown, pretty = true) {
  writeFileSync(file, pretty ? JSON.stringify(value, null, 2) : JSON.stringify(value));
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
