import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetBimModelRefresh,
  useGetEngagementBimModel,
  usePushEngagementBimModel,
  useResolveBimModelDivergence,
  getGetBimModelRefreshQueryKey,
  getGetEngagementBimModelQueryKey,
  getListBimModelDivergencesQueryKey,
  type BimModelDivergenceListEntry,
} from "@workspace/api-client-react";
import {
  BriefingDivergenceDetailDialog,
  BriefingDivergenceRow as PortalBriefingDivergenceRow,
  BriefingDivergencesPanel as PortalBriefingDivergencesPanel,
  formatRelativeMaterializedAt,
} from "@workspace/portal-ui";

/**
 * DA-PI-5 / Spec 53 §3 — the "Push to Revit" affordance the
 * Site Context tab renders below the briefing-sources list.
 *
 * Surfaces three statuses driven by the `bim_models` row's
 * `materializedAt` vs the active briefing's `updatedAt` (computed
 * server-side and returned in `refreshStatus`):
 *
 *   - `not-pushed`  — neutral "Push to Revit" affordance. The first
 *     click creates the bim-model row.
 *   - `current`     — green "Materialized at <ts>" pill. The CTA
 *     becomes "Push again to Revit" so the architect can force a
 *     re-materialization (e.g. after deleting and re-uploading a
 *     QGIS layer that did not bump the briefing version yet).
 *   - `stale`       — amber "Briefing has changed since last push"
 *     warning. The CTA becomes the primary "Re-push to Revit"
 *     action.
 *
 * Disabled with a hint when no parcel briefing exists yet (the
 * server refuses the push without an active briefing — surfacing
 * the disabled state up front avoids the round-trip).
 */
