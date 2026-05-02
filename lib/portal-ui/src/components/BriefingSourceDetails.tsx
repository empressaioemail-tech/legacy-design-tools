import { useMemo, useState } from "react";
import {
  getGetLocalSetbackTableQueryKey,
  useGetLocalSetbackTable,
  type EngagementBriefingSource,
  type LocalSetbackDistrict,
} from "@workspace/api-client-react";
import {
  evaluateRowFreshness,
  type ProvenanceTier,
  type SnapshotFreshnessVerdict,
} from "../lib/briefingSourceHelpers";

/**
 * "View layer details" panel for one adapter-driven briefing source row.
 *
 * Renders the structured `payload` the adapter persisted (zoning
 * district, parcel id, FEMA flood-zone code, etc.) inline beneath the
 * source row in the Site Context tab — the architect's "what does my
 * parcel look like to the code" workflow without leaving the
 * engagement detail page.
 *
 * Rendering strategy:
 *   - Switch on `payload.kind` (the discriminator every adapter sets:
 *     `parcel`, `zoning`, `floodplain`, `roads`, `address-point`,
 *     `elevation-contours`, `edwards-aquifer`).
 *   - For each known kind, surface the highlights (e.g. the zoning
 *     district code, the in/out floodplain bool + FEMA fields) via
 *     {@link AttributesGrid} which prefers a small whitelist of
 *     well-known field names but falls back to the raw `attributes`
 *     dictionary so an adapter that returns an unexpected field name
 *     is still visible.
 *   - For `local`-tier zoning rows, also fetch the matching setback
 *     table from `GET /local/setbacks/{jurisdictionKey}` and render
 *     the front/rear/side/height/coverage row that corresponds to the
 *     reported zoning district. The jurisdiction key is extracted
 *     from `provider`, which the generate-layers route packs as
 *     `<adapterKey> (<providerLabel>)` (e.g.
 *     `grand-county-ut:zoning (Grand County, UT GIS)`).
 *
 * Manual-upload rows never reach this component — `BriefingSourceRow`
 * gates the expander on `sourceKind !== "manual-upload"`.
 */
export function BriefingSourceDetails({
  source,
  onRerunStaleAdapter = null,
  isRerunningStaleAdapter = false,
  rerunStaleAdapterError = null,
  rerunStaleAdapterSuccessAt = null,
}: {
  source: EngagementBriefingSource;
  /**
   * Task #255 — when the parent passes a callback, the stale-snapshot
   * badge inside `ProvenanceFooter` renders a paired "Re-run" button
   * that hands back the adapter key parsed out of the row's packed
   * `provider` string (`<adapterKey> (<provider-label>)`). The parent
   * (`EngagementDetail`) fires the same `useGenerateEngagementLayers`
   * mutation but with `?adapterKey=<key>&forceRefresh=true`, so the
   * architect can refresh just the stale layer in one click without
   * leaving the engagement. `null` (the default) renders the badge
   * without an action — used by tests + by surfaces that don't have
   * a mutation in scope.
   */
  onRerunStaleAdapter?: ((adapterKey: string) => void) | null;
  /**
   * Task #255 — true while the single-layer rerun mutation for THIS
   * row's adapter key is in flight. Drives the button's disabled +
   * label state without needing the badge to inspect the mutation's
   * `variables` shape directly.
   */
  isRerunningStaleAdapter?: boolean;
  /**
   * Task #255 — human-readable error message to show under the badge
   * when the most recent rerun for this row's adapter failed (e.g.
   * upstream timeout, no_applicable_adapters). `null` while idle or
   * after a successful rerun.
   */
  rerunStaleAdapterError?: string | null;
  /**
   * Task #271 — wall-clock millis at which the most recent rerun
   * targeting THIS row's adapter key resolved successfully. The
   * parent (`EngagementDetail`) gates this on
   * `lastRerunSuccessAt.adapterKey === thisRowKey` so a successful
   * rerun on a sibling adapter can never flash a "Refreshed just now"
   * confirmation on this row. The footer renders a transient pill
   * when set; the parent owns the timer that clears the value back to
   * `null` after the affordance window (~4s) so the pill auto-fades
   * without the row needing its own timer.
   */
  rerunStaleAdapterSuccessAt?: number | null;
}) {
  const payload = (source.payload ?? {}) as Record<string, unknown>;
  const kind =
    typeof payload["kind"] === "string"
      ? (payload["kind"] as string)
      : "unknown";
  const jurisdictionKey = useMemo(
    () => extractJurisdictionKey(source.provider),
    [source.provider],
  );
  const reportedDistrict = useMemo(
    () => (kind === "zoning" ? extractZoningDistrict(payload) : null),
    [kind, payload],
  );

  return (
    <div
      data-testid={`briefing-source-details-${source.id}`}
      style={{
        marginTop: 8,
        paddingTop: 8,
        borderTop: "1px dashed var(--border-subtle)",
        display: "flex",
        flexDirection: "column",
        gap: 10,
        fontSize: 12,
        color: "var(--text-primary)",
      }}
    >
      <div
        style={{
          display: "flex",
          gap: 8,
          alignItems: "baseline",
          flexWrap: "wrap",
        }}
      >
        <span
          style={{
            fontSize: 11,
            color: "var(--text-muted)",
            textTransform: "uppercase",
            letterSpacing: 0.4,
          }}
        >
          Layer payload
        </span>
        <span
          style={{
            fontSize: 11,
            color: "var(--text-secondary)",
          }}
        >
          {kind}
        </span>
      </div>

      <KindBody source={source} />

      {/* Show "as of <snapshot date> · source: <provider>" beneath
       * every adapter-driven KindBody branch — generalized from
       * federal-only (Task #209) to all adapter kinds (Task #221) so
       * auditors get the same provenance trail for local zoning,
       * parcels, floodplain features, etc. The `unknown` branch
       * (RawPayload fallback) is suppressed since we have no
       * structured body to attach it to. */}
      {kind !== "unknown" && (
        <ProvenanceFooter
          source={source}
          onRerunStaleAdapter={onRerunStaleAdapter}
          isRerunningStaleAdapter={isRerunningStaleAdapter}
          rerunStaleAdapterError={rerunStaleAdapterError}
          rerunStaleAdapterSuccessAt={rerunStaleAdapterSuccessAt}
        />
      )}

      {/* Federal-only one-line markdown digest button. Rendered
       * outside KindBody so the order stays
       * `[summary, footer, copy button]` — matching the layout
       * established in Task #209 — even now that the footer is
       * hoisted up to the parent. `CopySummaryButton` returns null
       * for non-federal payloads so this is a no-op for them. */}
      <CopySummaryButton source={source} />

      {source.sourceKind === "local-adapter" &&
        kind === "zoning" &&
        jurisdictionKey && (
          <SetbackPanel
            sourceId={source.id}
            jurisdictionKey={jurisdictionKey}
            reportedDistrict={reportedDistrict}
            snapshotDate={source.snapshotDate}
          />
        )}
    </div>
  );
}

