import { createTheme } from "@mui/material/styles";

export const MONO = 'ui-monospace, "JetBrains Mono", "Cascadia Mono", Consolas, monospace';

// Monochrome: near-black primary actions and selections, red only for what needs attention.
// Light, dark, or the system setting, chosen with <ThemeToggle> and remembered in the browser
// (MUI's "mui-mode" key; index.html applies it before the first paint).
export const theme = createTheme({
  cssVariables: { colorSchemeSelector: "class" },
  colorSchemes: {
    light: {
      palette: {
        primary: { main: "#141414", contrastText: "#ffffff" },
        error: { main: "#c4262e" },
        warning: { main: "#b45d0a" },
        success: { main: "#1a7f4b" },
        background: { default: "#f4f4f2", paper: "#ffffff" },
        text: { primary: "#141414", secondary: "#6b6b6b" },
        divider: "#e4e4e0",
        action: { hover: "rgba(0,0,0,0.04)" },
      },
    },
    dark: {
      palette: {
        primary: { main: "#ececec", contrastText: "#111111" },
        error: { main: "#ef4444" },
        warning: { main: "#f59e0b" },
        success: { main: "#4ade80" },
        background: { default: "#0f1012", paper: "#17181b" },
        text: { primary: "#ececec", secondary: "#9a9a9a" },
        divider: "#2a2b30",
      },
    },
  },
  shape: { borderRadius: 8 },
  typography: {
    fontFamily: '"Inter", system-ui, -apple-system, "Segoe UI", sans-serif',
    fontSize: 14,
    button: { textTransform: "none", fontWeight: 600 },
    h1: { fontSize: 30, fontWeight: 700, letterSpacing: "-0.02em", lineHeight: 1.1 },
    h2: { fontSize: 21, fontWeight: 700, letterSpacing: "-0.01em" },
  },
  components: {
    MuiButton: { defaultProps: { disableElevation: true } },
    MuiCard: { defaultProps: { variant: "outlined" }, styleOverrides: { root: { borderRadius: 10 } } },
    MuiPaper: { styleOverrides: { root: { backgroundImage: "none" } } },
    MuiTextField: { defaultProps: { size: "small" } },
    MuiSelect: { defaultProps: { size: "small" } },
    MuiChip: { styleOverrides: { root: { borderRadius: 6, fontWeight: 500 } } },
    MuiTableCell: {
      styleOverrides: {
        head: { fontFamily: MONO, fontSize: 10.5, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--mui-palette-text-secondary)" },
      },
    },
  },
});
