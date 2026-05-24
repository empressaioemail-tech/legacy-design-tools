import { useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  Search,
  ChevronDown,
  Sparkles,
  Clock,
  AlertTriangle,
  Box,
  RefreshCw,
  X,
} from "lucide-react";
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
 *
 * Layout adopted from the Spec Catalog canvas mockup: filter bar +
 * unified catalog table + right-side spec detail drawer. The table
 * surfaces NAME / SOURCE / ID / STATUS / VERIFIED columns and the
 * drawer hosts the History list, Re-verify (= refresh) and the Add
 * dialog trigger. No raw color literals introduced — all colors flow
 * through smartcity-themes.css tokens.
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
        background: "var(--bg-chrome)",
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
/*                       Filter chip (catalog header)                         */
/* -------------------------------------------------------------------------- */

function FilterChip({
  label,
  value,
  onClick,
  active,
}: {
  label: string;
  value: string;
  onClick?: () => void;
  active?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        padding: "5px 10px",
        borderRadius: 4,
        background: active ? "var(--cyan-accent-bg)" : "var(--bg-elevated)",
        border: `1px solid ${
          active ? "var(--cyan-accent-border)" : "var(--border-default)"
        }`,
        color: active ? "var(--cyan-text)" : "var(--text-primary)",
        fontSize: 11.5,
        cursor: onClick ? "pointer" : "default",
      }}
    >
      <span
        style={{
          color: "var(--text-secondary)",
          fontWeight: 600,
          letterSpacing: 0.4,
          fontSize: 10,
          textTransform: "uppercase",
        }}
      >
        {label}
      </span>
      <span>{value}</span>
      <ChevronDown size={12} style={{ color: "var(--text-muted)" }} />
    </button>
  );
}

/* -------------------------------------------------------------------------- */
/*                          Catalog table row                                 */
/* -------------------------------------------------------------------------- */

