import { createTheme } from "@mui/material/styles";

export const MONO = 'ui-monospace, "JetBrains Mono", "Cascadia Mono", Consolas, monospace';

// Monochrome: near-black primary actions and selections, red only for what needs attention.
// Apple-style surfaces: borderless white cards with large radii and a soft shadow on a light grey canvas.
// Light, dark, or the system setting, chosen with <ThemeToggle> and remembered in the browser
// (MUI's "mui-mode" key; index.html applies it before the first paint).
export const theme = createTheme({
  cssVariables: { colorSchemeSelector: "class" },
  colorSchemes: {
    light: {
      palette: {
        primary: { main: "#1d1d1f", contrastText: "#ffffff" },
        error: { main: "#c4262e" },
        warning: { main: "#b45d0a" },
        success: { main: "#1a7f4b" },
        background: { default: "#f5f5f7", paper: "#ffffff" },
        text: { primary: "#1d1d1f", secondary: "#6e6e73" },
        divider: "#e5e5ea",
        action: { hover: "rgba(0,0,0,0.04)" },
      },
    },
    dark: {
      palette: {
        primary: { main: "#ececec", contrastText: "#111111" },
        error: { main: "#ef4444" },
        warning: { main: "#f59e0b" },
        success: { main: "#4ade80" },
        background: { default: "#000000", paper: "#1c1c1e" },
        text: { primary: "#f5f5f7", secondary: "#98989d" },
        divider: "#38383a",
      },
    },
  },
  shape: { borderRadius: 8 },
  typography: {
    fontFamily: '"Bricolage Grotesque", system-ui, -apple-system, "Segoe UI", sans-serif',
    fontSize: 14,
    button: { textTransform: "none", fontWeight: 600 },
    h1: { fontSize: 28, fontWeight: 700, letterSpacing: "-0.025em", lineHeight: 1.1 },
    h2: { fontSize: 22, fontWeight: 600, letterSpacing: "-0.015em" },
  },
  components: {
    MuiButton: { defaultProps: { disableElevation: true }, styleOverrides: { root: { borderRadius: 980, paddingInline: 16 } } },
    MuiCard: {
      defaultProps: { elevation: 0 },
      styleOverrides: {
        root: {
          borderRadius: 18, border: "none", transition: "box-shadow .2s ease, transform .2s ease",
          boxShadow: "0 1px 2px rgba(0,0,0,0.04), 0 4px 16px rgba(0,0,0,0.04)",
          ".dark &": { boxShadow: "none" },
        },
      },
    },
    MuiCardActionArea: { styleOverrides: { root: { borderRadius: "inherit" } } },
    MuiOutlinedInput: { styleOverrides: { root: { borderRadius: 10 } } },
    MuiMenu: { styleOverrides: { paper: { borderRadius: 12, boxShadow: "0 8px 30px rgba(0,0,0,0.12)" } } },
    MuiDialog: { styleOverrides: { paper: { borderRadius: 20 } } },
    MuiAlert: { styleOverrides: { root: { borderRadius: 14 } } },
    MuiPaper: { styleOverrides: { root: { backgroundImage: "none" } } },
    MuiTextField: { defaultProps: { size: "small" } },
    MuiSelect: { defaultProps: { size: "small" } },
    MuiChip: { styleOverrides: { root: { borderRadius: 980, fontWeight: 500 } } },
    MuiTableCell: {
      styleOverrides: {
        head: { fontFamily: MONO, fontSize: 10.5, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--mui-palette-text-secondary)" },
      },
    },
  },
});
