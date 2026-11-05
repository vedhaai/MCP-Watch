import { useState } from "react";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import ButtonBase from "@mui/material/ButtonBase";
import Card from "@mui/material/Card";
import CardActionArea from "@mui/material/CardActionArea";
import CircularProgress from "@mui/material/CircularProgress";
import Link from "@mui/material/Link";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import AddIcon from "@mui/icons-material/Add";
import { api } from "../api";
import { Empty, Label, PageHead, Tag } from "../components/ui";
import { useApp } from "../context";
import { KINDS, status } from "../lib";
import type { Project, ProjectKind } from "../types";

export function ProjectsPage() {
  const { projects } = useApp();
  return (
    <>
      <PageHead title="Projects" sub={projects ? `${projects.length} project${projects.length === 1 ? "" : "s"}` : "Loading…"}
        actions={<Button variant="contained" startIcon={<AddIcon />} href="#/new">New project</Button>} />
      {!projects ? <Box sx={{ display: "grid", placeItems: "center", py: 6 }}><CircularProgress size={28} color="inherit" /></Box>
        : projects.length ? (
          <Box sx={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: 1.5 }}>
            {projects.map((p) => {
              const st = status(p);
              return (
                <Card key={p.id} sx={{ "&:hover": { borderColor: "text.primary" } }}>
                  <CardActionArea href={`#/p/${p.id}/requests`} sx={{ p: 2 }}>
                    <Typography sx={{ fontWeight: 700, fontSize: 15 }}>{p.name}</Typography>
                    <Typography sx={{ color: "text.secondary", fontSize: 12, mt: 0.5 }}>{KINDS[p.kind][0]}</Typography>
                    <Box sx={{ display: "flex", gap: 0.75, mt: 1.25, flexWrap: "wrap" }}>
                      <Tag tone={st.cls === "st-on" ? "ok" : st.cls === "st-wait" ? "medium" : "outline"}>{st.text}</Tag>
                      <Tag>{p.mode}</Tag>
                    </Box>
                  </CardActionArea>
                </Card>
              );
            })}
          </Box>
        ) : (
          <Card><Empty>No projects yet. Create one to get a project key and the steps to connect your MCP server.</Empty></Card>
        )}
      <Typography sx={{ fontSize: 12, color: "text.secondary", mt: 2 }}>
        Guards running without a project key write to a local file: <Link href="#/local" color="inherit">local events</Link>.
      </Typography>
    </>
  );
}

export function NewProjectPage() {
  const { refreshProjects } = useApp();
  const [name, setName] = useState("");
  const [kind, setKind] = useState<ProjectKind>("middleware");
  const [error, setError] = useState("");
  const create = async () => {
    if (!name.trim()) return setError("Enter a name.");
    try {
      const p = await api<Project>("/api/projects", { method: "POST", body: { name: name.trim(), kind } });
      refreshProjects();
      location.hash = `#/p/${p.id}/setup`;
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <>
      <PageHead title="New project" sub="A project gets its own key, settings and request history." />
      <Card sx={{ p: { xs: 2, md: 3 }, maxWidth: 960 }}>
        <TextField autoFocus label="Project name" placeholder="e.g. Support tools server" value={name} onChange={(e) => { setName(e.target.value); setError(""); }}
          onKeyDown={(e) => e.key === "Enter" && create()} sx={{ width: "100%", maxWidth: 420 }} />
        <Label sx={{ mt: 3 }}>How is your MCP server built?</Label>
        <Box sx={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 1.25 }}>
          {(Object.entries(KINDS) as [ProjectKind, [string, string]][]).map(([k, [t, d]]) => (
            <ButtonBase key={k} onClick={() => setKind(k)} sx={{
              display: "block", textAlign: "left", p: 1.5, borderRadius: 2, border: "1px solid", bgcolor: "background.paper",
              borderColor: kind === k ? "text.primary" : "divider", boxShadow: kind === k ? "inset 0 0 0 1px" : "none", color: "text.primary",
            }}>
              <Typography sx={{ fontWeight: 600, mb: 0.5 }}>{t}</Typography>
              <Typography sx={{ fontSize: 12, color: "text.secondary" }}>{d}</Typography>
            </ButtonBase>
          ))}
        </Box>
        <Box sx={{ display: "flex", gap: 1.5, alignItems: "center", mt: 3 }}>
          <Button variant="contained" onClick={create}>Create project</Button>
          <Typography sx={{ color: "error.main", fontSize: 13 }}>{error}</Typography>
        </Box>
      </Card>
    </>
  );
}
