// Detection patterns shared by the rules.

export const SECRET_PATTERNS: { name: string; re: RegExp }[] = [
  { name: "private-key", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g },
  { name: "aws-access-key", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { name: "aws-secret-key", re: /(aws_secret_access_key\s*[=:]\s*)[A-Za-z0-9/+]{40}/gi },
  { name: "github-token", re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g },
  { name: "api-key", re: /\bsk-[A-Za-z0-9_-]{20,}\b/g },
  { name: "slack-token", re: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g },
  { name: "jwt", re: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g },
  { name: "google-api-key", re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { name: "stripe-key", re: /\b[rs]k_(?:live|test)_[0-9A-Za-z]{20,}\b/g },
  { name: "npm-token", re: /\bnpm_[A-Za-z0-9]{36}\b/g },
  // user:password@ inside a URL (database and proxy connection strings): the password is what goes.
  { name: "url-password", re: /(\b[a-z][a-z0-9+.-]{1,20}:\/\/[^\s:/@]{1,100}:)[^\s@/]{1,200}(?=@)/gi },
  { name: "bearer-token", re: /(\bBearer\s+)[A-Za-z0-9._~+/=-]{20,}/g },
];

// Patterns whose first group (the label) stays in the output; only the value after it is replaced.
const KEEP_PREFIX = new Set(["aws-secret-key", "url-password", "bearer-token"]);

export function findSecrets(s: string): string[] {
  return SECRET_PATTERNS.filter((p) => {
    p.re.lastIndex = 0;
    return p.re.test(s);
  }).map((p) => p.name);
}

export function redactSecrets(s: string): string {
  let out = s;
  for (const p of SECRET_PATTERNS) {
    p.re.lastIndex = 0;
    out = KEEP_PREFIX.has(p.name)
      ? out.replace(p.re, `$1[REDACTED:${p.name}]`)
      : out.replace(p.re, `[REDACTED:${p.name}]`);
  }
  return out;
}

// Card numbers pass the Luhn check; this keeps order ids, timestamps and other long numbers readable.
function luhn(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1 && (d *= 2) > 9) d -= 9;
    sum += d;
  }
  return sum % 10 === 0;
}

// The user-name folder of a profile path: C:\Users\Jane, /Users/jane, /home/jane, C:\Documents and Settings\Jane.
// - A path inside JSON has its backslashes doubled, and one inside JSON inside JSON quadrupled: 1 to 4 are allowed.
// - A name may hold spaces ("Mary Ann", up to three words) when a separator follows, which tells where it ends.
//   Without one only the first word is taken, so a sentence after a path isn't swallowed.
// - Shared profiles (Public, Shared, Default, All Users) say nothing about a person and stay.
const PROFILE_PATH = new RegExp(
  // (?<!\bAll ) keeps the "Users" inside "All Users" from starting a match of its own.
  String.raw`(?<!\bAll )\b((?:Users|home|Documents and Settings)(?:\\{1,4}|/))(?!(?:Public|Shared|Default|All Users)\b)` +
  String.raw`(?:[^\\/\s"'<>|:]+(?: [^\\/\s"'<>|:]+){0,2}(?=\\|/)|[^\\/\s"'<>|:]+)`,
  "gi",
);

// The extra pass for a model that runs on someone else's machine, on top of redactSecrets: personal data
// that a security review doesn't need. The part that matters for judging an attack stays: an email's
// domain (where data is sent), the shape of a path. Only the person is removed.
export function redactPersonal(s: string): string {
  return s
    .replace(/\b[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,})\b/g, "[email]@$1")
    .replace(/\b(?:\d[ -]?){12,18}\d\b/g, (m) => (luhn(m.replace(/\D/g, "")) ? "[card-number]" : m))
    .replace(/\b\d{3}-\d{2}-\d{4}\b/g, "[ssn]")
    .replace(PROFILE_PATH, "$1[user]");
}

const SHELL_CMDS =
  "curl|wget|nc|ncat|bash|sh|zsh|powershell|pwsh|cmd(?:\\.exe)?|rm|del|chmod|chown|python3?|perl|node|cat|type|whoami|id|uname|nslookup|ping|certutil|bitsadmin";

