/**
 * T2-WATCH (Smart Site mobile, 2026-10-22) — change detection for the
 * Watching tab (design screen 5).
 *
 * Every saved property (`pe_saved_properties`) is watched. For each one,
 * `detectWatchChanges` reads the parcel through the ONE-DOOR record read
 * (`readOneDoorRecord`: hauska-engine retrieval `GET /property-nodes/:id/record`,
 * the same reader the card's brief and the stub rails read), AS THE USER
 * (their plan's entitlement header, so plan gating holds), and compares the
 * watched facts with the last snapshot (`pe_watch_snapshots`).
 *
 * Watched facts:
 *   - `flood` (flood zone / FIRM panel)            -> kind "flood_map"
 *   - `zoningDistrict`                              -> kind "zoning_case"
 *   - the CAD appraisal rails (market, assessed, land, improvement value,
 *     value history), plan-gated                   -> kind "appraisal",
 *     titled "Appraisal updated" with NO numbers; the snapshot stores only a
 *     sha256 of a gated value, never the figure
 *   - the user's latest records-request job for the parcel
 *     (`records_request_jobs`, parcel_key `apn:<id>`) -> kind "records_request"
 *   - every other rail the card reads             -> kind "record_update"
 *
 * Honesty rules:
 *   - The FIRST read of a parcel only snapshots. It never alerts.
 *   - Only facts the reader actually stated are compared: `value`,
 *     `not-on-record` and `not-applicable`. `failed`, `not-loaded`, `held`
 *     and `plan-gated` carry the previous snapshot forward unchanged, so an
 *     outage, a plan change (gated -> value) or a pending load never reads
 *     as a change. A rail seen for the first time is snapshotted silently.
 *   - Titles use the reader's own words (rendered verbatim, never composed
 *     from a guess). Sale prices are never watched (`salesHistory` is not a
 *     watched rail).
 *   - A reader that does not speak `one-door-v1` (no facts) or cannot be
 *     reached leaves the snapshot untouched: nothing is compared.
 *
 * Scheduling (`startWatchDetector`, in-process like `peLifecycleDrain.ts`):
 * a tick every `WATCH_DETECT_TICK_MS` (default hourly) re-checks each saved
 * parcel whose last check is older than `WATCH_CHECK_EVERY_MS` (default
 * daily). Each (user, parcel) is CLAIMED with one upsert on
 * `pe_watch_snapshots.checked_at` before it is read, so every instance can run
 * the tick and a parcel is read once per window cluster-wide, with no
 * transaction held across the network read. `WATCH_DETECT_TICK_MS=0`
 * disables the schedule (named, logged).
 *
 * After a run, each user with new changes gets ONE Web Push notification
 * summarising them (`peWebPush.ts`). Push being unconfigured never stops
 * detection.
 */

import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { db, type PeSubscriptionTier, type PeWatchChangeKind } from "@workspace/db";
import {
  oneDoorEntitlementsFor,
  readOneDoorRecord,
  type OneDoorFact,
  type OneDoorRecord,
} from "./oneDoor/oneDoorReaderClient";
import { ONE_DOOR_SURFACE_RAILS } from "./oneDoor/oneDoorSurfaces";
import { getPeEntitlementRow } from "./peIdentity";
import { grantsOwnerCoGatedFields } from "./peEntitlement";
import { sendWatchPushes, type WatchPushChange } from "./peWebPush";
import { logger } from "./logger";

type Log = Pick<typeof logger, "info" | "warn" | "error">;

/** One watched fact in a snapshot: canonical value (or its hash) + the reader's words. */
export type WatchFactEntry = { c: string; w?: string; src?: string; url?: string };
export type WatchFacts = Record<string, WatchFactEntry>;

/** Rails the card reads but that are geometry or identity, not watched facts. */
const NOT_WATCHED = new Set(["apn", "buildingFootprint", "parcelGeometry", "salesHistory"]);

/** The appraisal rails (all plan-gated). */
export const APPRAISAL_RAILS = new Set([
  "marketValue",
  "assessedValue",
  "landValue",
  "improvementValue",
  "valueHistory",
]);

