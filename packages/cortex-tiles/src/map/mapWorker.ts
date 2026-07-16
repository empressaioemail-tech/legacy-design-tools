// packages/cortex-tiles/src/map/mapWorker.ts
//
// MV3 worker seam for the library map tile.
//
// WHY THIS EXISTS: @hauska/map-renderer's FloatingMap mounts MapLibre GL with
// MapLibre's DEFAULT internal tile worker, which MapLibre bootstraps from a
// blob: URL. Under a Chrome MV3 extension's Content Security Policy a blob:
// worker is FORBIDDEN, so the map fails to start inside an extension (the Brief
// extension is the load-bearing consumer). The MV3-safe fix is to point MapLibre
// at a worker script served from the extension's own origin
// (web_accessible_resources), which the consumer vendors and passes in.
//
// This module is the LIBRARY's half of that seam: it does NOT hardcode a worker
// (an app with a normal page CSP wants the default). It exposes a `workerUrl`
// (and a forward-compatible `workerClass`) that a consumer injects; when set, it
// installs the URL globally on maplibre-gl via the documented `setWorkerUrl`
// mechanism BEFORE any Map is constructed. When not provided, MapLibre keeps its
// default worker and behavior is unchanged.
//
// A consumer (the Brief extension) injects like:
//   <LiveMapTile workerUrl={chrome.runtime.getURL('maplibre-gl-csp-worker.js')} />
// with that file listed under web_accessible_resources and wasm-unsafe-eval in
// the extension CSP.

import maplibregl from 'maplibre-gl'

/**
 * A consumer-supplied worker constructor (forward-compatible seam). MapLibre GL
 * v5 configures its worker by URL (`setWorkerUrl`); a `workerClass` is threaded
 * through to @hauska/map-renderer's FloatingMap for the day the renderer/MapLibre
 * expose a class-based worker override, so consumers can wire it now without a
 * later tile change.
 */
export type MapWorkerClass = new () => Worker

export interface MapWorkerSeam {
  /**
   * URL of a CSP-safe MapLibre worker script the consumer serves from its own
   * origin (e.g. an MV3 extension's web_accessible_resources). When set, it is
   * installed globally via maplibregl.setWorkerUrl before the map mounts.
   */
  workerUrl?: string
  /**
   * Forward-compatible worker constructor override, threaded through to
   * FloatingMap. Unused by MapLibre v5's URL-based worker config; present so a
   * consumer can inject it once and have it take effect when the renderer adds
   * class-based worker support.
   */
  workerClass?: MapWorkerClass
}

/** The last workerUrl we installed, so re-renders don't re-install redundantly. */
let installedWorkerUrl: string | null = null

/**
 * Install a consumer-provided CSP-safe worker URL on maplibre-gl. Idempotent:
 * calling with the same URL twice is a no-op, and calling with `undefined`
 * leaves MapLibre's default worker in place (never clears an installed URL, so
 * one live map can't yank the worker out from under another).
 *
 * MUST be called before the MapLibre Map is constructed (setWorkerUrl is a
 * process-global read at Map creation time). The tile calls it in render, which
 * runs before FloatingMap's mount effect creates the map.
 */
export function installMapWorker(workerUrl?: string): void {
  if (!workerUrl || workerUrl === installedWorkerUrl) return
  const setWorkerUrl = (maplibregl as unknown as { setWorkerUrl?: (v: string) => void })
    .setWorkerUrl
  if (typeof setWorkerUrl === 'function') {
    setWorkerUrl(workerUrl)
    installedWorkerUrl = workerUrl
  }
}

/** Test seam: reset the install memo so a test can re-assert install behavior. */
export function __resetInstalledMapWorker(): void {
  installedWorkerUrl = null
}
