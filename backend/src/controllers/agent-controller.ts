import { Body, Controller, Get, Post, Request, Response, Route, Security, Tags } from "@tsoa/runtime";
import type { GuardRequest } from "../http/authentication.js";
import type { GuardConfig, GuardEvents, GuardHealth, Ok, Stored } from "../models/api.js";
import type { AgentService } from "../services/agent-service.js";
import type { Services } from "../services/index.js";

// Used by guards (middleware and proxies), authenticated by the project key.
@Route("api/agent")
@Security("projectKey")
@Tags("Agent")
@Response(401, "Unknown project key")
export class AgentController extends Controller {
  private agent: AgentService;

  constructor(services: Services) {
    super();
    this.agent = services.agent;
  }

  /** The project's settings for its guards. */
  @Get("config")
  public config(@Request() req: GuardRequest): GuardConfig {
    const config = this.agent.config(req.user);
    this.setHeader("X-MCPWatch-Signature", this.agent.sign(config, req.user.key));
    return config;
  }

  /** A batch of up to 1000 events. */
  @Post("events")
  public events(@Request() req: GuardRequest, @Body() body: GuardEvents): Stored {
    return this.agent.report(req.user, body);
  }

  /** The guard's checks are failing: shown as a warning on the project's pages. */
  @Post("health")
  public health(@Request() req: GuardRequest, @Body() body: GuardHealth): Ok {
    return this.agent.health(req.user, body);
  }
}
