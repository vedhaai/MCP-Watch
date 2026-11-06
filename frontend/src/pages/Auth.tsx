import { useEffect, useState } from "react";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Link from "@mui/material/Link";
import InputLabel from "@mui/material/InputLabel";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import useMediaQuery from "@mui/material/useMediaQuery";
import { keyframes, type Theme } from "@mui/material/styles";
import ArrowForwardIcon from "@mui/icons-material/ArrowForward";
import { api } from "../api";
import logo from "../assets/logo.png";
import { ThemeToggle } from "../components/ThemeToggle";
import { MONO } from "../theme";
import type { User } from "../types";

const eyebrowSx = { fontFamily: MONO, fontSize: 11, letterSpacing: "0.14em", textTransform: "uppercase", color: "text.secondary" } as const;

function Logo() {
  return (
    <Box sx={{ display: "flex", alignItems: "center", gap: 1.5 }}>
      <Box component="img" src={logo} alt="" sx={{ width: 40, height: 40 }} />
      <Typography sx={{ fontSize: 22, fontWeight: 700, letterSpacing: "-0.025em" }}>MCPWatch</Typography>
    </Box>
  );
}

type Verdict = "ALLOW" | "FLAG" | "BLOCK";

// Made-up guard traffic, played in a loop: the one-glance picture of what MCPWatch does.
const TRAFFIC: [string, string, Verdict][] = [
  ["tools/call", "search_docs", "ALLOW"],
  ["tools/list", "", "ALLOW"],
  ["tools/call", 'run_shell "rm -rf /"', "BLOCK"],
  ["resources/read", "file:///.env", "FLAG"],
  ["tools/call", "read_file report.md", "ALLOW"],
  ["tools/call", "send_email to=external", "FLAG"],
  ["prompts/get", "summarize", "ALLOW"],
  ["tools/call", "fetch_url http://169.254.169.254/", "BLOCK"],
  ["resources/list", "", "ALLOW"],
  ["tools/call", 'query_db "DROP TABLE logs"', "FLAG"],
  ["tools/call", "write_file ~/.ssh/authorized_keys", "BLOCK"],
  ["tools/call", "get_forecast", "ALLOW"],
];

const ROWS = 6, ROW_H = 48, TICK_MS = 2200;

type Row = { id: number; time: string; method: string; arg: string; verdict: Verdict };

const clock = (d: Date) => d.toTimeString().slice(0, 8);
const rowAt = (id: number, at: Date): Row => {
  const [method, arg, verdict] = TRAFFIC[id % TRAFFIC.length];
  return { id, time: clock(at), method, arg, verdict };
};

const slideIn = keyframes`from { transform: translateY(-${ROW_H}px); } to { transform: translateY(0); }`;
const popIn = keyframes`0% { opacity: 0; transform: scale(0.6); } 70% { opacity: 1; transform: scale(1.08); } 100% { transform: scale(1); }`;
const pulse = keyframes`0% { box-shadow: 0 0 0 0 rgba(236,106,44,0.55); } 100% { box-shadow: 0 0 0 7px rgba(236,106,44,0); }`;
const flash = keyframes`from { background-color: rgba(236,106,44,0.12); } to { background-color: transparent; }`;

const verdictSx = (v: Verdict) => (t: Theme) => ({
  fontFamily: MONO, fontSize: 11, fontWeight: 700, letterSpacing: "0.06em", px: 1, py: 0.375, borderRadius: "6px", border: "1px solid", flexShrink: 0,
  ...(v === "ALLOW" && { borderColor: "divider", color: "text.primary", bgcolor: "background.paper" }),
  ...(v === "BLOCK" && { borderColor: "transparent", color: "#fff", bgcolor: "#b8430f", ...t.applyStyles("dark", { bgcolor: "#ec6a2c", color: "#0e0d0c" }) }),
  ...(v === "FLAG" && {
    borderColor: "#f6cfae", color: "#b8430f", bgcolor: "#fde8d7",
    ...t.applyStyles("dark", { borderColor: "rgba(245,154,74,0.25)", color: "#f59a4a", bgcolor: "rgba(236,106,44,0.16)" }),
  }),
});

