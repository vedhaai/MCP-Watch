import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

// Dashboard accounts: username + password (scrypt), signed-in sessions in an HttpOnly cookie.

export interface User {
  id: string;
  username: string;
  salt: string;
  hash: string;
  createdAt: string;
}

interface Session {
  userId: string;
  expires: number;
}

export const SESSION_COOKIE = "mw_session";
const SESSION_DAYS = 14;
const USERNAME = /^[A-Za-z0-9_.@-]{3,40}$/;
// After 5 wrong passwords for a username, refuse sign-in for it for 5 minutes.
const MAX_FAILURES = 5;
const LOCK_MS = 5 * 60_000;

function hashPassword(password: string, salt: string): string {
  return scryptSync(password, salt, 64).toString("hex");
}

export class AuthError extends Error {
  constructor(message: string, public status = 400) {
    super(message);
  }
}

export class Accounts {
  private users: User[] = [];
  private sessions = new Map<string, Session>();
  private failures = new Map<string, { count: number; until: number }>();
  private readonly usersFile: string;
  private readonly sessionsFile: string;

  constructor(dir: string) {
    this.usersFile = path.join(dir, "users.json");
    this.sessionsFile = path.join(dir, "sessions.json");
    if (existsSync(this.usersFile)) this.users = JSON.parse(readFileSync(this.usersFile, "utf8"));
    // Sessions survive a restart of the dashboard.
    if (existsSync(this.sessionsFile)) {
      const now = Date.now();
      for (const [token, s] of Object.entries(JSON.parse(readFileSync(this.sessionsFile, "utf8")) as Record<string, Session>)) {
        if (s.expires > now) this.sessions.set(token, s);
      }
    }
  }

  private saveUsers() {
    writeFileSync(this.usersFile, JSON.stringify(this.users, null, 2));
  }

  private saveSessions() {
    writeFileSync(this.sessionsFile, JSON.stringify(Object.fromEntries(this.sessions)));
  }

  get count() {
    return this.users.length;
  }

  oldest(): User | undefined {
    return this.users[0];
  }

  register(username: string, password: string): User {
    username = username.trim();
    if (!USERNAME.test(username)) throw new AuthError("Username must be 3-40 letters, numbers or _ . @ -");
    if (this.users.some((u) => u.username.toLowerCase() === username.toLowerCase())) throw new AuthError("That username is taken.");
    if (password.length < 8) throw new AuthError("Password must be at least 8 characters.");
    const salt = randomBytes(16).toString("hex");
    const user: User = { id: randomUUID(), username, salt, hash: hashPassword(password, salt), createdAt: new Date().toISOString() };
    this.users.push(user);
    this.saveUsers();
    return user;
  }

  verify(username: string, password: string): User {
    const key = username.trim().toLowerCase();
    const f = this.failures.get(key);
    if (f && f.count >= MAX_FAILURES && f.until > Date.now()) {
      throw new AuthError("Too many failed attempts. Try again in a few minutes.", 429);
    }
    const user = this.users.find((u) => u.username.toLowerCase() === key);
    // Hash even for unknown users, so response time doesn't reveal which usernames exist.
    const expected = Buffer.from(user?.hash ?? "0".repeat(128), "hex");
    const actual = Buffer.from(hashPassword(password, user?.salt ?? "x"), "hex");
    if (!user || !timingSafeEqual(expected, actual)) {
      const count = f && f.until > Date.now() ? f.count + 1 : 1;
      this.failures.set(key, { count, until: Date.now() + LOCK_MS });
      throw new AuthError("Wrong username or password.", 401);
    }
    this.failures.delete(key);
    return user;
  }

  startSession(user: User): string {
    const token = randomBytes(32).toString("base64url");
    this.sessions.set(token, { userId: user.id, expires: Date.now() + SESSION_DAYS * 86_400_000 });
    this.saveSessions();
    return token;
  }

  endSession(token: string) {
    if (this.sessions.delete(token)) this.saveSessions();
  }

  userFor(token: string | undefined): User | undefined {
    if (!token) return undefined;
    const s = this.sessions.get(token);
    if (!s) return undefined;
    if (s.expires < Date.now()) {
      this.endSession(token);
      return undefined;
    }
    return this.users.find((u) => u.id === s.userId);
  }
}

export function sessionCookie(token: string): string {
  return `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_DAYS * 86_400}`;
}

export const clearedCookie = `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`;

export function tokenFrom(cookieHeader: string | undefined): string | undefined {
  for (const part of (cookieHeader ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === SESSION_COOKIE) return v.join("=");
  }
  return undefined;
}
