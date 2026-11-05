import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";

// The dashboard ships in the backend's npm package, so that is the version the app shows.
const { version } = JSON.parse(readFileSync(new URL("../backend/package.json", import.meta.url), "utf8"));

// The dashboard web app. `npm run build` writes it to ../backend/public, which the backend serves and
// its npm package ships. `npm run dev` serves it with hot reload and sends /api to a running dashboard.
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [react()],
  define: { __APP_VERSION__: JSON.stringify(version) },
  build: {
    outDir: fileURLToPath(new URL("../backend/public", import.meta.url)),
    emptyOutDir: true,
    // One bundle (React + MUI) served from the same machine; splitting it buys nothing here.
    chunkSizeWarningLimit: 800,
  },
  server: {
    proxy: { "/api": "http://127.0.0.1:9100" },
  },
});
