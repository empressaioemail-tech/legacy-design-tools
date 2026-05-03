import { useEffect, useMemo, useRef, useState } from "react";
import {
  BriefingDivergenceRow,
  BriefingDivergenceDetailDialog,
  BriefingDivergencesPanel,
  RequestRefreshAffordance,
  formatRelativeMaterializedAt,
  useReviewerRequestIsPending,
} from "@workspace/portal-ui";
import {
  useGetEngagementBimModel,
  type BimModelDivergenceListEntry,
  type EngagementBimModel,
  type MaterializableElement,
  type MaterializableElementKind,
} from "@workspace/api-client-react";
import { BimModelViewport } from "@workspace/portal-ui";
import { useSessionUserId } from "../lib/session";

/**
 * Canonical ordering + display labels for the seven Spec 51a §2.4
 * materializable element kinds. Mirrors the
 * `MATERIALIZABLE_ELEMENT_KINDS` tuple in
 * `lib/db/src/schema/materializableElements.ts` so the reviewer
 * sees the same kind grouping the architect side uses, in the
 * same order, even when the bim-model row only contains a subset.
 */
const ELEMENT_KIND_DISPLAY: Record<
  MaterializableElementKind,
  { label: string; order: number }
> = {
  terrain: { label: "Terrain", order: 0 },
  "property-line": { label: "Property line", order: 1 },
  "setback-plane": { label: "Setback planes", order: 2 },
  "buildable-envelope": { label: "Buildable envelope", order: 3 },
  floodplain: { label: "Floodplain", order: 4 },
  wetland: { label: "Wetland", order: 5 },
  "neighbor-mass": { label: "Neighbor masses", order: 6 },
};

const REFRESH_STATUS_COPY: Record<
  EngagementBimModel["refreshStatus"],
  { label: string; tone: "success" | "warning" | "muted" }
> = {
  current: { label: "Current", tone: "success" },
  stale: { label: "Stale — re-push pending", tone: "warning" },
  "not-pushed": { label: "Not pushed", tone: "muted" },
};

/**
 * Reviewer-facing list of the materializable elements the bim-model
 * is currently materialized against, grouped by kind in the
 * canonical Spec 51a §2.4 order. Read-only — there are no edit /
 * delete affordances; the architect owns element lifecycle.
 *
 * Renders a compact "(no materializable elements yet)" hint when the
 * bim-model exists but the briefing engine has not produced any
 * elements yet — easy to mistake for an empty divergences panel
 * otherwise.
 */
/**
 * Resolve a finding's `elementRef` (a free-form pointer like
 * `wall:north-side-l2` or a server-side element id) against the
 * loaded materializable elements. We try a small ordered set of
 * matchers so a finding emitted by the AI engine has a few
 * fallbacks before we give up:
 *
 *   1. exact `id` match (the strongest match — the AI would have
 *      to know the server-side element id);
 *   2. exact `label` match;
 *   3. case-insensitive `label` match;
 *   4. case-insensitive trailing-segment match — e.g. an
 *      `elementRef` of `wall:north-side-l2` matches a label of
 *      `North side L2` or an id ending in `north-side-l2`.
 *
 * Returns `null` when nothing matches; the caller then announces
 * the no-match case via the aria-live region rather than scrolling
 * to or pulsing a row.
 */
function findElementByRef(
  elements: MaterializableElement[],
  ref: string,
): MaterializableElement | null {
  if (!ref) return null;
  const exactId = elements.find((el) => el.id === ref);
  if (exactId) return exactId;
  const exactLabel = elements.find((el) => el.label === ref);
  if (exactLabel) return exactLabel;
  const lower = ref.toLowerCase();
  const ciLabel = elements.find(
    (el) => el.label != null && el.label.toLowerCase() === lower,
  );
  if (ciLabel) return ciLabel;
  // Trailing-segment match: `wall:north-side-l2` → `north-side-l2`.
  const tail = lower.includes(":") ? lower.split(":").pop() ?? lower : lower;
  if (tail !== lower) {
    const tailMatch = elements.find((el) => {
      if (el.id.toLowerCase().endsWith(tail)) return true;
      if (el.label != null && el.label.toLowerCase().includes(tail))
        return true;
      return false;
    });
    if (tailMatch) return tailMatch;
  }
  return null;
}

