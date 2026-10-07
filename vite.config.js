import { resolve } from "node:path";
import { defineConfig } from "vite";

const root = import.meta.dirname;

export default defineConfig({
  // Two separate entry points / bundles:
  //   index.html          → tenant app (business owners and staff)
  //   console/index.html  → Luna Super Admin console (internal only)
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        app: resolve(root, "index.html"),
        console: resolve(root, "console/index.html"),
      },
    },
  },
  resolve: {
    alias: {
      "@shared": resolve(root, "shared"),
    },
  },
  server: {
    port: 5173,
  },
  test: {
    include: ["tests/**/*.test.js"],
    // Emulator security suite has its own config (vitest.rules.config.js).
    exclude: ["tests/rules/**", "node_modules/**"],
  },
});
