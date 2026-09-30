import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath, URL } from "node:url";

const apiTarget = process.env.RESTREAM_API_TARGET || "http://localhost:8080";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  build: {
    rollupOptions: {
      output: {
        // Keep the shared framework cache stable across application changes.
        // HLS and settings remain on-demand chunks through dynamic imports.
        manualChunks(id) {
          if (/node_modules\/(react|react-dom|scheduler)\//.test(id))
            return "react";
          if (
            /node_modules\/(motion|framer-motion|motion-dom|motion-utils)\//.test(
              id,
            )
          )
            return "motion";
        },
      },
    },
  },
  server: {
    watch: { usePolling: process.env.RESTREAM_WATCH_POLLING === "true" },
    proxy: {
      "/api": apiTarget,
      "/healthz": apiTarget,
    },
  },
});