function CatalogRow({
  reference,
  selected,
  onSelect,
}: {
  reference: ProductSpecReferenceAtom;
  selected: boolean;
  onSelect: () => void;
}) {
  const status = reference.status as ProductSpecStatus;
  const needsReview = status !== "active";
  const accent = needsReview ? "var(--danger)" : "var(--cyan)";

  return (
    <tr
      data-testid={`product-spec-reference-row-${reference.entityId}`}
      onClick={onSelect}
      style={{
        borderBottom: "1px solid var(--border-soft)",
        background: selected
          ? "var(--bg-highlight)"
          : needsReview
            ? "var(--danger-dim)"
            : "transparent",
        cursor: "pointer",
      }}
    >
      <td
        style={{
          padding: "10px 8px 10px 14px",
          position: "relative",
          width: 28,
        }}
      >
        {(selected || needsReview) && (
          <span
            aria-hidden="true"
            style={{
              position: "absolute",
              left: 0,
              top: 0,
              bottom: 0,
              width: 2,
              background: selected ? "var(--cyan)" : accent,
            }}
          />
        )}
        <Box
          size={14}
          color={
            selected
              ? "var(--cyan-text)"
              : needsReview
                ? "var(--danger-text)"
                : "var(--text-muted)"
          }
        />
      </td>
      <td
        style={{
          padding: "10px 8px",
          color: selected ? "var(--cyan-text)" : "var(--text-primary)",
          fontWeight: 500,
          fontSize: 12.5,
          maxWidth: 240,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {reference.product.name}
      </td>
      <td
        style={{
          padding: "10px 8px",
          color: "var(--text-secondary)",
          fontSize: 12,
          maxWidth: 160,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {reference.product.manufacturer}
      </td>
      <td
        style={{
          padding: "10px 8px",
          color: "var(--text-secondary)",
          fontFamily:
            "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
          fontSize: 11,
        }}
        data-testid={`product-spec-esr-${reference.entityId}`}
      >
        {reference.esrNumber}
      </td>
      <td style={{ padding: "10px 8px" }}>
        <StatusBadge status={status} />
      </td>
      <td
        style={{
          padding: "10px 8px",
          color: "var(--text-secondary)",
          fontSize: 12,
        }}
      >
        {relativeTime(reference.lastVerifiedAt)}
      </td>
      <td
        style={{
          padding: "10px 14px 10px 8px",
          textAlign: "right",
        }}
      >
        {needsReview ? (
          <span
            data-testid={`product-spec-${reference.entityId}-review-flag`}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 4,
              padding: "3px 8px",
              borderRadius: 4,
              background: "var(--danger-dim)",
              border: "1px solid var(--danger)",
              color: "var(--danger-text)",
              fontSize: 10.5,
              fontWeight: 600,
            }}
          >
            <AlertTriangle size={11} />
            Review
          </span>
        ) : (
          <span
            style={{
              color: "var(--text-muted)",
              fontSize: 11,
            }}
          >
            —
          </span>
        )}
      </td>
    </tr>
  );
}

/* -------------------------------------------------------------------------- */
/*                          Spec detail drawer                                */
/* -------------------------------------------------------------------------- */

function SpecDetailDrawer({
  engagementId,
  reference,
  onClose,
}: {
  engagementId: string;
  reference: ProductSpecReferenceAtom;
  onClose: () => void;
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
    <aside
      data-testid={`product-spec-drawer-${reference.entityId}`}
      style={{
        width: 340,
        flexShrink: 0,
        background: "var(--bg-surface)",
        borderLeft: "1px solid var(--border-soft)",
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
      }}
    >
      {/* Header */}
      <div
        style={{
          padding: "16px 16px 14px",
          borderBottom: "1px solid var(--border-soft)",
        }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "flex-start",
            marginBottom: 12,
          }}
        >
          <div
            style={{
              width: 44,
              height: 44,
              borderRadius: 6,
              background: "var(--bg-elevated)",
              border: "1px solid var(--border-default)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <Box size={20} color="var(--text-secondary)" />
          </div>
          <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <StatusBadge status={status} />
            <button
              type="button"
              onClick={onClose}
              aria-label="Close detail panel"
              style={{
                background: "transparent",
                border: "none",
                color: "var(--text-secondary)",
                cursor: "pointer",
                padding: 4,
                display: "flex",
              }}
            >
              <X size={16} />
            </button>
          </div>
        </div>

        <h2
          style={{
            margin: 0,
            color: "var(--text-primary)",
            fontSize: 16,
            fontWeight: 600,
          }}
        >
          {reference.product.name}
        </h2>
        <div
          style={{
            marginTop: 4,
            display: "flex",
            gap: 6,
            alignItems: "center",
            fontSize: 12,
            color: "var(--text-secondary)",
          }}
        >
          <span>{reference.product.manufacturer}</span>
          <span style={{ color: "var(--text-muted)" }}>·</span>
          <span
            style={{
              fontFamily:
                "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
              fontSize: 11,
              padding: "2px 6px",
              borderRadius: 3,
              background: "var(--bg-elevated)",
              color: "var(--text-primary)",
            }}
          >
            {reference.esrNumber}
          </span>
        </div>

        {/* Verified row + Re-verify */}
        <div
          style={{
            marginTop: 12,
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            background: "var(--bg-base)",
            border: "1px solid var(--border-default)",
            borderRadius: 6,
            padding: "8px 10px",
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              fontSize: 11.5,
              color: "var(--text-primary)",
            }}
          >
            <Clock
              size={13}
              color={needsReview ? "var(--warning-text)" : "var(--success-text)"}
            />
            <span>Verified {relativeTime(reference.lastVerifiedAt)}</span>
          </div>
          <button
            type="button"
            disabled={refresh.isPending}
            onClick={() =>
              refresh.mutate({ referenceId: reference.entityId })
            }
            data-testid={`product-spec-${reference.entityId}-refresh`}
            style={{
              background: "transparent",
              border: "none",
              color: "var(--cyan-text)",
              cursor: refresh.isPending ? "wait" : "pointer",
              fontSize: 11,
              fontWeight: 600,
              display: "inline-flex",
              alignItems: "center",
              gap: 4,
              padding: 0,
            }}
          >
            <RefreshCw size={11} />
            {refresh.isPending ? "Polling…" : "Re-verify"}
          </button>
        </div>
      </div>

      {/* Body */}
      <div
        className="sc-scroll"
        style={{
          flex: 1,
          overflowY: "auto",
          padding: 16,
          display: "flex",
          flexDirection: "column",
          gap: 16,
        }}
      >
        {needsReview && (
          <div
            style={{
              padding: "10px 12px",
              borderRadius: 6,
              background: "var(--danger-dim)",
              border: "1px solid var(--danger)",
              color: "var(--danger-text)",
              fontSize: 11.5,
              fontWeight: 600,
              display: "flex",
              gap: 8,
              alignItems: "flex-start",
            }}
          >
            <AlertTriangle size={14} style={{ flexShrink: 0, marginTop: 1 }} />
            <span>
              This ESR is {status} — review any findings that cite this product.
            </span>
          </div>
        )}

        <section>
          <h3
            className="sc-label"
            style={{
              margin: 0,
              marginBottom: 8,
              color: "var(--text-secondary)",
            }}
          >
            Status history
          </h3>
          {reference.statusHistory.length === 0 ? (
            <div
              className="sc-meta"
              style={{ fontSize: 11.5, color: "var(--text-muted)" }}
            >
              No status changes recorded yet.
            </div>
          ) : (
            <>
              <button
                type="button"
                className="sc-btn-ghost sc-btn-sm"
                data-testid={`product-spec-${reference.entityId}-history-toggle`}
                onClick={() => setHistoryOpen((v) => !v)}
              >
                {historyOpen
                  ? "Hide history"
                  : `Show history (${reference.statusHistory.length})`}
              </button>
              {historyOpen && (
                <div
                  data-testid={`product-spec-${reference.entityId}-history`}
                  style={{
                    marginTop: 8,
                    display: "flex",
                    flexDirection: "column",
                    gap: 6,
                  }}
                >
                  {reference.statusHistory.map((entry, i) => (
                    <div
                      key={i}
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center",
                        padding: "6px 8px",
                        borderRadius: 4,
                        background: "var(--bg-base)",
                        border: "1px solid var(--border-default)",
                        fontSize: 11.5,
                      }}
                    >
                      <span
                        style={{
                          color: "var(--text-primary)",
                          textTransform: "uppercase",
                          letterSpacing: 0.3,
                          fontWeight: 600,
                        }}
                      >
                        {entry.status}
                      </span>
                      <span style={{ color: "var(--text-secondary)" }}>
                        {relativeTime(entry.changedAt)}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </section>

        <section>
          <h3
            className="sc-label"
            style={{
              margin: 0,
              marginBottom: 8,
              color: "var(--text-secondary)",
            }}
          >
            Properties
          </h3>
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              fontSize: 12,
            }}
          >
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                padding: "6px 0",
                borderBottom: "1px solid var(--border-default)",
              }}
            >
              <span style={{ color: "var(--text-secondary)" }}>ESR number</span>
              <span
                style={{
                  color: "var(--text-primary)",
                  fontFamily:
                    "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
                  fontSize: 11,
                }}
              >
                {reference.esrNumber}
              </span>
            </div>
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                padding: "6px 0",
                borderBottom: "1px solid var(--border-default)",
              }}
            >
              <span style={{ color: "var(--text-secondary)" }}>
                Manufacturer
              </span>
              <span style={{ color: "var(--text-primary)" }}>
                {reference.product.manufacturer}
              </span>
            </div>
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                padding: "6px 0",
                borderBottom: "1px solid var(--border-default)",
              }}
            >
              <span style={{ color: "var(--text-secondary)" }}>Status</span>
              <StatusBadge status={status} />
            </div>
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                padding: "6px 0",
              }}
            >
              <span style={{ color: "var(--text-secondary)" }}>
                Last verified
              </span>
              <span style={{ color: "var(--text-primary)" }}>
                {relativeTime(reference.lastVerifiedAt)}
              </span>
            </div>
          </div>
        </section>

        {error && (
          <div
            data-testid={`product-spec-${reference.entityId}-error`}
            role="alert"
            style={{
              padding: "8px 10px",
              borderRadius: 4,
              background: "var(--danger-dim)",
              border: "1px solid var(--danger)",
              color: "var(--danger-text)",
              fontSize: 11.5,
            }}
          >
            {error}
          </div>
        )}
      </div>
    </aside>
  );
}

