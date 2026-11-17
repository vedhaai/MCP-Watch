import { useState } from "react";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import Checkbox from "@mui/material/Checkbox";
import Collapse from "@mui/material/Collapse";
import Divider from "@mui/material/Divider";
import FormControlLabel from "@mui/material/FormControlLabel";
import MenuItem from "@mui/material/MenuItem";
import Radio from "@mui/material/Radio";
import RadioGroup from "@mui/material/RadioGroup";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import { api } from "../api";
import { Label, useConfirm } from "../components/ui";
import { useApp } from "../context";
import { AI_CHOICES, AI_PROVIDERS, MODES, isHostedUrl } from "../lib";
import type { AiProvider, Mode, Project, Severity } from "../types";

const list = (s: string) => s.split(",").map((x) => x.trim()).filter(Boolean);
const Note = ({ children }: { children: React.ReactNode }) => <Typography sx={{ fontSize: 12, color: "text.secondary", mt: 0.75 }}>{children}</Typography>;

function Choice({ value, title, text }: { value: string; title: string; text: string }) {
  return (
    <FormControlLabel value={value} control={<Radio size="small" />} sx={{ alignItems: "flex-start", my: 0.5, "& .MuiRadio-root": { pt: 0.25 } }}
      label={<span><b>{title}</b> <Box component="span" sx={{ color: "text.secondary" }}>— {text}</Box></span>} />
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return <Box sx={{ mt: 3, "&:first-of-type": { mt: 0 } }}><Label>{title}</Label>{children}</Box>;
}

// Form state is taken from the project once; polling elsewhere doesn't overwrite what's being typed.
export function SettingsTab({ project: p, onChange }: { project: Project; onChange: (p: Project) => void }) {
  const { refreshProjects } = useApp();
  const confirm = useConfirm();
  const [mode, setMode] = useState<Mode>(p.mode);
  const [windowSeconds, setWindow] = useState(String(p.windowSeconds));
  const [throttleAt, setThrottle] = useState(String(p.throttleAt));
  const [blockAt, setBlock] = useState(String(p.blockAt));
  const [deny, setDeny] = useState(p.denyTools.join(", "));
  const [origins, setOrigins] = useState((p.allowedOrigins ?? []).join(", "));
  const [requireAuth, setRequireAuth] = useState(p.requireAuth);
  const [audience, setAudience] = useState(p.expectedAudience ?? "");
  const [provider, setProvider] = useState<AiProvider>(p.ai.provider);
  const [local, setLocal] = useState({ url: p.ai.provider === "local" ? p.ai.url : "", model: p.ai.provider === "local" ? p.ai.model : "" });
  const [remote, setRemote] = useState({ url: p.ai.provider === "api" ? p.ai.url : "", model: p.ai.provider === "api" ? p.ai.model : "", apiKey: "" });
  const [preset, setPreset] = useState(String(Math.max(0, AI_PROVIDERS.findIndex(([, url]) => p.ai.provider === "api" && url === p.ai.url))));
  const [aiResult, setAiResult] = useState("");
  const [saved, setSaved] = useState("");
  const [name, setName] = useState(p.name);
  const [alertsOn, setAlertsOn] = useState(p.alerts.enabled);
  const [minSeverity, setMinSeverity] = useState<Severity>(p.alerts.minSeverity);
  const [onBlock, setOnBlock] = useState(p.alerts.onBlock);
  const [cooldown, setCooldown] = useState(String(Math.round(p.alerts.cooldownSeconds / 60)));
  const [emails, setEmails] = useState(p.alerts.emails.join(", "));
  // URLs and the secret are never sent to the browser: empty means "keep the saved one".
  const [hooks, setHooks] = useState({ slackUrl: "", webhookUrl: "", webhookSecret: "", smtpPass: "" });
  const [smtp, setSmtp] = useState({ smtpHost: p.alerts.smtpHost, smtpPort: String(p.alerts.smtpPort), smtpSecure: p.alerts.smtpSecure, smtpUser: p.alerts.smtpUser, smtpFrom: p.alerts.smtpFrom });
  const [alertResult, setAlertResult] = useState("");
  const noHooks = { slackUrl: "", webhookUrl: "", webhookSecret: "", smtpPass: "" };

  const alertsForm = () => ({
    enabled: alertsOn, minSeverity, onBlock, cooldownSeconds: Math.max(0, Number(cooldown) || 0) * 60, emails: list(emails), ...hooks,
    ...smtp, smtpPort: Number(smtp.smtpPort) || 587,
  });

  const testAlerts = async () => {
    setAlertResult("Sending…");
    try {
      const r = await api<{ results: { channel: string; ok: boolean; error?: string }[] }>(`/api/projects/${p.id}/alerts-test`, { method: "POST", body: alertsForm() });
      setAlertResult(r.results.length ? r.results.map((x) => `${x.channel}: ${x.ok ? "sent" : `failed (${x.error})`}`).join(" · ") : "Nothing to send to yet: add an email, Slack or webhook URL.");
    } catch (e) {
      setAlertResult((e as Error).message);
    }
  };

  const clearChannel = async (body: { clearSlack?: boolean; clearWebhook?: boolean; clearSmtp?: boolean }) => {
    try {
      // Removing email also drops its recipients, which can't be saved without a server.
      const emailGone = body.clearSmtp ? { emails: [] as string[] } : {};
      onChange(await api<Project>(`/api/projects/${p.id}`, { method: "PATCH", body: { alerts: { ...alertsForm(), ...noHooks, ...emailGone, ...body } } }));
      setHooks(noHooks);
      if (body.clearSmtp) {
        setEmails("");
        setSmtp({ smtpHost: "", smtpPort: "587", smtpSecure: false, smtpUser: "", smtpFrom: "" });
      }
    } catch (e) {
      setAlertResult((e as Error).message);
    }
  };

  // Projects saved before the consent existed have none and keep working, so an API project shows it as given.
  const [consent, setConsent] = useState(p.ai.hostedConsent ?? p.ai.provider === "api");
  // Message text leaves the guard's machine: any API provider, or a "local" server at another address.
  const hosted = provider === "api" ? isHostedUrl(remote.url) : provider === "local" && !!local.url.trim() && isHostedUrl(local.url);

  const aiForm = () =>
    provider === "local" ? { provider, ...local, hostedConsent: consent } : provider === "api" ? { provider, ...remote, hostedConsent: consent } : { provider };

  const testAi = async () => {
    setAiResult("Testing… (a local model may take a while to load)");
    try {
      const r = await api<{ message?: string; ok: boolean; error?: string; model: string; ms: number; caught: boolean }>(
        `/api/projects/${p.id}/ai-test`, { method: "POST", body: aiForm() });
      setAiResult(r.message ? r.message
        : !r.ok ? `Failed: ${r.error}`
        : `${r.model} answered in ${r.ms} ms and ${r.caught ? "caught" : "missed"} a sample command injection. ${r.caught ? "" : "It works, but consider a stronger model."}`);
    } catch (e) {
      setAiResult((e as Error).message);
    }
  };

  const save = async () => {
    try {
      onChange(await api<Project>(`/api/projects/${p.id}`, { method: "PATCH", body: {
        mode, windowSeconds, throttleAt, blockAt,
        denyTools: list(deny), allowedOrigins: list(origins), requireAuth, ai: aiForm(), expectedAudience: audience, alerts: alertsForm(),
      } }));
      setRemote((r) => ({ ...r, apiKey: "" }));
      setHooks(noHooks);
      setSaved("Saved.");
      refreshProjects();
    } catch (e) {
      setSaved((e as Error).message);
    }
  };

  const rename = async () => {
    onChange(await api<Project>(`/api/projects/${p.id}`, { method: "PATCH", body: { name } }));
    refreshProjects();
  };
  const rotate = async () => {
    if (!(await confirm.ask("Rotate the project key? Guards using the old key stop reporting until updated."))) return;
    await api(`/api/projects/${p.id}/rotate-key`, { method: "POST" });
    location.hash = `#/p/${p.id}/setup`;
  };
  const clear = async () => {
    if (!(await confirm.ask("Delete all stored requests for this project?"))) return;
    await api(`/api/projects/${p.id}/events`, { method: "DELETE" });
    location.hash = `#/p/${p.id}/requests`;
  };
  const remove = async () => {
    if (!(await confirm.ask(`Delete project "${p.name}" and its requests? Guards using its key stop reporting.`))) return;
    await api(`/api/projects/${p.id}`, { method: "DELETE" });
    refreshProjects();
    location.hash = "#/";
  };

  return (
    <Box sx={{ maxWidth: 860 }}>
      <Card sx={{ p: { xs: 2, md: 3 }, mb: 2 }}>
        <Section title="Mode">
          <RadioGroup value={mode} onChange={(e) => setMode(e.target.value as Mode)}>
            {Object.entries(MODES).map(([m, d]) => <Choice key={m} value={m} title={m} text={d} />)}
          </RadioGroup>
        </Section>

        <Section title="Scoring">
          <Box sx={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 1.5 }}>
            <TextField label="Window (seconds)" type="number" value={windowSeconds} onChange={(e) => setWindow(e.target.value)} slotProps={{ htmlInput: { min: 1 } }} />
            <TextField label="Throttle at score" type="number" value={throttleAt} onChange={(e) => setThrottle(e.target.value)} slotProps={{ htmlInput: { min: 1 } }} />
            <TextField label="Block at score" type="number" value={blockAt} onChange={(e) => setBlock(e.target.value)} slotProps={{ htmlInput: { min: 1 } }} />
          </Box>
          <TextField fullWidth sx={{ mt: 2 }} label="Denied tools (comma separated)" placeholder="e.g. run_command, delete_file" value={deny} onChange={(e) => setDeny(e.target.value)} />
        </Section>

        <Section title="AI review">
          <Note>An AI model can review every message on top of the rules. It can only add findings, never clear a rule's. If the model is down or too slow, the rules alone decide.</Note>
          <RadioGroup value={provider} onChange={(e) => { setProvider(e.target.value as AiProvider); setAiResult(""); }} sx={{ mt: 1 }}>
            {Object.entries(AI_CHOICES).map(([v, [title, d]]) => <Choice key={v} value={v} title={title} text={d} />)}
          </RadioGroup>
          <Collapse in={provider === "local"}>
            <Box sx={{ ml: 3.5, mt: 1 }}>
              <Box sx={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 1.5 }}>
                <TextField label="Server URL" placeholder="http://127.0.0.1:11434/v1 (Ollama)" value={local.url} onChange={(e) => setLocal({ ...local, url: e.target.value })} />
                <TextField label="Model" placeholder="qwen2.5:7b" value={local.model} onChange={(e) => setLocal({ ...local, model: e.target.value })} />
              </Box>
              <Note>Leave both empty for Ollama with qwen2.5:7b. Works with any OpenAI-compatible local server (LM Studio, llama.cpp, vLLM). Nothing leaves the machine.</Note>
            </Box>
          </Collapse>
          <Collapse in={provider === "api"}>
            <Box sx={{ ml: 3.5, mt: 1 }}>
              <TextField select label="Provider" value={preset} sx={{ minWidth: 240 }} onChange={(e) => {
                setPreset(e.target.value);
                const [, url, model] = AI_PROVIDERS[Number(e.target.value)];
                setRemote({ ...remote, url, model });
              }}>
                {AI_PROVIDERS.map(([n], i) => <MenuItem key={n} value={String(i)}>{n}</MenuItem>)}
              </TextField>
              <Box sx={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 1.5, mt: 2 }}>
                <TextField label="API URL" placeholder="https://…/v1" value={remote.url} onChange={(e) => setRemote({ ...remote, url: e.target.value })} />
                <TextField label="Model" placeholder="model name" value={remote.model} onChange={(e) => setRemote({ ...remote, model: e.target.value })} />
              </Box>
              <TextField fullWidth sx={{ mt: 2, maxWidth: 420 }} label="API key" type="password" autoComplete="off" value={remote.apiKey}
                placeholder={p.ai.keySet ? `Saved (${p.ai.keyHint}). Leave empty to keep it` : "Paste your API key"}
                slotProps={{ inputLabel: { shrink: true } }}
                onChange={(e) => setRemote({ ...remote, apiKey: e.target.value })} />
              <Note>Any OpenAI-compatible API. Model names are suggestions; use any model your account has. Messages are sent to this provider with secrets masked. The key is stored by this dashboard and passed to the project's guards; it is never shown again here.</Note>
            </Box>
          </Collapse>
          {hosted && (
            <Box sx={{ ml: 3.5, mt: 1.5 }}>
              <FormControlLabel control={<Checkbox size="small" checked={consent} onChange={(e) => { setConsent(e.target.checked); setAiResult(""); }} />}
                label="Allow sending message text to this model, which is not on the guard's machine" />
              <Note>The guard masks secrets and personal data (emails, card numbers, user names in paths) and sends at most 3,000 characters per message. Without this the model is not used and the rules decide alone.</Note>
            </Box>
          )}
          <Box sx={{ display: "flex", gap: 1.25, alignItems: "center", flexWrap: "wrap", mt: 1.5 }}>
            <Button variant="outlined" color="inherit" onClick={testAi}>Test AI</Button>
            <Typography sx={{ fontSize: 13, color: "text.secondary" }}>{aiResult}</Typography>
          </Box>
        </Section>

        <Section title="Alerts">
          <Note>Get told when the guard finds something, by email, Slack or a webhook. Alerts name the rule, tool and server, never the message text.</Note>
          <FormControlLabel sx={{ mt: 1 }} control={<Checkbox size="small" checked={alertsOn} onChange={(e) => setAlertsOn(e.target.checked)} />} label="Send alerts" />
          <Collapse in={alertsOn}>
            <Box sx={{ ml: 3.5, mt: 1 }}>
              <Box sx={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 1.5 }}>
                <TextField select label="Alert on findings of" value={minSeverity} onChange={(e) => setMinSeverity(e.target.value as Severity)}>
                  <MenuItem value="high">High severity</MenuItem>
                  <MenuItem value="medium">Medium and above</MenuItem>
                  <MenuItem value="low">Any finding</MenuItem>
                </TextField>
                <TextField label="At most one alert every (minutes)" type="number" value={cooldown} onChange={(e) => setCooldown(e.target.value)} slotProps={{ htmlInput: { min: 0 } }} />
              </Box>
              <FormControlLabel sx={{ mt: 1 }} control={<Checkbox size="small" checked={onBlock} onChange={(e) => setOnBlock(e.target.checked)} />}
                label="Also alert whenever a message is blocked or throttled" />
              <Note>Alerts that arrive during the wait are counted in the next one, so a noisy attack sends one message, not hundreds.</Note>

              <Divider sx={{ my: 2.5 }} />
              <Typography sx={{ fontWeight: 600, fontSize: 14 }}>Email</Typography>
              <Note>Email is sent only when an SMTP server, a from address and at least one recipient are filled in. Leave them empty to skip email.</Note>
              <Box sx={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 1.5, mt: 1.5 }}>
                <TextField label="SMTP host" placeholder="smtp.example.com" value={smtp.smtpHost} onChange={(e) => setSmtp({ ...smtp, smtpHost: e.target.value })} />
                <TextField label="Port" select value={smtp.smtpPort} onChange={(e) => setSmtp({ ...smtp, smtpPort: e.target.value, smtpSecure: e.target.value === "465" })}>
                  {["587", "465", "25", "2525"].map((v) => <MenuItem key={v} value={v}>{v}{v === "587" ? " (STARTTLS)" : v === "465" ? " (TLS)" : ""}</MenuItem>)}
                </TextField>
                <TextField label="Username" autoComplete="off" value={smtp.smtpUser} onChange={(e) => setSmtp({ ...smtp, smtpUser: e.target.value })} />
                <TextField label="Password" type="password" autoComplete="off" value={hooks.smtpPass}
                  placeholder={p.alerts.smtpPassSet ? "Saved. Leave empty to keep it" : ""} slotProps={{ inputLabel: { shrink: true } }}
                  onChange={(e) => setHooks({ ...hooks, smtpPass: e.target.value })} />
                <TextField label="From address" placeholder="alerts@example.com" value={smtp.smtpFrom} onChange={(e) => setSmtp({ ...smtp, smtpFrom: e.target.value })} />
              </Box>
              <TextField fullWidth sx={{ mt: 1.5 }} label="Send to (comma separated)" placeholder="security@example.com" value={emails} onChange={(e) => setEmails(e.target.value)} />
              <Note>The password is stored encrypted and never shown again. The mail server has to be reachable on the internet.</Note>
              {p.alerts.smtpHost && <Button size="small" color="inherit" sx={{ mt: 0.5 }} onClick={() => clearChannel({ clearSmtp: true })}>Remove email</Button>}

              <Divider sx={{ my: 2.5 }} />
              <Typography sx={{ fontWeight: 600, fontSize: 14 }}>Slack</Typography>
              <Note>Posts a message to a Slack channel through an incoming webhook.</Note>
              <TextField fullWidth sx={{ mt: 1.5 }} label="Slack incoming webhook URL" type="password" autoComplete="off" value={hooks.slackUrl}
                placeholder={p.alerts.slackSet ? `Saved (${p.alerts.slackHost}). Leave empty to keep it` : "https://hooks.slack.com/services/…"}
                slotProps={{ inputLabel: { shrink: true } }} onChange={(e) => setHooks({ ...hooks, slackUrl: e.target.value })} />
              {p.alerts.slackSet && <Button size="small" color="inherit" sx={{ mt: 0.5 }} onClick={() => clearChannel({ clearSlack: true })}>Remove Slack</Button>}

              <Divider sx={{ my: 2.5 }} />
              <Typography sx={{ fontWeight: 600, fontSize: 14 }}>Webhook</Typography>
              <Note>Sends each alert as JSON to a URL of your own.</Note>
              <TextField fullWidth sx={{ mt: 1.5 }} label="Webhook URL" type="password" autoComplete="off" value={hooks.webhookUrl}
                placeholder={p.alerts.webhookSet ? `Saved (${p.alerts.webhookHost}). Leave empty to keep it` : "https://example.com/mcpwatch-alerts"}
                slotProps={{ inputLabel: { shrink: true } }} onChange={(e) => setHooks({ ...hooks, webhookUrl: e.target.value })} />
              <TextField fullWidth sx={{ mt: 1.5, maxWidth: 420 }} label="Signing secret (optional)" type="password" autoComplete="off" value={hooks.webhookSecret}
                placeholder={p.alerts.webhookSecretSet ? "Saved. Leave empty to keep it" : "Used to sign each request"}
                slotProps={{ inputLabel: { shrink: true } }} onChange={(e) => setHooks({ ...hooks, webhookSecret: e.target.value })} />
              <Note>Each alert is a JSON POST. With a secret, requests carry X-MCPWatch-Timestamp and X-MCPWatch-Signature: sha256=HMAC(secret, timestamp + "." + body). Slack and webhook URLs are stored encrypted and never shown again.</Note>
              {p.alerts.webhookSet && <Button size="small" color="inherit" sx={{ mt: 0.5 }} onClick={() => clearChannel({ clearWebhook: true })}>Remove webhook</Button>}

              <Divider sx={{ my: 2.5 }} />
              <Box sx={{ display: "flex", gap: 1.25, alignItems: "center", flexWrap: "wrap" }}>
                <Button variant="outlined" color="inherit" onClick={testAlerts}>Send test alert</Button>
                <Typography sx={{ fontSize: 13, color: "text.secondary" }}>{alertResult}</Typography>
              </Box>
            </Box>
          </Collapse>
        </Section>

        <Section title="Transport (HTTP servers)">
          <TextField fullWidth label="Allowed web origins (comma separated)" placeholder="e.g. https://app.example.com" value={origins} onChange={(e) => setOrigins(e.target.value)} />
          <Note>Browser requests from any other origin are refused (MW030, stops DNS rebinding). Clients that aren't browsers send no origin and are unaffected.</Note>
          <FormControlLabel sx={{ mt: 1 }} control={<Checkbox size="small" checked={requireAuth} onChange={(e) => setRequireAuth(e.target.checked)} />}
            label="Require an Authorization or X-API-Key header (MW031)" />
          <TextField fullWidth sx={{ mt: 1, maxWidth: 420, display: "flex" }} label="Expected token audience" placeholder="e.g. https://mcp.example.com" value={audience} onChange={(e) => setAudience(e.target.value)} />
          <Note>JWT bearer tokens issued for another service, or expired, are refused (MW036). Leave empty to skip the audience check.</Note>
        </Section>

        <Box sx={{ display: "flex", gap: 1.5, alignItems: "center", mt: 3 }}>
          <Button variant="contained" onClick={save}>Save</Button>
          <Typography sx={{ fontSize: 13, color: "text.secondary" }}>{saved}</Typography>
        </Box>
        <Note>Guards pick up changes within 5 seconds. No restart needed.</Note>
      </Card>

      <Card sx={{ p: { xs: 2, md: 3 } }}>
        <Label>Project</Label>
        <Box sx={{ display: "flex", gap: 1, flexWrap: "wrap", alignItems: "center" }}>
          <TextField label="Name" value={name} onChange={(e) => setName(e.target.value)} sx={{ flex: 1, maxWidth: 420 }} />
          <Button variant="outlined" color="inherit" onClick={rename} disabled={!name.trim() || name === p.name}>Rename</Button>
        </Box>
        <Box sx={{ display: "flex", gap: 1, flexWrap: "wrap", mt: 2 }}>
          <Button variant="outlined" color="inherit" onClick={rotate}>Rotate key</Button>
          <Button variant="outlined" color="inherit" onClick={clear}>Clear requests</Button>
          <Button variant="outlined" color="error" onClick={remove}>Delete project</Button>
        </Box>
        <Note>Rotating the key disconnects guards using the old one until you give them the new key.</Note>
      </Card>
      {confirm.dialog}
    </Box>
  );
}