function MaterializableElementsList({
  elements,
  highlightToken = null,
}: {
  elements: MaterializableElement[];
  /**
   * Task #343 / #371 — when a reviewer clicks "Show in 3D viewer"
   * on a finding, the modal sets this to a `{ ref, nonce }` token
   * and we (a) resolve `ref` to a row, (b) scroll the row into
   * view, (c) apply a visual highlight, and (d) announce the jump
   * in an aria-live region for screen readers.
   *
   * The `nonce` is a monotonically-increasing counter the modal
   * bumps on every click — including re-clicks of the SAME
   * finding — so the highlight effect re-runs and re-scrolls even
   * when `ref` has not changed. This replaces the brittle 2.5s
   * `onHighlightConsumed` clear-and-refire dance from Task #343.
   */
  highlightToken?: { ref: string; nonce: number } | null;
}) {
  const grouped = useMemo(() => {
    const buckets = new Map<MaterializableElementKind, MaterializableElement[]>();
    for (const el of elements) {
      const list = buckets.get(el.elementKind) ?? [];
      list.push(el);
      buckets.set(el.elementKind, list);
    }
    return Array.from(buckets.entries()).sort(
      ([a], [b]) =>
        (ELEMENT_KIND_DISPLAY[a]?.order ?? 99) -
        (ELEMENT_KIND_DISPLAY[b]?.order ?? 99),
    );
  }, [elements]);

  // Resolve the highlight ref to a concrete element on every change.
  // `matched` is `null` when the reviewer clicked a finding whose
  // elementRef does not appear in the current bim-model — we still
  // announce the no-match case so they know the jump landed.
  const ref = highlightToken?.ref ?? null;
  const matched = useMemo(
    () => (ref ? findElementByRef(elements, ref) : null),
    [elements, ref],
  );

  // Per-row refs let us scroll the matched row into view without
  // querying the DOM. We only allocate refs lazily on render — a
  // model with hundreds of elements doesn't need to keep stale
  // refs around for rows it never highlighted.
  const rowRefs = useRef(new Map<string, HTMLLIElement | null>());

  // Scroll + announce side-effect. Re-runs on every new
  // highlightToken — including same-ref / new-nonce re-clicks —
  // because the modal hands us a fresh object each time. No
  // wall-clock timer needed: the highlight outline simply stays
  // applied until the modal clears the token (on tab leave or
  // modal close), and the scroll fires on each click.
  const nonce = highlightToken?.nonce ?? null;
  useEffect(() => {
    if (!ref) return;
    if (matched) {
      const node = rowRefs.current.get(matched.id);
      if (node) {
        node.scrollIntoView({ behavior: "smooth", block: "center" });
      }
    }
  }, [ref, nonce, matched]);

  // Screen-reader announcement string. Empty when there's nothing to
  // announce so the live region doesn't read out spurious "" updates.
  const announcement = useMemo(() => {
    if (!ref) return "";
    if (matched) {
      const label = matched.label ?? matched.id;
      return `Showing ${label} in the BIM model viewer.`;
    }
    return `Element ${ref} from the finding is not present in the current BIM model.`;
  }, [ref, matched]);

  return (
    <div
      data-testid="bim-model-elements-list"
      className="sc-card"
      style={{
        padding: 16,
        border: "1px solid var(--border-default)",
        borderRadius: 6,
        display: "flex",
        flexDirection: "column",
        gap: 12,
      }}
    >
      <div className="sc-medium" style={{ fontSize: 14 }}>
        Materializable elements
      </div>
      {/*
       * aria-live region for the cross-tab "Show in 3D viewer" jump
       * (Task #343). Sighted users see the row pulse + scroll;
       * screen-reader users hear an announcement of which element
       * was focused (or that the elementRef has no match in the
       * current model). `aria-atomic` ensures the full sentence is
       * read on each update, not just the diff.
       */}
      <div
        data-testid="bim-model-elements-announcer"
        role="status"
        aria-live="polite"
        aria-atomic="true"
        style={{
          position: "absolute",
          width: 1,
          height: 1,
          padding: 0,
          margin: -1,
          overflow: "hidden",
          clip: "rect(0,0,0,0)",
          whiteSpace: "nowrap",
          border: 0,
        }}
      >
        {announcement}
      </div>
      {ref && !matched && (
        <div
          data-testid="bim-model-elements-no-match"
          style={{
            fontSize: 12,
            color: "var(--warning-text)",
            background: "var(--warning-dim)",
            border: "1px solid var(--warning-text)",
            borderRadius: 4,
            padding: "6px 8px",
          }}
        >
          The finding references{" "}
          <code style={{ fontFamily: "ui-monospace, monospace" }}>
            {ref}
          </code>
          , which is not present in the current BIM model.
        </div>
      )}
      {elements.length === 0 ? (
        <div
          data-testid="bim-model-elements-list-empty"
          style={{ fontSize: 12, color: "var(--text-muted)" }}
        >
          The briefing has not produced any materializable elements
          yet. Once the briefing engine emits geometry, the elements
          the C# add-in is materializing will appear here grouped by
          kind.
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {grouped.map(([kind, items]) => (
            <div
              key={kind}
              data-testid="bim-model-elements-group"
              data-kind={kind}
              style={{ display: "flex", flexDirection: "column", gap: 4 }}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "baseline",
                  justifyContent: "space-between",
                  gap: 8,
                }}
              >
                <div
                  className="sc-medium"
                  style={{ fontSize: 12, color: "var(--text-default)" }}
                >
                  {ELEMENT_KIND_DISPLAY[kind]?.label ?? kind}
                </div>
                <div
                  data-testid="bim-model-elements-group-count"
                  style={{
                    fontSize: 11,
                    color: "var(--text-muted)",
                    fontVariantNumeric: "tabular-nums",
                  }}
                >
                  {items.length} {items.length === 1 ? "element" : "elements"}
                </div>
              </div>
              <ul
                style={{
                  margin: 0,
                  padding: 0,
                  listStyle: "none",
                  display: "flex",
                  flexDirection: "column",
                  gap: 2,
                }}
              >
                {items.map((el) => {
                  const isHighlighted = matched?.id === el.id;
                  return (
                    <li
                      key={el.id}
                      ref={(node) => {
                        if (node) {
                          rowRefs.current.set(el.id, node);
                        } else {
                          rowRefs.current.delete(el.id);
                        }
                      }}
                      data-testid="bim-model-elements-row"
                      data-element-id={el.id}
                      data-locked={el.locked ? "true" : "false"}
                      data-highlighted={isHighlighted ? "true" : "false"}
                      style={{
                        display: "flex",
                        gap: 8,
                        alignItems: "center",
                        fontSize: 12,
                        color: "var(--text-default)",
                        padding: isHighlighted ? "4px 6px" : 0,
                        borderRadius: 4,
                        background: isHighlighted
                          ? "var(--info-dim, var(--bg-input))"
                          : "transparent",
                        outline: isHighlighted
                          ? "2px solid var(--info-text, var(--border-active))"
                          : "none",
                        outlineOffset: 1,
                        transition:
                          "background 200ms ease-out, outline-color 200ms ease-out",
                      }}
                    >
                      <span style={{ flex: 1 }}>
                        {el.label ?? <em style={{ color: "var(--text-muted)" }}>(unlabeled)</em>}
                      </span>
                      {el.locked && (
                        <span
                          data-testid="bim-model-elements-row-locked"
                          style={{
                            fontSize: 10,
                            fontWeight: 600,
                            textTransform: "uppercase",
                            letterSpacing: 0.4,
                            padding: "1px 6px",
                            borderRadius: 3,
                            color: "var(--text-muted)",
                            background: "var(--bg-muted)",
                            border: "1px solid var(--border-default)",
                          }}
                        >
                          Locked
                        </span>
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function BimModelSummaryCard({
  bimModel,
  engagementId,
  audience,
}: {
  bimModel: EngagementBimModel;
  engagementId: string;
  /**
   * Threaded down from the SubmissionDetailModal (which itself reads
   * the session audience on the EngagementDetail page). The Task #429
   * "Request BIM refresh" affordance only renders for reviewer
   * sessions (`audience === "internal"`); architect / agent
   * audiences see the existing read-only summary card.
   */
  audience: "internal" | "user" | "ai";
}) {
  const status = REFRESH_STATUS_COPY[bimModel.refreshStatus];
  // Task #429 — reviewer-side "Request BIM refresh" gate.
  // Limit the affordance to reviewer audience and to states where a
  // refresh is meaningful (`stale` — re-push pending; the model is
  // out of sync with the briefing). Showing it on `current` would
  // ask the architect to redo work that's already in lock-step;
  // showing it on `not-pushed` would conflate "please push for the
  // first time" with "please refresh", a different conceptual ask
  // outside V1-2 scope.
  const showRequestRefresh =
    audience === "internal" && bimModel.refreshStatus === "stale";
  const requestRefreshIsPending = useReviewerRequestIsPending(
    engagementId,
    "refresh-bim-model",
    bimModel.id,
    showRequestRefresh,
  );
  const toneColor =
    status.tone === "success"
      ? "var(--success-text)"
      : status.tone === "warning"
        ? "var(--warning-text)"
        : "var(--text-muted)";
  const toneBg =
    status.tone === "success"
      ? "var(--success-dim)"
      : status.tone === "warning"
        ? "var(--warning-dim)"
        : "var(--bg-muted)";

  return (
    <div
      data-testid="bim-model-summary-card"
      className="sc-card"
      style={{
        padding: 16,
        border: "1px solid var(--border-default)",
        borderRadius: 6,
        display: "flex",
        flexDirection: "column",
        gap: 12,
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          gap: 12,
        }}
      >
        <div className="sc-medium" style={{ fontSize: 14 }}>
          BIM model
        </div>
        <span
          data-testid="bim-model-summary-refresh-status"
          data-status={bimModel.refreshStatus}
          style={{
            fontSize: 11,
            fontWeight: 600,
            textTransform: "uppercase",
            letterSpacing: 0.4,
            padding: "3px 8px",
            borderRadius: 4,
            color: toneColor,
            background: toneBg,
          }}
        >
          {status.label}
        </span>
      </div>
      <dl
        style={{
          display: "grid",
          gridTemplateColumns: "max-content 1fr",
          columnGap: 16,
          rowGap: 6,
          margin: 0,
          fontSize: 12,
        }}
      >
        <dt style={{ color: "var(--text-muted)" }}>Last materialized</dt>
        <dd
          data-testid="bim-model-summary-materialized-at"
          style={{ margin: 0, color: "var(--text-default)" }}
        >
          {bimModel.materializedAt
            ? formatRelativeMaterializedAt(bimModel.materializedAt)
            : "Never materialized"}
        </dd>
        <dt style={{ color: "var(--text-muted)" }}>Briefing version</dt>
        <dd
          data-testid="bim-model-summary-briefing-version"
          style={{ margin: 0, color: "var(--text-default)" }}
        >
          v{bimModel.briefingVersion}
        </dd>
        <dt style={{ color: "var(--text-muted)" }}>Revit document</dt>
        <dd
          data-testid="bim-model-summary-revit-document"
          style={{
            margin: 0,
            color: bimModel.revitDocumentPath
              ? "var(--text-default)"
              : "var(--text-muted)",
            wordBreak: "break-all",
          }}
        >
          {bimModel.revitDocumentPath ?? "—"}
        </dd>
      </dl>
      {/*
        Task #429 — reviewer-side "Request BIM refresh" affordance.
        Sits in-card under the materialized-at / briefing-version
        block so the ask sits adjacent to the as-of timestamp the
        reviewer is reading when they decide a refresh is warranted.
        Caller-owns-the-gate contract: the affordance itself does
        not check audience — `BimModelSummaryCard` does, then mounts
        only when `audience === "internal"` and the model is stale.
      */}
      {showRequestRefresh && (
        <div
          data-testid="bim-model-summary-request-refresh-row"
          style={{
            display: "flex",
            justifyContent: "flex-end",
            paddingTop: 4,
            borderTop: "1px dashed var(--border-default)",
            marginTop: 4,
          }}
        >
          <RequestRefreshAffordance
            engagementId={engagementId}
            requestKind="refresh-bim-model"
            targetEntityType="bim-model"
            targetEntityId={bimModel.id}
            targetLabel="BIM model"
            pending={requestRefreshIsPending}
          />
        </div>
      )}
    </div>
  );
}

export interface BimModelTabProps {
  engagementId: string;
  /**
   * Task #343 / #371 — when the reviewer clicks "Show in 3D
   * viewer" on a finding, the SubmissionDetailModal switches to
   * this tab and threads a `{ ref, nonce }` token down so the
   * materializable-elements list can scroll to + highlight the
   * matching row. The `nonce` increments on every click so a
   * re-click of the SAME finding still re-runs the highlight
   * effect even though `ref` is unchanged. `null` means no jump
   * is in flight.
   */
  highlightToken?: { ref: string; nonce: number } | null;
  /**
   * Task #429 — caller's session audience. The reviewer-side
   * "Request BIM refresh" affordance on `BimModelSummaryCard` only
   * mounts when `audience === "internal"`. Defaults to `"user"` so
   * existing tests / non-reviewer mounts keep their current
   * behavior without change.
   */
  audience?: "internal" | "user" | "ai";
}

/**
 * Plan-review's read-only BIM Model tab on the submission detail
 * modal (Wave 2 Sprint B / Task #306). Surfaces the bim-model
 * + briefing-divergences feedback loop to the reviewer audience
 * without exposing any of the architect-side write affordances
 * (no Push to Revit, no Resolve button on Open rows).
 *
 * The reviewer can drill into any individual divergence to see the
 * tabular diff between the briefing-locked element state and the
 * architect's recorded edit, but cannot move a row from Open to
 * Resolved — that remains an architect-side responsibility.
 *
 * Composes three pieces from `@workspace/portal-ui`:
 *   - {@link BriefingDivergencesPanel} — the loading / error /
 *     Open vs. Resolved partition + per-element grouping.
 *   - {@link BriefingDivergenceRow} — the per-row presentation,
 *     wrapped here with a "View details" right-slot button so the
 *     reviewer can open the drill-in.
 *   - {@link BriefingDivergenceDetailDialog} — the per-divergence
 *     tabular diff drill-in.
 *
 * When the engagement has no bim-model yet (no Push has happened
 * on the architect side) the panel renders nothing; this tab
 * supplies an empty-state explanation in that case so a reviewer
 * doesn't see a blank pane.
 */
export function BimModelTab({
  engagementId,
  highlightToken = null,
  audience = "user",
}: BimModelTabProps) {
  const [activeDivergence, setActiveDivergence] =
    useState<BimModelDivergenceListEntry | null>(null);
  const bimModelQuery = useGetEngagementBimModel(engagementId);
  const bimModel = bimModelQuery.data?.bimModel ?? null;
  // Task #409 — pass the session reviewer id down so the BIM
  // viewport's "graduated" gesture-legend preference is scoped
  // per-user. `null` (loading / anonymous / agent) is forwarded
  // as `undefined` so the viewport falls back to its shared
  // anonymous bucket without conflating loading and unauth.
  const reviewerId = useSessionUserId();

  return (
    <div
      data-testid="bim-model-tab"
      style={{ display: "flex", flexDirection: "column", gap: 16 }}
    >
      {bimModelQuery.isLoading && (
        <div
          data-testid="bim-model-tab-loading"
          className="sc-body opacity-60"
          style={{ fontSize: 13 }}
        >
          Loading BIM model…
        </div>
      )}

      {!bimModelQuery.isLoading && bimModel == null && (
        <div
          data-testid="bim-model-tab-empty"
          className="sc-card"
          style={{
            padding: 16,
            border: "1px dashed var(--border-default)",
            borderRadius: 6,
            color: "var(--text-secondary)",
            fontSize: 13,
            display: "flex",
            flexDirection: "column",
            gap: 4,
          }}
        >
          <div className="sc-medium" style={{ fontSize: 14 }}>
            No BIM model recorded yet
          </div>
          <div style={{ fontSize: 12, color: "var(--text-muted)" }}>
            The architect hasn't pushed this engagement's briefing to
            Revit yet. Once they do, recorded overrides will appear
            here for review.
          </div>
        </div>
      )}

      {bimModel && (
        <BimModelSummaryCard
          bimModel={bimModel}
          engagementId={engagementId}
          audience={audience}
        />
      )}

      {bimModel && (
        <BimModelViewport
          elements={bimModel.elements}
          selectedElementRef={highlightToken?.ref ?? null}
          currentUserId={reviewerId ?? undefined}
        />
      )}

      {bimModel && (
        <MaterializableElementsList
          elements={bimModel.elements}
          highlightToken={highlightToken}
        />
      )}

      {bimModel && (
        <BriefingDivergencesPanel
          engagementId={engagementId}
          title="BIM model overrides"
          description="The C# add-in records every edit the architect makes to a locked element. Click a row to see the briefing-vs-Revit diff."
          renderRow={(row) => (
            <BriefingDivergenceRow
              key={row.id}
              row={row}
              rightSlot={
                <button
                  type="button"
                  data-testid="briefing-divergences-view-details-button"
                  data-divergence-id={row.id}
                  onClick={() => setActiveDivergence(row)}
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
              }
            />
          )}
        />
      )}

      <BriefingDivergenceDetailDialog
        divergence={activeDivergence}
        onClose={() => setActiveDivergence(null)}
      />
    </div>
  );
}
