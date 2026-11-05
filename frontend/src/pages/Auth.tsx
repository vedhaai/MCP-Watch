import { useState } from "react";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import Link from "@mui/material/Link";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import { api } from "../api";
import { ThemeToggle } from "../components/ThemeToggle";
import { MONO } from "../theme";
import type { User } from "../types";

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

  return (
    <Box sx={{ minHeight: "100vh", display: "grid", placeItems: "center", px: 2, py: 3 }}>
      <Box sx={{ width: "100%", maxWidth: 380 }}>
        <Box sx={{ mb: 3, display: "flex", alignItems: "center" }}>
          <Box sx={{ flex: 1 }}>
            <Typography sx={{ fontSize: 20, fontWeight: 800, letterSpacing: "-0.02em" }}>MCPWatch</Typography>
            <Typography sx={{ fontFamily: MONO, fontSize: 10, letterSpacing: "0.14em", color: "text.secondary", textTransform: "uppercase" }}>MCP security guard</Typography>
          </Box>
          <ThemeToggle />
        </Box>
        <Card component="form" onSubmit={submit} sx={{ p: 3 }}>
          <Typography sx={{ fontSize: 24, fontWeight: 700, letterSpacing: "-0.02em" }}>{login ? "Sign in" : "Create account"}</Typography>
          <Typography sx={{ color: "text.secondary", mt: 0.5, mb: 2.5 }}>See every request that reaches your MCP servers, and stop the suspicious ones.</Typography>
          <TextField fullWidth autoFocus label="Username" autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} />
          <TextField fullWidth sx={{ mt: 2 }} label="Password" type="password" autoComplete={login ? "current-password" : "new-password"}
            value={password} onChange={(e) => setPassword(e.target.value)} helperText={login ? undefined : "At least 8 characters."} />
          {error && <Alert severity="error" sx={{ mt: 2 }}>{error}</Alert>}
          <Button type="submit" variant="contained" fullWidth size="large" disabled={busy} sx={{ mt: 2.5 }}>{login ? "Sign in" : "Create account"}</Button>
          <Typography sx={{ textAlign: "center", fontSize: 13, color: "text.secondary", mt: 2 }}>
            {login ? "No account yet? " : "Already have an account? "}
            <Link component="button" type="button" color="inherit" onClick={() => { setMode(login ? "register" : "login"); setError(""); }}>
              {login ? "Create one" : "Sign in"}
            </Link>
          </Typography>
        </Card>
      </Box>
    </Box>
  );
}
