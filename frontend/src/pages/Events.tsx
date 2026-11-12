import { useMemo, useState, type ReactNode } from "react";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import ButtonBase from "@mui/material/ButtonBase";
import Card from "@mui/material/Card";
import InputAdornment from "@mui/material/InputAdornment";
import Tab from "@mui/material/Tab";
import Tabs from "@mui/material/Tabs";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import SearchIcon from "@mui/icons-material/Search";
import { Code, Empty, Label, Stat, Stats, Tag, actionTone, severityTone } from "../components/ui";
import { useApp } from "../context";
import { direction, eventKey, flagged } from "../lib";
import { MONO } from "../theme";
import type { McpEvent, Severity } from "../types";

const PAGE = 50;
const FILTERS: [string, string, (e: McpEvent) => boolean][] = [
  ["", "All", () => true],
  ["flagged", "Flagged", flagged],
  ["block", "Blocked", (e) => e.action === "block"],
  ["throttle", "Throttled", (e) => e.action === "throttle"],
  ["strip", "Tools removed", (e) => e.action === "strip"],
  ["redact", "Redacted", (e) => e.action === "redact"],
  ["allow", "Allowed", (e) => e.action === "allow"],
];
const RANK: Record<Severity, number> = { high: 3, medium: 2, low: 1 };

export const topSeverity = (e: McpEvent): Severity | undefined =>
  e.findings.reduce<Severity | undefined>((top, f) => (!top || RANK[f.severity] > RANK[top] ? f.severity : top), undefined);

export function Chip({ active, label, count, onClick }: { active: boolean; label: string; count?: number; onClick: () => void }) {
  return (
    <ButtonBase onClick={onClick} sx={{
      gap: 0.75, px: 1.1, py: 0.5, border: "1px solid", borderRadius: 1.5, fontSize: 13, fontWeight: 500,
      borderColor: active ? "primary.main" : "divider", bgcolor: active ? "primary.main" : "background.paper", color: active ? "primary.contrastText" : "text.primary",
      "&:hover": { bgcolor: active ? "primary.main" : "action.hover" },
    }}>
      {label}
      {count !== undefined && (
        <Box component="span" sx={{ fontFamily: MONO, fontSize: 11, border: "1px solid", borderColor: active ? "rgba(128,128,128,.4)" : "divider", borderRadius: 1, px: 0.6 }}>{count}</Box>
      )}
    </ButtonBase>
  );
}

// The left-hand list of a list / detail page.
export function ListPane({ head, children, footer }: { head: ReactNode; children: ReactNode; footer?: ReactNode }) {
  return (
    <Card sx={{ display: "flex", flexDirection: "column" }}>
      <Box sx={{ p: 2, pb: 1 }}>{head}</Box>
      <Box sx={{ maxHeight: { xs: 420, lg: "calc(100vh - 380px)" }, minHeight: 200, overflowY: "auto", px: 1.5, pb: 1.5 }}>
        {children}
        {footer}
      </Box>
    </Card>
  );
}

