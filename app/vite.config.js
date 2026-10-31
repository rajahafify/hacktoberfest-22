import { defineConfig } from "vite";

// Fully static build: everything runs in the browser, so the output deploys
// to Cloudflare Pages (or any static host) with no server.
export default defineConfig({
  base: "./",
  build: { outDir: "dist", emptyOutDir: true, target: "es2022" },
  test: { environment: "node" },
});
