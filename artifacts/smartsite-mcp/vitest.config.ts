import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    env: {
      DATABASE_URL: "postgres://smartsite_mcp_test:test@127.0.0.1:5432/smartsite_mcp_test",
    },
  },
});
