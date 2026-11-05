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

  oldest(): User | undefined {
    return this.users[0];
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
