import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

const backend = process.env.TEXDESK_BACKEND ?? "http://127.0.0.1:8080";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      // The Go server checks the Host header (DNS-rebinding protection), so
      // rewrite it to the backend's own host.
      "/api": { target: backend, changeOrigin: true },
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    chunkSizeWarningLimit: 2000,
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
