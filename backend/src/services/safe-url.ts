import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { HttpError } from "../errors.js";

// Which addresses the dashboard is willing to request on a signed-in user's behalf. Without this a
// user could point a setting at 127.0.0.1 or 169.254.169.254 and use the dashboard to reach things
// only the dashboard's host can see.
//   "private"  this machine and the local network, which is the point of a local model
//   "public"   only addresses routable on the internet
export type Reach = "public" | "private";

type Kind = "public" | "private" | "loopback" | "blocked";

// Never a model server, whatever the provider: the cloud metadata endpoints. The link-local range
// below already covers most of them; these are spelled out so the intent survives a refactor.
const METADATA = new Set(["169.254.169.254", "169.254.170.2", "100.100.100.200", "fd00:ec2::254"]);

function v4Bytes(ip: string): number[] | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  const out = parts.map(Number);
  return out.every((n) => Number.isInteger(n) && n >= 0 && n <= 255) ? out : null;
}

// 16 bytes, or null if it doesn't parse. `isIP` has already said it is an address.
function v6Bytes(ip: string): number[] | null {
  let s = ip.toLowerCase().split("%")[0];
  // A trailing dotted-quad (::ffff:10.0.0.1) becomes the two hextets it stands for.
  const embedded = s.match(/^(.*:)((?:\d+\.){3}\d+)$/);
  if (embedded) {
    const v4 = v4Bytes(embedded[2]);
    if (!v4) return null;
    s = `${embedded[1]}${((v4[0] << 8) | v4[1]).toString(16)}:${((v4[2] << 8) | v4[3]).toString(16)}`;
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const groups = halves.length === 2
    ? [...head, ...Array(8 - head.length - tail.length).fill("0"), ...tail]
    : head;
  if (groups.length !== 8) return null;
  const out: number[] = [];
  for (const g of groups) {
    const n = parseInt(g || "0", 16);
    if (!Number.isInteger(n) || n < 0 || n > 0xffff) return null;
    out.push(n >> 8, n & 0xff);
  }
  return out;
}

function kindV4([a, b]: number[]): Kind {
  if (a === 0 || a === 127) return a === 127 ? "loopback" : "blocked";
  if (a === 169 && b === 254) return "blocked"; // link-local, where the metadata services live
  if (a >= 224) return "blocked"; // multicast and reserved, including 255.255.255.255
  if (a === 10) return "private";
  if (a === 172 && b >= 16 && b <= 31) return "private";
  if (a === 192 && b === 168) return "private";
  if (a === 192 && b === 0) return "blocked"; // IETF protocol assignments
  if (a === 100 && b >= 64 && b <= 127) return "private"; // carrier-grade NAT
  if (a === 198 && (b === 18 || b === 19)) return "private"; // benchmarking
  return "public";
}

export function addressKind(ip: string): Kind {
  if (METADATA.has(ip.toLowerCase())) return "blocked";
  const version = isIP(ip);
  if (version === 4) {
    const b = v4Bytes(ip);
    return b ? kindV4(b) : "blocked";
  }
  if (version !== 6) return "blocked";
  const b = v6Bytes(ip);
  if (!b) return "blocked";
  // IPv4-mapped (::ffff:a.b.c.d) is just that IPv4 address wearing a hat.
  if (b.slice(0, 10).every((x) => x === 0) && b[10] === 0xff && b[11] === 0xff) return kindV4(b.slice(12));
  if (b.every((x) => x === 0)) return "blocked"; // ::
  if (b.slice(0, 15).every((x) => x === 0) && b[15] === 1) return "loopback"; // ::1
  const first = (b[0] << 8) | b[1];
  if (b[0] === 0xff) return "blocked"; // multicast
  if (first >= 0xfe80 && first <= 0xfebf) return "blocked"; // link-local
  if (b[0] === 0xfc || b[0] === 0xfd) return "private"; // unique local
  return "public";
}

async function addressesOf(host: string, what: string): Promise<string[]> {
  if (isIP(host)) return [host];
  try {
    const found = await lookup(host, { all: true, verbatim: true });
    if (found.length) return found.map((a) => a.address);
  } catch {
    // falls through to the same answer as an empty result
  }
  throw new HttpError(400, `${what}: could not resolve ${host}`);
}

// Rejects a URL the dashboard should not fetch. Every address the host resolves to has to pass, so a
// name with one public and one internal answer is refused.
export async function assertReachable(raw: string, reach: Reach, what: string): Promise<void> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new HttpError(400, `${what} is not a valid URL`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new HttpError(400, `${what} must start with http:// or https://`);
  const host = url.hostname.replace(/^\[|\]$/g, "");
  for (const address of await addressesOf(host, what)) {
    const kind = addressKind(address);
    if (kind === "blocked") throw new HttpError(400, `${what} points at ${address}, which is a reserved address.`);
    if (reach === "public" && kind !== "public") {
      throw new HttpError(400, `${what} points at ${address}, which is on this machine or your local network. An API provider has to be reachable on the internet; use the local model option for a model you host yourself.`);
    }
  }
}
