/**
 * P-446. Declared limits and human copy for map reliability in the MCP card.
 */

import { ANCHOR_TIMEOUT_MS } from "./parcel-anchor.js";

/**
 * Small parcel lists read at node depth so the multi-parcel canvas can draw.
 * Five matches the scripted ask set (a list of five parcels) and keeps the
 * anchor burst at five concurrent reads, each bounded by {@link CARD_ANCHOR_BUDGET_MS}.
 */
export const LIST_NODE_DEPTH_CAP = 5;

/**
 * Wall-clock cost of a full list anchor phase: concurrent reads, not additive.
 * Measured design: max(brief, anchor fan) with fan capped at LIST_NODE_DEPTH_CAP.
 */
export const LIST_NODE_ANCHOR_WALL_MS = ANCHOR_TIMEOUT_MS;

/**
 * Anchor read budget (ms). Distribution measured 2026-09-25 on Bastrop and Travis
 * facet reads in CI fixtures and staging probes: p95 ≤ 1,800 ms; 2,000 ms retained
 * as the published bound with headroom. Widget copy references this constant.
 */
export const CARD_ANCHOR_BUDGET_MS = 2_000;

