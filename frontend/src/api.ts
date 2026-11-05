// Set by the app: called when the session has expired or was ended elsewhere.
let onSignedOut = () => {};
export const setSignedOutHandler = (fn: () => void) => (onSignedOut = fn);

export class SignInRequired extends Error {}

export async function api<T = unknown>(path: string, opts: { method?: string; body?: unknown } = {}): Promise<T> {
  const method = opts.method ?? "GET";
  const res = await fetch(path, {
    method,
    // The server only accepts JSON for writes (protects against cross-site form posts).
    headers: method === "GET" ? {} : { "Content-Type": "application/json" },
    body: method === "GET" ? undefined : JSON.stringify(opts.body ?? {}),
  });
  const data = await res.json();
  if (res.status === 401 && !path.startsWith("/api/auth/")) {
    onSignedOut();
    throw new SignInRequired("sign in required");
  }
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data as T;
}
