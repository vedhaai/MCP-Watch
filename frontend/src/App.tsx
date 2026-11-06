import { useEffect, useMemo, useState } from "react";
import Box from "@mui/material/Box";
import Card from "@mui/material/Card";
import CircularProgress from "@mui/material/CircularProgress";
import { api, setSignedOutHandler } from "./api";
import { Shell } from "./components/Shell";
import { Empty } from "./components/ui";
import { AppContext, type AppState } from "./context";
import { usePoll, useRoute } from "./lib";
import { AuthPage } from "./pages/Auth";
import { LocalPage, ProjectPage } from "./pages/Project";
import { NewProjectPage, ProjectsPage } from "./pages/Projects";
import { MONO } from "./theme";
import type { Meta, Project, User } from "./types";

function Unreachable({ what, message }: { what: string; message: string }) {
  return (
    <Box sx={{ maxWidth: 560, mx: "auto", mt: 10, px: 2 }}>
      <Card><Empty>
        Could not {what} ({message}).<br />
        If you just updated MCPWatch, restart it: stop the running <Box component="span" sx={{ fontFamily: MONO }}>mcpwatch dashboard</Box> (Ctrl+C) and start it again.
      </Empty></Card>
    </Box>
  );
}

const Loading = () => <Box sx={{ display: "grid", placeItems: "center", minHeight: "100vh" }}><CircularProgress size={28} color="inherit" /></Box>;

export function App() {
  // undefined: still asking the server; null: signed out.
  const [user, setUser] = useState<User | null | undefined>(undefined);
  const [failed, setFailed] = useState("");

  useEffect(() => {
    setSignedOutHandler(() => setUser(null));
    api<{ user: User | null }>("/api/auth/me").then((r) => setUser(r.user), (e: Error) => setFailed(e.message));
  }, []);

  if (failed) return <Unreachable what="reach the dashboard server" message={failed} />;
  if (user === undefined) return <Loading />;
  if (!user) return <AuthPage onSignedIn={setUser} />;
  return <SignedIn user={user} onSignOut={() => setUser(null)} />;
}

function SignedIn({ user, onSignOut }: { user: User; onSignOut: () => void }) {
  const route = useRoute();
  const [meta, setMeta] = useState<Meta | null>(null);
  const [failed, setFailed] = useState("");
  const [lastProject, setLastProject] = useState<string | undefined>(undefined);
  const projects = usePoll(() => api<Project[]>("/api/projects"), 5000, []);

  useEffect(() => {
    api<Meta>("/api/meta").then(setMeta, (e: Error) => setFailed(e.message));
  }, []);

  const routeProject = route[0] === "p" ? route[1] : undefined;
  useEffect(() => {
    if (routeProject) setLastProject(routeProject);
  }, [routeProject]);
  // The sidebar's project pages point at the project being viewed, else the last one, else the first.
  const projectId = routeProject ?? (lastProject && projects.data?.some((p) => p.id === lastProject) ? lastProject : projects.data?.[0]?.id);

  const state = useMemo<AppState | null>(() => meta && {
    user,
    meta,
    rules: Object.fromEntries(meta.rules.map((r) => [r.id, r])),
    projects: projects.data,
    refreshProjects: projects.refresh,
    signOut: async () => {
      await api("/api/auth/logout", { method: "POST" }).catch(() => {});
      location.hash = "#/";
      onSignOut();
    },
  }, [meta, user, projects.data]);

  if (failed) return <Unreachable what="load the dashboard" message={failed} />;
  if (!state) return <Loading />;

  // #/local is the host's own captured traffic. Someone who isn't the dashboard's owner gets the
  // projects page instead of a view that would only poll a 403.
  const page = route[0] === "new" ? <NewProjectPage />
    : route[0] === "local" && user.owner ? <LocalPage />
    : route[0] === "p" && route[1] ? <ProjectPage key={route[1]} id={route[1]} tab={route[2] ?? "requests"} />
    : <ProjectsPage />;

  return (
    <AppContext.Provider value={state}>
      <Shell route={route} projectId={projectId}>{page}</Shell>
    </AppContext.Provider>
  );
}
