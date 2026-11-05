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

  /** Creates an account and signs it in. */
  @Post("register")
  @Response(400, "Invalid username or password, or the username is taken")
  public register(@Body() body: Credentials): SignedIn {
    const { user, token } = this.auth.register(body.username, body.password);
    this.setHeader("set-cookie", sessionCookie(token));
    return { user: { username: user.username } };
  }

  @Post("login")
  @Response(401, "Wrong username or password")
  @Response(429, "Too many failed attempts")
  public login(@Body() body: Credentials): SignedIn {
    const { user, token } = this.auth.login(body.username, body.password);
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
