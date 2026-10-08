import { defineConfig } from "vitest/config";

// Emulator security suite (tests/rules/). Run through `npm run test:rules`,
// which starts the Firestore + Storage emulators around it. Files run one
// at a time because they share the emulator's single demo project.
export default defineConfig({
  test: {
    include: ["tests/rules/**/*.test.js", "tests/emulator/**/*.test.js"],
    fileParallelism: false,
    testTimeout: 30000,
    hookTimeout: 60000,
  },
});