function KindBody({ source }: { source: EngagementBriefingSource }) {
  const payload = (source.payload ?? {}) as Record<string, unknown>;
  const kind =
    typeof payload["kind"] === "string"
      ? (payload["kind"] as string)
      : "unknown";
  switch (kind) {
    case "parcel": {
      const parcel = payload["parcel"];
      if (!parcel || typeof parcel !== "object") {
        return (
          <EmptyHint>
            No parcel polygon at this lat/lng (likely public land).
          </EmptyHint>
        );
      }
      return (
        <AttributesGrid
          source={parcel as Record<string, unknown>}
          highlightFields={[
            "PARCEL_ID",
            "PARCELID",
            "PARCEL_NO",
            "OBJECTID",
            "Acres",
            "ACRES",
            "OWNER",
          ]}
        />
      );
    }
    case "zoning": {
      const zoning = payload["zoning"];
      if (!zoning || typeof zoning !== "object") {
        return <EmptyHint>No zoning polygon at this lat/lng.</EmptyHint>;
      }
      return (
        <AttributesGrid
          source={zoning as Record<string, unknown>}
          highlightFields={[
            "ZONING",
            "ZONE",
            "ZONE_DIST",
            "DISTRICT",
            "ZONE_TYPE",
            "ZONE_CLASS",
            "ZoningClass",
            "ZONING_CODE",
            "district",
          ]}
        />
      );
    }
    case "floodplain": {
      const inMapped = payload["inMappedFloodplain"];
      const features = payload["features"];
      const firstFeature =
        Array.isArray(features) && features.length > 0
          ? (features[0] as Record<string, unknown>)
          : null;
      return (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <KvRow
            label="In mapped FEMA floodplain"
            value={
              typeof inMapped === "boolean" ? (inMapped ? "Yes" : "No") : "—"
            }
          />
          {firstFeature && (
            <AttributesGrid
              source={firstFeature}
              highlightFields={[
                "FLD_ZONE",
                "ZONE_SUBTY",
                "FLD_AR_ID",
                "FIRM_PANEL",
                "EFF_DATE",
                "STATIC_BFE",
              ]}
            />
          )}
        </div>
      );
    }
    case "edwards-aquifer": {
      return (
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <KvRow
            label="In Edwards Aquifer recharge zone"
            value={payload["inRecharge"] ? "Yes" : "No"}
          />
          <KvRow
            label="In Edwards Aquifer contributing zone"
            value={payload["inContributing"] ? "Yes" : "No"}
          />
        </div>
      );
    }
    case "elevation-contours": {
      const featureCount = payload["featureCount"];
      return (
        <KvRow
          label="Elevation contour features"
          value={
            typeof featureCount === "number" ? String(featureCount) : "0"
          }
        />
      );
    }
    case "roads": {
      const source = payload["source"];
      const features = payload["features"];
      const elements = payload["elements"];
      const count = Array.isArray(features)
        ? features.length
        : Array.isArray(elements)
          ? elements.length
          : 0;
      return (
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <KvRow
            label="Source"
            value={typeof source === "string" ? source : "—"}
          />
          <KvRow label="Road features within radius" value={String(count)} />
        </div>
      );
    }
    case "address-point": {
      const feature = payload["feature"];
      if (!feature || typeof feature !== "object") {
        return <EmptyHint>No address point at this lat/lng.</EmptyHint>;
      }
      return (
        <AttributesGrid
          source={feature as Record<string, unknown>}
          highlightFields={[
            "FullAdd",
            "AddNum",
            "PrefixDir",
            "StreetName",
            "StreetType",
            "City",
            "ZipCode",
            "ZIP",
          ]}
        />
      );
    }
    case "flood-zone":
      return <FemaFloodZoneSummary payload={payload} />;
    case "elevation-point":
      return <UsgsElevationSummary payload={payload} />;
    case "ejscreen-blockgroup":
      return <EpaEjscreenSummary payload={payload} />;
    case "broadband-availability":
      return <FccBroadbandSummary payload={payload} />;
    default:
      return <RawPayload payload={payload} />;
  }
}

function CopySummaryButton({ source }: { source: EngagementBriefingSource }) {
  const markdown = useMemo(
    () => formatFederalSummaryMarkdown(source),
    [source],
  );
  if (!markdown) return null;
  return (
    <CopyMarkdownButton
      markdown={markdown}
      testId={`briefing-source-copy-summary-${source.id}`}
    />
  );
}

/**
 * Generic "Copy summary" button that writes a pre-built markdown
 * digest to the clipboard. Shared by the federal-adapter row summary
 * and the local-tier setback panel — both surface the same one-line
 * affordance ("Copied!" / "Copy failed" feedback that resets after
 * 1.5s) so reviewers can drop the digest into chat or a code-review
 * note without retyping the values.
 */
function CopyMarkdownButton({
  markdown,
  testId,
}: {
  markdown: string;
  testId: string;
}) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(markdown);
      setState("copied");
      setTimeout(() => setState("idle"), 1500);
    } catch {
      setState("failed");
      setTimeout(() => setState("idle"), 1500);
    }
  }

  const label =
    state === "copied"
      ? "Copied!"
      : state === "failed"
        ? "Copy failed"
        : "Copy summary";

  return (
    <button
      type="button"
      onClick={copy}
      data-testid={testId}
      title={markdown}
      style={{
        alignSelf: "flex-start",
        fontSize: 11,
        padding: "4px 8px",
        borderRadius: 4,
        border: "1px solid var(--border-subtle)",
        background: "var(--surface-muted)",
        color: "var(--text-secondary)",
        cursor: "pointer",
      }}
    >
      {label}
    </button>
  );
}

