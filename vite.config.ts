import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The installable app. Built to ./dist and served by the Worker as static assets (wrangler.jsonc "assets").
// In local development, /api and /media are proxied to `wrangler dev` on port 8787.
export default defineConfig({
  plugins: [react()],
  // assetsInlineLimit 0: fonts and images stay as files, so the strict Content-Security-Policy needs no data: allowance.
  build: { outDir: "dist", emptyOutDir: true, sourcemap: false, target: "es2022", assetsInlineLimit: 0 },
  server: {
    port: 5173,
    proxy: {
      "/api": { target: "http://localhost:8787", ws: true },
      "/media": "http://localhost:8787",
    },
  },
});
