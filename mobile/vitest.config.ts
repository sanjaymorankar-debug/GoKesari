import { defineConfig } from "vitest/config";

// Unit tests for the app's plain TypeScript modules (no React Native imports):
// the URL parser, navigation policy, PKCE helpers and the injected page bridge.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