/**
 * "as of <snapshot date> · source: <provider>" footer rendered
 * beneath every adapter-driven KindBody so auditors can see at a
 * glance how fresh the value is and which dataset version it came
 * from. Generalized from federal-only (Task #209) to all adapter
 * kinds (Task #221) — local zoning, parcels, floodplain features,
 * Edwards Aquifer, etc. — since the same provenance trail is just
 * as useful there.
 *
 * Returns null when both `snapshotDate` and `provider` are absent
 * (older rows persisted before adapters started stamping these
 * fields) so the footer never renders empty.
 */
function ProvenanceFooter({
  source,
  onRerunStaleAdapter = null,
  isRerunningStaleAdapter = false,
  rerunStaleAdapterError = null,
  rerunStaleAdapterSuccessAt = null,
}: {
  source: EngagementBriefingSource;
  onRerunStaleAdapter?: ((adapterKey: string) => void) | null;
  isRerunningStaleAdapter?: boolean;
  rerunStaleAdapterError?: string | null;
  rerunStaleAdapterSuccessAt?: number | null;
}) {
  // Reuse the same `formatSnapshotDate` helper the federal-summary
  // markdown digest uses (Task #210) so the YYYY-MM-DD value the
  // footer shows is byte-identical to the one the architect copies
  // out into a code-review note. The generated client types
  // `snapshotDate` as `Date` but the wire shape is an ISO string.
  const snapshot = formatSnapshotDate(
    source.snapshotDate as unknown as string | null | undefined,
  );
  const provider =
    typeof source.provider === "string" && source.provider.trim().length > 0
      ? source.provider.trim()
      : null;
  // V1-2 Phase 1A decision (d-ii): the per-tier freshness probe lives
  // in `briefingSourceHelpers.ts` so the row-level affordance gate
  // and this footer-level badge both call into the same pure helper.
  // For non-adapter layer kinds, missing/malformed dates, or
  // future-dated snapshots, the helper returns `null` and we fall
  // through to the original "as of … · source: …" footer with no
  // badge. Memoize on the inputs that drive the helper.
  const freshness = useMemo<{
    tier: ProvenanceTier;
    verdict: SnapshotFreshnessVerdict;
  } | null>(
    () => evaluateRowFreshness(source),
    [source.layerKind, source.snapshotDate],
  );
  // Task #255 — recover the original adapterKey from the row's packed
  // `provider` string. The generate-layers route writes
  // `<adapterKey> (<provider-label>)`, so the adapterKey is everything
  // before the first " (". `extractAdapterKeyFromProvider` enforces a
  // namespace `:` prefix so a manual-upload row (or a malformed
  // provider) cannot accidentally surface a re-run affordance whose
  // key the backend would 422 on. Now that Task #254 generalized the
  // stale-badge across all three tiers, the rerun pairing rides along
  // for any tier whose provider string follows the packed convention.
  const adapterKeyForRerun = useMemo(
    () => extractAdapterKeyFromProvider(source.provider),
    [source.provider],
  );
  // The re-run pairing is only meaningful when (a) the parent wired a
  // mutation callback, and (b) we successfully recovered an adapterKey
  // from the provider — without one the backend would reject the
  // ?adapterKey=… scope.
  const showRerunAction =
    onRerunStaleAdapter !== null && adapterKeyForRerun !== null;
  if (!snapshot && !provider) return null;
  return (
    <div
      data-testid={`briefing-source-provenance-${source.id}`}
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 4,
        marginTop: 2,
      }}
    >
      {snapshot && <span>as of {snapshot}</span>}
      {snapshot && provider && <span aria-hidden="true">·</span>}
      {provider && <span>source: {provider}</span>}
      {freshness?.verdict.isStale && (
        <SnapshotStaleBadge
          sourceId={source.id}
          tier={freshness.tier}
          freshness={freshness.verdict}
          onRerun={
            showRerunAction
              ? () => onRerunStaleAdapter!(adapterKeyForRerun!)
              : null
          }
          adapterKey={showRerunAction ? adapterKeyForRerun : null}
          isRerunning={isRerunningStaleAdapter}
        />
      )}
      {/*
        Task #255 — surface the most recent rerun failure inline below
        the badge so the architect sees *why* the click didn't take.
        Rendered only when the mutation actually targeted this row's
        adapterKey (the parent gates `rerunStaleAdapterError` on that),
        so an unrelated full-run failure can't leak into this row's
        footer.
      */}
      {freshness?.verdict.isStale &&
        showRerunAction &&
        rerunStaleAdapterError !== null && (
          <span
            role="alert"
            data-testid={`briefing-source-${freshness.tier}-rerun-error-${source.id}`}
            style={{
              fontSize: 11,
              color: "var(--danger-text, #b00020)",
            }}
          >
            Couldn't re-run this layer: {rerunStaleAdapterError}
          </span>
        )}
      {/*
        Task #271 — transient "Refreshed just now" pill rendered when
        the most recent rerun targeting THIS row's adapterKey resolved
        successfully. The parent (`EngagementDetail`) owns both the
        per-adapter scoping (so a sibling rerun can't flash success
        here) AND the auto-clear timer (so the pill fades back to
        nothing after ~4s). We render unconditionally on the prop —
        no freshness gate — because by the time success lands the
        briefing query has refetched and `freshness.verdict.isStale`
        already flipped to false on the new row, so the stale badge
        is naturally gone. The pill closes the loop visually so the
        architect doesn't double-click thinking nothing happened.
      */}
      {rerunStaleAdapterSuccessAt !== null && (
        <span
          role="status"
          aria-live="polite"
          data-testid={`briefing-source-rerun-success-${source.id}`}
          // Keyed on the success timestamp so React re-mounts the node
          // when the parent stamps a fresh success — that resets the
          // CSS transition / opacity from scratch instead of trying
          // to crossfade back from a half-faded state.
          key={rerunStaleAdapterSuccessAt}
          style={{
            alignSelf: "flex-start",
            fontSize: 11,
            padding: "1px 8px",
            borderRadius: 999,
            background: "var(--success-dim, #e6f7ec)",
            color: "var(--success-text, #1a6b3a)",
            border: "1px solid var(--success-border, #b8e6c9)",
            lineHeight: 1.4,
            // Fade-in then fade-out within the parent's ~4s success
            // window so the pill announces itself, holds, and then
            // gracefully disappears just before the parent clears
            // the prop back to null.
            animation: "sc-rerun-success-fade 4s ease-in-out forwards",
          }}
        >
          Refreshed just now
        </span>
      )}
      {rerunStaleAdapterSuccessAt !== null && (
        // Inline keyframes scoped via a unique animation name so the
        // pill doesn't depend on a global CSS file (mirrors the
        // pattern `SnapshotStaleBadge` already uses for its spinner).
        <style>{`@keyframes sc-rerun-success-fade {
          0% { opacity: 0; transform: translateY(-2px); }
          12% { opacity: 1; transform: translateY(0); }
          85% { opacity: 1; transform: translateY(0); }
          100% { opacity: 0; transform: translateY(-1px); }
        }`}</style>
      )}
    </div>
  );
}

