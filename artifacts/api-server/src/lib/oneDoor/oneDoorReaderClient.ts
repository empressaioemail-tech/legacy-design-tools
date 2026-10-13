/**
 * ONE DOOR (WP-L, `_design/2026-10-13_one_door_build_spec.md` §2): the typed
 * client for the single reader, hauska-engine retrieval-api
 * `GET /property-nodes/:id/record`.
 *
 * THIS IS THE ONLY FILE THAT KNOWS THE READER'S WIRE FIELD NAMES. Aligned to
 * the published contract `one-door-v1` (hauska-engine PR #525, CONTRACT
 * section): `contract`, top-level `mode`, `facts` keyed by rail key; 404
 * `errorClass: "parcel-not-found"` (no facts); 503 `errorClass: read-failed |
 * timeout | store-not-configured` (facts all `failed`, plus `mode`).
 * Everything else in cortex and the MCP codes against the types exported here
 * (`OneDoorFact`, `OneDoorMode`, the seven `OneDoorState`s).
 *
 * What the reader returns (§2), one object per fact keyed by rail key:
 *
 *   { state, value? (only when state = "value"), words, source: { adapter, vintage, asOf }, detail? }
 *
 * plus `mode` (`off` | `shadow` | `on`, the per-county one-door switch, which
 * lives only in the reader). The reader owns the wording: consumers render
 * `words` verbatim and never replace it.
 *
 * Fail-safe direction. A reader that has not been upgraded yet (no `mode` on
 * the body) reads as `off`, so this module deploying ahead of WP-R changes
 * nothing a user sees. A reader that cannot be reached falls back to the last
 * mode this process saw for the county (so an `on` county keeps serving the
 * reader's `failed` state instead of silently reverting to the old doors), and
 * to `off` when there is no such memory.
 *
 * Nothing here caches a FACT. The only memory is the per-county mode, which is
 * a switch position, not parcel data; `failed` is never cached by anyone (§2).
 */

import { retrievalBaseUrlFromEnv } from "../retrievalEndpoint";

// ---------------------------------------------------------------------------
// Contract types (§2)
// ---------------------------------------------------------------------------

export const ONE_DOOR_STATES = [
  "value",
  "not-on-record",
  "not-applicable",
  "not-loaded",
  "held",
  "plan-gated",
  "failed",
] as const;

export type OneDoorState = (typeof ONE_DOOR_STATES)[number];

export const ONE_DOOR_MODES = ["off", "shadow", "on"] as const;

export type OneDoorMode = (typeof ONE_DOOR_MODES)[number];

export type OneDoorSource = {
  adapter: string | null;
  vintage: string | null;
  asOf: string | null;
};

export type OneDoorFact = {
  state: OneDoorState;
  /** Present only when `state === "value"`. */
  value?: unknown;
  /** The reader's customer phrase for the state. Rendered verbatim. */
  words: string;
  source: OneDoorSource;
  detail?: Record<string, unknown>;
};

export type OneDoorRecord = {
  parcelNodeId: string;
  countyFips: string | null;
  mode: OneDoorMode;
  readAt: string | null;
  facts: Record<string, OneDoorFact>;
};

export type OneDoorUnavailableReason =
  | "not-configured"
  | "timeout"
  | "network"
  | "http-error"
  | "malformed";

export type OneDoorRead =
  | { kind: "record"; record: OneDoorRecord }
  | { kind: "parcel-not-found"; mode: OneDoorMode }
  | {
      kind: "unavailable";
      reason: OneDoorUnavailableReason;
      /** Last mode seen for this county in this process, or `off`. */
      mode: OneDoorMode;
    };

// ---------------------------------------------------------------------------
// Entitlements (§2 "default deny")
// ---------------------------------------------------------------------------

/** The header trusted server callers send. The browser proxy strips it (WP-M). */
export const ONE_DOOR_ENTITLEMENTS_HEADER = "X-Hauska-Entitlements";

/**
 * The gated rails, reusing LDT #813's list (`ownerCoGatedMapFields.ts`:
 * owner name, owner mailing address, exemptions, the CAD tax-assessed dollar
 * values) plus the dollar companions (`valueHistory`, P-246; `salesHistory`).
 * Mailing address rides on the `owner` companion; there is no separate rail.
 */
