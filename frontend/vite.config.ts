import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

// The dashboard web app. `npm run build` writes it to ../backend/public, which the backend serves and
// its npm package ships. `npm run dev` serves it with hot reload and sends /api to a running dashboard.
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [react()],
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