/**
 * Small inline "snapshot is N months old" badge rendered next to the
 * provenance footer when the snapshot is older than the per-dataset
 * adapter-declared freshness window. Used uniformly for federal
 * (Task #222), state, and local (Task #254) tiers — the tier only
 * influences the testid suffix the e2e tests assert on; the visible
 * label and aria-label are tier-agnostic so a screen-reader user
 * gets the same warning regardless of which dataset triggered it.
 *
 * Accessibility: the staleness signal is *not* color-only — the dot
 * is paired with a literal "snapshot is N months old" label and an
 * `aria-label` that names the dataset's threshold ("snapshot is 14
 * months old; freshness window is 12 months"), so a screen reader
 * picks up the warning even when the amber dot is invisible. The
 * dot itself is `aria-hidden` since the text already conveys the
 * same meaning.
 */
function SnapshotStaleBadge({
  sourceId,
  tier,
  freshness,
  onRerun = null,
  adapterKey = null,
  isRerunning = false,
}: {
  sourceId: string;
  tier: ProvenanceTier;
  freshness: SnapshotFreshnessVerdict;
  /**
   * Task #255 — when set, render a small "Re-run" button next to the
   * stale pill. Clicking it calls `onRerun()`; the parent owns the
   * mutation and supersession contract. `null` keeps the badge as a
   * pure status indicator (the legacy Task #222 behavior).
   */
  onRerun?: (() => void) | null;
  /**
   * Task #255 — adapterKey surfaced on the button as a `data-*`
   * attribute + tooltip so QA / e2e can pin which adapter the click
   * targets without mocking the parent's `extractAdapterKeyFromProvider`
   * extraction.
   */
  adapterKey?: string | null;
  /**
   * Task #255 — true while a rerun targeting THIS adapterKey is in
   * flight. Drives the spinner label + disabled state.
   */
  isRerunning?: boolean;
}) {
  const { ageMonths, thresholdMonths } = freshness;
  // Round small / huge ages into a reader-friendly label. Snapshots
  // older than 24 months drop down to "~Ny" because "snapshot is 47
  // months old" is harder to scan than "snapshot is ~4y old".
  const ageLabel =
    ageMonths >= 24
      ? `~${Math.floor(ageMonths / 12)}y`
      : `${ageMonths} month${ageMonths === 1 ? "" : "s"}`;
  const ariaLabel = `Snapshot is ${ageLabel} old; freshness window is ${thresholdMonths} months. Re-run the adapter to refresh.`;
  const showRerun = onRerun !== null;
  // Wrap badge + button in an inline-flex group so they sit visually
  // together as one unit, regardless of whether the surrounding
  // provenance row wraps onto a new line.
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
      }}
    >
      <span
        role="status"
        data-testid={`briefing-source-${tier}-stale-${sourceId}`}
        aria-label={ariaLabel}
        title={ariaLabel}
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 4,
          padding: "1px 6px",
          borderRadius: 999,
          // Warning palette borrowed from the existing var(--warn-*)
          // tokens used elsewhere on the engagement page; falls back
          // to amber-ish defaults for surfaces that haven't defined
          // them yet so the badge degrades gracefully.
          background: "var(--warn-dim, #fff4e5)",
          color: "var(--warn-text, #8a4b00)",
          border: "1px solid var(--warn-border, #f5c98c)",
          fontSize: 11,
          lineHeight: 1.4,
        }}
      >
        <span
          aria-hidden="true"
          style={{
            width: 6,
            height: 6,
            borderRadius: "50%",
            background: "var(--warn-text, #b86e00)",
            display: "inline-block",
          }}
        />
        <span>snapshot is {ageLabel} old</span>
      </span>
      {showRerun && (
        // Task #255 — paired "Re-run" button. Rendered as a small
        // underlined link to match the row's existing
        // "View layer details" / "View history" / "Refresh this
        // layer" controls so it doesn't compete visually with the
        // page-level Generate Layers CTA. The aria-label echoes the
        // adapter-key target so a screen reader announces *which*
        // layer is about to be refreshed, and `aria-busy` flips
        // while the mutation is in flight so assistive tech can
        // pick up the spinner state.
        <button
          type="button"
          onClick={() => onRerun!()}
          disabled={isRerunning}
          aria-busy={isRerunning}
          data-testid={`briefing-source-${tier}-rerun-${sourceId}`}
          data-adapter-key={adapterKey ?? ""}
          aria-label={
            adapterKey
              ? `Re-run the ${adapterKey} adapter to refresh this layer`
              : "Re-run this layer to refresh the snapshot"
          }
          title={
            adapterKey
              ? `Re-fetch this layer live from the upstream feed (adapter: ${adapterKey}). Other adapters are not re-run.`
              : "Re-fetch this layer live from the upstream feed. Other adapters are not re-run."
          }
          style={{
            background: "transparent",
            border: "none",
            padding: 0,
            cursor: isRerunning ? "not-allowed" : "pointer",
            fontSize: 11,
            color: "var(--info-text, #0b5cad)",
            textDecoration: "underline",
            opacity: isRerunning ? 0.5 : 1,
          }}
        >
          {isRerunning ? (
            <span
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 4,
              }}
            >
              <span
                aria-hidden="true"
                data-testid={`briefing-source-${tier}-rerun-spinner-${sourceId}`}
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: "50%",
                  border: "1.5px solid currentColor",
                  borderRightColor: "transparent",
                  display: "inline-block",
                  animation: "sc-rerun-spin 0.8s linear infinite",
                }}
              />
              <span>Re-running…</span>
            </span>
          ) : (
            "Re-run"
          )}
        </button>
      )}
      {showRerun && (
        // Inline keyframes so the spinner doesn't depend on a global
        // CSS file. Scoped via the unique animation name so it can
        // coexist with any other in-app spinners.
        <style>{`@keyframes sc-rerun-spin { to { transform: rotate(360deg); } }`}</style>
      )}
    </span>
  );
}

