import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  test: {
    environment: 'happy-dom',
    globals: true,
  },
  resolve: {
    alias: {
      // CI runs tests before any package dist is built; resolve the workspace
      // dep to SOURCE so vitest never needs tile-shell's dist. Also guarantees
      // the test exercises the same tile-shell instance as the tiles (no
      // dual-instance context split).
      '@empressaio/tile-shell': fileURLToPath(
        new URL('../tile-shell/src/index.ts', import.meta.url),
      ),
    },
  },
})
