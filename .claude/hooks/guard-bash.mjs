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
  // `cargo publish` matters most of the four: a crates.io version is immutable, so it can be
  // yanked but never edited, replaced or removed. The lookahead keeps `--dry-run` usable, which
  // is the one publishing command that belongs in a review.
  [/\bnpm\s+publish\b|\btwine\s+upload\b|\bmvn\b[^\n]*\bdeploy\b|\bcargo\s+publish\b(?![^\n]*--dry-run\b)/, "publishing is a release step; confirm with the user first"],
  [/\bcargo\s+(yank|owner|login)\b/, "this changes a published crate or its credentials; confirm with the user first"],
  // Go has no publish command: pushing the tag IS the release. proxy.golang.org serves the zip
  // and sum.golang.org records its hash the first time anyone resolves it, and both are
  // append-only. Moving the tag afterwards does not ship the new code - it gives everyone who
  // already fetched a checksum mismatch, which reads like a supply-chain attack. A bad version
  // can only be retracted, and a retraction itself needs a later release to carry it.
  // --dry-run stays usable, as with cargo.
  [/\bgit\s+push\b(?![^\n]*\s(--dry-run\b|-n\b))[^\n]*\bgo\/(\w+\/)*v\d+\.\d+\.\d+/, "pushing a `go/v*` tag publishes the Go module permanently; confirm with the user first"],
  // --tags pushes whatever happens to be local, which is how the wrong commit gets released.
  [/\bgit\s+push\b(?![^\n]*\s(--dry-run\b|-n\b))[^\n]*\s--tags\b/, "this pushes every local tag at once; push one release tag by name instead"],
  // Deleting a released tag unpublishes nothing; it only guarantees that the next tag of that
  // name is a checksum mismatch for everyone who already has it.
  [/\bgit\s+push\b[^\n]*(\s--delete\b|\s:refs\/tags\/)/, "deleting a released tag does not unpublish it and breaks the recorded checksum; confirm with the user first"],
  // `gh release create` creates the tag as a side effect, so it is a publishing command too.
  [/\bgh\s+release\s+(create|edit|delete)\b(?![^\n]*--draft\b)/, "a GitHub release creates or moves a tag; confirm with the user first"],
  // The .NET half of the publish rule above, which was missing.
  [/\b(dotnet\s+)?nuget\s+(push|delete)\b/, "publishing is a release step; confirm with the user first"],
];

for (const [re, why] of rules) {
  if (re.test(cmd)) {
    console.error(`Blocked command: ${why}.`);
    process.exit(2);
  }
}
process.exit(0);
