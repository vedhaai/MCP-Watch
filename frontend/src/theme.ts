import { createTheme } from "@mui/material/styles";

export const MONO = 'ui-monospace, "JetBrains Mono", "Cascadia Mono", Consolas, monospace';

// Warm palette: cream surfaces on a beige canvas, dark brown for selections, and an orange
// gradient (ACCENT, the secondary color) for the main call to action and highlights.
// Light, dark, or the system setting, chosen with <ThemeToggle> and remembered in the browser
// (MUI's "mui-mode" key; index.html applies it before the first paint).
export const ACCENT = "linear-gradient(135deg, #fbb45e 0%, #ec6a2c 100%)";

export const theme = createTheme({
  cssVariables: { colorSchemeSelector: "class" },
  colorSchemes: {
    light: {
      palette: {
        primary: { main: "#2b1a12", contrastText: "#fffaf4" },
        secondary: { main: "#ec7a32", contrastText: "#2b1a12" },
        error: { main: "#b42318" },
        warning: { main: "#d9661f" },
        success: { main: "#2f7a4a" },
        background: { default: "#f1e7dc", paper: "#fffaf4" },
        text: { primary: "#2b1a12", secondary: "#7a6656" },
        divider: "#e6d9c9",
        action: { hover: "rgba(43,26,18,0.05)" },
      },
    },
    dark: {
      palette: {
        primary: { main: "#f6e9da", contrastText: "#2b1a12" },
        secondary: { main: "#f59a4a", contrastText: "#2b1a12" },
        error: { main: "#f0645a" },
        warning: { main: "#f59a4a" },
        success: { main: "#5fbf83" },
        background: { default: "#120d0a", paper: "#1d1713" },
        text: { primary: "#f6ece2", secondary: "#a8968a" },
        divider: "#3a2f27",
        action: { hover: "rgba(246,233,218,0.06)" },
      },
    },
  },
  shape: { borderRadius: 8 },
  typography: {
    fontFamily: '"Bricolage Grotesque", system-ui, -apple-system, "Segoe UI", sans-serif',
    fontSize: 14,
    button: { textTransform: "none", fontWeight: 600 },
    h1: { fontSize: 28, fontWeight: 800, letterSpacing: "-0.035em", lineHeight: 1.1 },
    h2: { fontSize: 22, fontWeight: 600, letterSpacing: "-0.015em" },
  },
  components: {
    MuiButton: {
      defaultProps: { disableElevation: true },
      styleOverrides: {
        root: {
          borderRadius: 980, paddingInline: 16,
          variants: [{
            props: { variant: "contained", color: "secondary" },
            style: { background: ACCENT, color: "#2b1a12", "&:hover": { background: ACCENT, filter: "brightness(1.05)" } },
          }],
        },
      },
    },
    MuiRadio: { defaultProps: { color: "secondary" } },
    MuiCheckbox: { defaultProps: { color: "secondary" } },
    MuiSwitch: { defaultProps: { color: "secondary" } },
    MuiCard: {
      defaultProps: { elevation: 0 },
      styleOverrides: {
        root: {
          borderRadius: 18, border: "none", boxShadow: "none", transition: "box-shadow .2s ease, transform .2s ease",
          // A card inside a card (stat tiles in a detail panel) sits on the canvas color.
          "& .MuiCard-root": { backgroundColor: "var(--mui-palette-background-default)" },
        },
      },
    },
    MuiCardActionArea: { styleOverrides: { root: { borderRadius: "inherit" } } },
    MuiOutlinedInput: { styleOverrides: { root: { borderRadius: 10 } } },
    MuiMenu: { styleOverrides: { paper: { borderRadius: 12, boxShadow: "0 8px 30px rgba(43,26,18,0.14)" } } },
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
