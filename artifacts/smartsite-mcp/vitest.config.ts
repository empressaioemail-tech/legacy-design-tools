import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    setupFiles: ["tests/vitest-served-globals.setup.ts"],
    include: ["tests/**/*.test.ts"],
    env: {
      DATABASE_URL: "postgres://smartsite_mcp_test:test@127.0.0.1:5432/smartsite_mcp_test",
      // D-42: the parcel tile origin is config with NO product default, so the
      // suite declares the value it runs under -- a `.invalid` origin, which can
      // never be mistaken for the real Spaces origin D-42 creates. The unset
      // refusal is proven separately in tests/parcel-tiles-origin.test.ts.
      PARCEL_TILES_ORIGIN: "https://tiles.test.invalid",
      SMARTSITE_MAP_WIRE: "0",
    },
  },
});