/** Plan-gated rails: stored as a hash only, never with words (words may carry a figure or a name). */
const HASH_ONLY_RAILS = new Set([...APPRAISAL_RAILS, "owner", "exemptionCodes"]);

/** The rails read for a watched parcel. */
export const WATCHED_RAILS: readonly string[] = ONE_DOOR_SURFACE_RAILS.filter(
  (r) => !NOT_WATCHED.has(r),
);

/** Plain labels for "Record updated: …" titles. Unlisted rails use a generic word. */
const RAIL_LABELS: Record<string, string> = {
  situsAddress: "address",
  situsCity: "city",
  situsZip: "ZIP",
  landUseCode: "land use",
  acreageAcres: "acreage",
  cityLimits: "city limits",
  setbackFrontFt: "setbacks",
  setbackSideFt: "setbacks",
  setbackRearFt: "setbacks",
  setbackCornerFt: "setbacks",
  parcelAreaSqFt: "parcel area",
  maxHeightFt: "height limit",
  maxLotCoveragePct: "lot coverage",
  maxFootprintSqFt: "footprint limit",
  maxImperviousCoverPct: "impervious cover",
  owner: "owner",
  exemptionCodes: "exemptions",
  livingAreaSqft: "living area",
  yearBuilt: "year built",
  agValuation: "ag valuation",
  schoolDistrict: "school district",
  utilityService: "utility service",
  specialDistricts: "special districts",
  overlayDistricts: "overlay districts",
  wells: "wells",
  pipelines: "pipelines",
};

const COMPARED_STATES = new Set(["value", "not-on-record", "not-applicable"]);

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const rec = value as Record<string, unknown>;
  return `{${Object.keys(rec)
    .sort()
    .filter((k) => rec[k] !== undefined)
    .map((k) => `${JSON.stringify(k)}:${stableStringify(rec[k])}`)
    .join(",")}}`;
}

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

function httpUrl(v: unknown): string | undefined {
  return typeof v === "string" && /^https?:\/\//i.test(v) ? v : undefined;
}

/** One reader fact -> a snapshot entry, or null when the fact is not a stated fact. */
export function watchEntryFromFact(rail: string, fact: OneDoorFact): WatchFactEntry | null {
  if (!COMPARED_STATES.has(fact.state)) return null;
  const canonical =
    fact.state === "value" ? `v:${stableStringify(fact.value)}` : `s:${fact.state}`;
  if (HASH_ONLY_RAILS.has(rail)) return { c: `h:${sha256(canonical)}` };
  const entry: WatchFactEntry = { c: canonical };
  if (fact.words) entry.w = fact.words;
  if (fact.source.adapter) entry.src = fact.source.adapter;
  const url = httpUrl(fact.detail?.["sourceUrl"]) ?? httpUrl(fact.detail?.["url"]);
  if (url) entry.url = url;
  return entry;
}

/** The watched facts the reader stated on this record. */
export function watchFactsFromRecord(record: OneDoorRecord): WatchFacts {
  const out: WatchFacts = {};
  for (const rail of WATCHED_RAILS) {
    const fact = record.facts[rail];
    if (!fact) continue;
    const entry = watchEntryFromFact(rail, fact);
    if (entry) out[rail] = entry;
  }
  return out;
}

export function hashWatchFacts(facts: WatchFacts): string {
  return sha256(stableStringify(Object.fromEntries(Object.entries(facts).map(([k, v]) => [k, v.c]))));
}

export type DetectedChange = {
  kind: PeWatchChangeKind;
  title: string;
  sourceUrl: string | null;
};

const RECORDS_REQUEST_TITLES: Record<string, string> = {
  complete: "Records request complete",
  "needs-human": "Records request needs a person to finish",
  failed: "Records request couldn't finish",
  "awaiting-purchase-approval": "Records request awaiting your approval",
};

function isFemaSource(src: string | undefined): boolean {
  return Boolean(src && /fema|nfhl|firm/i.test(src));
}

