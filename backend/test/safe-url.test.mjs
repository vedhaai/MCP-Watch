// Which addresses the dashboard will fetch on a signed-in user's behalf. The classifier is the whole
// defence against SSRF through the AI settings, so it is tested directly, boundaries included.
import { test } from "node:test";
import assert from "node:assert/strict";
import { addressKind, assertReachable } from "../dist/services/safe-url.js";

test("safe-url: address classification", () => {
  const cases = {
    blocked: [
      "169.254.169.254", // AWS/GCP/Azure metadata
      "169.254.170.2", // ECS task metadata
      "100.100.100.200", // Alibaba metadata
      "fd00:ec2::254", // AWS metadata over IPv6
      "169.254.1.1", // the link-local range it hides in
      "fe80::1", // IPv6 link-local
      "0.0.0.0",
      "255.255.255.255",
      "224.0.0.1", // multicast
      "ff02::1", // IPv6 multicast
      "::",
      "192.0.0.1", // IETF protocol assignments
    ],
    loopback: ["127.0.0.1", "127.1.2.3", "::1", "::ffff:127.0.0.1", "::ffff:7f00:1"],
    private: ["10.0.0.5", "172.16.0.1", "172.31.255.254", "192.168.1.1", "100.64.0.1", "fd00::1", "fc00::1", "::ffff:10.0.0.5"],
    public: [
      "8.8.8.8",
      "1.1.1.1",
      "172.15.0.1", // just below the private block
      "172.32.0.1", // just above it
      "192.167.0.1",
      "192.169.0.1",
      "100.63.0.1", // just below carrier-grade NAT
      "128.0.0.1",
      "223.255.255.255", // just below multicast
      "2001:4860:4860::8888",
      "::ffff:8.8.8.8",
    ],
  };
  for (const [expected, ips] of Object.entries(cases)) {
    for (const ip of ips) assert.equal(addressKind(ip), expected, `${ip} should be ${expected}`);
  }
});

test("safe-url: a public reach refuses anything that isn't routable on the internet", async () => {
  const refuses = async (url, match) => {
    await assert.rejects(() => assertReachable(url, "public", "AI URL"), (e) => (assert.match(e.message, match), assert.equal(e.status, 400), true), `${url} should be refused`);
  };
  await refuses("http://127.0.0.1:9299/v1", /on this machine or your local network/);
  await refuses("http://localhost:9299/v1", /on this machine or your local network/); // resolved, not just string-matched
  await refuses("http://10.0.0.5/v1", /on this machine or your local network/);
  await refuses("http://[::1]:9299/v1", /on this machine or your local network/);
  await refuses("http://[::ffff:127.0.0.1]/v1", /on this machine or your local network/);
  await refuses("http://169.254.169.254/latest/meta-data", /reserved address/);
  await refuses("http://[fd00:ec2::254]/latest", /reserved address/);
  // Not a URL the dashboard should fetch at all.
  await refuses("file:///etc/passwd", /must start with http/);
  await refuses("not a url", /not a valid URL/);
});

test("safe-url: a private reach allows this machine but never the metadata services", async () => {
  // What a local model needs.
  await assertReachable("http://127.0.0.1:11434/v1", "private", "AI URL");
  await assertReachable("http://192.168.1.50:8000/v1", "private", "AI URL");
  await assertReachable("https://api.openai.com/v1", "private", "AI URL");
  // Still never these.
  for (const url of ["http://169.254.169.254/v1", "http://[fe80::1]/v1", "http://255.255.255.255/v1"]) {
    await assert.rejects(() => assertReachable(url, "private", "AI URL"), /reserved address/, `${url} should be refused`);
  }
});

test("safe-url: a public provider is accepted", async () => {
  await assertReachable("https://api.openai.com/v1", "public", "AI URL");
});
