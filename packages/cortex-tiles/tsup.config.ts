import { defineConfig } from 'tsup'
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['cjs', 'esm'],
  dts: true,
  external: ['react', 'react-dom', '@empressaio/cortex-client', '@empressaio/tile-shell', '@empressaio/design-tokens', '@hauska/map-renderer', 'maplibre-gl'],
})
