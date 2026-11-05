import { useState } from "react";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Link from "@mui/material/Link";
import InputLabel from "@mui/material/InputLabel";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import ArrowForwardIcon from "@mui/icons-material/ArrowForward";
import { api } from "../api";
import logo from "../assets/logo.png";
import { ThemeToggle } from "../components/ThemeToggle";
import { ACCENT, MONO } from "../theme";
import type { User } from "../types";

const eyebrowSx = { fontFamily: MONO, fontSize: 11, letterSpacing: "0.18em", textTransform: "uppercase", color: "text.secondary" } as const;

function Logo() {
  return (
    <Box sx={{ display: "flex", alignItems: "center", gap: 1.25 }}>
      <Box component="img" src={logo} alt="" sx={{ width: 34, height: 34 }} />
      <Box>
        <Typography sx={{ fontSize: 19, fontWeight: 800, letterSpacing: "-0.02em", lineHeight: 1.2 }}>MCPWatch</Typography>
        <Typography sx={{ fontFamily: MONO, fontSize: 10, letterSpacing: "0.14em", textTransform: "uppercase", color: "text.secondary" }}>MCP security guard</Typography>
      </Box>
    </Box>
  );
}

// The guard node stays dark brown in both themes.
const GUARD = { bg: "#2b1a12", text: "#fffaf4" };

function FlowNode({ label, children, active }: { label: string; children: React.ReactNode; active?: boolean }) {
  return (
    <Box sx={{ px: 2.25, py: 1.75, borderRadius: "14px", bgcolor: active ? GUARD.bg : "background.paper", color: active ? GUARD.text : "text.primary" }}>
      <Typography sx={{ ...eyebrowSx, fontSize: 10, letterSpacing: "0.12em", mb: 0.75, ...(active && { color: "secondary.main", fontWeight: 700 }) }}>{label}</Typography>
      {children}
    </Box>
  );
}

const VERDICTS = [["ALLOW", false], ["FLAG", false], ["BLOCK", true]] as const;
const flowText = { fontFamily: MONO, fontSize: 14, fontWeight: 500 };

// Client -> guard -> server, the one-line picture of what MCPWatch does.
function Flow() {
  const link = <Box sx={{ width: 26, height: "2px", bgcolor: "divider" }} />;
  return (
    <Box sx={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 1.25, mt: 4.5 }}>
      <FlowNode label="Client"><Typography sx={flowText}>tools/call</Typography></FlowNode>
      {link}
      <FlowNode label="MCPWatch" active>
        <Box sx={{ display: "flex", gap: 0.75 }}>
          {VERDICTS.map(([v, hot]) => (
            <Box key={v} sx={{
              fontFamily: MONO, fontSize: 10.5, fontWeight: 700, letterSpacing: "0.06em", px: 1, py: 0.25, borderRadius: 980, border: "1px solid",
              ...(hot ? { background: ACCENT, borderColor: "transparent", color: GUARD.bg } : { borderColor: v === "FLAG" ? "secondary.main" : "rgba(255,250,244,0.35)", color: v === "FLAG" ? "secondary.main" : GUARD.text }),
            }}>{v}</Box>
          ))}
        </Box>
      </FlowNode>
      {link}
      <FlowNode label="Server"><Typography sx={flowText}>mcp-server</Typography></FlowNode>
    </Box>
  );
}

