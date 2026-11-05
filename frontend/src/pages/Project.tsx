import Box from "@mui/material/Box";
import Card from "@mui/material/Card";
import CircularProgress from "@mui/material/CircularProgress";
import Link from "@mui/material/Link";
import { api, SignInRequired } from "../api";
import { Empty, PageHead, Tag } from "../components/ui";
import { KINDS, status, usePoll } from "../lib";
import type { McpEvent, Project } from "../types";
import { ClientsTab } from "./Clients";
import { EventsView } from "./Events";
import { SettingsTab } from "./Settings";
import { SetupTab } from "./Setup";

const TITLES: Record<string, string> = { requests: "Requests", clients: "Clients", settings: "Settings", setup: "Setup" };

export function ProjectPage({ id, tab }: { id: string; tab: string }) {
  const withEvents = tab === "requests" || tab === "clients";
  const { data, error, setData } = usePoll(async () => {
    const [project, events] = await Promise.all([
      api<Project>(`/api/projects/${id}`),
      withEvents ? api<McpEvent[]>(`/api/projects/${id}/events?limit=2000`) : Promise.resolve([] as McpEvent[]),
    ]);
    return { project, events };
  }, 2000, [id, tab]);

  if (error && !data && !(error instanceof SignInRequired)) {
    return <Card><Empty>Project not found. <Link href="#/" color="inherit">Back to projects</Link></Empty></Card>;
  }
  if (!data) return <Box sx={{ display: "grid", placeItems: "center", py: 8 }}><CircularProgress size={28} color="inherit" /></Box>;

  const { project: p, events } = data;
  const st = status(p);
  const update = (project: Project) => setData({ project, events });
  return (
    <>
      <PageHead title={TITLES[tab] ?? "Requests"} sub={
        <>
          <span>{p.name}</span>
          <Box component="span" sx={{ color: "divider" }}>·</Box>
          <span>{KINDS[p.kind][0]}</span>
          <Tag tone={st.on ? "ok" : !p.lastSeenAt ? "medium" : "outline"}>{st.text}</Tag>
          <Tag>mode: {p.mode}</Tag>
        </>
      } />
      {tab === "settings" ? <SettingsTab key={p.id} project={p} onChange={update} />
        : tab === "setup" ? <SetupTab project={p} />
        : tab === "clients" ? <ClientsTab project={p} events={events} onChange={update} />
        : <EventsView key={p.id} events={events} />}
    </>
  );
}

export function LocalPage() {
  const { data } = usePoll(() => api<McpEvent[]>("/api/local-events?limit=2000"), 2000, []);
  return (
    <>
      <PageHead title="Local events" sub="From guards running without a project key (written to ~/.mcpwatch/events.jsonl)." />
      {data ? <EventsView events={data} /> : <Box sx={{ display: "grid", placeItems: "center", py: 8 }}><CircularProgress size={28} color="inherit" /></Box>}
    </>
  );
}
