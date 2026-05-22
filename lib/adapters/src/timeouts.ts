/**
 * Shared per-adapter timeout budgets for the site-context adapter
 * runner (QA-22).
 *
 * The runner ({@link runAdapters}) caps every adapter at a per-call
 * budget — `max(adapter.timeoutMs, context.timeoutMs)` — so one slow
 * upstream cannot stall the Generate Layers batch indefinitely, and a
 * feed that is genuinely down degrades to a single failed row rather
 * than failing the whole layer set.
 *
 * The default budget is 15s. That is ample for the fast feeds (FEMA
 * NFHL, USGS EPQS), but QA-22 observed three public endpoints timing
 * out against it on real engagements: the EPA EJScreen broker, the FCC
 * National Broadband Map API, and the Grand County, UT county ArcGIS
 * server. The failure surfaced to architects as a `timeout` pill on
 * the EPA / FCC / Grand County rows and an empty site-context layer
 * set (which in turn left the site 3D view with nothing to render).
 * Those upstreams answer reliably given more headroom, so each carries
 * the widened {@link SLOW_UPSTREAM_TIMEOUT_MS} budget via its adapter's
 * optional `timeoutMs` floor.
 */

/**
 * Default per-adapter network budget. The runner falls back to this
 * when neither the adapter nor the caller (`context.timeoutMs`) widens
 * it. The api-server's generate-layers route passes this as the
 * `context.timeoutMs` floor, overridable via the `ADAPTER_TIMEOUT_MS`
 * env var.
 */
export const DEFAULT_ADAPTER_TIMEOUT_MS = 15_000;

/**
 * Widened per-adapter budget for known-slow public upstreams (EPA
 * EJScreen broker, FCC NBM API, Grand County county ArcGIS). ~2x the
 * default — generous headroom for a slow single response while still
 * bounding the Generate Layers worst case. An adapter's `timeoutMs`
 * can only widen the runner budget, never tighten it, so wiring this
 * on the slow adapters is safe regardless of the caller's floor.
 *
 * Grand County roads is deliberately NOT on this constant: its OSM
 * Overpass fallback has a 25s server-side `[timeout:25]` directive and
 * needs the larger `GRAND_COUNTY_ROADS_TIMEOUT_MS` (60s) to cover a
 * retry.
 */
export const SLOW_UPSTREAM_TIMEOUT_MS = 30_000;
