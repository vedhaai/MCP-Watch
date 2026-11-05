import { isInternalHost } from "./patterns.js";
import type { Policy } from "./policy.js";
import { finding, type Finding } from "./rules.js";
import type { Session } from "./state.js";

// What the guard knows about the HTTP request that carried a message. stdio messages have none.
export interface HttpInfo {
  // Lower-case header names, as Node and the MCP SDK give them.
  headers: Record<string, string | string[] | undefined>;
  // Known to the proxy; the middleware only sees headers.
  remoteAddress?: string;
  encrypted?: boolean;
  // Proxy only: the upstream server is reached over plain HTTP on a public address.
  insecureUpstream?: boolean;
}

const header = (info: HttpInfo, name: string): string | undefined => {
  const v = info.headers[name];
  return Array.isArray(v) ? v[0] : v;
};

const hostOf = (hostHeader: string) => hostHeader.replace(/:\d+$/, "").replace(/^\[|\]$/g, "").toLowerCase();

const isLoopback = (host: string) => {
  const h = host.replace(/^::ffff:/, "").replace(/^\[|\]$/g, "").toLowerCase();
  return h === "localhost" || h.endsWith(".localhost") || h === "::1" || /^127\./.test(h);
};

// The caller's credential: a bearer token or an API key header.
export function credentialOf(info: HttpInfo): string | undefined {
  const auth = header(info, "authorization");
  if (auth) return auth.replace(/^(?:bearer|basic|token)\s+/i, "").trim() || undefined;
  return header(info, "x-api-key")?.trim() || undefined;
}

// JWT claims without verifying the signature. Verifying it is the server's auth layer's job; the
// guard only checks that a token meant for another service, or an expired one, is not accepted.
function jwtClaims(token: string): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    return claims && typeof claims === "object" ? claims : null;
  } catch {
    return null;
  }
}

// A session id an attacker could guess: short or from a small alphabet.
const weakSessionId = (id: string) => id.length < 16 || /^\d+$/.test(id) || new Set(id).size < 8;

// MW030–MW035: checks on how a message arrived, run for every client request that came over HTTP.
// Findings about the deployment rather than the caller fire once per session, so they never add up
// to a throttle on their own.
export function checkTransport(info: HttpInfo, s: Session, policy: Policy): Finding[] {
  const out: Finding[] = [];

  // MW030 DNS rebinding / cross-site request. Browsers always send Origin on a cross-site POST;
  // MCP clients that aren't browsers send none.
  const origin = header(info, "origin");
  if (origin && origin !== "null" && !policy.allowedOrigins.includes(origin)) {
    let originHost = "";
    try {
      originHost = new URL(origin).hostname;
    } catch {
      // unparseable origin: treated as foreign
    }
    if (!isLoopback(originHost)) out.push(finding("MW030", `Request from web origin ${origin}, which is not allowed`, "header.origin"));
  } else if (origin === "null") {
    out.push(finding("MW030", "Request from an opaque (null) origin, e.g. a sandboxed page or file", "header.origin"));
  }
  const host = header(info, "host");
  if (host && policy.allowedHosts.length && !policy.allowedHosts.includes(hostOf(host)) && !isLoopback(hostOf(host))) {
    out.push(finding("MW030", `Host header "${hostOf(host)}" is not one of this server's names`, "header.host"));
  }

  // MW031 missing authentication.
  const credential = credentialOf(info);
  const forwardedFor = header(info, "x-forwarded-for")?.split(",")[0]?.trim();
  const caller = forwardedFor || info.remoteAddress;
  if (!credential) {
    if (policy.requireAuth) out.push(finding("MW031", "No Authorization or API key header"));
    else if (caller && !isLoopback(caller) && !isInternalHost(caller) && s.once("MW031")) {
      out.push(finding("MW031", "Unauthenticated request from a public address", undefined, "low"));
    } else if (caller && !isLoopback(caller) && s.once("MW031")) {
      out.push(finding("MW031", "Unauthenticated request from another machine", undefined, "low"));
    }
  }

  // MW036 token audience / expiry (OAuth confused deputy: a token issued for another service).
  if (credential) {
    const claims = jwtClaims(credential);
    if (claims) {
      const exp = typeof claims.exp === "number" ? claims.exp : undefined;
      if (exp !== undefined && exp * 1000 < Date.now()) out.push(finding("MW036", "Bearer token has expired", "header.authorization"));
      if (policy.expectedAudience) {
        const aud = Array.isArray(claims.aud) ? claims.aud.map(String) : claims.aud !== undefined ? [String(claims.aud)] : [];
        if (!aud.includes(policy.expectedAudience)) {
          out.push(finding("MW036", `Token audience ${aud.length ? aud.join(", ") : "(none)"} is not ${policy.expectedAudience}`, "header.authorization"));
        }
      }
    } else if (policy.expectedAudience && s.once("MW036-opaque")) {
      out.push(finding("MW036", "Opaque token: audience can't be checked here; make sure the server validates it", "header.authorization", "low"));
    }
  }

  // MW033 session hijacking: an MCP session id presented with a different credential than the one
  // that opened it, or a guessable session id.
  const sessionId = header(info, "mcp-session-id");
  if (sessionId) {
    if (weakSessionId(sessionId) && s.once("MW033-weak")) {
      out.push(finding("MW033", "Session id is short or predictable", "header.mcp-session-id", "low"));
    }
    const agent = header(info, "user-agent") ?? "";
    if (s.credential === undefined) {
      s.credential = credential ?? "";
      s.agent = agent;
    } else if (s.credential !== (credential ?? "")) {
      out.push(finding("MW033", "Session used with a different credential than the one that opened it", "header.mcp-session-id"));
    } else if (s.agent !== agent && s.once("MW033-agent")) {
      out.push(finding("MW033", "Session used from a different user agent", "header.user-agent", "medium"));
    }
  } else if (credential && s.credential === undefined) {
    s.credential = credential;
  }

  // MW037 resuming an event stream with an event id this session was never sent: replaying or
  // reading another session's stream. Only the HTTP proxy relays events, so only it records ids.
  const lastEventId = header(info, "last-event-id");
  if (lastEventId && info.remoteAddress !== undefined && !s.eventIds.has(lastEventId)) {
    out.push(finding("MW037", "Stream resumed with an event id this session was never sent", "header.last-event-id"));
  }

  // MW034 plain HTTP to or from another machine.
  const proto = header(info, "x-forwarded-proto");
  const plainFromRemote = (proto === "http" && host && !isLoopback(hostOf(host)))
    || (proto === undefined && info.encrypted === false && caller && !isLoopback(caller));
  if (plainFromRemote && s.once("MW034-in")) out.push(finding("MW034", "Client reached the server over plain HTTP", undefined, "low"));
  if (info.insecureUpstream && s.once("MW034-up")) out.push(finding("MW034", "Upstream MCP server is reached over plain HTTP", undefined, "low"));

  return out;
}

// MW032: the caller's own credential inside tool arguments or server output.
export function credentialLeak(text: string, s: Session): boolean {
  return !!s.credential && s.credential.length >= 12 && text.includes(s.credential);
}

export function redactCredential(text: string, s: Session): string {
  return s.credential && s.credential.length >= 12 ? text.split(s.credential).join("[REDACTED:client-credential]") : text;
}
