import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import type { SessionRepository } from "../data/session-repository.js";
import type { UserRepository } from "../data/user-repository.js";
import { HttpError } from "../errors.js";
import type { User } from "../models/user.js";
import type { ProjectService } from "./project-service.js";

// Dashboard accounts: username + password (scrypt), and signed-in sessions by token.

export const SESSION_DAYS = 14;
const USERNAME = /^[A-Za-z0-9_.@-]{3,40}$/;
// After 5 wrong passwords for a username, refuse sign-in for it for 5 minutes.
const MAX_FAILURES = 5;
const LOCK_MS = 5 * 60_000;

function hashPassword(password: string, salt: string): string {
  return scryptSync(password, salt, 64).toString("hex");
}

export class AuthService {
  private failures = new Map<string, { count: number; until: number }>();

  constructor(private users: UserRepository, private sessions: SessionRepository, private projects: ProjectService) {}

  register(username: string, password: string): { user: User; token: string } {
    username = username.trim();
    if (!USERNAME.test(username)) throw new HttpError(400, "Username must be 3-40 letters, numbers or _ . @ -");
    if (this.users.byUsername(username)) throw new HttpError(400, "That username is taken.");
    if (password.length < 8) throw new HttpError(400, "Password must be at least 8 characters.");
    const salt = randomBytes(16).toString("hex");
    const user = this.users.insert({ id: randomUUID(), username, salt, hash: hashPassword(password, salt), createdAt: new Date().toISOString() });
    return this.signIn(user);
  }

  login(username: string, password: string): { user: User; token: string } {
    const key = username.trim().toLowerCase();
    const f = this.failures.get(key);
    if (f && f.count >= MAX_FAILURES && f.until > Date.now()) {
      throw new HttpError(429, "Too many failed attempts. Try again in a few minutes.");
    }
    const user = this.users.byUsername(key);
    // Hash even for unknown users, so response time doesn't reveal which usernames exist.
    const expected = Buffer.from(user?.hash ?? "0".repeat(128), "hex");
    const actual = Buffer.from(hashPassword(password, user?.salt ?? "x"), "hex");
    if (!user || !timingSafeEqual(expected, actual)) {
      const count = f && f.until > Date.now() ? f.count + 1 : 1;
      this.failures.set(key, { count, until: Date.now() + LOCK_MS });
      throw new HttpError(401, "Wrong username or password.");
    }
    this.failures.delete(key);
    return this.signIn(user);
  }

  logout(token: string | undefined) {
    if (token) this.sessions.delete(token);
  }

  userFor(token: string | undefined): User | undefined {
    if (!token) return undefined;
    const s = this.sessions.get(token);
    if (!s) return undefined;
    if (s.expires < Date.now()) {
      this.sessions.delete(token);
      return undefined;
    }
    return this.users.byId(s.userId);
  }

  private signIn(user: User): { user: User; token: string } {
    // The first account takes over projects created before accounts existed.
    if (this.users.oldest()?.id === user.id) this.projects.claimUnowned(user.id);
    const token = randomBytes(32).toString("base64url");
    this.sessions.set(token, { userId: user.id, expires: Date.now() + SESSION_DAYS * 86_400_000 });
    return { user, token };
  }
}
