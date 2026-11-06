import { Controller, Get, Query, Request, Response, Route, Security, Tags } from "@tsoa/runtime";
import type { SessionRequest } from "../http/authentication.js";
import type { Meta } from "../models/api.js";
import type { Services } from "../services/index.js";
import type { MetaService } from "../services/meta-service.js";

@Route("api")
@Security("session")
@Tags("Dashboard")
@Response(401, "Sign in required")
export class MetaController extends Controller {
  private meta: MetaService;

  constructor(services: Services) {
    super();
    this.meta = services.meta;
  }

  /** The dashboard's address (for setup steps) and the rule catalog. */
  @Get("meta")
  public get(): Meta {
    return this.meta.meta();
  }

  /** Events from guards without a project key. Only for the account that set up this dashboard. */
  @Get("local-events")
  @Response(403, "Local events belong to the account that set up this dashboard")
  public localEvents(@Request() req: SessionRequest, @Query() limit?: number): unknown[] {
    return this.meta.localEvents(req.user, limit);
  }
}
