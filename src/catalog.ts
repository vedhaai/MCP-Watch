export type Severity = "high" | "medium" | "low";

export interface RuleInfo {
  id: string;
  title: string;
  severity: Severity;
  points: number;
  group: "tool-call" | "tool-definition" | "server-output" | "transport" | "behavior" | "supply-chain" | "ai";
}

// MW rules check a single message. MB rules check a session's behavior over time.
// A finding may raise or lower the severity listed here (e.g. one weak indicator vs several).
export const CATALOG: RuleInfo[] = [
  { id: "MW001", title: "Command injection in tool arguments", severity: "high", points: 5, group: "tool-call" },
  { id: "MW002", title: "Path traversal or sensitive file in arguments", severity: "high", points: 5, group: "tool-call" },
  { id: "MW003", title: "SSRF: internal, metadata or file URL in arguments", severity: "high", points: 5, group: "tool-call" },
  { id: "MW004", title: "SQL injection in tool arguments", severity: "high", points: 5, group: "tool-call" },
  { id: "MW005", title: "Secret in tool arguments (possible exfiltration)", severity: "high", points: 5, group: "tool-call" },
  { id: "MW006", title: "Arguments do not match the tool's input schema", severity: "medium", points: 2, group: "tool-call" },
  { id: "MW007", title: "Call to a tool the server never listed", severity: "medium", points: 2, group: "tool-call" },
  { id: "MW008", title: "Oversized or deeply nested arguments", severity: "medium", points: 2, group: "tool-call" },
  { id: "MW009", title: "Tool denied by policy", severity: "high", points: 5, group: "tool-call" },
  { id: "MW010", title: "NoSQL, LDAP, template or XML (XXE) injection in arguments", severity: "high", points: 5, group: "tool-call" },
  { id: "MW020", title: "Tool poisoning: hidden instructions in a tool definition", severity: "high", points: 5, group: "tool-definition" },
  { id: "MW021", title: "Invisible or obfuscated characters in a tool definition", severity: "medium", points: 2, group: "tool-definition" },
  { id: "MW022", title: "Prompt injection in server output", severity: "high", points: 5, group: "server-output" },
  { id: "MW023", title: "Oversized server response", severity: "medium", points: 2, group: "server-output" },
  { id: "MW024", title: "Rug pull: tool definition changed after it was pinned", severity: "high", points: 5, group: "tool-definition" },
  { id: "MW025", title: "Secret or credential in server output", severity: "medium", points: 2, group: "server-output" },
  { id: "MW026", title: "Server asked the client's model to generate (sampling)", severity: "low", points: 1, group: "server-output" },
  { id: "MW027", title: "Tool name collision: another server on this machine has the same tool", severity: "medium", points: 2, group: "tool-definition" },
  { id: "MW028", title: "Tool shadowing: description refers to another server's tools", severity: "high", points: 5, group: "tool-definition" },
  { id: "MW029", title: "Elicitation phishing: server asks the user for credentials", severity: "high", points: 5, group: "server-output" },
  { id: "MW030", title: "DNS rebinding or cross-site request: foreign Origin or Host", severity: "high", points: 5, group: "transport" },
  { id: "MW031", title: "Request without authentication", severity: "high", points: 5, group: "transport" },
  { id: "MW032", title: "Client credential in tool arguments or server output (token passthrough)", severity: "high", points: 5, group: "transport" },
  { id: "MW033", title: "Session hijacking: session reused with another credential or guessable id", severity: "high", points: 5, group: "transport" },
  { id: "MW034", title: "Plain HTTP between machines", severity: "medium", points: 2, group: "transport" },
  { id: "MW035", title: "Client identity changed within a session (impersonation)", severity: "high", points: 5, group: "transport" },
  { id: "MW036", title: "Bearer token expired or issued for another service (confused deputy)", severity: "high", points: 5, group: "transport" },
  { id: "MW037", title: "Event stream abuse: forged response or foreign resumption id", severity: "high", points: 5, group: "transport" },
  { id: "MW038", title: "Server changed: new name or version since it was pinned", severity: "medium", points: 2, group: "supply-chain" },
  { id: "MW039", title: "Over-privileged server: shell, file-write, network or payment tools", severity: "low", points: 1, group: "tool-definition" },
  { id: "MB001", title: "Call flood: too many tool calls in the window", severity: "medium", points: 2, group: "behavior" },
  { id: "MB002", title: "Repeated blocked attempts", severity: "medium", points: 3, group: "behavior" },
  { id: "MB003", title: "Enumeration: one tool walked with many different arguments", severity: "medium", points: 2, group: "behavior" },
  { id: "MB004", title: "Exfiltration chain: secret read, then an outbound tool called", severity: "high", points: 5, group: "behavior" },
  { id: "MB005", title: "Replay: identical call repeated", severity: "low", points: 1, group: "behavior" },
  { id: "MB006", title: "Cross-server leakage: data from one server sent to another", severity: "high", points: 5, group: "behavior" },
  // MA rules come from the AI reviewer. Its other findings use the rule ids above.
  { id: "MA001", title: "AI reviewer: threat not covered by a pattern rule", severity: "medium", points: 2, group: "ai" },
  { id: "MA002", title: "AI reviewer unavailable while required", severity: "high", points: 5, group: "ai" },
  // MS rules come from `mcpwatch scan`, which checks client configs before any server runs.
  { id: "MS001", title: "Typosquatted package: name is close to a well-known MCP server", severity: "high", points: 5, group: "supply-chain" },
  { id: "MS002", title: "Suspicious launch command (download-and-run, encoded script)", severity: "high", points: 5, group: "supply-chain" },
  { id: "MS003", title: "Unpinned package or image: updates run without review", severity: "low", points: 1, group: "supply-chain" },
  { id: "MS004", title: "Plaintext secret in an MCP config", severity: "medium", points: 2, group: "supply-chain" },
  { id: "MS005", title: "Over-broad access: whole disk, privileged container or host network", severity: "medium", points: 2, group: "supply-chain" },
  { id: "MS006", title: "Config tampering: server added or changed since the last accepted scan", severity: "medium", points: 2, group: "supply-chain" },
  { id: "MS007", title: "Remote MCP server over plain HTTP", severity: "medium", points: 2, group: "supply-chain" },
];

export const RULES: Record<string, RuleInfo> = Object.fromEntries(CATALOG.map((r) => [r.id, r]));
