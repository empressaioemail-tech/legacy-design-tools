// Minimal ambient typing for the Vite `import.meta.env` fields the map tile
// reads. The package is consumed inside a Vite app (codex-reviewer-qa) that
// injects these at build time; this only satisfies tsup's dts pass.
interface ImportMetaEnv {
  readonly VITE_HAUSKA_MAP_URL?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
