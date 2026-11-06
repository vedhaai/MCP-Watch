import { Body, Controller, Get, Post, Request, Response, Route, Tags } from "@tsoa/runtime";
import type { Request as ExpressRequest } from "express";
import { clearedCookie, sessionCookie, tokenFrom } from "../http/session-cookie.js";
import type { Credentials, Ok, SignedIn } from "../models/api.js";
import type { AuthService } from "../services/auth-service.js";
import type { Services } from "../services/index.js";

@Route("api/auth")
@Tags("Auth")
export class AuthController extends Controller {
  private auth: AuthService;

  constructor(services: Services) {
    super();
    this.auth = services.auth;
  }

  /** The signed-in user, or null. */
  @Get("me")
  public me(@Request() req: ExpressRequest): SignedIn {
    const user = this.auth.userFor(tokenFrom(req.headers.cookie));
    return { user: user ? { username: user.username } : null };
  }

  /**
   * Creates an account. The first one signs itself in; after that only a signed-in user can make
   * one, and doing so leaves their own session alone.
   */
  @Post("register")
  @Response(400, "Invalid username or password, or the username is taken")
  @Response(403, "This dashboard already has an account")
  @Response(429, "Too many attempts")
  public async register(@Request() req: ExpressRequest, @Body() body: Credentials): Promise<SignedIn> {
    const caller = this.auth.userFor(tokenFrom(req.headers.cookie));
    const { user, token } = await this.auth.register(body.username, body.password, caller);
    if (token) this.setHeader("set-cookie", sessionCookie(token));
    return { user: { username: user.username } };
  }

  @Post("login")
  @Response(401, "Wrong username or password")
  @Response(429, "Too many failed attempts")
  public async login(@Body() body: Credentials): Promise<SignedIn> {
    const { user, token } = await this.auth.login(body.username, body.password);
    this.setHeader("set-cookie", sessionCookie(token));
    return { user: { username: user.username } };
  }

  /** Ends this session only. */
  @Post("logout")
  public logout(@Request() req: ExpressRequest): Ok {
    this.auth.logout(tokenFrom(req.headers.cookie));
    this.setHeader("set-cookie", clearedCookie);
    return { ok: true };
  }
}
