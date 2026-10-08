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
    exclude: ["tests/rules/**", "tests/emulator/**", "node_modules/**"],
    // Unit tests must never reach a real Firebase project: blank the web
    // config that Vite would otherwise load from .env.local
    // (tests/app/no-real-firebase.test.js checks this).
    env: {
      VITE_FIREBASE_API_KEY: "",
      VITE_FIREBASE_AUTH_DOMAIN: "",
      VITE_FIREBASE_PROJECT_ID: "",
      VITE_FIREBASE_APP_ID: "",
      VITE_FIREBASE_STORAGE_BUCKET: "",
      VITE_FIREBASE_MESSAGING_SENDER_ID: "",
    },
  },
});
