import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath, URL } from "node:url";

const apiTarget = process.env.RESTREAM_API_TARGET || "http://127.0.0.1:8080";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  build: {
    rolldownOptions: {
      output: {
        // Keep the shared framework cache stable across application changes.
        // HLS and settings remain on-demand chunks through dynamic imports.
        codeSplitting: {
          groups: [
            {
              name: "react",
              test: /node_modules\/(react|react-dom|scheduler)\//,
            },
            {
              name: "motion",
              test: /node_modules\/(motion|framer-motion|motion-dom|motion-utils)\//,
            },
          ],
        },
      },
    },
  },
  server: {
    proxy: {
      "/api": apiTarget,
      "/auth": apiTarget,
      "/healthz": apiTarget,
    },
  },
});