export function ListItem({ selected, severity, onClick, title, right, sub }: {
  selected: boolean; severity?: Severity; onClick: () => void; title: ReactNode; right?: ReactNode; sub?: ReactNode;
}) {
  const edge = severity === "high" ? "error.main" : severity === "medium" ? "warning.main" : severity === "low" ? "text.secondary" : "transparent";
  return (
    <ButtonBase onClick={onClick} sx={{
      display: "block", width: "100%", textAlign: "left", borderLeft: "4px solid", borderLeftColor: edge, borderRadius: "12px", px: 1.75, py: 1.25, mb: 0.5,
      bgcolor: selected ? "primary.main" : "transparent", color: selected ? "primary.contrastText" : "text.primary",
      "&:hover": { bgcolor: selected ? "primary.main" : "action.hover" },
      "& .sub": { color: selected ? "inherit" : "text.secondary", opacity: selected ? 0.7 : 1 },
    }}>
      <Box sx={{ display: "flex", alignItems: "center", gap: 1, fontFamily: MONO, fontSize: 13, fontWeight: 600 }}>
        <Box component="span" sx={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{title}</Box>
        <Box component="span" sx={{ ml: "auto", display: "flex", gap: 0.5 }}>{right}</Box>
      </Box>
      {sub && <Box sx={{ display: "flex", alignItems: "center", gap: 0.75, mt: 0.5, fontFamily: MONO, fontSize: 11.5, flexWrap: "wrap" }}>{sub}</Box>}
    </ButtonBase>
  );
}

// Side by side on wide screens (list, then detail), stacked below that. `columns` sets the wide layout.
export function Split({ children, columns = "minmax(320px, 5fr) minmax(0, 7fr)" }: { children: ReactNode; columns?: string }) {
  return <Box sx={{ display: "grid", gridTemplateColumns: { xs: "minmax(0, 1fr)", lg: columns }, gap: 2, alignItems: "start" }}>{children}</Box>;
}

export function Kv({ rows }: { rows: [string, ReactNode][] }) {
  return (
    <Box component="dl" sx={{ display: "grid", gridTemplateColumns: "120px 1fr", gap: "6px 12px", m: 0, fontSize: 13 }}>
      {rows.map(([k, v]) => [
        <Box component="dt" key={k + "k"} sx={{ color: "text.secondary" }}>{k}</Box>,
        <Box component="dd" key={k + "v"} sx={{ m: 0, fontFamily: MONO, fontSize: 12.5, wordBreak: "break-all" }}>{v}</Box>,
      ])}
    </Box>
  );
}

function FindingRow({ f }: { f: McpEvent["findings"][number] }) {
  const { rules } = useApp();
  return (
    <Box sx={{ py: 1.25, borderBottom: "1px solid", borderColor: "divider", "&:last-child": { borderBottom: 0 } }}>
      <Box sx={{ display: "flex", gap: 1, alignItems: "center", flexWrap: "wrap" }}>
        <Tag tone={severityTone(f.severity)}>{f.severity}</Tag>
        <Typography component="span" sx={{ fontFamily: MONO, fontWeight: 600, fontSize: 13, textDecoration: "underline" }}>{f.rule}</Typography>
        <Typography component="span" sx={{ fontSize: 13 }}>{rules[f.rule]?.title}</Typography>
        {f.source === "ai" && <Tag tone="dark">AI ✦</Tag>}
        <Tag sx={{ ml: "auto" }}>+{f.points}</Tag>
      </Box>
      <Typography sx={{ fontFamily: MONO, fontSize: 12, color: "text.secondary", mt: 0.5, wordBreak: "break-word" }}>
        {f.detail}{f.where ? ` · ${f.where}` : ""}
      </Typography>
    </Box>
  );
}

function EventDetail({ e }: { e: McpEvent }) {
  const [tab, setTab] = useState("overview");
  const sev = topSeverity(e);
  return (
    <Card sx={{ p: { xs: 2, md: 2.75 } }}>
      <Box sx={{ display: "flex", alignItems: "center", gap: 1.25, flexWrap: "wrap" }}>
        <Typography variant="h2" sx={{ fontFamily: MONO, wordBreak: "break-all" }}>{e.tool ?? e.method}</Typography>
        <Tag tone={actionTone(e.action)}>{e.action}</Tag>
        {e.action !== e.enforceAction && <Tag>enforce: {e.enforceAction}</Tag>}
        {e.clientRule && <Tag tone="dark">client {e.clientRule === "block" ? "blocked" : "trusted"}</Tag>}
      </Box>
      <Box sx={{ mt: 1.25 }}><Tag tone={sev ? severityTone(sev) : "outline"}>score {e.score}</Tag></Box>
      <Box sx={{ color: "text.secondary", fontSize: 13, my: 2 }}>
        <div>{e.tool ? e.method : direction(e)} · {e.client}</div>
        <div>{new Date(e.time).toLocaleString()}</div>
      </Box>
      <Stats min={110}>
        <Stat n={e.score} label="Session score" hot={sev === "high"} />
        <Stat n={e.findings.length} label="Findings" hot={e.findings.length > 0} />
        <Stat n={e.findings.filter((f) => f.severity === "high").length} label="High severity" hot={sev === "high"} />
      </Stats>
      <Tabs value={tab} onChange={(_, v) => setTab(v)} variant="scrollable" sx={{
        minHeight: 0, mb: 2.25, p: 0.4, bgcolor: "background.default", border: "1px solid", borderColor: "divider", borderRadius: 2,
        "& .MuiTabs-indicator": { display: "none" },
        "& .MuiTab-root": { minHeight: 0, py: 0.75, px: 1.5, borderRadius: 1.5, color: "text.secondary", textTransform: "none", fontWeight: 500 },
        "& .MuiTab-root.Mui-selected": { bgcolor: "primary.main", color: "primary.contrastText" },
      }}>
        <Tab value="overview" label="Overview" />
        <Tab value="findings" label={`Findings  ${e.findings.length}`} />
        <Tab value="message" label="Message" />
      </Tabs>
      {tab === "overview" && (
        <>
          <Label>Message</Label>
          <Kv rows={[
            ["Direction", direction(e)],
            ["Method", e.method],
            ...(e.tool ? [["Tool", e.tool] as [string, ReactNode]] : []),
            ["Client", e.client],
            ["Server", e.server],
            ["Session", e.session],
            ["Request id", String(e.id ?? "—")],
            ["Mode", e.mode],
          ]} />
          <Box sx={{ borderTop: "1px solid", borderColor: "divider", mt: 2, pt: 2 }}>
            <Label>{e.findings.length ? `Why this was ${e.action === "allow" ? "flagged" : e.action === "strip" ? "removed" : e.action + "ed"}` : "Findings"}</Label>
            {e.findings.length ? e.findings.slice(0, 3).map((f, i) => <FindingRow key={i} f={f} />) : <Typography sx={{ color: "text.secondary", fontSize: 13 }}>No rule matched this message.</Typography>}
            {e.findings.length > 3 && <Button size="small" color="inherit" onClick={() => setTab("findings")}>All {e.findings.length} findings</Button>}
          </Box>
          {e.ai && (
            <Box sx={{ borderTop: "1px solid", borderColor: "divider", mt: 2, pt: 2 }}>
              <Label>AI review</Label>
              <Box sx={{ display: "flex", gap: 1, alignItems: "center", flexWrap: "wrap", fontSize: 13 }}>
                <Tag tone={e.ai.verdict === "block" ? "high" : e.ai.verdict === "suspicious" ? "medium" : e.ai.verdict === "allow" ? "ok" : "outline"}>{e.ai.verdict}</Tag>
                <span>{e.ai.model}</span>
                <Typography component="span" sx={{ color: "text.secondary", fontSize: 13 }}>{e.ai.cached ? "cached" : `${e.ai.ms} ms`}{e.ai.error ? ` · ${e.ai.error}` : ""}</Typography>
                {e.ai.promptTokens !== undefined && (
                  <Typography component="span" sx={{ color: "text.secondary", fontSize: 13 }}>
                    {e.ai.tokensEstimated ? "~" : ""}{(e.ai.promptTokens + (e.ai.completionTokens ?? 0)).toLocaleString()} tokens
                    {e.ai.costUsd !== undefined ? ` · $${e.ai.costUsd.toFixed(4)}` : ""}
                  </Typography>
                )}
              </Box>
              {e.ai.summary && <Typography sx={{ fontSize: 13, mt: 1 }}>{e.ai.summary}</Typography>}
            </Box>
          )}
        </>
      )}
      {tab === "findings" && (e.findings.length ? e.findings.map((f, i) => <FindingRow key={i} f={f} />) : <Empty>No findings.</Empty>)}
      {tab === "message" && (e.snippet ? <><Label>Excerpt (secrets redacted)</Label><Code>{e.snippet}</Code></> : <Empty>No excerpt for this message.</Empty>)}
    </Card>
  );
}

// Tiles, the filterable message list, the selected message and the rules hit most.
export function EventsView({ events }: { events: McpEvent[] }) {
  const { rules } = useApp();
  const [filter, setFilter] = useState("");
  const [text, setText] = useState("");
  const [shown, setShown] = useState(PAGE);
  const [selected, setSelected] = useState<string | null>(null);

  const newest = useMemo(() => events.slice().reverse(), [events]);
  const list = newest.filter((e) => {
    if (!FILTERS.find(([k]) => k === filter)![2](e)) return false;
    if (text) {
      const hay = [e.method, e.tool, e.client, e.server, ...e.findings.map((f) => f.rule + " " + f.detail)].join(" ").toLowerCase();
      if (!hay.includes(text.toLowerCase())) return false;
    }
    return true;
  });
  const current = list.find((e) => eventKey(e) === selected) ?? list[0];

  const counts: Record<string, number> = {};
  events.forEach((e) => e.findings.forEach((f) => (counts[f.rule] = (counts[f.rule] || 0) + 1)));
  const top = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  const blocked = events.filter((e) => ["block", "throttle", "strip"].includes(e.action)).length;

  return (
    <>
      <Stats>
        <Stat n={events.length} label="Messages checked" />
        <Stat n={events.filter((e) => e.method === "tools/call" && e.direction === "client->server").length} label="Tool calls" />
        <Stat n={events.filter(flagged).length} label="Flagged" hot={events.some(flagged)} />
        <Stat n={blocked} label="Blocked / removed" hot={blocked > 0} />
        <Stat n={events.filter((e) => e.action === "redact").length} label="Redacted" />
        <Stat n={events.filter((e) => e.action === "allow" && e.enforceAction !== "allow").length} label="Would block (observe)" />
        <Stat n={new Set(events.map((e) => e.client)).size} label="Clients" />
      </Stats>
      <Split columns="minmax(0, 3fr) minmax(380px, 2fr)">
        <ListPane
          head={
            <>
              <Label>Action</Label>
              <Box sx={{ display: "flex", gap: 0.75, flexWrap: "wrap", mb: 1.5 }}>
                {FILTERS.map(([k, l, fn]) => (
                  <Chip key={k} active={filter === k} label={l} count={events.filter(fn).length} onClick={() => { setFilter(k); setShown(PAGE); }} />
                ))}
              </Box>
              <TextField
                fullWidth
                placeholder="Search tool, method, client, rule…"
                value={text}
                onChange={(e) => { setText(e.target.value); setShown(PAGE); }}
                slotProps={{ input: { startAdornment: <InputAdornment position="start"><SearchIcon fontSize="small" /></InputAdornment> } }}
              />
              <Typography sx={{ fontFamily: MONO, fontSize: 11, color: "text.secondary", mt: 1.25 }}>{list.length} messages</Typography>
            </>
          }
          footer={list.length > shown && (
            <Box sx={{ display: "flex", justifyContent: "center", pt: 1 }}>
              <Button variant="outlined" color="inherit" onClick={() => setShown((n) => n + PAGE)}>Load more ({list.length - shown} left)</Button>
            </Box>
          )}
        >
          {list.slice(0, shown).map((e) => {
            const k = eventKey(e);
            const sev = topSeverity(e);
            return (
              <ListItem
                key={k}
                selected={current === e}
                severity={sev}
                onClick={() => setSelected(k)}
                title={<>{e.method}{e.tool && <> · {e.tool}</>}</>}
                right={<>{e.action !== "allow" && <Tag tone={actionTone(e.action)}>{e.action}</Tag>}{e.score > 0 && <Tag tone={severityTone(sev)}>{e.score}</Tag>}</>}
                sub={
                  <>
                    <span className="sub">{new Date(e.time).toLocaleTimeString()}</span>
                    <span className="sub">{direction(e)}</span>
                    <span className="sub">{e.client}</span>
                    {e.findings.slice(0, 2).map((f, i) => <Tag key={i} tone={severityTone(f.severity)} title={rules[f.rule]?.title}>{f.rule}{f.source === "ai" ? " ✦" : ""}</Tag>)}
                    {e.findings.length > 2 && <Tag>+{e.findings.length - 2}</Tag>}
                  </>
                }
              />
            );
          })}
          {!list.length && <Empty>{events.length ? "Nothing matches these filters." : "No requests yet."}</Empty>}
        </ListPane>
        <Box sx={{ minWidth: 0 }}>
          {current ? <EventDetail key={eventKey(current)} e={current} /> : <Card><Empty>Select a message to see what MCPWatch found.</Empty></Card>}
          <Card sx={{ p: 2.25, mt: 2 }}>
            <Label>Top rules hit</Label>
            {top.length ? top.slice(0, 10).map(([id, n]) => (
              <Box key={id} sx={{ display: "flex", alignItems: "center", gap: 1, py: 1, borderBottom: "1px solid", borderColor: "divider", fontSize: 13, "&:last-child": { borderBottom: 0 } }}>
                <Tag tone={severityTone(rules[id]?.severity)}>{id}</Tag>
                <span>{rules[id]?.title}</span>
                <Typography component="b" sx={{ ml: "auto", fontFamily: MONO, fontWeight: 700 }}>{n}</Typography>
              </Box>
            )) : <Empty>No findings yet.</Empty>}
          </Card>
        </Box>
      </Split>
    </>
  );
}