export const ONE_DOOR_GATED_RAILS = [
  "owner",
  "exemptionCodes",
  "marketValue",
  "assessedValue",
  "landValue",
  "improvementValue",
  "valueHistory",
  "salesHistory",
] as const;

/**
 * The END USER's entitlement list for one parcel. `grantsOwnerCoGated` is
 * exactly the predicate #813/#814 already compute for the caller
 * (`grantsOwnerCoGatedFields`: Studio|Team, or an active Property Unlock on
 * this parcel; the browser-proxy end user per #814). Anonymous, free, Solo,
 * identified-only and service-key callers get nothing.
 */
export function oneDoorEntitlementsFor(grantsOwnerCoGated: boolean): string[] {
  return grantsOwnerCoGated ? [...ONE_DOOR_GATED_RAILS] : [];
}

/** The header value. Empty list => header omitted (no header means no gated rails). */
export function oneDoorEntitlementsHeaderValue(entitlements: readonly string[]): string | null {
  const list = [...new Set(entitlements.map((e) => e.trim()).filter(Boolean))].sort();
  return list.length ? list.join(",") : null;
}

/**
 * Defense in depth only. The reader projects gated rails itself; if it ever
 * returns a value for a gated rail this caller is not entitled to, the value
 * is dropped here. These words are a guard copy of the reader's default
 * plan-gated phrase (§2) and should never be seen when the reader is correct.
 */
export const ONE_DOOR_PLAN_GATED_GUARD_WORDS = "Included in Studio";

/**
 * The one phrase cortex writes itself: the reader could not be reached at all,
 * so there is no reader to speak. It is the reader's own default `failed`
 * wording (§2) and is never cached.
 */
export const ONE_DOOR_TRANSPORT_FAILED_WORDS = "Couldn't load this just now — retry";

// ---------------------------------------------------------------------------
// Wire normalisation — the one place WP-R's field names live
// ---------------------------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function isOneDoorState(value: unknown): value is OneDoorState {
  return typeof value === "string" && (ONE_DOOR_STATES as readonly string[]).includes(value);
}

export function isOneDoorMode(value: unknown): value is OneDoorMode {
  return typeof value === "string" && (ONE_DOOR_MODES as readonly string[]).includes(value);
}

function parseSource(value: unknown): OneDoorSource {
  const rec = asRecord(value);
  return {
    adapter: str(rec?.adapter),
    vintage: str(rec?.vintage),
    asOf: str(rec?.asOf),
  };
}

/**
 * One fact. A fact whose state is not one of the seven is not a fact this
 * consumer can render honestly and is dropped (the surface then omits it
 * rather than inventing words). A `value` state with no value is downgraded to
 * the reader's own words under `failed` — the reader claimed a value it did
 * not send.
 */
export function parseOneDoorFact(value: unknown): OneDoorFact | null {
  const rec = asRecord(value);
  if (!rec || !isOneDoorState(rec.state)) return null;
  const words = typeof rec.words === "string" ? rec.words : "";
  const fact: OneDoorFact = {
    state: rec.state,
    words,
    source: parseSource(rec.source),
  };
  if (rec.state === "value") {
    if (!("value" in rec) || rec.value === undefined) {
      return { ...fact, state: "failed", words: words || ONE_DOOR_TRANSPORT_FAILED_WORDS };
    }
    fact.value = rec.value;
  }
  const detail = asRecord(rec.detail);
  if (detail) fact.detail = detail;
  return fact;
}

/** The contract version this client speaks (`contract` on every reader response). */
export const ONE_DOOR_CONTRACT = "one-door-v1";

/**
 * The reader body -> `OneDoorRecord`, or `null` when the body is not a reader
 * body at all. A body that does not declare `contract: "one-door-v1"` with a
 * recognised top-level `mode` (today's pre-#525 `/record`) is `mode: "off"`
 * and carries no one-door facts: the legacy `rails` map is never read here.
 */
