import { CATALOG } from "@vedhaai/mcpwatch";
import type { EventRepository } from "../data/event-repository.js";
import type { UserRepository } from "../data/user-repository.js";
import { HttpError } from "../errors.js";
import type { Meta } from "../models/api.js";
import type { User } from "../models/user.js";
import { eventLimit } from "./project-service.js";

// What the dashboard page needs besides projects: its own address, the rule catalog and local events.
export class MetaService {
  constructor(private serverUrl: string, private events: EventRepository, private users: UserRepository) {}

  meta(): Meta {
    return { server: this.serverUrl, rules: CATALOG };
  }

  // These come from guards running without a project key, so nothing in them says whose they are:
  // they are the captured traffic of the machine the dashboard runs on. That belongs to the account
  // that set it up, not to everyone who happens to have an account here.
  localEvents(user: User, limit?: number): unknown[] {
    if (!this.users.isOwner(user.id)) throw new HttpError(403, "Local events belong to the account that set up this dashboard.");
    return this.events.recentLocal(eventLimit(limit));
  }
}
