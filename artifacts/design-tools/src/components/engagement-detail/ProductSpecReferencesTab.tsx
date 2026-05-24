import { useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListProductSpecReferences,
  getListProductSpecReferencesQueryKey,
  useCreateProductSpecReference,
  useRefreshProductSpecReference,
  ApiError,
  type ProductSpecReferenceAtom,
  type ProductSpecStatus,
} from "@workspace/api-client-react";
import { TabHeader } from "../cockpit/TabChrome";
import { relativeTime } from "../../lib/relativeTime";
import type { SpecDraftEntry } from "../../store/engagements";

/** WS-C — pre-fill values an agent-drafted L5 reference seeds the form with. */
interface ProductSpecDraftInitial {
  name: string;
  manufacturer: string;
  esrNumber: string;
}

/**
 * Cortex L5 (Lane C.4 / C.4.5) — architect-side product-spec-reference
 * surface.
 *
 * Lists the engagement's ICC-ES-evaluated product references, adds a
 * new reference, surfaces the live ESR status (highlighting withdrawn
 * / expired reports for review), and triggers a synchronous ICC-ES
 * re-poll. Co-designed with cc-agent-M's
 * `cortex_product_spec_reference_*` MCP tools.
 */

const ESR_RE = /^ESR-\d+$/;

const STATUS_COLORS: Record<ProductSpecStatus, { bg: string; fg: string }> = {
  active: { bg: "var(--success-dim)", fg: "var(--success-text)" },
  withdrawn: { bg: "var(--danger-dim)", fg: "var(--danger-text)" },
  expired: { bg: "var(--warning-dim)", fg: "var(--warning-text)" },
};

const inputStyle: React.CSSProperties = {
  width: "100%",
  background: "var(--bg-input)",
  border: "1px solid var(--border-default)",
  color: "var(--text-primary)",
  padding: "8px 10px",
  borderRadius: 4,
  outline: "none",
  fontSize: 12.5,
};

function formatRefError(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 502) {
      return "ICC-ES could not be reached. The status was left unchanged — try the refresh again shortly.";
    }
    if (err.status === 404) return "This reference no longer exists. Refresh.";
    if (err.status === 400) return "The request was rejected as invalid.";
    if (err.status >= 500) return "The server hit a snag. Try again.";
    return err.message;
  }
  if (err instanceof Error) return err.message;
  return "Something went wrong — please try again.";
}

function StatusBadge({ status }: { status: ProductSpecStatus }) {
  const palette = STATUS_COLORS[status] ?? STATUS_COLORS.active;
  return (
    <span
      data-testid={`product-spec-status-${status}`}
      style={{
        display: "inline-flex",
        padding: "2px 8px",
        borderRadius: 999,
        background: palette.bg,
        color: palette.fg,
        fontSize: 11,
        fontWeight: 600,
        textTransform: "uppercase",
        letterSpacing: 0.2,
      }}
    >
      {status}
    </span>
  );
}

/* -------------------------------------------------------------------------- */
/*                           Create dialog                                    */
/* -------------------------------------------------------------------------- */