export const COMMAND_INJECTION: RegExp[] = [
  new RegExp(`(?:;|&&|\\|\\|?|\\n)\\s*(?:${SHELL_CMDS})\\b`, "i"),
  // Bounded: each `$(` or backtick without a closing partner would otherwise scan to the end of the text.
  /\$\([^)]{1,500}\)/,
  /`[^`]{1,500}`/,
  /\/dev\/tcp\/|\bmkfifo\b|\brm\s+-rf\s+[/~]/i,
];

export const PATH_TRAVERSAL = /(?:^|[\\/])\.\.(?:[\\/]|$)|%2e%2e(?:%2f|%5c|[\\/])/i;

export const SENSITIVE_PATH =
  /(?:^|[\\/~])(?:\.ssh|id_rsa|id_ed25519|id_ecdsa|\.aws[\\/]credentials|\.env|\.git-credentials|\.npmrc|\.netrc|\.kube[\\/]config|\.docker[\\/]config\.json|mcp\.json|claude_desktop_config\.json)(?:$|[\\/.\s'"])|^\/etc\/(?:passwd|shadow|sudoers)|^\/proc\/self|^[a-z]:\\windows\\system32\\config/i;

export const SQL_INJECTION: RegExp[] = [
  /'\s*(?:or|and)\s+'?\w+'?\s*=\s*'?\w+/i,
  /\bunion\s+(?:all\s+)?select\b/i,
  /;\s*(?:drop|delete|truncate|alter|insert|update|create)\s/i,
  /'\s*;?\s*--/,
  /\b(?:sleep|benchmark|pg_sleep)\s*\(/i,
];

// Each match is one indicator. Several indicators in one text = high severity.
export const INJECTION_INDICATORS: { name: string; re: RegExp }[] = [
  { name: "ignore-instructions", re: /\b(?:ignore|disregard|forget)\s+(?:all\s+|any\s+)?(?:the\s+)?(?:previous|prior|above|earlier|your)\s+(?:instructions|prompts|messages|rules)/i },
  { name: "role-override", re: /\byou\s+are\s+now\b|\bact\s+as\s+(?:an?\s+)?(?:admin|system|developer)\b|\b(?:admin|developer|god)\s+mode\b/i },
  { name: "new-instructions", re: /\b(?:new|updated|real)\s+(?:system\s+)?instructions\s*:/i },
  { name: "hide-from-user", re: /\b(?:do\s+not|don'?t|never)\s+(?:tell|inform|mention|reveal|show|let)\b[^.]{0,40}\buser\b/i },
  { name: "instruction-tag", re: /<\/?\s*(?:important|system|instructions?|secret)\s*>/i },
  { name: "tool-directive", re: /\b(?:call|invoke|use|run)\s+(?:the\s+)?[`'"]?[a-z]+_[a-z_]+[`'"]?\s+(?:tool\s+)?with\b/i },
  { name: "precondition", re: /\bbefore\s+(?:using|calling|answering|responding)\b|\botherwise\s+the\s+tool\s+will\s+(?:fail|not\s+work)\b/i },
  { name: "data-handoff", re: /\bpass\s+(?:its|the|their)\s+(?:full\s+)?contents?\b|\binclude\s+the\s+user'?s\s+\w+/i },
  { name: "sensitive-path", re: /~\/\.ssh|id_rsa|\.aws\/credentials|\.env\b|mcp\.json|\/etc\/passwd/i },
  { name: "exfil-address", re: /@[\w-]*(?:attacker|evil|exfil|collector)[\w.-]*/i },
];

export function injectionIndicators(s: string): string[] {
  return INJECTION_INDICATORS.filter((p) => p.re.test(s)).map((p) => p.name);
}

// Zero-width, bidi controls and Unicode tag characters: invisible to a person, visible to a model.
export const HIDDEN_CHARS = /[​-‏‪-‮⁠-⁤⁦-⁩﻿]|[\u{E0000}-\u{E007F}]/gu;

export const OUTBOUND_TOOL = /send|email|mail|post|upload|webhook|http|fetch|slack|message|publish|notify/i;

export const URL_IN_TEXT = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi;