export function PushToRevitAffordance({
  engagementId,
  hasBriefing,
}: {
  engagementId: string;
  hasBriefing: boolean;
}) {
  const queryClient = useQueryClient();
  const bimModelQuery = useGetEngagementBimModel(engagementId);
  const bimModelId = bimModelQuery.data?.bimModel?.id ?? null;
  // The `/refresh` route is the live source of truth — `/bim-model`
  // returns the row at fetch time, but the status / element-diff
  // payload the C# add-in uses to plan its next sync only ships from
  // `/refresh`. Mirroring that shape here keeps the affordance and
  // the add-in consistent (so an operator can read off "v3, 2 added,
  // 1 modified" and trust it matches what Revit will see).
  const refreshQuery = useGetBimModelRefresh(bimModelId ?? "", {
    query: {
      enabled: bimModelId !== null,
      queryKey: getGetBimModelRefreshQueryKey(bimModelId ?? ""),
    },
  });
  const pushMutation = usePushEngagementBimModel({
    mutation: {
      onSuccess: () => {
        // Re-fetch so the status pill flips from `not-pushed` /
        // `stale` to `current` and `materializedAt` updates without
        // an out-of-band poll. Also invalidate `/refresh` so the
        // diff counters reset to zero unchanged-only after a push.
        void queryClient.invalidateQueries({
          queryKey: getGetEngagementBimModelQueryKey(engagementId),
        });
        if (bimModelId !== null) {
          void queryClient.invalidateQueries({
            queryKey: getGetBimModelRefreshQueryKey(bimModelId),
          });
          // The divergence list lives on the same Site Context tab —
          // a re-push usually means the architect has just reconciled
          // their overrides, so closing the loop with a fresh fetch
          // keeps the panel honest. The route is cheap (single
          // indexed select) so an unconditional invalidation here is
          // simpler than threading the prior refreshStatus through.
          void queryClient.invalidateQueries({
            queryKey: getListBimModelDivergencesQueryKey(bimModelId),
          });
        }
      },
    },
  });

  // Prefer the refresh payload when available — it's the canonical
  // shape the add-in consumes — and fall back to the bim-model row
  // for the not-pushed / first-render case.
  const refreshStatus =
    refreshQuery.data?.refreshStatus ??
    bimModelQuery.data?.bimModel?.refreshStatus ??
    "not-pushed";
  const materializedAt =
    refreshQuery.data?.materializedAt ??
    bimModelQuery.data?.bimModel?.materializedAt ??
    null;
  const briefingVersion =
    refreshQuery.data?.briefingVersion ??
    bimModelQuery.data?.bimModel?.briefingVersion ??
    null;
  const diff = refreshQuery.data?.diff ?? null;

  const statusPalette = (() => {
    if (refreshStatus === "current") {
      return {
        bg: "var(--success-dim)",
        fg: "var(--success-text)",
        label: "Current",
      };
    }
    if (refreshStatus === "stale") {
      return {
        bg: "var(--warning-dim)",
        fg: "var(--warning-text)",
        label: "Stale",
      };
    }
    return {
      bg: "var(--info-dim)",
      fg: "var(--info-text)",
      label: "Not pushed",
    };
  })();

  const ctaLabel = (() => {
    if (refreshStatus === "stale") return "Re-push to Revit";
    if (refreshStatus === "current") return "Push again to Revit";
    return "Push to Revit";
  })();

  const explainer = (() => {
    if (!hasBriefing) {
      return "Upload a briefing source first — the briefing is what gets materialized.";
    }
    if (refreshStatus === "current" && materializedAt) {
      // Mirrors the relative-timestamp pattern used by the briefing
      // source rows above; a full ISO is shown in the title attribute
      // so an operator can hover for the precise instant. The "against
      // briefing v<n>" tail is the wording the code review asked for —
      // it lets an operator reading this card cross-reference the
      // materialization with the briefing version the C# add-in is
      // working against without opening DevTools.
      const versionTail =
        briefingVersion !== null ? ` against briefing v${briefingVersion}` : "";
      return `Materialized at ${formatRelativeMaterializedAt(materializedAt)}${versionTail}.`;
    }
    if (refreshStatus === "stale") {
      // Surface the per-element delta returned by `/refresh` so the
      // operator knows roughly how big the re-push will be before
      // they click. `addedCount + modifiedCount` matches what the
      // add-in will report once the architect re-runs the sync.
      const changes = diff
        ? ` (${diff.addedCount} added, ${diff.modifiedCount} modified)`
        : "";
      const tail =
        materializedAt && briefingVersion !== null
          ? ` Last materialized at ${formatRelativeMaterializedAt(
              materializedAt,
            )} against briefing v${briefingVersion}.`
          : "";
      return `The briefing has changed since the last push${changes}. Re-push to refresh the architect's Revit model.${tail}`;
    }
    return "Materializes the engagement's briefing into the architect's active Revit model.";
  })();

  const disabled =
    !hasBriefing || pushMutation.isPending || bimModelQuery.isLoading;

  return (
    <div
      className="sc-card"
      data-testid="push-to-revit-affordance"
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 8,
        padding: 12,
        border: "1px solid var(--border-subtle)",
        borderRadius: 6,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
        }}
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <div
            style={{ display: "flex", alignItems: "center", gap: 8 }}
          >
            <div className="sc-medium">Push to Revit</div>
            <span
              data-testid="push-to-revit-status-badge"
              data-status={refreshStatus}
              title={
                materializedAt
                  ? new Date(materializedAt).toISOString()
                  : undefined
              }
              style={{
                display: "inline-flex",
                alignItems: "center",
                padding: "2px 8px",
                borderRadius: 999,
                background: statusPalette.bg,
                color: statusPalette.fg,
                fontSize: 11,
                fontWeight: 600,
                letterSpacing: 0.2,
                textTransform: "uppercase",
                lineHeight: 1.4,
              }}
            >
              {statusPalette.label}
            </span>
          </div>
          <div
            style={{ fontSize: 12, color: "var(--text-muted)" }}
            data-testid="push-to-revit-explainer"
          >
            {explainer}
          </div>
        </div>
        <button
          type="button"
          className="sc-btn sc-btn-primary"
          disabled={disabled}
          onClick={() =>
            pushMutation.mutate({ id: engagementId, data: {} })
          }
          data-testid="push-to-revit-button"
          style={{ opacity: disabled ? 0.6 : 1 }}
        >
          {pushMutation.isPending ? "Pushing…" : ctaLabel}
        </button>
      </div>
      {pushMutation.isError && (
        <div
          role="alert"
          data-testid="push-to-revit-error"
          style={{
            fontSize: 12,
            color: "var(--danger-text)",
            background: "var(--danger-dim)",
            padding: 8,
            borderRadius: 4,
          }}
        >
          Failed to push to Revit. Try again in a moment.
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Briefing-divergences UI — DA-PI-5 / Spec 51a §2.2
// ---------------------------------------------------------------------------
// The presentational primitives (helpers, ResolvedByChip, the row /
// group / panel components) live in @workspace/portal-ui as of Wave 2
// Sprint B (Task #306) so the architect surface here and the read-
// only reviewer surface in plan-review render the same recorded-
// override audit trail without a copy/paste fork. The portal-ui
// imports are pulled in at the top of this file alongside the other
// shared symbols.
//
// design-tools owns the *architect-only* concerns layered on top:
// the Resolve mutation + cache invalidation, surfaced as the
// row's right-aligned action slot.

/**
 * Architect-side wrapper around the presentational
 * {@link PortalBriefingDivergenceRow} from portal-ui. Supplies the
 * Resolve button (when the row is still Open), a "View details"
 * button that opens the per-divergence drill-in dialog (Task #320),
 * and the resolve-error toast — the three pieces that diverge from
 * the read-only reviewer surface in plan-review.
 *
 * Uses `row.bimModelId` directly for the mutation + cache key so
 * the wrapper stays pure (no engagement-id prop drilling) and a
 * row's bim-model scope is always the source of truth.
 *
 * `onViewDetails` is hoisted to the parent panel so a single
 * dialog can be rendered alongside the list (mirrors the plan-
 * review pattern in `BimModelTab.tsx`) instead of mounting one
 * dialog per row.
 */
function ArchitectBriefingDivergenceRow({
  row,
  onViewDetails,
}: {
  row: BimModelDivergenceListEntry;
  onViewDetails: (row: BimModelDivergenceListEntry) => void;
}) {
  const queryClient = useQueryClient();
  const isResolved = row.resolvedAt != null;
  const resolveMutation = useResolveBimModelDivergence({
    mutation: {
      onSuccess: () => {
        // Invalidate the *list* query so the row physically moves
        // from Open into Resolved without splicing the cache by hand.
        void queryClient.invalidateQueries({
          queryKey: getListBimModelDivergencesQueryKey(row.bimModelId),
        });
      },
    },
  });
  const viewDetailsButton = (
    <button
      type="button"
      data-testid="briefing-divergences-view-details-button"
      data-divergence-id={row.id}
      onClick={() => onViewDetails(row)}
      style={{
        all: "unset",
        cursor: "pointer",
        padding: "3px 10px",
        borderRadius: 4,
        fontSize: 11,
        fontWeight: 600,
        background: "var(--bg-default)",
        color: "var(--text-default)",
        border: "1px solid var(--border-default)",
      }}
    >
      View details
    </button>
  );
  return (
    <PortalBriefingDivergenceRow
      row={row}
      rightSlot={
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          {viewDetailsButton}
          {!isResolved && (
            <button
              type="button"
              data-testid="briefing-divergences-resolve-button"
              disabled={resolveMutation.isPending}
              onClick={() =>
                resolveMutation.mutate({
                  id: row.bimModelId,
                  divergenceId: row.id,
                })
              }
              style={{
                all: "unset",
                cursor: resolveMutation.isPending ? "wait" : "pointer",
                padding: "3px 10px",
                borderRadius: 4,
                fontSize: 11,
                fontWeight: 600,
                background: "var(--bg-default)",
                color: "var(--text-default)",
                border: "1px solid var(--border-default)",
                opacity: resolveMutation.isPending ? 0.6 : 1,
              }}
            >
              {resolveMutation.isPending ? "Resolving…" : "Resolve"}
            </button>
          )}
        </div>
      }
      errorSlot={
        resolveMutation.isError ? (
          <div
            role="alert"
            data-testid="briefing-divergences-resolve-error"
            style={{
              fontSize: 11,
              color: "var(--danger-text)",
            }}
          >
            Couldn't mark as resolved. Try again in a moment.
          </div>
        ) : null
      }
    />
  );
}

/**
 * Architect-flavored wrapper around the shared
 * {@link PortalBriefingDivergencesPanel} from portal-ui. Wires the
 * panel's per-row render slot to {@link ArchitectBriefingDivergenceRow}
 * so each Open row gets a Resolve button, and owns the
 * `activeDivergence` state that drives the shared
 * {@link BriefingDivergenceDetailDialog} drill-in (Task #320) so
 * architects can inspect a recorded override before resolving
 * without leaving the engagement page. Keeps the architect-facing
 * panel header copy unchanged. Re-exported so existing tests
 * (`artifacts/design-tools/src/pages/__tests__/BriefingDivergencesPanel.test.tsx`)
 * keep importing `BriefingDivergencesPanel` from this module.
 */
export function BriefingDivergencesPanel({
  engagementId,
}: {
  engagementId: string;
}) {
  const [activeDivergence, setActiveDivergence] =
    useState<BimModelDivergenceListEntry | null>(null);
  return (
    <>
      <PortalBriefingDivergencesPanel
        engagementId={engagementId}
        renderRow={(row) => (
          <ArchitectBriefingDivergenceRow
            key={row.id}
            row={row}
            onViewDetails={setActiveDivergence}
          />
        )}
      />
      <BriefingDivergenceDetailDialog
        divergence={activeDivergence}
        onClose={() => setActiveDivergence(null)}
      />
    </>
  );
}