/**
 * One-line-per-field summary for the FEMA NFHL adapter
 * (`lib/adapters/src/federal/fema-nfhl.ts`).
 *
 * The adapter persists `floodZone: null` + `features: []` for parcels
 * that fall outside any mapped flood zone — surface that explicitly
 * rather than rendering empty rows, since "no mapped zone" is a
 * meaningful answer in the architect's workflow (treat as Zone X).
 */
function FemaFloodZoneSummary({
  payload,
}: {
  payload: Record<string, unknown>;
}) {
  const floodZone = payload["floodZone"];
  const features = payload["features"];
  const noFeatures = Array.isArray(features) && features.length === 0;
  if ((floodZone === null || floodZone === undefined) && noFeatures) {
    return (
      <EmptyHint>
        Parcel does not intersect a mapped FEMA flood zone (treat as Zone X).
      </EmptyHint>
    );
  }
  const inSfha = payload["inSpecialFloodHazardArea"];
  const zoneSubtype = payload["zoneSubtype"];
  const bfe = payload["baseFloodElevation"];
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <KvRow
        label="FEMA flood zone"
        value={typeof floodZone === "string" ? floodZone : "—"}
      />
      <KvRow
        label="Special Flood Hazard Area"
        value={typeof inSfha === "boolean" ? (inSfha ? "Yes" : "No") : "—"}
      />
      {typeof zoneSubtype === "string" && zoneSubtype.length > 0 && (
        <KvRow label="Zone subtype" value={zoneSubtype} />
      )}
      {typeof bfe === "number" && (
        <KvRow label="Base flood elevation" value={`${bfe} ft`} />
      )}
    </div>
  );
}

/**
 * Summary for the USGS NED elevation adapter
 * (`lib/adapters/src/federal/usgs-ned.ts`).
 *
 * The adapter requests EPQS in feet and surfaces the literal `units`
 * string so we don't hard-code "ft" here — if a future caller flips
 * the request to meters the summary follows. `elevationFeet: null` is
 * the adapter's "off-raster" sentinel and gets a graceful hint.
 */
function UsgsElevationSummary({
  payload,
}: {
  payload: Record<string, unknown>;
}) {
  const elevation = payload["elevationFeet"];
  if (elevation === null || elevation === undefined) {
    return (
      <EmptyHint>
        USGS NED has no elevation value at this point (off-raster).
      </EmptyHint>
    );
  }
  const units = payload["units"];
  const unitsLabel =
    typeof units === "string" && units.length > 0 ? units : "Feet";
  return (
    <KvRow
      label="Elevation"
      value={
        typeof elevation === "number"
          ? `${elevation} ${unitsLabel}`
          : String(elevation)
      }
    />
  );
}

/** EPA EJScreen percentile fields the adapter promotes onto the
 * top-level payload, in the order they should be considered for the
 * "top percentiles" summary. */
const EJSCREEN_PERCENTILE_FIELDS: ReadonlyArray<{
  key: string;
  label: string;
}> = [
  { key: "demographicIndexPercentile", label: "Demographic index" },
  { key: "pm25Percentile", label: "PM2.5" },
  { key: "ozonePercentile", label: "Ozone" },
  { key: "leadPaintPercentile", label: "Lead paint" },
];

/**
 * Summary for the EPA EJScreen adapter
 * (`lib/adapters/src/federal/epa-ejscreen.ts`).
 *
 * EJScreen percentiles are 0–100; we sort the promoted fields by
 * percentile descending and render the top three so the architect can
 * see the most-elevated indicators at a glance. Falls back to a hint
 * when none of the promoted percentile fields were populated (the
 * `raw` envelope is still available in the parent adapter row).
 */
function EpaEjscreenSummary({
  payload,
}: {
  payload: Record<string, unknown>;
}) {
  const population = payload["population"];
  const ranked = EJSCREEN_PERCENTILE_FIELDS.map((f) => ({
    label: f.label,
    value: payload[f.key],
  }))
    .filter(
      (f): f is { label: string; value: number } => typeof f.value === "number",
    )
    .sort((a, b) => b.value - a.value)
    .slice(0, 3);
  if (ranked.length === 0 && typeof population !== "number") {
    return (
      <EmptyHint>
        EJScreen returned no percentile indicators for this block group.
      </EmptyHint>
    );
  }
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      {typeof population === "number" && (
        <KvRow label="Block group population" value={String(population)} />
      )}
      {ranked.map((r) => (
        <KvRow
          key={r.label}
          label={`${r.label} percentile`}
          value={String(r.value)}
        />
      ))}
    </div>
  );
}

/**
 * Summary for the FCC National Broadband Map adapter
 * (`lib/adapters/src/federal/fcc-broadband.ts`).
 *
 * `providerCount === 0` is the adapter's "no fixed-broadband
 * deployment here" sentinel — surface that as a hint rather than
 * rendering "0 providers / — Mbps". Otherwise show provider count
 * plus the fastest advertised down/up tiers.
 */
