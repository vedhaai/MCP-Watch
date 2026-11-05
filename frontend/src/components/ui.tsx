import { useState, type ReactNode } from "react";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import Typography from "@mui/material/Typography";
import type { SxProps, Theme } from "@mui/material/styles";
import { MONO } from "../theme";
import type { Action, Severity } from "../types";

// Small uppercase monospace heading, used for section and stat labels.
export function Label({ children, sx }: { children: ReactNode; sx?: SxProps<Theme> }) {
  return (
    <Typography component="div" sx={{ fontFamily: MONO, fontSize: 11, letterSpacing: "0.08em", textTransform: "uppercase", color: "text.secondary", fontWeight: 500, mb: 1, ...sx }}>
      {children}
    </Typography>
  );
}

export type Tone = "high" | "medium" | "low" | "ok" | "outline" | "dark";

const TONES: Record<Tone, SxProps<Theme>> = {
  high: { bgcolor: "error.main", color: "#fff", borderColor: "error.main" },
  medium: { color: "warning.main", borderColor: "warning.main" },
  low: { color: "text.secondary", borderColor: "divider", bgcolor: "action.hover" },
  ok: { color: "success.main", borderColor: "success.main" },
  outline: { color: "text.secondary", borderColor: "divider" },
  dark: { bgcolor: "text.primary", color: "background.paper", borderColor: "text.primary" },
};

// A compact status tag (BLOCK, MW001, SCORE 12...).
export function Tag({ tone = "outline", children, title, sx }: { tone?: Tone; children: ReactNode; title?: string; sx?: SxProps<Theme> }) {
  return (
    <Box component="span" title={title} sx={{
      display: "inline-flex", alignItems: "center", gap: 0.5, px: 0.875, py: "1px", borderRadius: 1, border: "1px solid",
      fontFamily: MONO, fontSize: 11, fontWeight: 600, letterSpacing: "0.04em", textTransform: "uppercase", whiteSpace: "nowrap", lineHeight: 1.6,
      ...TONES[tone], ...sx,
    } as SxProps<Theme>}>
      {children}
    </Box>
  );
}

export const severityTone = (s: Severity | undefined): Tone => (s === "high" ? "high" : s === "medium" ? "medium" : "low");
export const actionTone = (a: Action): Tone =>
  a === "block" || a === "strip" ? "high" : a === "throttle" || a === "redact" ? "medium" : "ok";

export function Stat({ n, label, hot }: { n: ReactNode; label: string; hot?: boolean }) {
  return (
    <Card sx={{ px: 2.25, py: 2 }}>
      <Typography sx={{ fontSize: 30, fontWeight: 600, letterSpacing: "-0.02em", lineHeight: 1.1, fontVariantNumeric: "tabular-nums", color: hot ? "error.main" : "text.primary" }}>{n}</Typography>
      <Label sx={{ mt: 0.5, mb: 0, fontSize: 10.5 }}>{label}</Label>
    </Card>
  );
}

export function Stats({ children, min = 130 }: { children: ReactNode; min?: number }) {
  return <Box sx={{ display: "grid", gridTemplateColumns: `repeat(auto-fit, minmax(${min}px, 1fr))`, gap: 1.25, mb: 2 }}>{children}</Box>;
}

export function Code({ children }: { children: ReactNode }) {
  return (
    <Box component="pre" sx={{
      bgcolor: "background.default", border: "1px solid", borderColor: "divider", borderRadius: 1.5, px: 1.5, py: 1.25, my: 0.75,
      fontFamily: MONO, fontSize: 12, whiteSpace: "pre-wrap", wordBreak: "break-all",
    }}>
      {children}
    </Box>
  );
}

export function CopyBlock({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    await navigator.clipboard.writeText(text).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  };
  return (
    <Box sx={{ position: "relative", "& pre": { pr: 9 } }}>
      <Button size="small" variant="outlined" color="inherit" onClick={copy} sx={{ position: "absolute", top: 8, right: 8, py: 0, minWidth: 0, bgcolor: "background.paper" }}>
        {copied ? "Copied" : "Copy"}
      </Button>
      <Code>{text}</Code>
    </Box>
  );
}

export function PageHead({ title, sub, actions }: { title: ReactNode; sub?: ReactNode; actions?: ReactNode }) {
  return (
    <Box sx={{ display: "flex", alignItems: "flex-end", gap: 2, mb: 3, flexWrap: "wrap" }}>
      <Box>
        <Typography variant="h1">{title}</Typography>
        {sub && <Box sx={{ color: "text.secondary", mt: 0.75, display: "flex", gap: 1, alignItems: "center", flexWrap: "wrap" }}>{sub}</Box>}
      </Box>
      {actions && <Box sx={{ ml: "auto", display: "flex", gap: 1 }}>{actions}</Box>}
    </Box>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <Box sx={{ p: 3.5, textAlign: "center", color: "text.secondary" }}>{children}</Box>;
}

// A yes/no dialog: `ask(text)` resolves to true when confirmed.
export function useConfirm() {
  const [state, setState] = useState<{ text: string; done: (ok: boolean) => void } | null>(null);
  const ask = (text: string) => new Promise<boolean>((done) => setState({ text, done }));
  const close = (ok: boolean) => {
    state?.done(ok);
    setState(null);
  };
  const dialog = (
    <Dialog open={!!state} onClose={() => close(false)} maxWidth="xs" fullWidth>
      <DialogTitle sx={{ fontWeight: 700 }}>Are you sure?</DialogTitle>
      <DialogContent><Typography color="text.secondary">{state?.text}</Typography></DialogContent>
      <DialogActions sx={{ px: 3, pb: 2 }}>
        <Button color="inherit" onClick={() => close(false)}>Cancel</Button>
        <Button variant="contained" color="error" onClick={() => close(true)}>Continue</Button>
      </DialogActions>
    </Dialog>
  );
  return { ask, dialog };
}
