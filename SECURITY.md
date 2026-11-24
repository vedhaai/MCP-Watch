# Security policy

MCPWatch is a security tool, so reports about it are taken seriously.

## Reporting a vulnerability

Please do not open a public issue for a vulnerability. Use GitHub's private reporting instead:
**Security tab → Report a vulnerability** on https://github.com/vedhaai/MCP-Watch.

Include the affected package and version, the steps to reproduce, and the impact you expect. Do not include real customer data or real secrets in a report.

You can expect an acknowledgement within a few days. Fixes ship in a patch release of the affected package, and the changelog credits the reporter unless they prefer not to be named.

## What counts

- A way to get a malicious MCP message past a rule that should catch it (a bypass of MW rules).
- A way to make the guard crash, hang or fail open when it should refuse.
- Dashboard issues: reaching it from outside 127.0.0.1, reading stored secrets, SSRF through outbound URLs, auth or rate-limit bypass.

Missing detections for brand new attack styles are welcome as normal issues or pull requests.

## Supported versions

Fixes go into the latest published version of each package.
