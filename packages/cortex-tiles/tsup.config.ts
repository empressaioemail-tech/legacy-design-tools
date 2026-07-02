import { defineConfig } from 'tsup'
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['cjs', 'esm'],
  dts: true,
  external: ['react', 'react-dom', '@hauska/cortex-client', '@hauska/tile-shell', '@hauska/design-tokens', '@hauska/map-renderer', 'maplibre-gl'],
})
