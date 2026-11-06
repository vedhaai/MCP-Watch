import { randomBytes, randomUUID, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
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
// Long enough for any real passphrase. Without a cap the whole request body gets hashed.
const MAX_PASSWORD = 1024;
// Beyond the first account, a new one is created by someone already signed in. Whoever starts the
// dashboard can reopen it for a team; a visitor can't, which is the point.
const OPEN_REGISTRATION = process.env.MCPWATCH_OPEN_REGISTRATION === "1";

const scryptAsync = promisify(scrypt) as (password: string, salt: string, keylen: number) => Promise<Buffer>;

// scrypt runs on libuv's threadpool (four threads by default), which also serves this dashboard's
// file reads and writes. Hashing every request at once would stall those too, so they queue.
const MAX_CONCURRENT_HASHES = 2;
let hashing = 0;
const waiting: (() => void)[] = [];

async function hashPassword(password: string, salt: string): Promise<string> {
  while (hashing >= MAX_CONCURRENT_HASHES) await new Promise<void>((resume) => waiting.push(resume));
  hashing += 1;
  try {
    return (await scryptAsync(password, salt, 64)).toString("hex");
  } finally {
    hashing -= 1;
    waiting.shift()?.();
  }
}

export class AuthService {
  private failures = new Map<string, { count: number; until: number }>();

  constructor(private users: UserRepository, private sessions: SessionRepository, private projects: ProjectService) {}

  // `caller` is the signed-in user creating the account, if there is one. The very first account has
  // no one to create it, so that one is open; after that an anonymous request is refused.
  async register(username: string, password: string, caller?: User): Promise<{ user: User; token?: string }> {
    if (!OPEN_REGISTRATION && !caller && this.users.count() > 0) {
      throw new HttpError(403, "This dashboard already has an account. Ask whoever set it up to create one for you.");
    }
    username = username.trim();
    if (!USERNAME.test(username)) throw new HttpError(400, "Username must be 3-40 letters, numbers or _ . @ -");
    if (this.users.byUsername(username)) throw new HttpError(400, "That username is taken.");
    if (password.length < 8) throw new HttpError(400, "Password must be at least 8 characters.");
    if (password.length > MAX_PASSWORD) throw new HttpError(400, `Password must be at most ${MAX_PASSWORD} characters.`);
    const salt = randomBytes(16).toString("hex");
    const user = this.users.insert({ id: randomUUID(), username, salt, hash: await hashPassword(password, salt), createdAt: new Date().toISOString() });
    // Someone signing themselves up starts a session; an account made for someone else does not, so
    // the signed-in user keeps their own.
    return caller ? { user } : this.signIn(user);
  }

  async login(username: string, password: string): Promise<{ user: User; token: string }> {
    const key = username.trim().toLowerCase();
    const f = this.failures.get(key);
    if (f && f.count >= MAX_FAILURES && f.until > Date.now()) {
      throw new HttpError(429, "Too many failed attempts. Try again in a few minutes.");
    }
    const user = this.users.byUsername(key);
    // Hash even for unknown users, so response time doesn't reveal which usernames exist.
    const expected = Buffer.from(user?.hash ?? "0".repeat(128), "hex");
    const actual = Buffer.from(await hashPassword(password.slice(0, MAX_PASSWORD), user?.salt ?? "x"), "hex");
    if (!user || expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
      this.noteFailure(key, f);
      throw new HttpError(401, "Wrong username or password.");
    }
    this.failures.delete(key);
    return this.signIn(user);
  }

  // Counters for usernames whose lock has run out are dropped, so failed sign-ins for names that
  // don't exist can't grow this map without bound.
  private noteFailure(key: string, current?: { count: number; until: number }) {
    const now = Date.now();
    if (this.failures.size > 1000) {
      for (const [k, v] of this.failures) if (v.until <= now) this.failures.delete(k);
    }
    this.failures.set(key, { count: current && current.until > now ? current.count + 1 : 1, until: now + LOCK_MS });
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
