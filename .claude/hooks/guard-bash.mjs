// PreToolUse (Bash): block risky git commands. Exit code 2 blocks the call.
import { readFileSync } from "node:fs";

let input = {};
try {
  input = JSON.parse(readFileSync(0, "utf8"));
} catch {
  process.exit(0);
}

const cmd = String(input.tool_input?.command ?? "");

const rules = [
  [/\bgit\s+push\b[^\n]*\s(--force\b|-f\b|--force-with-lease\b)/, "force-push; ask the user first"],
  [/\bgit\s+push\b[^\n]*\s(main|master)\b/, "direct push to main; open a PR from develop instead"],
  [/--no-verify\b|--no-gpg-sign\b/, "skipping hooks or signing is not allowed"],
  [/\bgit\s+reset\s+--hard\b/, "destructive reset; confirm with the user first"],
  [/\bnpm\s+publish\b|\btwine\s+upload\b|\bmvn\b[^\n]*\bdeploy\b/, "publishing is a release step; confirm with the user first"],
];

for (const [re, why] of rules) {
  if (re.test(cmd)) {
    console.error(`Blocked command: ${why}.`);
    process.exit(2);
  }
}
process.exit(0);