// Newest event on top: each tick the stack slides down one row, the new event enters from above,
// and the oldest falls out of the clipped window. Holds still for prefers-reduced-motion.
function LiveTraffic() {
  const still = useMediaQuery("(prefers-reduced-motion: reduce)");
  const [rows, setRows] = useState<Row[]>(() => {
    const now = Date.now();
    return Array.from({ length: ROWS }, (_, i) => rowAt(ROWS - 1 - i, new Date(now - i * TICK_MS)));
  });

  useEffect(() => {
    if (still) return;
    const timer = setInterval(() => setRows((r) => [rowAt(r[0].id + 1, new Date()), ...r].slice(0, ROWS + 1)), TICK_MS);
    return () => clearInterval(timer);
  }, [still]);

  const cell = { fontFamily: MONO, fontSize: 13 };
  const newest = rows[0].id;
  const moving = !still && rows.length > ROWS;
  return (
    <Box sx={{ mt: 5, bgcolor: "background.paper", border: "1px solid", borderColor: "divider", borderRadius: "14px", overflow: "hidden" }}>
      <Box sx={{ display: "flex", alignItems: "center", gap: 1, px: 2.25, py: 1.5, borderBottom: "1px solid", borderColor: "divider" }}>
        <Box sx={{ width: 7, height: 7, borderRadius: "50%", bgcolor: "secondary.main", animation: still ? "none" : `${pulse} 1.6s ease-out infinite` }} />
        <Typography sx={{ ...eyebrowSx, letterSpacing: "0.08em", color: "text.primary", flex: 1 }}>Live traffic</Typography>
        <Typography sx={{ ...cell, fontSize: 11.5, color: "text.secondary" }}>client → guard → mcp-server</Typography>
      </Box>
      <Box sx={{ height: ROWS * ROW_H - 1, overflow: "hidden" }}>
        {/* Keyed by the newest event so the slide replays on every tick. */}
        <Box key={newest} sx={{ animation: moving ? `${slideIn} 0.5s cubic-bezier(0.2, 0.8, 0.2, 1)` : "none" }}>
          {rows.map((row) => {
            const fresh = moving && row.id === newest;
            return (
              <Box key={row.id} sx={{
                display: "flex", alignItems: "center", gap: 3, px: 2.25, height: ROW_H, borderBottom: "1px solid", borderColor: "divider",
                animation: fresh ? `${flash} 1.6s ease-out` : "none",
              }}>
                <Typography sx={{ ...cell, color: "text.secondary", flexShrink: 0 }}>{row.time}</Typography>
                <Typography noWrap sx={{ ...cell, flex: 1, minWidth: 0 }}>
                  <Box component="span" sx={{ fontWeight: 600 }}>{row.method}</Box>
                  {row.arg && <Box component="span" sx={{ color: "text.secondary" }}> {row.arg}</Box>}
                </Typography>
                {/* The verdict lands a beat after the request, as if the guard just checked it. */}
                <Box sx={[verdictSx(row.verdict), fresh && { animation: `${popIn} 0.4s ease-out 0.45s both` }]}>{row.verdict}</Box>
              </Box>
            );
          })}
        </Box>
      </Box>
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

  const labelSx = { fontSize: 14, fontWeight: 500, color: "text.primary", mb: 1 };
  const inputSx = { "& .MuiOutlinedInput-root": { height: 46, borderRadius: "8px", bgcolor: "background.paper" } };

  return (
    <Box sx={{
      minHeight: "100vh", height: { md: "100dvh" }, display: "grid", bgcolor: "background.paper", color: "text.primary",
      gridTemplateColumns: { xs: "minmax(0, 1fr)", md: "40% 60%" },
    }}>
      <Box sx={{ display: "flex", flexDirection: "column", px: { xs: 2, sm: 7, md: 4, lg: 7 }, py: { xs: 3, sm: 5 }, minHeight: 0, minWidth: 0, overflowY: "auto", "& > *": { width: "100%", maxWidth: 440, mx: "auto" } }}>
        <Box component="header" sx={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <Logo />
          <ThemeToggle sx={{ width: 44, height: 44, borderRadius: "10px" }} />
        </Box>

        <Box component="form" onSubmit={submit} sx={{ flex: 1, display: "flex", flexDirection: "column", justifyContent: "center", py: 6 }}>
          <Typography component="h1" sx={{ fontSize: 32, fontWeight: 700, letterSpacing: "-0.035em", lineHeight: 1.15 }}>{login ? "Sign in" : "Create an account"}</Typography>
          <Typography sx={{ color: "text.secondary", mt: 1, mb: 4, fontSize: 15 }}>
            {login ? "Pick up where your guard left off." : "Set up a local account to start watching your servers."}
          </Typography>

          <InputLabel htmlFor="auth-username" sx={labelSx}>Username</InputLabel>
          <TextField id="auth-username" fullWidth autoComplete="username" placeholder="you@company.com" value={username} onChange={(e) => setUsername(e.target.value)} sx={inputSx} />

          <InputLabel htmlFor="auth-password" sx={{ ...labelSx, mt: 2.5 }}>Password</InputLabel>
          <TextField id="auth-password" fullWidth type="password" autoComplete={login ? "current-password" : "new-password"} placeholder="••••••••"
            value={password} onChange={(e) => setPassword(e.target.value)} helperText={login ? undefined : "At least 8 characters."} sx={inputSx} />

          {error && <Alert severity="error" sx={{ mt: 2 }}>{error}</Alert>}
          <Button type="submit" variant="contained" color="primary" fullWidth disabled={busy} endIcon={<ArrowForwardIcon sx={{ fontSize: "18px !important" }} />}
            sx={{ height: 48, borderRadius: "8px", fontSize: 15, fontWeight: 600, mt: 3.5 }}>
            {login ? "Continue" : "Create account"}
          </Button>

          <Typography sx={{ mt: 3, textAlign: "center", fontSize: 14, color: "text.secondary" }}>
            {login ? "New to MCPWatch?" : "Already have an account?"}{" "}
            <Link component="button" type="button" onClick={() => { setMode(login ? "register" : "login"); setError(""); }}
              sx={{ font: "inherit", fontWeight: 600, color: "text.primary", textDecorationColor: "currentColor", textUnderlineOffset: 3, verticalAlign: "baseline" }}>
              {login ? "Create an account" : "Sign in"}
            </Link>
          </Typography>
        </Box>

        <Box component="footer" sx={{ display: "flex", justifyContent: "space-between", fontFamily: MONO, fontSize: 11, letterSpacing: "0.06em", textTransform: "uppercase", color: "text.secondary" }}>
          <span>MCP security guard</span>
          <span>v{__APP_VERSION__}</span>
        </Box>
      </Box>

      <Box component="aside" sx={{
        display: { xs: "none", md: "flex" }, alignItems: "center", m: 2, ml: 0, px: { md: 8, lg: 12 }, minHeight: 0, overflowY: "auto",
        bgcolor: "background.default", border: "1px solid", borderColor: "divider", borderRadius: "20px",
      }}>
        <Box sx={{ maxWidth: 640, width: "100%" }}>
          <Typography sx={eyebrowSx}>Monitor · Configure · Protect</Typography>
          <Typography component="h2" sx={{ fontSize: { md: 36, lg: 42 }, fontWeight: 700, letterSpacing: "-0.035em", lineHeight: 1.08, mt: 2, maxWidth: 520 }}>
            See every request that reaches your MCP servers.
          </Typography>
          <Typography sx={{ color: "text.secondary", mt: 3, fontSize: 16, lineHeight: 1.6, maxWidth: 540 }}>
            A guard sits between your clients and your server, checks each message against your rules, and stops the suspicious ones.
          </Typography>
          <LiveTraffic />
        </Box>
      </Box>
    </Box>
  );
}
