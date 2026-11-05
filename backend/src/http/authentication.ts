import type { Request } from "express";
import { HttpError } from "../errors.js";
import type { Project } from "../models/project.js";
import type { User } from "../models/user.js";
import { servicesOf } from "./ioc.js";
import { tokenFrom } from "./session-cookie.js";

// The two kinds of caller, as @Security names:
//   "session"    the web page, signed in with the session cookie; request.user is the User
//   "projectKey" a guard, sending its project key in a header; request.user is the Project
const KEY_HEADERS = ["x-mcpwatch-key", "x-headerwatch-key"];

export interface SessionRequest extends Request {
  user: User;
}

export interface GuardRequest extends Request {
  user: Project;
}

export async function expressAuthentication(req: Request, securityName: string): Promise<User | Project> {
  const services = servicesOf(req);
  if (securityName === "session") {
    const user = services.auth.userFor(tokenFrom(req.headers.cookie));
    if (!user) throw new HttpError(401, "sign in required");
    return user;
  }
  if (securityName === "projectKey") {
    const key = KEY_HEADERS.map((h) => req.headers[h]).find((v) => typeof v === "string") as string | undefined;
    const project = services.agent.projectForKey(key);
    if (!project) throw new HttpError(401, "unknown project key");
    return project;
  }
  throw new HttpError(500, `unknown security scheme ${securityName}`);
}