export function isInternalHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, "").toLowerCase();
  if (h === "localhost" || h.endsWith(".localhost") || h === "0.0.0.0" || h === "::" || h === "::1") return true;
  if (/^metadata(\.google\.internal)?$/.test(h) || h === "metadata.azure.com") return true;
  if (/^(fc|fd)[0-9a-f]{2}:|^fe80:/.test(h) || h.startsWith("::ffff:")) return true;
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(h);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 127 || a === 10 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
}

// MW010: injection into query languages and template engines other than SQL.
export const OTHER_INJECTION: { name: string; re: RegExp }[] = [
  { name: "nosql-operator", re: /\{\s*["']?\$(?:where|ne|gt|gte|lt|lte|regex|nin|in|expr|function|accumulator)["']?\s*:/i },
  { name: "nosql-js", re: /\b(?:this\.\w+\s*==|sleep\(\d+\)|db\.\w+\.(?:find|drop|remove))\b|';\s*return\s+(?:true|1)/i },
  { name: "ldap", re: /\*\)\s*\(\s*[|&!]|\)\s*\(\s*\|?\s*\(?\s*(?:uid|cn|objectclass|mail)\s*=\s*\*/i },
  { name: "template", re: /\{\{\s*[^}]{0,200}?(?:\d\s*[*+]\s*\d|__class__|config|self\.|request\.|lipsum|cycler|constructor)[^}]{0,200}\}\}|\$\{\s*(?:\d\s*[*+]\s*\d|T\(|Runtime|java\.|jndi:)|<%=?\s*[^%]{0,200}(?:system|exec|`)|#\{\s*\d\s*\*\s*\d\s*\}/i },
  { name: "xxe", re: /<!ENTITY\s+[%\w]+\s+(?:SYSTEM|PUBLIC)\b|<!DOCTYPE[^>]*\[\s*<!ENTITY/i },
];

// Keys that are MongoDB-style operators, when the arguments are objects rather than strings.
export const NOSQL_KEY = /^\$(?:where|ne|gt|gte|lt|lte|regex|nin|in|expr|function|accumulator|or|and|not)$/;

// MW029: fields an elicitation form should never ask for.
export const CREDENTIAL_FIELD =
  /pass(?:word|wd|phrase|code)?\b|\bpin\b|\botp\b|one[\s_-]?time|2fa|mfa|\btotp\b|secret|api[\s_-]?key|access[\s_-]?key|\btoken\b|private[\s_-]?key|seed[\s_-]?phrase|mnemonic|recovery[\s_-]?(?:code|phrase)|card[\s_-]?number|\bcvv\b|\bcvc\b|security[\s_-]?code|\bssn\b|social[\s_-]?security|bank[\s_-]?account|routing[\s_-]?number/i;

// Capabilities a tool gives the model, judged from its name and description (MW039).
export const CAPABILITIES: { name: string; re: RegExp }[] = [
  { name: "shell", re: /\b(?:run_command|exec(?:ute)?(?:_\w+)?|shell|terminal|bash|powershell|cmd|spawn|subprocess|eval)\b/i },
  { name: "file-write", re: /\b(?:write_file|delete_file|remove_file|move_file|edit_file|create_file|rm|unlink|overwrite)\b|\b(?:writes?|deletes?|modif(?:y|ies))\s+(?:a\s+|the\s+)?files?\b/i },
  { name: "network", re: /\b(?:fetch_url|http_request|fetch|download|upload|webhook|curl|browse|navigate)\b/i },
  { name: "messaging", re: /\b(?:send_email|send_message|post_message|slack|sms|tweet|publish)\b/i },
  { name: "payments", re: /\b(?:transfer|payment|charge|refund|payout|invoice)\b/i },
];

// Output that is sensitive enough for its lines to be remembered across servers (MB006).
export const CONFIDENTIAL_LABEL = /\b(?:confidential|internal\s+only|do\s+not\s+(?:share|distribute|forward)|proprietary|restricted)\b/i;

// A link that carries secrets or text for a model must not be readable on the way: https, or plain http only to this machine.
export function isLoopbackHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, "").replace(/^::ffff:/, "").toLowerCase();
  return h === "localhost" || h.endsWith(".localhost") || h === "::1" || /^127\.\d+\.\d+\.\d+$/.test(h);
}

export function isTrustedUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "https:" || (u.protocol === "http:" && isLoopbackHost(u.hostname));
  } catch {
    return false;
  }
}
