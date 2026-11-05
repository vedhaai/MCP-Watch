import { useEffect, useMemo, useState, type ReactNode } from "react";
import Avatar from "@mui/material/Avatar";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import ButtonBase from "@mui/material/ButtonBase";
import Dialog from "@mui/material/Dialog";
import InputBase from "@mui/material/InputBase";
import List from "@mui/material/List";
import ListItemButton from "@mui/material/ListItemButton";
import ListItemIcon from "@mui/material/ListItemIcon";
import ListItemText from "@mui/material/ListItemText";
import Menu from "@mui/material/Menu";
import MenuItem from "@mui/material/MenuItem";
import Select from "@mui/material/Select";
import Typography from "@mui/material/Typography";
import AddIcon from "@mui/icons-material/Add";
import ArticleOutlinedIcon from "@mui/icons-material/ArticleOutlined";
import CableIcon from "@mui/icons-material/Cable";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import FolderOutlinedIcon from "@mui/icons-material/FolderOutlined";
import LogoutIcon from "@mui/icons-material/Logout";
import PeopleIcon from "@mui/icons-material/People";
import SearchIcon from "@mui/icons-material/Search";
import SettingsOutlinedIcon from "@mui/icons-material/SettingsOutlined";
import ShowChartIcon from "@mui/icons-material/ShowChart";
import { useColorScheme } from "@mui/material/styles";
import { useApp } from "../context";
import { THEME_MODES, ThemeToggle } from "./ThemeToggle";
import { MONO } from "../theme";

const SIDEBAR = 232;
export const PROJECT_TABS = [
  ["requests", "Requests", <ShowChartIcon fontSize="small" />],
  ["clients", "Clients", <PeopleIcon fontSize="small" />],
  ["setup", "Setup", <CableIcon fontSize="small" />],
  ["settings", "Settings", <SettingsOutlinedIcon fontSize="small" />],
] as const;

interface NavItem { label: string; href: string; icon: ReactNode; active: boolean; disabled?: boolean }

function NavGroup({ title, items }: { title: string; items: NavItem[] }) {
  return (
    <>
      <Typography sx={{ fontFamily: MONO, fontSize: 10.5, letterSpacing: "0.1em", textTransform: "uppercase", color: "text.secondary", fontWeight: 600, px: 1, pt: 1.75, pb: 0.75 }}>
        {title}
      </Typography>
      {items.map((it) => (
        <ListItemButton key={it.label} component="a" href={it.href} selected={it.active} disabled={it.disabled} sx={{
          borderRadius: 1.5, py: 0.75, px: 1.25, mb: 0.25, position: "relative",
          "&.Mui-selected, &.Mui-selected:hover": { bgcolor: "primary.main", color: "primary.contrastText", "& .MuiListItemIcon-root": { color: "inherit" } },
          "&.Mui-selected::before": { content: '""', position: "absolute", left: 0, top: 5, bottom: 5, width: 3, borderRadius: 2, bgcolor: "error.main" },
        }}>
          <ListItemIcon sx={{ minWidth: 30, color: "text.primary" }}>{it.icon}</ListItemIcon>
          <ListItemText primary={it.label} />
        </ListItemButton>
      ))}
    </>
  );
}