function CreateProductSpecReferenceDialog({
  engagementId,
  isOpen,
  onClose,
  initialDraft,
  aiReasoning,
}: {
  engagementId: string;
  isOpen: boolean;
  onClose: () => void;
  /** WS-C — agent-drafted values to pre-fill the form with (WSC.4). */
  initialDraft?: ProductSpecDraftInitial | null;
  /** WS-C — the agent's rationale, shown in the AI-populated banner. */
  aiReasoning?: string | null;
}) {
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [manufacturer, setManufacturer] = useState("");
  const [esrNumber, setEsrNumber] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    if (initialDraft) {
      // WS-C — open pre-filled from the agent's draft for operator review.
      setName(initialDraft.name);
      setManufacturer(initialDraft.manufacturer);
      setEsrNumber(initialDraft.esrNumber);
    } else {
      setName("");
      setManufacturer("");
      setEsrNumber("");
    }
    setError(null);
  }, [isOpen, initialDraft]);

  const mutation = useCreateProductSpecReference({
    mutation: {
      onSuccess: async () => {
        await qc.invalidateQueries({
          queryKey: getListProductSpecReferencesQueryKey(engagementId),
        });
        onClose();
      },
      onError: (err: unknown) => setError(formatRefError(err)),
    },
  });

  if (!isOpen) return null;
  const submitting = mutation.isPending;
  const esrValid = ESR_RE.test(esrNumber.trim());
  const canSubmit =
    name.trim().length > 0 &&
    manufacturer.trim().length > 0 &&
    esrValid &&
    !submitting;

  return (
    <div
      onClick={() => !submitting && onClose()}
      data-testid="create-product-spec-reference-dialog"
      role="dialog"
      aria-modal="true"
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.5)",
        zIndex: 50,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 16,
      }}
    >
      <div
        className="sc-card"
        onClick={(e) => e.stopPropagation()}
        style={{ width: "100%", maxWidth: 480, display: "flex", flexDirection: "column" }}
      >
        <div className="sc-card-header">
          <span style={{ fontSize: 16, fontWeight: 600, color: "var(--text-primary)" }}>
            {initialDraft
              ? "Review AI-drafted reference"
              : "New product-spec reference"}
          </span>
        </div>
        {initialDraft && (
          <div
            data-testid="product-spec-ai-banner"
            style={{
              margin: "12px 16px 0",
              padding: "8px 10px",
              borderRadius: 4,
              background: "var(--cyan-accent-bg)",
              border: "1px solid var(--cyan)",
              color: "var(--cyan)",
              fontSize: 11.5,
            }}
          >
            AI-populated by the Cortex agent — review every field before saving.
            {aiReasoning ? ` ${aiReasoning}` : ""}
          </div>
        )}
        <div className="p-4 flex flex-col" style={{ gap: 10 }}>
          <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <span className="sc-label" style={{ color: "var(--text-secondary)" }}>
              Product name (required)
            </span>
            <input
              type="text"
              value={name}
              disabled={submitting}
              data-testid="product-spec-name-input"
              onChange={(e) => setName(e.target.value)}
              placeholder='e.g. "Strong-Drive SDWS Timber Screw"'
              style={inputStyle}
            />
          </label>
          <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <span className="sc-label" style={{ color: "var(--text-secondary)" }}>
              Manufacturer (required)
            </span>
            <input
              type="text"
              value={manufacturer}
              disabled={submitting}
              data-testid="product-spec-manufacturer-input"
              onChange={(e) => setManufacturer(e.target.value)}
              placeholder='e.g. "Simpson Strong-Tie"'
              style={inputStyle}
            />
          </label>
          <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <span className="sc-label" style={{ color: "var(--text-secondary)" }}>
              ESR number (required — format ESR-1234)
            </span>
            <input
              type="text"
              value={esrNumber}
              disabled={submitting}
              data-testid="product-spec-esr-input"
              onChange={(e) => setEsrNumber(e.target.value)}
              placeholder="ESR-1234"
              style={{
                ...inputStyle,
                borderColor:
                  esrNumber.length > 0 && !esrValid
                    ? "var(--danger-text)"
                    : "var(--border-default)",
              }}
            />
            {esrNumber.length > 0 && !esrValid && (
              <span
                className="sc-meta"
                style={{ color: "var(--danger-text)", fontSize: 11 }}
              >
                ESR number must match ESR-&lt;digits&gt;.
              </span>
            )}
          </label>
          {error && (
            <div
              data-testid="create-product-spec-reference-error"
              role="alert"
              className="sc-meta"
              style={{ color: "var(--danger-text)" }}
            >
              {error}
            </div>
          )}
        </div>
        <div
          className="p-4 flex justify-end gap-2"
          style={{ borderTop: "1px solid var(--border-default)" }}
        >
          <button
            type="button"
            className="sc-btn-ghost"
            onClick={onClose}
            disabled={submitting}
          >
            Cancel
          </button>
          <button
            type="button"
            className="sc-btn-primary"
            disabled={!canSubmit}
            data-testid="create-product-spec-reference-submit"
            onClick={() => {
              setError(null);
              mutation.mutate({
                engagementId,
                data: {
                  product: {
                    name: name.trim(),
                    manufacturer: manufacturer.trim(),
                  },
                  esrNumber: esrNumber.trim(),
                },
              });
            }}
          >
            {submitting ? "Adding…" : "Add reference"}
          </button>
        </div>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*                            Reference row                                   */