/**
 * Compare the previous snapshot with the new read. Returns the changes and
 * the snapshot to store (previous entries carried forward for rails that the
 * new read did not state).
 */
export function diffWatchFacts(
  prev: WatchFacts,
  next: WatchFacts,
): { changes: DetectedChange[]; merged: WatchFacts } {
  const merged: WatchFacts = { ...prev, ...next };
  const changed = Object.keys(next).filter((k) => prev[k] && prev[k]!.c !== next[k]!.c);
  const changes: DetectedChange[] = [];

  if (changed.includes("flood")) {
    const n = next["flood"]!;
    const lead = isFemaSource(n.src) ? "FEMA flood map change" : "Flood map change";
    changes.push({ kind: "flood_map", title: n.w ? `${lead}: ${n.w}` : lead, sourceUrl: n.url ?? null });
  }
  if (changed.includes("zoningDistrict")) {
    const n = next["zoningDistrict"]!;
    changes.push({
      kind: "zoning_case",
      title: n.w ? `Zoning changed: ${n.w}` : "Zoning changed",
      sourceUrl: n.url ?? null,
    });
  }
  if (changed.some((k) => APPRAISAL_RAILS.has(k))) {
    changes.push({ kind: "appraisal", title: "Appraisal updated", sourceUrl: null });
  }
  if (changed.includes("recordsRequest")) {
    const status = next["recordsRequest"]!.c.split(":").pop() ?? "";
    const title = RECORDS_REQUEST_TITLES[status];
    if (title) changes.push({ kind: "records_request", title, sourceUrl: null });
  }
  const other = changed.filter(
    (k) => k !== "flood" && k !== "zoningDistrict" && k !== "recordsRequest" && !APPRAISAL_RAILS.has(k),
  );
  if (other.length > 0) {
    const labels = [...new Set(other.map((k) => RAIL_LABELS[k] ?? "record"))];
    changes.push({
      kind: "record_update",
      title: `Record updated: ${labels.slice(0, 3).join(", ")}${labels.length > 3 ? ` +${labels.length - 3}` : ""}`,
      sourceUrl: null,
    });
  }
  return { changes, merged };
}

/** The user's plan, as the reader's entitlement list for this parcel. */
async function entitlementsForUser(userId: string, parcelNodeId: string): Promise<string[]> {
  const row = await getPeEntitlementRow(userId);
  const tier: PeSubscriptionTier | null = row.devRole
    ? "team"
    : row.accessTier === "paid"
      ? ((row.subscriptionTier as PeSubscriptionTier | null) ?? "solo")
      : null;
  return oneDoorEntitlementsFor(await grantsOwnerCoGatedFields(userId, tier, parcelNodeId));
}

/** The user's latest records-request job for the parcel, as a watched entry. */
async function recordsRequestEntry(userId: string, parcelNodeId: string): Promise<WatchFactEntry | null> {
  const r = await db.execute<{ id: string; status: string }>(sql`
    SELECT id::text AS id, status FROM records_request_jobs
     WHERE user_id = ${userId} AND parcel_key = ${`apn:${parcelNodeId}`}
     ORDER BY created_at DESC LIMIT 1`);
  const row = r.rows[0];
  return row ? { c: `rr:${row.id}:${row.status}` } : null;
}

/** Read seam (tests replace the record read; production is the one-door reader). */
export type WatchRead = (args: {
  userId: string;
  parcelNodeId: string;
}) => Promise<WatchFacts | null>;

const defaultRead: WatchRead = async ({ userId, parcelNodeId }) => {
  const entitlements = await entitlementsForUser(userId, parcelNodeId);
  const read = await readOneDoorRecord(parcelNodeId, { entitlements });
  if (read.kind !== "record") return null;
  const facts = watchFactsFromRecord(read.record);
  return Object.keys(facts).length > 0 ? facts : null;
};

