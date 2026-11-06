import type { RequestHandler } from "express";

// A fixed window per client address, for the handful of endpoints where a request is expensive or
// creates something. Not a general-purpose limiter: it holds counters in memory, so it resets when
// the dashboard restarts and doesn't span several processes.

// Counters are dropped once their window has passed. The sweep keeps a flood of distinct addresses
// from growing the map without bound.
const SWEEP_AT = 5000;

export function rateLimit({ windowMs, max, message }: { windowMs: number; max: number; message: string }): RequestHandler {
  const hits = new Map<string, { count: number; resets: number }>();
  return (req, res, next) => {
    const now = Date.now();
    if (hits.size > SWEEP_AT) {
      for (const [k, v] of hits) if (v.resets <= now) hits.delete(k);
    }
    // `req.ip` is the socket's address: express only believes a forwarded header when told to trust a
    // proxy, which this dashboard never does.
    const key = req.ip ?? req.socket.remoteAddress ?? "unknown";
    const hit = hits.get(key);
    if (!hit || hit.resets <= now) {
      hits.set(key, { count: 1, resets: now + windowMs });
      return next();
    }
    hit.count += 1;
    if (hit.count > max) {
      res.setHeader("retry-after", String(Math.ceil((hit.resets - now) / 1000)));
      res.status(429).json({ error: message });
      return;
    }
    next();
  };
}