export function AuthPage({ onSignedIn }: { onSignedIn: (u: User) => void }) {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const login = mode === "login";

  const submit = async (ev: React.FormEvent) => {
    ev.preventDefault();
    setBusy(true);
    try {
      const r = await api<{ user: User }>(`/api/auth/${mode}`, { method: "POST", body: { username, password } });
      onSignedIn(r.user);
    } catch (e) {
      setError((e as Error).message);
      setPassword("");
    } finally {
      setBusy(false);
    }
  };

  const labelSx = { fontSize: 14, fontWeight: 600, color: "text.primary", mb: 1 };
  const inputSx = { "& .MuiOutlinedInput-root": { height: 46, borderRadius: "12px", bgcolor: "rgba(var(--mui-palette-background-defaultChannel) / 0.6)" } };
  const bigButton = { height: 46, borderRadius: "12px", fontSize: 15, fontWeight: 600 };

  return (
    <Box sx={{ minHeight: "100vh", height: { md: "100dvh" }, display: "flex", flexDirection: "column", bgcolor: "background.paper", color: "text.primary" }}>
      <Box component="header" sx={{ display: "flex", alignItems: "center", justifyContent: "space-between", px: { xs: 2, md: 2.5 }, py: 1.5 }}>
        <Logo />
        <ThemeToggle />
      </Box>

      <Box component="main" sx={{
        flex: 1, minHeight: 0, overflowY: "auto", display: "grid", alignItems: "center", gap: { xs: 4, md: 6 }, mx: { xs: 1, md: 2.5 }, mb: { xs: 1, md: 2.5 },
        px: { xs: 2, md: 6, lg: 17.5 }, py: { xs: 4, md: 3 }, borderRadius: "24px", bgcolor: "background.default",
        gridTemplateColumns: { xs: "minmax(0, 1fr)", md: "minmax(0, 1fr) minmax(360px, 440px)" },
      }}>
        <Box sx={{ display: { xs: "none", md: "block" }, maxWidth: 540 }}>
          <Typography sx={{ ...eyebrowSx, color: "secondary.main" }}>Monitor · Configure · Protect</Typography>
          <Typography component="h1" sx={{ fontSize: { md: 44, lg: 56 }, fontWeight: 800, letterSpacing: "-0.045em", lineHeight: 1.05, mt: 2.5 }}>
            See every request that reaches your{" "}
            <Box component="span" sx={{ background: ACCENT, WebkitBackgroundClip: "text", backgroundClip: "text", color: "transparent" }}>MCP servers.</Box>
          </Typography>
          <Typography sx={{ color: "text.secondary", mt: 4, fontSize: 18, lineHeight: 1.55 }}>
            A guard sits between your clients and your server, checks each message against rules, and stops the suspicious ones.
          </Typography>
          <Flow />
        </Box>

        <Box component="form" onSubmit={submit} sx={{ bgcolor: "background.paper", borderRadius: "24px", px: { xs: 3, sm: 6.5 }, pt: { xs: 4, sm: 6 }, pb: login ? { xs: 6, sm: 9 } : { xs: 4, sm: 6 } }}>
          <Typography sx={eyebrowSx}>{login ? "Sign in" : "Sign up"}</Typography>
          <Typography component="h2" sx={{ fontSize: 34, fontWeight: 800, letterSpacing: "-0.04em", mt: 1.25 }}>{login ? "Welcome back" : "Create an account"}</Typography>
          <Typography sx={{ color: "text.secondary", mt: 1, mb: 3, fontSize: 15 }}>
            {login ? "Sign in to pick up where your guard left off." : "Set up a local account to start watching your servers."}
          </Typography>

          <InputLabel htmlFor="auth-username" sx={labelSx}>Username</InputLabel>
          <TextField id="auth-username" fullWidth autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} sx={inputSx} />

          <InputLabel htmlFor="auth-password" sx={{ ...labelSx, mt: 2.5 }}>Password</InputLabel>
          <TextField id="auth-password" fullWidth type="password" autoComplete={login ? "current-password" : "new-password"}
            value={password} onChange={(e) => setPassword(e.target.value)} helperText={login ? undefined : "At least 8 characters."} sx={inputSx} />

          {error && <Alert severity="error" sx={{ mt: 2 }}>{error}</Alert>}
          <Button type="submit" variant="contained" color="secondary" fullWidth disabled={busy} endIcon={<ArrowForwardIcon />} sx={{ ...bigButton, mt: login ? 4.5 : 3 }}>
            {login ? "Continue" : "Create account"}
          </Button>

          <Typography sx={{ mt: 3, textAlign: "center", fontSize: 14, color: "text.secondary" }}>
            {login ? "New here?" : "Already have an account?"}{" "}
            <Link component="button" type="button" onClick={() => { setMode(login ? "register" : "login"); setError(""); }}
              sx={{ font: "inherit", fontWeight: 600, color: "secondary.main", verticalAlign: "baseline" }}>
              {login ? "Create an account" : "Sign in"}
            </Link>
          </Typography>
        </Box>
      </Box>
    </Box>
  );
}