function FccBroadbandSummary({
  payload,
}: {
  payload: Record<string, unknown>;
}) {
  const providerCount = payload["providerCount"];
  if (providerCount === 0) {
    return (
      <EmptyHint>
        FCC reports no fixed-broadband deployment at this location.
      </EmptyHint>
    );
  }
  const down = payload["fastestDownstreamMbps"];
  const up = payload["fastestUpstreamMbps"];
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      {typeof providerCount === "number" && (
        <KvRow label="Providers" value={String(providerCount)} />
      )}
      <KvRow
        label="Max advertised download"
        value={typeof down === "number" ? `${down} Mbps` : "—"}
      />
      <KvRow
        label="Max advertised upload"
        value={typeof up === "number" ? `${up} Mbps` : "—"}
      />
    </div>
  );
}

/**
 * Build the single-line markdown digest the "Copy summary" button
 * writes to the clipboard for a federal-adapter briefing source.
 *
 * Shape: `**<label>** — <body> — snapshot YYYY-MM-DD`
 *   e.g. `**FEMA NFHL** — Zone AE, in SFHA, BFE 432 ft — snapshot 2026-01-01`
 *
 * Returns `null` when:
 *   - `payload.kind` is not one of the four federal kinds we support
 *   - the kind is supported but the payload has nothing meaningful to
 *     summarize (so the button stays hidden rather than copying an
 *     empty digest).
 *
 * Exported so the format is unit-testable without rendering the
 * component (see `__tests__/BriefingSourceDetails.test.tsx`).
 */
export function formatFederalSummaryMarkdown(
  source: EngagementBriefingSource,
): string | null {
  const payload = (source.payload ?? {}) as Record<string, unknown>;
  const kind =
    typeof payload["kind"] === "string" ? (payload["kind"] as string) : null;
  let label: string;
  let body: string;
  switch (kind) {
    case "flood-zone":
      label = "FEMA NFHL";
      body = formatFloodZoneSummaryBody(payload);
      break;
    case "elevation-point":
      label = "USGS NED";
      body = formatElevationSummaryBody(payload);
      break;
    case "ejscreen-blockgroup":
      label = "EPA EJScreen";
      body = formatEjscreenSummaryBody(payload);
      break;
    case "broadband-availability":
      label = "FCC";
      body = formatBroadbandSummaryBody(payload);
      break;
    default:
      return null;
  }
  if (!body) return null;
  const snapshot = formatSnapshotDate(source.snapshotDate);
  const tail = snapshot ? ` — snapshot ${snapshot}` : "";
  return `**${label}** — ${body}${tail}`;
}

/** ISO-timestamp prefix (YYYY-MM-DD) — adapters always persist a UTC
 * `snapshotDate`, so a string slice keeps this dependency-free and
 * timezone-stable. Returns `null` for absent / malformed inputs so
 * the caller can drop the trailing "snapshot …" segment. */
function formatSnapshotDate(s: string | null | undefined): string | null {
  if (typeof s !== "string") return null;
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(s);
  return m ? m[1] : null;
}

function formatFloodZoneSummaryBody(payload: Record<string, unknown>): string {
  const floodZone = payload["floodZone"];
  const features = payload["features"];
  const noFeatures = Array.isArray(features) && features.length === 0;
  if ((floodZone === null || floodZone === undefined) && noFeatures) {
    return "no mapped flood zone (treat as Zone X)";
  }
  const inSfha = payload["inSpecialFloodHazardArea"];
  const zoneSubtype = payload["zoneSubtype"];
  const bfe = payload["baseFloodElevation"];
  const parts: string[] = [];
  if (typeof floodZone === "string" && floodZone.length > 0) {
    parts.push(`Zone ${floodZone}`);
  }
  if (typeof inSfha === "boolean") {
    parts.push(inSfha ? "in SFHA" : "not in SFHA");
  }
  if (typeof zoneSubtype === "string" && zoneSubtype.length > 0) {
    parts.push(zoneSubtype);
  }
  if (typeof bfe === "number") parts.push(`BFE ${bfe} ft`);
  return parts.join(", ");
}

function formatElevationSummaryBody(payload: Record<string, unknown>): string {
  const elevation = payload["elevationFeet"];
  if (elevation === null || elevation === undefined) {
    return "no elevation value (off-raster)";
  }
  if (typeof elevation !== "number") return "";
  const units = payload["units"];
  const unitsLabel =
    typeof units === "string" && units.length > 0 ? units : "Feet";
  return `Elevation ${elevation} ${unitsLabel}`;
}

function formatEjscreenSummaryBody(payload: Record<string, unknown>): string {
  const population = payload["population"];
  const ranked = EJSCREEN_PERCENTILE_FIELDS.map((f) => ({
    label: f.label,
    value: payload[f.key],
  }))
    .filter(
      (f): f is { label: string; value: number } => typeof f.value === "number",
    )
    .sort((a, b) => b.value - a.value)
    .slice(0, 3);
  if (ranked.length === 0 && typeof population !== "number") return "";
  const parts: string[] = [];
  if (typeof population === "number") parts.push(`pop ${population}`);
  for (const r of ranked) parts.push(`${r.label} p${r.value}`);
  return parts.join(", ");
}

function formatBroadbandSummaryBody(
  payload: Record<string, unknown>,
): string {
  const providerCount = payload["providerCount"];
  if (providerCount === 0) return "no fixed-broadband deployment";
  const down = payload["fastestDownstreamMbps"];
  const up = payload["fastestUpstreamMbps"];
  const parts: string[] = [];
  if (typeof providerCount === "number") {
    parts.push(`${providerCount} providers`);
  }
  if (typeof down === "number") parts.push(`${down} Mbps down`);
  if (typeof up === "number") parts.push(`${up} Mbps up`);
  return parts.join(", ");
}

/**
 * Read `attributes` off a feature object (ArcGIS shape:
 * `{ attributes, geometry }`) and render it as a
 * highlight-field-first / fallback-everything-else key/value list.
 * Falls back to a raw dump when the shape isn't an arcgis feature.
 */