export function parseOneDoorRecord(body: unknown, parcelNodeId: string): OneDoorRecord | null {
  const rec = asRecord(body);
  if (!rec) return null;
  const speaksContract = rec.contract === ONE_DOOR_CONTRACT;
  const mode: OneDoorMode = speaksContract && isOneDoorMode(rec.mode) ? rec.mode : "off";
  const factsRaw = (speaksContract && asRecord(rec.facts)) || {};
  const facts: Record<string, OneDoorFact> = {};
  for (const [rail, raw] of Object.entries(factsRaw)) {
    const fact = parseOneDoorFact(raw);
    if (fact) facts[rail] = fact;
  }
  return {
    parcelNodeId: str(rec.parcelNodeId) ?? parcelNodeId,
    countyFips: str(rec.countyFips) ?? countyFipsOf(parcelNodeId),
    mode,
    readAt: str(rec.readAt),
    facts,
  };
}

/** Drop any gated value the caller is not entitled to (guard; see above). */
export function enforceOneDoorEntitlements(
  record: OneDoorRecord,
  entitlements: readonly string[],
): OneDoorRecord {
  const granted = new Set(entitlements);
  let changed = false;
  const facts: Record<string, OneDoorFact> = {};
  for (const [rail, fact] of Object.entries(record.facts)) {
    if (
      (ONE_DOOR_GATED_RAILS as readonly string[]).includes(rail) &&
      !granted.has(rail) &&
      fact.state === "value"
    ) {
      changed = true;
      facts[rail] = {
        state: "plan-gated",
        words: ONE_DOOR_PLAN_GATED_GUARD_WORDS,
        source: fact.source,
      };
      continue;
    }
    facts[rail] = fact;
  }
  return changed ? { ...record, facts } : record;
}

function countyFipsOf(parcelNodeId: string): string | null {
  const m = /^(\d{5}):/.exec(parcelNodeId);
  return m ? m[1]! : null;
}

// ---------------------------------------------------------------------------
// Per-county mode memory (a switch position, never a fact)
// ---------------------------------------------------------------------------

const MODE_MEMORY_TTL_MS = 10 * 60 * 1000;
const modeMemory = new Map<string, { mode: OneDoorMode; at: number }>();

function rememberMode(countyFips: string | null, mode: OneDoorMode): void {
  if (countyFips) modeMemory.set(countyFips, { mode, at: Date.now() });
}

