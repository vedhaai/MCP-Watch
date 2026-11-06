import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { RequestHandler } from "express";

// Headers sent with every response, API and page alike.

// index.html carries one inline <script>: it applies the saved light/dark choice before React loads,
// so the page doesn't flash the wrong theme. Hashing it at startup lets script-src stay strict —
// 'unsafe-inline' would let any injected script run, which is the thing a CSP is for. The hash is
// read from the file that is actually served, so editing the page updates the hash with it.
function inlineScriptHashes(html: string): string[] {
  const inline = html.matchAll(/<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/gi);
  return [...inline].map((m) => `'sha256-${createHash("sha256").update(m[1], "utf8").digest("base64")}'`);
}

export function securityHeaders(indexFile: string): RequestHandler {
  let scriptSrc = "'self'";
  try {
    scriptSrc = ["'self'", ...inlineScriptHashes(readFileSync(indexFile, "utf8"))].join(" ");
  } catch {
    // The web app isn't built. The page says so; this header doesn't need to.
  }

  const csp = [
    "default-src 'self'",
    `script-src ${scriptSrc}`,
    // MUI builds its styles in the browser and injects them, which no hash can cover. Inline *style*
    // is a far weaker sink than inline script, and script-src above stays strict.
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data:",
    "connect-src 'self'",
    // Nothing here is meant to be framed, embedded, or to navigate anywhere but itself.
    "frame-ancestors 'none'",
    "form-action 'self'",
    "base-uri 'none'",
    "object-src 'none'",
  ].join("; ");

  return (_req, res, next) => {
    res.setHeader("content-security-policy", csp);
    // For anything that predates frame-ancestors.
    res.setHeader("x-frame-options", "DENY");
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader("referrer-policy", "no-referrer");
    res.setHeader("cross-origin-opener-policy", "same-origin");
    res.setHeader("permissions-policy", "camera=(), microphone=(), geolocation=()");
    next();
  };
}
