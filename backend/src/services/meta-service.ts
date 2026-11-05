import { CATALOG } from "@vedhaai/mcpwatch";
import type { EventRepository } from "../data/event-repository.js";
import type { Meta } from "../models/api.js";
import { eventLimit } from "./project-service.js";

// What the dashboard page needs besides projects: its own address, the rule catalog and local events.
export class MetaService {
  constructor(private serverUrl: string, private events: EventRepository) {}

  meta(): Meta {
    return { server: this.serverUrl, rules: CATALOG };
  }

  localEvents(limit?: number): unknown[] {
    return this.events.recentLocal(eventLimit(limit));
  }
}