/* -------------------------------------------------------------------------- */
/*                                 Tab                                        */
/* -------------------------------------------------------------------------- */

type StatusFilter = "all" | ProductSpecStatus;

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
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");

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

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return references.filter((r) => {
      if (statusFilter !== "all" && r.status !== statusFilter) return false;
      if (!q) return true;
      return (
        r.product.name.toLowerCase().includes(q) ||
        r.product.manufacturer.toLowerCase().includes(q) ||
        r.esrNumber.toLowerCase().includes(q)
      );
    });
  }, [references, search, statusFilter]);

  const reviewCount = useMemo(
    () => references.filter((r) => r.status !== "active").length,
    [references],
  );

  const selected = useMemo(
    () =>
      selectedId ? references.find((r) => r.entityId === selectedId) ?? null : null,
    [selectedId, references],
  );

  const statusOptions: { value: StatusFilter; label: string }[] = [
    { value: "all", label: "All" },
    { value: "active", label: "Active" },
    { value: "withdrawn", label: "Withdrawn" },
    { value: "expired", label: "Expired" },
  ];

  return (
    <div className="cockpit-tab" data-testid="product-spec-references-tab-shell">
      <TabHeader
        overline="Deliverables · group"
        title="Product specs"
        subtitle="ICC-ES-evaluated product references with live ESR status. Withdrawn or expired evaluations are flagged for review; refresh re-polls ICC-ES on demand."
      />
      <div
        className="sc-card"
        data-testid="product-spec-references-list"
        style={{
          padding: 0,
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
        }}
      >
        {/* Filter bar */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            padding: "10px 14px",
            borderBottom: "1px solid var(--border-soft)",
            background: "var(--bg-surface)",
            flexWrap: "wrap",
          }}
        >
          <div
            style={{
              position: "relative",
              flex: "1 1 240px",
              minWidth: 200,
            }}
          >
            <Search
              size={14}
              style={{
                position: "absolute",
                left: 10,
                top: "50%",
                transform: "translateY(-50%)",
                color: "var(--text-muted)",
                pointerEvents: "none",
              }}
            />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={`Search ${references.length} product spec${references.length === 1 ? "" : "s"}…`}
              data-testid="product-spec-search"
              style={{
                ...inputStyle,
                paddingLeft: 30,
                fontSize: 12,
              }}
            />
          </div>

          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            <span
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 4,
                fontSize: 10.5,
                fontWeight: 600,
                letterSpacing: 0.4,
                color: "var(--text-secondary)",
                textTransform: "uppercase",
                marginRight: 2,
              }}
            >
              Status
            </span>
            {statusOptions.map((opt) => (
              <button
                key={opt.value}
                type="button"
                onClick={() => setStatusFilter(opt.value)}
                data-testid={`product-spec-filter-${opt.value}`}
                style={{
                  padding: "4px 10px",
                  borderRadius: 4,
                  fontSize: 11.5,
                  cursor: "pointer",
                  background:
                    statusFilter === opt.value
                      ? "var(--cyan-accent-bg)"
                      : "var(--bg-elevated)",
                  border: `1px solid ${
                    statusFilter === opt.value
                      ? "var(--cyan-accent-border)"
                      : "var(--border-default)"
                  }`,
                  color:
                    statusFilter === opt.value
                      ? "var(--cyan-text)"
                      : "var(--text-primary)",
                  fontWeight: statusFilter === opt.value ? 600 : 400,
                }}
              >
                {opt.label}
              </button>
            ))}
          </div>

          <FilterChip label="Source" value="Any" />
          <FilterChip label="Cited in" value="Any" />

          <div
            style={{
              width: 1,
              alignSelf: "stretch",
              background: "var(--border-soft)",
              margin: "0 2px",
            }}
            aria-hidden="true"
          />

          {reviewCount > 0 && (
            <span
              data-testid="product-spec-ai-suggestions"
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                padding: "4px 10px",
                borderRadius: 4,
                background: "var(--cyan-accent-bg)",
                border: "1px solid var(--cyan-accent-border)",
                color: "var(--cyan-text)",
                fontSize: 11.5,
                fontWeight: 600,
              }}
            >
              <Sparkles size={12} />
              {reviewCount} need{reviewCount === 1 ? "s" : ""} review
            </span>
          )}

          <button
            type="button"
            className="sc-btn-primary sc-btn-sm"
            data-testid="product-spec-references-new"
            onClick={() => setCreateOpen(true)}
          >
            Add reference
          </button>
        </div>

        {/* Catalog body: table + drawer */}
        <div
          style={{
            display: "flex",
            minHeight: 360,
            maxHeight: "calc(100vh - 320px)",
          }}
        >
          <div
            className="sc-scroll"
            style={{
              flex: 1,
              overflow: "auto",
              minWidth: 0,
            }}
          >
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
                <div className="sc-prose opacity-70" style={{ maxWidth: 460, margin: "0 auto" }}>
                  No product-spec references yet. Add one to track an
                  ICC-ES-evaluated product's live evaluation status.
                </div>
              </div>
            ) : (
              <table
                style={{
                  width: "100%",
                  borderCollapse: "collapse",
                  fontSize: 12,
                }}
              >
                <thead>
                  <tr
                    style={{
                      borderBottom: "1px solid var(--border-soft)",
                      background: "var(--bg-surface)",
                    }}
                  >
                    <th
                      style={{
                        padding: "8px 8px 8px 14px",
                        width: 28,
                      }}
                    />
                    <SectionHeading>Name</SectionHeading>
                    <SectionHeading>Manufacturer</SectionHeading>
                    <SectionHeading>ESR</SectionHeading>
                    <SectionHeading>Status</SectionHeading>
                    <SectionHeading>Last verified</SectionHeading>
                    <SectionHeading align="right" pad="right">
                      Flags
                    </SectionHeading>
                  </tr>
                </thead>
                <tbody>
                  <tr
                    style={{
                      borderBottom: "1px solid var(--border-soft)",
                    }}
                  >
                    <td
                      colSpan={7}
                      style={{
                        padding: "10px 14px",
                        color: "var(--text-primary)",
                        fontSize: 12,
                        fontWeight: 500,
                        background: "var(--bg-base)",
                      }}
                    >
                      <span
                        style={{
                          display: "inline-flex",
                          alignItems: "center",
                          gap: 6,
                        }}
                      >
                        <Box size={13} color="var(--text-secondary)" />
                        Product Specs
                        <span style={{ color: "var(--text-muted)", marginLeft: 4 }}>
                          · {filtered.length}
                        </span>
                      </span>
                    </td>
                  </tr>
                  {filtered.length === 0 ? (
                    <tr>
                      <td
                        colSpan={7}
                        style={{
                          padding: "24px 14px",
                          textAlign: "center",
                          color: "var(--text-secondary)",
                          fontSize: 12,
                        }}
                        data-testid="product-spec-references-no-matches"
                      >
                        No references match the current filters.
                      </td>
                    </tr>
                  ) : (
                    filtered.map((reference) => (
                      <CatalogRow
                        key={reference.entityId}
                        reference={reference}
                        selected={selectedId === reference.entityId}
                        onSelect={() => setSelectedId(reference.entityId)}
                      />
                    ))
                  )}
                </tbody>
              </table>
            )}
          </div>

          {selected && (
            <SpecDetailDrawer
              engagementId={engagementId}
              reference={selected}
              onClose={() => setSelectedId(null)}
            />
          )}
        </div>
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

function SectionHeading({
  children,
  align,
  pad,
}: {
  children: React.ReactNode;
  align?: "left" | "right";
  pad?: "right";
}) {
  return (
    <th
      style={{
        padding: pad === "right" ? "8px 14px 8px 8px" : "8px 8px",
        textAlign: align ?? "left",
        color: "var(--text-secondary)",
        fontSize: 10.5,
        fontWeight: 600,
        letterSpacing: 0.4,
        textTransform: "uppercase",
      }}
    >
      {children}
    </th>
  );
}
