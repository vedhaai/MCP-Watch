import { createHmac, timingSafeEqual } from "node:crypto";
import { appendFileSync, chmodSync, mkdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

// The guard's files hold tool definitions, event snippets and cross-server fingerprints. They are
// private to the user that runs the guard: owner-only permissions (a no-op on Windows, where the
// profile directory is already per-user).
const FILE_MODE = 0o600;
const DIR_MODE = 0o700;

export function privateDir(dir: string) {
  mkdirSync(dir, { recursive: true, mode: DIR_MODE });
}

function tighten(file: string) {
  try {
    chmodSync(file, FILE_MODE);
  } catch {
    // not ours to change, or no such file yet
  }
}

export function writePrivate(file: string, data: string) {
  privateDir(path.dirname(file));
  writeFileSync(file, data, { mode: FILE_MODE });
  tighten(file);
}

// Writes through a temp file, so a reader never sees half a file.
export function writePrivateAtomic(file: string, data: string) {
  privateDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, data, { mode: FILE_MODE });
  renameSync(tmp, file);
}

// Appends a line. The file is rotated to `<file>.1` once it passes `maxBytes`, so it can't fill the disk.
export function appendPrivate(file: string, line: string, maxBytes = 20 * 1024 * 1024) {
  let created = false;
  try {
    if (statSync(file).size >= maxBytes) renameSync(file, `${file}.1`);
  } catch {
    created = true;
  }
  appendFileSync(file, line, { mode: FILE_MODE });
  if (created) tighten(file);
}

// Existing files from older versions get owner-only permissions the next time the guard starts.
export function tightenExisting(file: string) {
  tighten(file);
}

// ---- integrity ----
// With a key (MCPWATCH_PINS_KEY, kept outside the data directory), a file is stored with an HMAC over its
// contents. Whoever can write the file but doesn't have the key can't change it unnoticed. Without a key
// the files are stored as plain JSON, as before.
export const integrityKey = (env: NodeJS.ProcessEnv = process.env): string | undefined => env.MCPWATCH_PINS_KEY || undefined;

const mac = (data: unknown, key: string) => createHmac("sha256", key).update(JSON.stringify(data)).digest("hex");

export function seal(data: unknown, key: string | undefined, pretty = false): string {
  const text = (v: unknown) => (pretty ? JSON.stringify(v, null, 2) : JSON.stringify(v));
  return key ? text({ v: 1, data, hmac: mac(data, key) }) : text(data);
}

export interface Unsealed {
  data: unknown;
  // ok: readable (and, with a key, verified). unsigned: a key is set but the file has no signature.
  // tampered: signed, but not by this key or changed since.
  status: "ok" | "unsigned" | "tampered";
}

export function unseal(text: string, key: string | undefined): Unsealed {
  const parsed = JSON.parse(text) as { v?: unknown; data?: unknown; hmac?: unknown } | null;
  const sealed = !!parsed && typeof parsed === "object" && parsed.v === 1 && "data" in parsed && typeof parsed.hmac === "string";
  if (!key) return { data: sealed ? parsed!.data : parsed, status: "ok" };
  if (!sealed) return { data: parsed, status: "unsigned" };
  const want = Buffer.from(mac(parsed!.data, key));
  const got = Buffer.from(String(parsed!.hmac));
  return { data: parsed!.data, status: got.length === want.length && timingSafeEqual(got, want) ? "ok" : "tampered" };
}