export function lastKnownOneDoorMode(countyFips: string | null): OneDoorMode {
  if (!countyFips) return "off";
  const hit = modeMemory.get(countyFips);
  if (!hit || Date.now() - hit.at > MODE_MEMORY_TTL_MS) return "off";
  return hit.mode;
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

export type OneDoorFetchResult =
  | { kind: "ok"; status: number; body: unknown }
  | { kind: "not-configured" }
  | { kind: "timeout" }
  | { kind: "network" };

export type OneDoorFetcher = (args: {
  parcelNodeId: string;
  entitlementsHeader: string | null;
  timeoutMs: number;
}) => Promise<OneDoorFetchResult>;

function resolveApiKey(): string | undefined {
  return (
    process.env.HAUSKA_RETRIEVAL_API_KEY?.trim() ||
    process.env.RETRIEVAL_API_KEY?.trim() ||
    process.env.BRIEF_RETRIEVAL_API_KEY?.trim()
  );
}

/** Retrieval base URL and key, or null when this deployment never armed the reader. */
export function oneDoorReaderEndpoint(): { baseUrl: string; key: string } | null {
  const key = resolveApiKey();
  const baseUrl = retrievalBaseUrlFromEnv();
  return key && baseUrl ? { baseUrl, key } : null;
}

const defaultFetcher: OneDoorFetcher = async ({ parcelNodeId, entitlementsHeader, timeoutMs }) => {
  const endpoint = oneDoorReaderEndpoint();
  if (!endpoint) return { kind: "not-configured" };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${endpoint.key}`,
      Accept: "application/json",
    };
    if (entitlementsHeader) headers[ONE_DOOR_ENTITLEMENTS_HEADER] = entitlementsHeader;
    const res = await fetch(
      `${endpoint.baseUrl}/property-nodes/${encodeURIComponent(parcelNodeId)}/record`,
      { method: "GET", headers, signal: controller.signal },
    );
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    return { kind: "ok", status: res.status, body };
  } catch (err) {
    return (err as { name?: string })?.name === "AbortError" ? { kind: "timeout" } : { kind: "network" };
  } finally {
    clearTimeout(timer);
  }
};

let fetcher: OneDoorFetcher = defaultFetcher;

/** Test seam. */
export function setOneDoorFetcherForTests(next: OneDoorFetcher | null): void {
  fetcher = next ?? defaultFetcher;
}

/** Test seam: forget every county's last-seen mode. */
export function resetOneDoorModeMemoryForTests(): void {
  modeMemory.clear();
}

/** Default per-request budget; the reader's own statement timeout is 1.5 s (§2). */
export function oneDoorReaderTimeoutMs(): number {
  const raw = Number(process.env.ONE_DOOR_READER_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 2500;
}

/**
 * Read one parcel from the reader as the END USER (entitlements computed by
 * the caller from the user's plan). Never throws.
 */
export async function readOneDoorRecord(
  parcelNodeId: string,
  opts: { entitlements: readonly string[]; timeoutMs?: number },
): Promise<OneDoorRead> {
  const countyFips = countyFipsOf(parcelNodeId);
  let result: OneDoorFetchResult;
  try {
    result = await fetcher({
      parcelNodeId,
      entitlementsHeader: oneDoorEntitlementsHeaderValue(opts.entitlements),
      timeoutMs: opts.timeoutMs ?? oneDoorReaderTimeoutMs(),
    });
  } catch {
    result = { kind: "network" };
  }
  if (result.kind !== "ok") {
    return { kind: "unavailable", reason: result.kind, mode: lastKnownOneDoorMode(countyFips) };
  }
  const body = asRecord(result.body);
  const errorClass = str(body?.errorClass);
  if (result.status === 404 && errorClass === "parcel-not-found") {
    const mode = isOneDoorMode(body?.mode) ? body.mode : lastKnownOneDoorMode(countyFips);
    rememberMode(countyFips, mode);
    return { kind: "parcel-not-found", mode };
  }
  // 503 read-failed | timeout | store-not-configured: the reader still speaks
  // the contract -- its `facts` are `failed` (never cached) and it states the
  // mode -- so the surface renders those facts like any other read.
  if (
    result.status === 503 &&
    (errorClass === "read-failed" || errorClass === "timeout" || errorClass === "store-not-configured") &&
    body?.contract === ONE_DOOR_CONTRACT &&
    isOneDoorMode(body.mode) &&
    asRecord(body.facts)
  ) {
    const parsed = parseOneDoorRecord(body, parcelNodeId);
    if (parsed) {
      rememberMode(parsed.countyFips ?? countyFips, parsed.mode);
      return { kind: "record", record: enforceOneDoorEntitlements(parsed, opts.entitlements) };
    }
  }
  if (result.status < 200 || result.status >= 300) {
    return { kind: "unavailable", reason: "http-error", mode: lastKnownOneDoorMode(countyFips) };
  }
  const parsed = parseOneDoorRecord(result.body, parcelNodeId);
  if (!parsed) {
    return { kind: "unavailable", reason: "malformed", mode: lastKnownOneDoorMode(countyFips) };
  }
  rememberMode(parsed.countyFips ?? countyFips, parsed.mode);
  return { kind: "record", record: enforceOneDoorEntitlements(parsed, opts.entitlements) };
}

/** The mode a read resolves to. */
export function oneDoorModeOf(read: OneDoorRead): OneDoorMode {
  return read.kind === "record" ? read.record.mode : read.mode;
}

/** A record of `failed` facts for the given rails, for an `on` county whose reader is unreachable. */
export function transportFailedRecord(
  parcelNodeId: string,
  rails: readonly string[],
): OneDoorRecord {
  const facts: Record<string, OneDoorFact> = {};
  for (const rail of rails) {
    facts[rail] = {
      state: "failed",
      words: ONE_DOOR_TRANSPORT_FAILED_WORDS,
      source: { adapter: null, vintage: null, asOf: null },
    };
  }
  return {
    parcelNodeId,
    countyFips: countyFipsOf(parcelNodeId),
    mode: "on",
    readAt: null,
    facts,
  };
}

/** True when any fact on the record is `failed`: the response must not be cached by anyone. */
export function recordHasFailedFact(record: OneDoorRecord): boolean {
  return Object.values(record.facts).some((f) => f.state === "failed");
}
