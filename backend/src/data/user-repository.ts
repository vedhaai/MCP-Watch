import path from "node:path";
import type { User } from "../models/user.js";
import { readJson, writeJson } from "./json-files.js";

// Dashboard accounts in users.json, oldest first.
export class UserRepository {
  private users: User[];
  private readonly file: string;

  constructor(dir: string) {
    this.file = path.join(dir, "users.json");
    this.users = readJson<User[]>(this.file, []);
  }

  count(): number {
    return this.users.length;
  }

  oldest(): User | undefined {
    return this.users[0];
  }

  // The account that set up this dashboard: the first one created. It owns what exists outside any
  // project — the projects made before accounts existed, and the local events file the guards share.
  isOwner(userId: string): boolean {
    return this.users.length > 0 && this.users[0].id === userId;
  }

  byId(id: string): User | undefined {
    return this.users.find((u) => u.id === id);
  }

  // Usernames are unique regardless of case.
  byUsername(username: string): User | undefined {
    const key = username.toLowerCase();
    return this.users.find((u) => u.username.toLowerCase() === key);
  }

  insert(user: User): User {
    this.users.push(user);
    writeJson(this.file, this.users);
    return user;
  }
}
