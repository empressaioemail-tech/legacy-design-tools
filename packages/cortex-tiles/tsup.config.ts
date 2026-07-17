import { defineConfig } from 'tsup'
export default defineConfig({
  // "." barrel (React tiles + CSS) and the "./site-analysis" HEADLESS entry
  // (pure, React-free, CSS-free). Separate entry points so the headless output
  // never pulls in the React tiles or CSS side effects.
  entry: {
    index: 'src/index.ts',
    'site-analysis': 'src/site-analysis/headless.ts',
  },
  format: ['cjs', 'esm'],
  dts: true,
  external: ['react', 'react-dom', '@empressaio/cortex-client', '@empressaio/tile-shell', '@empressaio/design-tokens', '@empressaio/document-viewer', '@hauska/map-renderer', 'maplibre-gl', 'three', 'three/examples/jsm/controls/OrbitControls.js', 'three/examples/jsm/loaders/GLTFLoader.js', 'lucide-react'],
})