function AttributesGrid({
  source,
  highlightFields,
}: {
  source: Record<string, unknown>;
  highlightFields: readonly string[];
}) {
  const attrs = source["attributes"];
  if (!attrs || typeof attrs !== "object") {
    return <RawPayload payload={source} />;
  }
  const attrMap = attrs as Record<string, unknown>;
  const present = highlightFields.filter(
    (k) => attrMap[k] !== undefined && attrMap[k] !== null,
  );
  const remaining = Object.keys(attrMap).filter((k) => !present.includes(k));
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      {present.map((k) => (
        <KvRow key={k} label={k} value={formatScalar(attrMap[k])} />
      ))}
      {remaining.length > 0 && (
        <details
          style={{
            marginTop: 4,
            fontSize: 11,
            color: "var(--text-muted)",
          }}
        >
          <summary style={{ cursor: "pointer" }}>
            All attributes ({Object.keys(attrMap).length})
          </summary>
          <div
            style={{
              marginTop: 6,
              display: "flex",
              flexDirection: "column",
              gap: 2,
            }}
          >
            {Object.entries(attrMap).map(([k, v]) => (
              <KvRow key={k} label={k} value={formatScalar(v)} muted />
            ))}
          </div>
        </details>
      )}
    </div>
  );
}

function RawPayload({ payload }: { payload: Record<string, unknown> }) {
  return (
    <pre
      style={{
        margin: 0,
        padding: 8,
        background: "var(--surface-muted)",
        borderRadius: 4,
        fontSize: 11,
        color: "var(--text-secondary)",
        overflow: "auto",
        maxHeight: 240,
      }}
    >
      {JSON.stringify(payload, null, 2)}
    </pre>
  );
}

function KvRow({
  label,
  value,
  muted,
}: {
  label: string;
  value: string;
  muted?: boolean;
}) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "minmax(140px, 220px) 1fr",
        gap: 8,
        alignItems: "baseline",
        fontSize: muted ? 11 : 12,
        color: muted ? "var(--text-muted)" : "var(--text-secondary)",
      }}
    >
      <span style={{ color: "var(--text-muted)" }}>{label}</span>
      <span
        style={{
          color: muted ? "var(--text-muted)" : "var(--text-primary)",
          wordBreak: "break-word",
        }}
      >
        {value}
      </span>
    </div>
  );
}

function EmptyHint({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        fontSize: 11,
        color: "var(--text-muted)",
        fontStyle: "italic",
      }}
    >
      {children}
    </div>
  );
}

function formatScalar(v: unknown): string {
  if (v === null || v === undefined) return "—";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  // Common ArcGIS epoch-millis date columns (e.g. EFF_DATE) come over
  // as integers — leave them as numbers; the architect can read the
  // raw value, and we don't want to misinterpret a column that
  // happens to be named like a date but isn't one.
  return JSON.stringify(v);
}

/**
 * Pull the original `adapterKey` back out of the packed `provider`
 * column the generate-layers route writes:
 *   `<adapterKey> (<provider-label>)` → `fema:nfhl-flood-zone (FEMA NFHL)`.
 *
 * Mirrors the contract enforced by `extractAdapterKeyFromProvider` in
 * `EngagementDetail.tsx` (Task #228) — kept as a sibling rather than
 * imported from `pages/` so this component can stay free of page-
 * level imports. The colon check guards against a manual-upload row
 * whose architect-typed free-text provider happens to begin with
 * something that *looks* like an adapter key, so the badge can never
 * surface a re-run button whose ?adapterKey= the backend would 422
 * on.
 */
function extractAdapterKeyFromProvider(
  provider: string | null,
): string | null {
  if (!provider) return null;
  const tailStart = provider.indexOf(" (");
  if (tailStart <= 0) return null;
  if (!provider.endsWith(")")) return null;
  const key = provider.slice(0, tailStart).trim();
  if (!key.includes(":")) return null;
  return key;
}

/**
 * Pull the jurisdiction key out of the packed `provider` string the
 * generate-layers route writes:
 *   `<adapterKey> (<provider-label>)`  →  `grand-county-ut:zoning (...)`.
 * Returns the part before the first `:` (the jurisdiction slug) or
 * null when the provider doesn't follow the packed convention (e.g.
 * a manual-upload row's free-text provider).
 */
function extractJurisdictionKey(provider: string | null): string | null {
  if (!provider) return null;
  const colon = provider.indexOf(":");
  if (colon <= 0) return null;
  return provider.slice(0, colon).trim() || null;
}

/**
 * Try to find the zoning district name in the adapter's payload. The
 * county GIS layers don't agree on a single field name (Bastrop uses
 * `ZONING`, Grand County uses `ZONE_DIST`, the test fixtures use
 * `district`), so we walk a small whitelist and return the first
 * non-empty string we find.
 */
function extractZoningDistrict(
  payload: Record<string, unknown>,
): string | null {
  const direct = payload["district"];
  if (typeof direct === "string" && direct.trim()) return direct.trim();
  const zoning = payload["zoning"];
  if (zoning && typeof zoning === "object") {
    const attrs = (zoning as Record<string, unknown>)["attributes"];
    if (attrs && typeof attrs === "object") {
      const attrMap = attrs as Record<string, unknown>;
      const candidates = [
        "ZONING",
        "ZONE",
        "ZONE_DIST",
        "DISTRICT",
        "ZONE_TYPE",
        "ZONE_CLASS",
        "ZoningClass",
        "ZONING_CODE",
        "district",
      ];
      for (const k of candidates) {
        const v = attrMap[k];
        if (typeof v === "string" && v.trim()) return v.trim();
      }
    }
  }
  return null;
}

/**
 * Fetch + render the matching setback table row for a local zoning
 * source. Renders nothing when the jurisdiction has no codified
 * table (404), and a polite "no exact match" hint when the table
 * exists but the reported district doesn't appear in it.
 */
