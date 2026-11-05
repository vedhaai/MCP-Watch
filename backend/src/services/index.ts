import { EventRepository } from "../data/event-repository.js";
import { ProjectRepository } from "../data/project-repository.js";
import { SessionRepository } from "../data/session-repository.js";
import { UserRepository } from "../data/user-repository.js";
import { AgentService } from "./agent-service.js";
import { AiService } from "./ai-service.js";
import { AuthService } from "./auth-service.js";
import { MetaService } from "./meta-service.js";
import { ProjectService } from "./project-service.js";

export interface Services {
  auth: AuthService;
  projects: ProjectService;
  agent: AgentService;
  meta: MetaService;
}

export interface DashboardConfig {
  port: number;
  // Accounts, projects and events.
  dataDir: string;
  // Events from guards without a project key, shown under Local events.
  localEventsFile: string;
}

// Wires the data layer into the services. One set per running dashboard.
export function createServices({ port, dataDir, localEventsFile }: DashboardConfig): Services {
  const projectRepo = new ProjectRepository(dataDir);
  const eventRepo = new EventRepository(dataDir, localEventsFile);
  const ai = new AiService();
  const projects = new ProjectService(projectRepo, eventRepo, ai);
  return {
    auth: new AuthService(new UserRepository(dataDir), new SessionRepository(dataDir), projects),
    projects,
    agent: new AgentService(projectRepo, eventRepo, ai),
    meta: new MetaService(`http://127.0.0.1:${port}`, eventRepo),
  };
}
