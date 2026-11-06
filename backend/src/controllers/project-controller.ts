import { Body, Controller, Delete, Get, Patch, Path, Post, Query, Request, Response, Route, Security, SuccessResponse, Tags } from "@tsoa/runtime";
import type { SessionRequest } from "../http/authentication.js";
import type { AiSettingsInput, AiTestResult, NewProject, Ok, ProjectPatch, ProjectView } from "../models/api.js";
import type { Services } from "../services/index.js";
import type { ProjectService } from "../services/project-service.js";

@Route("api/projects")
@Security("session")
@Tags("Projects")
@Response(401, "Sign in required")
export class ProjectController extends Controller {
  private projects: ProjectService;

  constructor(services: Services) {
    super();
    this.projects = services.projects;
  }

  /** The signed-in user's projects, newest first. */
  @Get()
  public list(@Request() req: SessionRequest): ProjectView[] {
    return this.projects.list(req.user.id);
  }

  /** A new project in observe mode, with its own key. */
  @Post()
  @SuccessResponse(201, "Created")
  public create(@Request() req: SessionRequest, @Body() body: NewProject): ProjectView {
    this.setStatus(201);
    return this.projects.create(req.user.id, body);
  }

  @Get("{id}")
  @Response(404, "Project not found")
  public get(@Request() req: SessionRequest, @Path() id: string): ProjectView {
    return this.projects.get(req.user.id, id);
  }

  /** Changes settings; guards pick them up within 5 seconds. */
  @Patch("{id}")
  @Response(400, "Invalid settings")
  @Response(404, "Project not found")
  public update(@Request() req: SessionRequest, @Path() id: string, @Body() body: ProjectPatch): Promise<ProjectView> {
    return this.projects.update(req.user.id, id, body);
  }

  /** Deletes the project and its events; its key stops working. */
  @Delete("{id}")
  @Response(404, "Project not found")
  public remove(@Request() req: SessionRequest, @Path() id: string): Ok {
    this.projects.remove(req.user.id, id);
    return { ok: true };
  }

  @Post("{id}/rotate-key")
  @Response(404, "Project not found")
  public rotateKey(@Request() req: SessionRequest, @Path() id: string): ProjectView {
    return this.projects.rotateKey(req.user.id, id);
  }

  /** Sends a sample attack to the model in these settings (an empty key uses the saved one). */
  @Post("{id}/ai-test")
  @Response(400, "Invalid AI settings")
  @Response(404, "Project not found")
  public testAi(@Request() req: SessionRequest, @Path() id: string, @Body() body: AiSettingsInput): Promise<AiTestResult> {
    return this.projects.testAi(req.user.id, id, body);
  }

  /** The project's most recent events, oldest first. */
  @Get("{id}/events")
  @Response(404, "Project not found")
  public events(@Request() req: SessionRequest, @Path() id: string, @Query() limit?: number): unknown[] {
    return this.projects.events(req.user.id, id, limit);
  }

  @Delete("{id}/events")
  @Response(404, "Project not found")
  public clearEvents(@Request() req: SessionRequest, @Path() id: string): Ok {
    this.projects.clearEvents(req.user.id, id);
    return { ok: true };
  }
}
