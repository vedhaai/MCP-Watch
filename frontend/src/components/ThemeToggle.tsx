import { useState } from "react";
import IconButton from "@mui/material/IconButton";
import ListItemIcon from "@mui/material/ListItemIcon";
import ListItemText from "@mui/material/ListItemText";
import Menu from "@mui/material/Menu";
import MenuItem from "@mui/material/MenuItem";
import Tooltip from "@mui/material/Tooltip";
import { useColorScheme } from "@mui/material/styles";
import CheckIcon from "@mui/icons-material/Check";
import DarkModeOutlinedIcon from "@mui/icons-material/DarkModeOutlined";
import LightModeOutlinedIcon from "@mui/icons-material/LightModeOutlined";
import SettingsBrightnessIcon from "@mui/icons-material/SettingsBrightness";

export type ThemeMode = "system" | "light" | "dark";

export const THEME_MODES: [ThemeMode, string, React.ReactNode][] = [
  ["system", "System", <SettingsBrightnessIcon fontSize="small" />],
  ["light", "Light", <LightModeOutlinedIcon fontSize="small" />],
  ["dark", "Dark", <DarkModeOutlinedIcon fontSize="small" />],
];

// Light / dark / follow the system. MUI saves the choice in the browser.
export function ThemeToggle() {
  const { mode, setMode } = useColorScheme();
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const current = THEME_MODES.find(([m]) => m === (mode ?? "system")) ?? THEME_MODES[0];
  return (
    <>
      <Tooltip title={`Theme: ${current[1]}`}>
        <IconButton aria-label="Theme" onClick={(e) => setAnchor(e.currentTarget)}
          sx={{ border: "1px solid", borderColor: "divider", borderRadius: 2, bgcolor: "background.paper", color: "text.primary" }}>
          {current[2]}
        </IconButton>
      </Tooltip>
      <Menu anchorEl={anchor} open={!!anchor} onClose={() => setAnchor(null)} anchorOrigin={{ vertical: "bottom", horizontal: "right" }} transformOrigin={{ vertical: "top", horizontal: "right" }}>
        {THEME_MODES.map(([m, label, icon]) => (
          <MenuItem key={m} selected={m === current[0]} onClick={() => { setMode(m); setAnchor(null); }} sx={{ minWidth: 160 }}>
            <ListItemIcon>{icon}</ListItemIcon>
            <ListItemText primary={label} />
            {m === current[0] && <CheckIcon fontSize="small" sx={{ ml: 1 }} />}
          </MenuItem>
        ))}
      </Menu>
    </>
  );
}