function SetbackPanel({
  sourceId,
  jurisdictionKey,
  reportedDistrict,
  snapshotDate,
}: {
  sourceId: string;
  jurisdictionKey: string;
  reportedDistrict: string | null;
  snapshotDate: string | null;
}) {
  const tableQuery = useGetLocalSetbackTable(jurisdictionKey, {
    query: {
      queryKey: getGetLocalSetbackTableQueryKey(jurisdictionKey),
      // The setback tables are tiny and effectively static — the file
      // only changes when an ordinance does. A long staleTime keeps
      // the FE from re-fetching on every panel open.
      staleTime: 5 * 60 * 1000,
      // 404 is "no codified table" — we don't want React Query to
      // retry that case.
      retry: false,
    },
  });
  const matched = useMemo<LocalSetbackDistrict | null>(() => {
    if (!tableQuery.data || !reportedDistrict) return null;
    const wanted = reportedDistrict.trim().toLowerCase();
    return (
      tableQuery.data.districts.find(
        (d) => d.district_name.toLowerCase() === wanted,
      ) ?? null
    );
  }, [tableQuery.data, reportedDistrict]);

  if (tableQuery.isLoading) {
    return (
      <div
        style={{
          fontSize: 11,
          color: "var(--text-muted)",
        }}
      >
        Loading setbacks for {jurisdictionKey}…
      </div>
    );
  }
  if (tableQuery.isError) {
    // 404 is the expected "no codified table" case; suppress it.
    // Anything else: render a small inline error (auditors should
    // know the lookup ran but failed).
    const err = tableQuery.error as { status?: number } | null;
    if (err && err.status === 404) return null;
    return (
      <div
        role="alert"
        style={{
          fontSize: 11,
          color: "var(--danger-text)",
          background: "var(--danger-dim)",
          padding: 6,
          borderRadius: 4,
        }}
      >
        Failed to load setback table for {jurisdictionKey}.
      </div>
    );
  }
  if (!tableQuery.data) return null;

  return (
    <div
      data-testid={`briefing-source-setbacks-${sourceId}`}
      style={{
        marginTop: 4,
        padding: 10,
        background: "var(--surface-muted)",
        borderRadius: 4,
        display: "flex",
        flexDirection: "column",
        gap: 8,
      }}
    >
      <div
        style={{
          display: "flex",
          gap: 8,
          alignItems: "baseline",
          flexWrap: "wrap",
        }}
      >
        <span
          style={{
            fontSize: 11,
            color: "var(--text-muted)",
            textTransform: "uppercase",
            letterSpacing: 0.4,
          }}
        >
          Setbacks ({tableQuery.data.jurisdictionDisplayName})
        </span>
        {reportedDistrict && (
          <span style={{ fontSize: 11, color: "var(--text-secondary)" }}>
            District: <strong>{reportedDistrict}</strong>
          </span>
        )}
      </div>
      {matched ? (
        <>
          <SetbacksGrid district={matched} />
          <CopyMarkdownButton
            markdown={formatSetbackSummaryMarkdown({
              jurisdictionDisplayName:
                tableQuery.data.jurisdictionDisplayName,
              district: matched,
              snapshotDate,
            })}
            testId={`briefing-source-copy-setback-${sourceId}`}
          />
        </>
      ) : (
        <EmptyHint>
          {reportedDistrict
            ? `No row in the ${jurisdictionKey} setback table matched "${reportedDistrict}".`
            : "Adapter did not report a zoning district — cannot match a setback row."}
        </EmptyHint>
      )}
    </div>
  );
}

/**
 * Build the single-line markdown digest the local-tier setback panel's
 * "Copy summary" button writes to the clipboard when a matched row is
 * present.
 *
 * Shape: `**<jurisdiction>** — <district> — front X ft, rear X ft, side X ft, height X ft, max coverage X% — snapshot YYYY-MM-DD`
 *   e.g. `**Grand County, UT (Moab area)** — RR-1 Rural Residential — front 30 ft, rear 25 ft, side 15 ft, height 32 ft, max coverage 30% — snapshot 2026-01-01`
 *
 * The snapshot suffix is dropped when `snapshotDate` is missing or
 * malformed (mirrors `formatFederalSummaryMarkdown`). Exported so the
 * format is unit-testable without rendering the component.
 */
export function formatSetbackSummaryMarkdown({
  jurisdictionDisplayName,
  district,
  snapshotDate,
}: {
  jurisdictionDisplayName: string;
  district: LocalSetbackDistrict;
  snapshotDate: string | null | undefined;
}): string {
  const body = [
    `front ${district.front_ft} ft`,
    `rear ${district.rear_ft} ft`,
    `side ${district.side_ft} ft`,
    `height ${district.max_height_ft} ft`,
    `max coverage ${district.max_lot_coverage_pct}%`,
  ].join(", ");
  const snapshot = formatSnapshotDate(snapshotDate);
  const tail = snapshot ? ` — snapshot ${snapshot}` : "";
  return `**${jurisdictionDisplayName}** — ${district.district_name} — ${body}${tail}`;
}

function SetbacksGrid({ district }: { district: LocalSetbackDistrict }) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))",
        gap: 8,
      }}
    >
      <Stat label="Front" value={`${district.front_ft} ft`} />
      <Stat label="Rear" value={`${district.rear_ft} ft`} />
      <Stat label="Side" value={`${district.side_ft} ft`} />
      <Stat label="Side (corner)" value={`${district.side_corner_ft} ft`} />
      <Stat label="Max height" value={`${district.max_height_ft} ft`} />
      <Stat
        label="Max lot coverage"
        value={`${district.max_lot_coverage_pct}%`}
      />
      <Stat
        label="Max impervious"
        value={`${district.max_impervious_pct}%`}
      />
      {district.citation_url && (
        <a
          href={district.citation_url}
          target="_blank"
          rel="noreferrer noopener"
          style={{
            fontSize: 11,
            color: "var(--info-text)",
            alignSelf: "end",
            gridColumn: "1 / -1",
          }}
        >
          View citation →
        </a>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 2,
      }}
    >
      <span
        style={{
          fontSize: 10,
          color: "var(--text-muted)",
          textTransform: "uppercase",
          letterSpacing: 0.3,
        }}
      >
        {label}
      </span>
      <span
        style={{
          fontSize: 13,
          color: "var(--text-primary)",
          fontWeight: 600,
        }}
      >
        {value}
      </span>
    </div>
  );
}
