// PostToolUse (Edit|Write): typecheck the package that owns the edited .ts/.tsx file.
// Non-blocking feedback: exit 2 only surfaces tsc errors to Claude after the edit.
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

let input = {};
try {
  input = JSON.parse(readFileSync(0, "utf8"));
} catch {
  process.exit(0);
}

const file = String(input.tool_input?.file_path ?? "").replace(/\\/g, "/");
const m = file.match(/\/(engine|backend|frontend)\/src\/.+\.tsx?$/);
if (!m) process.exit(0);

const root = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const pkg = m[1];
// backend imports tsoa-generated routes; skip if they have not been built yet.
const res = spawnSync("npx", ["tsc", "--noEmit", "-p", `${pkg}/tsconfig.json`], {
  cwd: root,
  encoding: "utf8",
  shell: true,
  timeout: 90_000,
});

if (res.status !== 0) {
  const out = `${res.stdout ?? ""}${res.stderr ?? ""}`.trim().split("\n").slice(0, 25).join("\n");
  console.error(`tsc found errors in ${pkg}:\n${out}`);
  process.exit(2);
}
process.exit(0);