export type DetectWatchOptions = {
  /** Re-check every saved parcel now, ignoring the per-parcel window (manual trigger, tests). */
  force?: boolean;
  now?: Date;
  /** Cap on parcels read this run. */
  limit?: number;
  /** Send push notifications for new changes (default true). */
  push?: boolean;
  read?: WatchRead;
  log?: Log;
};

export type DetectWatchResult = {
  checked: number;
  firstSnapshots: number;
  unreadable: number;
  changes: number;
  usersNotified: number;
  pushSent: number;
  pushDropped: number;
  pushFailed: number;
  pushConfigured: boolean;
};

function checkEveryMs(): number {
  const raw = Number(process.env["WATCH_CHECK_EVERY_MS"]);
  return Number.isFinite(raw) && raw > 0 ? raw : 24 * 60 * 60 * 1000;
}

function maxPerRun(): number {
  const raw = Number(process.env["WATCH_MAX_PARCELS_PER_RUN"]);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 500;
}

/**
 * Run change detection for every saved property (or one user's). Writes
 * changes and new snapshots; sends one push per user with new changes.
 */
export async function detectWatchChanges(
  userId?: string,
  opts: DetectWatchOptions = {},
): Promise<DetectWatchResult> {
  const now = opts.now ?? new Date();
  const read = opts.read ?? defaultRead;
  const log = opts.log ?? logger;
  const cutoff = opts.force ? new Date(now.getTime() + 1000) : new Date(now.getTime() - checkEveryMs());
  const limit = opts.limit ?? maxPerRun();
  const result: DetectWatchResult = {
    checked: 0,
    firstSnapshots: 0,
    unreadable: 0,
    changes: 0,
    usersNotified: 0,
    pushSent: 0,
    pushDropped: 0,
    pushFailed: 0,
    pushConfigured: false,
  };

  const due = await db.execute<{ owner_user_id: string; parcel_node_id: string; label: string | null }>(sql`
    SELECT sp.owner_user_id, sp.parcel_node_id, max(sp.label) AS label
      FROM pe_saved_properties sp
      LEFT JOIN pe_watch_snapshots ws
        ON ws.owner_user_id = sp.owner_user_id AND ws.parcel_node_id = sp.parcel_node_id
     WHERE (${userId ?? null}::text IS NULL OR sp.owner_user_id = ${userId ?? null}::text)
       AND (ws.id IS NULL OR ws.checked_at < ${cutoff.toISOString()}::timestamptz)
     GROUP BY sp.owner_user_id, sp.parcel_node_id, ws.checked_at
     ORDER BY ws.checked_at ASC NULLS FIRST, sp.owner_user_id, sp.parcel_node_id
     LIMIT ${limit}`);

  const newChanges: WatchPushChange[] = [];

  for (const row of due.rows) {
    const owner = row.owner_user_id;
    const parcel = row.parcel_node_id;
    // Claim: insert, or move checked_at forward only if still due. A peer
    // instance that claimed it first makes this return no row.
    const claim = await db.execute<{ facts_hash: string | null; facts: WatchFacts }>(sql`
      INSERT INTO pe_watch_snapshots (owner_user_id, parcel_node_id, checked_at)
      VALUES (${owner}, ${parcel}, ${now.toISOString()}::timestamptz)
      ON CONFLICT (owner_user_id, parcel_node_id) DO UPDATE
        SET checked_at = EXCLUDED.checked_at
        WHERE pe_watch_snapshots.checked_at < ${cutoff.toISOString()}::timestamptz
      RETURNING facts_hash, facts`);
    const prevRow = claim.rows[0];
    if (!prevRow) continue;
    result.checked += 1;

    let facts: WatchFacts | null;
    try {
      facts = await read({ userId: owner, parcelNodeId: parcel });
    } catch (err) {
      log.warn({ err, parcelNodeId: parcel }, "watching: record read failed");
      facts = null;
    }
    if (!facts) {
      result.unreadable += 1;
      continue;
    }
    const rr = await recordsRequestEntry(owner, parcel);
    if (rr) facts["recordsRequest"] = rr;

    const first = prevRow.facts_hash === null;
    const prev = (prevRow.facts ?? {}) as WatchFacts;
    const { changes, merged } = first ? { changes: [], merged: facts } : diffWatchFacts(prev, facts);
    if (first) result.firstSnapshots += 1;

    await db.transaction(async (tx) => {
      for (const ch of changes) {
        const ins = await tx.execute<{ id: string }>(sql`
          INSERT INTO pe_watch_changes (owner_user_id, parcel_node_id, kind, title, detected_at, source_url)
          VALUES (${owner}, ${parcel}, ${ch.kind}, ${ch.title}, ${now.toISOString()}::timestamptz, ${ch.sourceUrl})
          RETURNING id::text AS id`);
        newChanges.push({
          id: ins.rows[0]!.id,
          userId: owner,
          parcelNodeId: parcel,
          address: watchAddress(row.label, merged),
          kind: ch.kind,
          title: ch.title,
        });
      }
      await tx.execute(sql`
        UPDATE pe_watch_snapshots
           SET facts = ${JSON.stringify(merged)}::jsonb,
               facts_hash = ${hashWatchFacts(merged)},
               last_read_at = ${now.toISOString()}::timestamptz
         WHERE owner_user_id = ${owner} AND parcel_node_id = ${parcel}`);
    });
    result.changes += changes.length;
  }

  if (opts.push !== false && newChanges.length > 0) {
    const push = await sendWatchPushes(newChanges, { log });
    result.pushConfigured = push.configured;
    result.usersNotified = push.usersNotified;
    result.pushSent = push.sent;
    result.pushDropped = push.dropped;
    result.pushFailed = push.failed;
  }
  log.info({ ...result, userId: userId ?? null }, "watching: detection run");
  return result;
}

