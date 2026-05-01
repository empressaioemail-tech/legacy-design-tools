interface ImportMetaEnv {
  readonly BASE_URL: string;
  /**
   * Task #317 — opt-out for the reviewer-side 2D site-context map
   * overlay rendered inside `EngagementContextPanel`. Set to the
   * literal string "false" (case-insensitive) to hide the map; any
   * other value (or absence) leaves the map enabled. Reviewers who
   * never look at the map can disable it to skip loading the
   * Leaflet bundle and OpenStreetMap tiles.
   */
  readonly VITE_REVIEWER_SITE_MAP_ENABLED?: string;
  /**
   * Task #317 — overrides the default OpenStreetMap tile URL used
   * by the reviewer-side site-context map. When set, the matching
   * `VITE_REVIEWER_SITE_MAP_TILE_ATTRIBUTION` should also be set so
   * the tile provider is credited correctly. Useful when a
   * deployment wants to swap to a self-hosted, MapLibre-styled, or
   * keyed tile provider (the URL template can embed the key, e.g.
   * `https://example.tiles/{z}/{x}/{y}.png?key=…`); leaving it
   * unset keeps the public OSM tile server.
   */
  readonly VITE_REVIEWER_SITE_MAP_TILE_URL?: string;
  readonly VITE_REVIEWER_SITE_MAP_TILE_ATTRIBUTION?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
