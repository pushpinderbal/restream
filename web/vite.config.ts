import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath, URL } from "node:url";

const apiTarget = process.env.RESTREAM_API_TARGET || "http://localhost:8080";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  server: {
    watch: { usePolling: process.env.RESTREAM_WATCH_POLLING === "true" },
    proxy: {
      "/api": apiTarget,
      "/healthz": apiTarget,
    },
  },
});
