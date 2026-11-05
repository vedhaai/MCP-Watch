import { useState } from "react";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import Table from "@mui/material/Table";
import TableBody from "@mui/material/TableBody";
import TableCell from "@mui/material/TableCell";
import TableHead from "@mui/material/TableHead";
import TableRow from "@mui/material/TableRow";
import Typography from "@mui/material/Typography";
import { api } from "../api";
import { Empty, Label, Stat, Stats, Tag, actionTone } from "../components/ui";
import { ago, direction, flagged } from "../lib";
import { MONO } from "../theme";
import type { McpEvent, Project } from "../types";
import { ListItem, ListPane, Split } from "./Events";

interface Client { id: string; name: string; sessions: Set<string>; messages: number; flagged: number; blocked: number; last: string; recent: McpEvent[] }

// Grouped by client name (without version), which is what the block / trust lists match on.
function byClient(events: McpEvent[]) {
  const by = new Map<string, Client>();
  for (const e of events) {
    if (e.direction === "local") continue; // scan results, not a connected client
    const id = e.clientName || e.client || "unknown";
    const c = by.get(id) ?? { id, name: e.client || id, sessions: new Set(), messages: 0, flagged: 0, blocked: 0, last: e.time, recent: [] };
    c.sessions.add(e.session);
    c.messages++;
    if (flagged(e)) c.flagged++;
    if (e.direction === "client->server" && e.action === "block") c.blocked++;
    if (e.time > c.last) c.last = e.time;
    c.recent.push(e);
    by.set(id, c);
  }
  return [...by.values()].sort((a, b) => b.last.localeCompare(a.last));
}

export function ClientsTab({ project, events, onChange }: { project: Project; events: McpEvent[]; onChange: (p: Project) => void }) {
  const clients = byClient(events);
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const current = clients.find((c) => c.id === selected) ?? clients[0];
  const ruleFor = (id: string) => (project.clients.block.includes(id) ? "block" : project.clients.allow.includes(id) ? "allow" : "");

  const setRule = async (client: string, rule: "block" | "allow" | "") => {
    const block = project.clients.block.filter((c) => c !== client);
    const allow = project.clients.allow.filter((c) => c !== client);
    if (rule === "block") block.push(client);
    if (rule === "allow") allow.push(client);
    setBusy(true);
    try {
      onChange(await api<Project>(`/api/projects/${project.id}`, { method: "PATCH", body: { clients: { block, allow } } }));
    } finally {
      setBusy(false);
    }
  };

  const rule = current ? ruleFor(current.id) : "";
  return (
    <Split>
      <ListPane head={
        <>
          <Typography sx={{ color: "text.secondary", fontSize: 13, mb: 1.5 }}>
            MCP clients that connected to this project's server. <b>Block</b> refuses everything from a client; <b>Trust</b> lets it through even when rules match. Applies within 5 seconds, in every mode.
          </Typography>
          <Typography sx={{ fontFamily: MONO, fontSize: 11, color: "text.secondary" }}>{clients.length} clients</Typography>
        </>
      }>
        {clients.map((c) => {
          const r = ruleFor(c.id);
          return (
            <ListItem
              key={c.id}
              selected={current === c}
              severity={c.blocked ? "high" : c.flagged ? "medium" : undefined}
              onClick={() => setSelected(c.id)}
              title={c.name}
              right={<>{r && <Tag tone={r === "block" ? "high" : "ok"}>{r === "block" ? "blocked" : "trusted"}</Tag>}{c.flagged > 0 && <Tag tone="medium">{c.flagged}</Tag>}</>}
              sub={<><span className="sub">{c.messages} messages</span><span className="sub">{c.sessions.size} sessions</span><span className="sub">{ago(c.last)}</span></>}
            />
          );
        })}
        {!clients.length && <Empty>No clients yet.</Empty>}
      </ListPane>
      {current ? (
        <Card sx={{ p: { xs: 2, md: 2.75 }, minWidth: 0 }}>
          <Box sx={{ display: "flex", alignItems: "center", gap: 1.25, flexWrap: "wrap" }}>
            <Typography variant="h2" sx={{ fontFamily: MONO, wordBreak: "break-all" }}>{current.name}</Typography>
            {rule && <Tag tone={rule === "block" ? "high" : "ok"}>{rule === "block" ? "blocked" : "trusted"}</Tag>}
            <Box sx={{ ml: "auto", display: "flex", gap: 1 }}>
              <Button variant="contained" color="error" disabled={busy || rule === "block"} onClick={() => setRule(current.id, "block")}>Block</Button>
              <Button variant="outlined" color="inherit" disabled={busy || rule === "allow"} onClick={() => setRule(current.id, "allow")}>Trust</Button>
              <Button color="inherit" disabled={busy || !rule} onClick={() => setRule(current.id, "")}>Reset</Button>
            </Box>
          </Box>
          <Typography sx={{ color: "text.secondary", fontSize: 13, my: 2 }}>Last seen {ago(current.last)} · matched as <Box component="span" sx={{ fontFamily: MONO }}>{current.id}</Box></Typography>
          <Stats min={110}>
            <Stat n={current.sessions.size} label="Sessions" />
            <Stat n={current.messages} label="Messages" />
            <Stat n={current.flagged} label="Flagged" hot={current.flagged > 0} />
            <Stat n={current.blocked} label="Blocked" hot={current.blocked > 0} />
          </Stats>
          <Label>Recent messages</Label>
          <Box sx={{ overflowX: "auto" }}>
            <Table size="small">
              <TableHead><TableRow><TableCell>Time</TableCell><TableCell>Dir</TableCell><TableCell>Method / tool</TableCell><TableCell>Action</TableCell><TableCell>Score</TableCell></TableRow></TableHead>
              <TableBody>
                {current.recent.slice(-12).reverse().map((e, i) => (
                  <TableRow key={i}>
                    <TableCell sx={{ fontFamily: MONO, color: "text.secondary", fontSize: 12 }}>{new Date(e.time).toLocaleTimeString()}</TableCell>
                    <TableCell sx={{ color: "text.secondary" }}>{direction(e)}</TableCell>
                    <TableCell sx={{ fontFamily: MONO, fontSize: 12 }}>{e.method}{e.tool && <b> · {e.tool}</b>}</TableCell>
                    <TableCell><Tag tone={actionTone(e.action)}>{e.action}</Tag></TableCell>
                    <TableCell sx={{ fontFamily: MONO }}>{e.score}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Box>
        </Card>
      ) : (
        <Card><Empty>Clients show up here after they connect.</Empty></Card>
      )}
    </Split>
  );
}
