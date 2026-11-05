import { Controller, Get, Query, Response, Route, Security, Tags } from "@tsoa/runtime";
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

  /** Events from guards without a project key. */
  @Get("local-events")
  public localEvents(@Query() limit?: number): unknown[] {
    return this.meta.localEvents(limit);
  }
}