/* -------------------------------------------------------------------------- */

function ReferenceRow({
  engagementId,
  reference,
}: {
  engagementId: string;
  reference: ProductSpecReferenceAtom;
}) {
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);

  const refresh = useRefreshProductSpecReference({
    mutation: {
      onSuccess: async () => {
        setError(null);
        await qc.invalidateQueries({
          queryKey: getListProductSpecReferencesQueryKey(engagementId),
        });
      },
      onError: (err: unknown) => setError(formatRefError(err)),
    },
  });

  const status = reference.status as ProductSpecStatus;
  const needsReview = status !== "active";

  return (
    <div
      data-testid={`product-spec-reference-row-${reference.entityId}`}
      style={{
        padding: "12px 16px",
        borderBottom: "1px solid var(--border-default)",
        display: "flex",
        flexDirection: "column",
        gap: 8,
        // Highlight withdrawn / expired references for review.
        background: needsReview ? "var(--danger-dim)" : "transparent",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span
          className="sc-medium"
          style={{ color: "var(--text-primary)", fontSize: 13, flex: 1 }}
        >
          {reference.product.name}
          <span style={{ color: "var(--text-secondary)", fontWeight: 400 }}>
            {" "}
            · {reference.product.manufacturer}
          </span>
        </span>
        <StatusBadge status={status} />
      </div>

      <div
        className="sc-meta"
        style={{ display: "flex", gap: 12, flexWrap: "wrap", fontSize: 11 }}
      >
        <span
          className="sc-medium"
          style={{ color: "var(--text-primary)" }}
          data-testid={`product-spec-esr-${reference.entityId}`}
        >
          {reference.esrNumber}
        </span>
        <span>Verified {relativeTime(reference.lastVerifiedAt)}</span>
        {reference.statusHistory.length > 0 && (
          <button
            type="button"
            className="sc-btn-ghost sc-btn-sm"
            data-testid={`product-spec-${reference.entityId}-history-toggle`}
            onClick={() => setHistoryOpen((v) => !v)}
          >
            {historyOpen
              ? "Hide history"
              : `History (${reference.statusHistory.length})`}
          </button>
        )}
      </div>

      {needsReview && (
        <div
          className="sc-meta"
          data-testid={`product-spec-${reference.entityId}-review-flag`}
          style={{ color: "var(--danger-text)", fontSize: 11, fontWeight: 600 }}
        >
          ⚠ This ESR is {status} — review any findings that cite this product.
        </div>
      )}

      {historyOpen && (
        <div
          data-testid={`product-spec-${reference.entityId}-history`}
          style={{ display: "flex", flexDirection: "column", gap: 3 }}
        >
          {reference.statusHistory.map((entry, i) => (
            <div
              key={i}
              className="sc-meta"
              style={{ fontSize: 11, color: "var(--text-secondary)" }}
            >
              {entry.status} · {relativeTime(entry.changedAt)}
            </div>
          ))}
        </div>
      )}

      <div style={{ display: "flex" }}>
        <button
          type="button"
          className="sc-btn-ghost sc-btn-sm"
          disabled={refresh.isPending}
          data-testid={`product-spec-${reference.entityId}-refresh`}
          onClick={() =>
            refresh.mutate({ referenceId: reference.entityId })
          }
        >
          {refresh.isPending ? "Polling ICC-ES…" : "Refresh ICC-ES status"}
        </button>
      </div>

      {error && (
        <div
          data-testid={`product-spec-${reference.entityId}-error`}
          role="alert"
          className="sc-meta"
          style={{ color: "var(--danger-text)" }}
        >
          {error}
        </div>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*                                 Tab                                        */
/* -------------------------------------------------------------------------- */

export function ProductSpecReferencesTab({
  engagementId,
  aiDraft,
  onAiDraftConsumed,
}: {
  engagementId: string;
  /** WS-C — an agent-prepared L5 draft routed in from the chat panel. */
  aiDraft?: SpecDraftEntry | null;
  /** Called once the draft has been taken into the create dialog. */
  onAiDraftConsumed?: () => void;
}) {
  const [createOpen, setCreateOpen] = useState(false);
  const [draftInitial, setDraftInitial] =
    useState<ProductSpecDraftInitial | null>(null);
  const [draftReasoning, setDraftReasoning] = useState<string | null>(null);

  // WS-C (WSC.4) — when the chat agent routes a product-spec draft in,
  // open the create dialog pre-filled with it for operator review.
  useEffect(() => {
    if (!aiDraft) return;
    const payload = aiDraft.payload as {
      product?: { name?: unknown; manufacturer?: unknown };
      esrNumber?: unknown;
    };
    const product = payload.product;
    if (
      product &&
      typeof product.name === "string" &&
      typeof product.manufacturer === "string" &&
      typeof payload.esrNumber === "string"
    ) {
      setDraftInitial({
        name: product.name,
        manufacturer: product.manufacturer,
        esrNumber: payload.esrNumber,
      });
      setDraftReasoning(aiDraft.reasoning);
      setCreateOpen(true);
    }
    onAiDraftConsumed?.();
    // `aiDraft` is the trigger; `onAiDraftConsumed` is a callback we
    // invoke, not a dependency that should re-run this effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [aiDraft]);

  const { data, isLoading } = useListProductSpecReferences(
    engagementId,
    undefined,
    {
      query: {
        enabled: !!engagementId,
        queryKey: getListProductSpecReferencesQueryKey(engagementId),
      },
    },
  );

  const references = useMemo(
    () => data?.productSpecReferences ?? [],
    [data],
  );

  return (
    <div className="cockpit-tab" data-testid="product-spec-references-tab-shell">
      <TabHeader
        overline="Deliverables · group"
        title="Product specs"
        subtitle="ICC-ES-evaluated product references with live ESR status. Withdrawn or expired evaluations are flagged for review; refresh re-polls ICC-ES on demand."
      />
      <div
        className="sc-card flex flex-col"
        data-testid="product-spec-references-list"
      >
        <div className="sc-card-header sc-row-sb">
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <span className="sc-label">PRODUCT-SPEC REFERENCES</span>
            <span className="sc-meta" style={{ opacity: 0.7 }}>
              {references.length}{" "}
              {references.length === 1 ? "reference" : "references"}
            </span>
          </div>
          <button
            type="button"
            className="sc-btn-primary"
            data-testid="product-spec-references-new"
            onClick={() => setCreateOpen(true)}
          >
            Add reference
          </button>
        </div>

        {isLoading ? (
          <div
            className="p-6 text-center"
            data-testid="product-spec-references-loading"
          >
            <div className="sc-body opacity-60">Loading references…</div>
          </div>
        ) : references.length === 0 ? (
          <div
            className="p-6 text-center"
            data-testid="product-spec-references-empty"
          >
            <div className="sc-prose opacity-70" style={{ maxWidth: 460 }}>
              No product-spec references yet. Add one to track an
              ICC-ES-evaluated product's live evaluation status.
            </div>
          </div>
        ) : (
          <div className="flex flex-col">
            {references.map((reference) => (
              <ReferenceRow
                key={reference.entityId}
                engagementId={engagementId}
                reference={reference}
              />
            ))}
          </div>
        )}
      </div>

      <CreateProductSpecReferenceDialog
        engagementId={engagementId}
        isOpen={createOpen}
        initialDraft={draftInitial}
        aiReasoning={draftReasoning}
        onClose={() => {
          setCreateOpen(false);
          setDraftInitial(null);
          setDraftReasoning(null);
        }}
      />
    </div>
  );
}