/** The parcel's address: the saved label, else the reader's situs words. */
export function watchAddress(label: string | null | undefined, facts: WatchFacts | null | undefined): string | null {
  const l = label?.trim();
  if (l) return l;
  const w = facts?.["situsAddress"]?.w?.trim();
  return w || null;
}

// ---------------------------------------------------------------------------
// Schedule (in-process, every instance; the per-row claim dedupes)
// ---------------------------------------------------------------------------

let timer: ReturnType<typeof setInterval> | null = null;
let bootTimer: ReturnType<typeof setTimeout> | null = null;
let inFlight = false;

export async function watchDetectorKick(log: Log): Promise<void> {
  if (inFlight) {
    log.warn("watching: tick skipped — previous tick still running");
    return;
  }
  inFlight = true;
  try {
    await detectWatchChanges(undefined, { log });
  } catch (err) {
    log.error({ err }, "watching: tick threw");
  } finally {
    inFlight = false;
  }
}

/** Start the detector. `WATCH_DETECT_TICK_MS=0` disables it (named, logged). */
export function startWatchDetector(log: Log): void {
  if (timer !== null || bootTimer !== null) return;
  const tickMs = Number(process.env["WATCH_DETECT_TICK_MS"] ?? 60 * 60 * 1000);
  if (!Number.isFinite(tickMs) || tickMs <= 0) {
    log.warn({ tickMs }, "watching: detector DISABLED by WATCH_DETECT_TICK_MS");
    return;
  }
  const bootDelayMs = Number(process.env["WATCH_DETECT_BOOT_DELAY_MS"] ?? 5 * 60 * 1000);
  bootTimer = setTimeout(() => {
    bootTimer = null;
    void watchDetectorKick(log);
    timer = setInterval(() => void watchDetectorKick(log), tickMs);
    timer.unref();
  }, Math.max(0, Number.isFinite(bootDelayMs) ? bootDelayMs : 0));
  bootTimer.unref();
  log.info({ tickMs, bootDelayMs, checkEveryMs: checkEveryMs() }, "watching: detector started");
}

export function stopWatchDetector(): void {
  if (bootTimer) clearTimeout(bootTimer);
  if (timer) clearInterval(timer);
  bootTimer = null;
  timer = null;
  inFlight = false;
}