// The page frame after sign-in: sidebar, top bar with search, project switcher and New project.
export function Shell({ route, projectId, children }: { route: string[]; projectId: string | undefined; children: ReactNode }) {
  const { user, projects, signOut } = useApp();
  const [menu, setMenu] = useState<HTMLElement | null>(null);
  const [palette, setPalette] = useState(false);
  const tab = route[0] === "p" ? route[2] ?? "requests" : "";

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPalette((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const project = projectId ? `#/p/${projectId}` : "";
  const monitor: NavItem[] = PROJECT_TABS.slice(0, 2).map(([k, l, icon]) => ({ label: l, href: `${project}/${k}`, icon, active: tab === k, disabled: !projectId }));
  const configure: NavItem[] = PROJECT_TABS.slice(2).map(([k, l, icon]) => ({ label: l, href: `${project}/${k}`, icon, active: tab === k, disabled: !projectId }));
  const workspace: NavItem[] = [
    { label: "Projects", href: "#/", icon: <FolderOutlinedIcon fontSize="small" />, active: route.length === 0 || route[0] === "new" },
    { label: "Local events", href: "#/local", icon: <ArticleOutlinedIcon fontSize="small" />, active: route[0] === "local" },
  ];

  return (
    <Box sx={{ display: "grid", gridTemplateColumns: { xs: "minmax(0, 1fr)", md: `${SIDEBAR}px minmax(0, 1fr)` }, minHeight: "100vh" }}>
      <Box component="aside" sx={{ minWidth: 0,
        bgcolor: "background.paper", borderRight: { md: "1px solid" }, borderBottom: { xs: "1px solid", md: 0 }, borderColor: "divider",
        display: "flex", flexDirection: "column", position: { md: "sticky" }, top: 0, height: { md: "100vh" },
      }}>
        <Box component="a" href="#/" sx={{ display: "block", px: 2.25, pt: 2.25, pb: 1, color: "inherit", textDecoration: "none" }}>
          <Typography sx={{ fontSize: 18, fontWeight: 800, letterSpacing: "-0.02em", lineHeight: 1.2 }}>MCPWatch</Typography>
          <Typography sx={{ fontFamily: MONO, fontSize: 10, letterSpacing: "0.14em", color: "text.secondary", textTransform: "uppercase" }}>MCP security guard</Typography>
        </Box>
        <List component="nav" sx={{
          flex: 1, overflowY: "auto", px: 1.25, pt: 0, pb: 1.5,
          display: { xs: "flex", md: "block" }, gap: { xs: 0.5, md: 0 }, overflowX: { xs: "auto", md: "hidden" },
          "& > p": { display: { xs: "none", md: "block" } }, "& .MuiListItemButton-root": { flex: { xs: "none", md: "initial" } },
        }}>
          <NavGroup title="Monitor" items={monitor} />
          <NavGroup title="Configure" items={configure} />
          <NavGroup title="Workspace" items={workspace} />
        </List>
        <Box sx={{ borderTop: "1px solid", borderColor: "divider", p: 1.5, display: { xs: "none", md: "block" } }}>
          <ButtonBase onClick={(e) => setMenu(e.currentTarget)} sx={{ width: "100%", justifyContent: "flex-start", gap: 1.25, p: 0.5, borderRadius: 1.5, "&:hover": { bgcolor: "action.hover" } }}>
            <Avatar variant="rounded" sx={{ width: 28, height: 28, fontSize: 13, fontWeight: 700, bgcolor: "primary.main", color: "primary.contrastText" }}>
              {user.username.slice(0, 1).toUpperCase()}
            </Avatar>
            <Typography sx={{ flex: 1, textAlign: "left", fontWeight: 600 }} noWrap>{user.username}</Typography>
            <ExpandMoreIcon fontSize="small" />
          </ButtonBase>
          <Menu anchorEl={menu} open={!!menu} onClose={() => setMenu(null)} anchorOrigin={{ vertical: "top", horizontal: "left" }} transformOrigin={{ vertical: "bottom", horizontal: "left" }}>
            <MenuItem onClick={() => { setMenu(null); signOut(); }}><LogoutIcon fontSize="small" sx={{ mr: 1 }} />Sign out</MenuItem>
          </Menu>
        </Box>
      </Box>

      <Box sx={{ minWidth: 0, display: "flex", flexDirection: "column" }}>
        <Box sx={{ display: "flex", alignItems: "center", gap: 2, px: { xs: 2, md: 3.5 }, py: 1.5, borderBottom: "1px solid", borderColor: "divider", bgcolor: "background.default", position: { md: "sticky" }, top: 0, zIndex: 5, flexWrap: { xs: "wrap", sm: "nowrap" } }}>
          <ButtonBase onClick={() => setPalette(true)} sx={{
            flex: 1, maxWidth: 520, justifyContent: "flex-start", gap: 1.25, px: 1.5, py: 1, border: "1px solid", borderColor: "divider",
            borderRadius: 2, bgcolor: "background.paper", color: "text.secondary",
          }}>
            <SearchIcon fontSize="small" />
            <Box component="span" sx={{ flex: 1, textAlign: "left" }}>Jump to a page, project or action</Box>
            <Box component="kbd" sx={{ fontFamily: MONO, fontSize: 11, border: "1px solid", borderColor: "divider", borderRadius: 1, px: 0.75, display: { xs: "none", sm: "block" } }}>Ctrl K</Box>
          </ButtonBase>
          <Box sx={{ flex: { xs: 1, sm: "none" }, ml: { sm: "auto" } }}>
            <Select
              value={projectId && projects?.some((p) => p.id === projectId) ? projectId : ""}
              displayEmpty
              onChange={(e) => (location.hash = `#/p/${e.target.value}/${tab || "requests"}`)}
              renderValue={(v) => projects?.find((p) => p.id === v)?.name ?? <Box component="span" sx={{ color: "text.secondary" }}>Select a project</Box>}
              sx={{ minWidth: { sm: 220 }, width: { xs: "100%", sm: "auto" }, fontWeight: 600, bgcolor: "background.paper" }}
            >
              {(projects ?? []).map((p) => <MenuItem key={p.id} value={p.id}>{p.name}</MenuItem>)}
            </Select>
          </Box>
          <ThemeToggle />
          <Button variant="contained" startIcon={<AddIcon />} href="#/new">New project</Button>
        </Box>
        <Box component="main" sx={{ px: { xs: 2, md: 4 }, pt: { xs: 2.5, md: 3.5 }, pb: 5, maxWidth: 1440, width: "100%" }}>{children}</Box>
      </Box>
      <CommandPalette open={palette} onClose={() => setPalette(false)} projectId={projectId} />
    </Box>
  );
}

interface Command { label: string; hint: string; run: () => void }

function CommandPalette({ open, onClose, projectId }: { open: boolean; onClose: () => void; projectId: string | undefined }) {
  const { projects, signOut } = useApp();
  const { setMode } = useColorScheme();
  const [q, setQ] = useState("");
  const [at, setAt] = useState(0);
  const go = (hash: string) => () => (location.hash = hash);
  const current = projects?.find((p) => p.id === projectId);

  const all = useMemo<Command[]>(() => [
    ...(current ? PROJECT_TABS.map(([k, l]) => ({ label: `${current.name}: ${l}`, hint: "page", run: go(`#/p/${current.id}/${k}`) })) : []),
    { label: "Projects", hint: "page", run: go("#/") },
    { label: "Local events", hint: "page", run: go("#/local") },
    { label: "New project", hint: "action", run: go("#/new") },
    ...(projects ?? []).filter((p) => p.id !== projectId).map((p) => ({ label: p.name, hint: "project", run: go(`#/p/${p.id}/requests`) })),
    ...THEME_MODES.map(([m, l]) => ({ label: `Theme: ${l}`, hint: "theme", run: () => setMode(m) })),
    { label: "Sign out", hint: "action", run: signOut },
  ], [projects, projectId, setMode]);
  const list = all.filter((c) => c.label.toLowerCase().includes(q.trim().toLowerCase()));

  useEffect(() => {
    if (open) { setQ(""); setAt(0); }
  }, [open]);

  const pick = (c: Command | undefined) => {
    if (!c) return;
    onClose();
    c.run();
  };

  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="sm" sx={{ "& .MuiDialog-container": { alignItems: "flex-start", pt: "12vh" } }}>
      <InputBase
        autoFocus
        fullWidth
        placeholder="Jump to a page, project or action"
        value={q}
        onChange={(e) => { setQ(e.target.value); setAt(0); }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") { e.preventDefault(); setAt((i) => Math.min(i + 1, list.length - 1)); }
          if (e.key === "ArrowUp") { e.preventDefault(); setAt((i) => Math.max(i - 1, 0)); }
          if (e.key === "Enter") pick(list[at]);
        }}
        sx={{ px: 2, py: 1.5, fontSize: 15, borderBottom: "1px solid", borderColor: "divider" }}
      />
      <List sx={{ p: 0.75, maxHeight: "50vh", overflowY: "auto" }}>
        {list.map((c, i) => (
          <ListItemButton key={c.label + c.hint} selected={i === at} onMouseEnter={() => setAt(i)} onClick={() => pick(c)} sx={{
            borderRadius: 1.5, "&.Mui-selected, &.Mui-selected:hover": { bgcolor: "primary.main", color: "primary.contrastText" },
          }}>
            <ListItemText primary={c.label} />
            <Typography sx={{ fontFamily: MONO, fontSize: 11, opacity: 0.6 }}>{c.hint}</Typography>
          </ListItemButton>
        ))}
        {!list.length && <Typography sx={{ p: 2, color: "text.secondary" }}>Nothing matches.</Typography>}
      </List>
    </Dialog>
  );
}
