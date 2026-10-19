import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { nodePolyfills } from "vite-plugin-node-polyfills";

// The API/indexer (app/server) runs on :8793 in development; production serves the built
// app from the same server, so every request is same-origin.
export default defineConfig({
  plugins: [react(), nodePolyfills({ include: ["buffer", "process", "stream", "util", "events"], globals: { Buffer: true, process: true } })],
  define: { "process.env.NODE_DEBUG": "false" },
  server: { port: 5174, proxy: { "/api": `http://127.0.0.1:${process.env.API_PORT || 8793}`, "^/m/": `http://127.0.0.1:${process.env.API_PORT || 8793}` } },
  build: { target: "es2022", sourcemap: false, chunkSizeWarningLimit: 1500 },
});
