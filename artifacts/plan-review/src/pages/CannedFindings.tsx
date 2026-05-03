import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { DashboardLayout } from "@workspace/portal-ui";
import {
  useListCannedFindings,
  useCreateCannedFinding,
  useUpdateCannedFinding,
  useDeleteCannedFinding,
  getListCannedFindingsQueryKey,
  type CannedFinding,
  type CannedFindingDiscipline,
  type FindingSeverity,
  type FindingCategory,
} from "@workspace/api-client-react";
import { useNavGroups } from "../components/NavGroups";
import {
  FINDING_CATEGORY_LABELS,
  FINDING_SEVERITY_LABELS,
} from "../lib/findingsApi";
import { useSessionTenantId } from "../lib/session";

const DISCIPLINES: CannedFindingDiscipline[] = [
  "building",
  "fire",
  "zoning",
  "civil",
];
const DISCIPLINE_LABELS: Record<CannedFindingDiscipline, string> = {
  building: "Building",
  fire: "Fire",
  zoning: "Zoning",
  civil: "Civil",
};
const SEVERITIES: FindingSeverity[] = ["blocker", "concern", "advisory"];
const CATEGORIES: FindingCategory[] = [
  "setback",
  "height",
  "coverage",
  "egress",
  "use",
  "overlay-conflict",
  "divergence-related",
  "other",
];

export default function CannedFindingsPage() {
  const navGroups = useNavGroups();
  const qc = useQueryClient();
  const [discipline, setDiscipline] = useState<CannedFindingDiscipline | "all">(
    "all",
  );
  const [includeArchived, setIncludeArchived] = useState(false);
  const [editing, setEditing] = useState<CannedFinding | null>(null);
  const [creating, setCreating] = useState(false);

  const params = useMemo(
    () => ({
      ...(discipline !== "all" ? { discipline } : {}),
      includeArchived,
    }),
    [discipline, includeArchived],
  );
  // PLR-10 — tenant id now comes from the authenticated session so a
  // future multi-tenant deployment scopes the library per-install
  // instead of every tenant sharing one `"default"` keyring. The
  // server enforces the same scoping (path `:tenantId` must match
  // `req.session.tenantId`) for defense-in-depth. Suppress the
  // request until the session resolves so the first paint never
  // briefly aims at an empty / wrong tenant.
  const tenantId = useSessionTenantId();
  const listQuery = useListCannedFindings(tenantId ?? "", params, {
    query: {
      enabled: !!tenantId,
      queryKey: getListCannedFindingsQueryKey(tenantId ?? "", params),
    },
  });

  // Invalidate every list-canned-findings query for this tenant by
  // matching on the URL prefix the generated queryKey starts with.
  // Refer to `getListCannedFindingsQueryKey`: the key is
  // `[urlWithSearch]`, so a `predicate` that matches on the URL prefix
  // catches every (discipline, includeArchived) variant.
  const invalidate = () => {
    if (!tenantId) return Promise.resolve();
    const prefix = getListCannedFindingsQueryKey(tenantId)[0];
    return qc.invalidateQueries({
      predicate: (q) => {
        const k0 = q.queryKey[0];
        return typeof k0 === "string" && k0.startsWith(String(prefix));
      },
    });
  };

  const archive = useDeleteCannedFinding({
    mutation: { onSuccess: () => { void invalidate(); } },
  });
  const update = useUpdateCannedFinding({
    mutation: { onSuccess: () => { void invalidate(); } },
  });

  const rows = listQuery.data?.cannedFindings ?? [];

  return (
    <DashboardLayout
      title="Canned Findings"
      navGroups={navGroups}
      brandLabel="SMARTCITY OS"
      brandProductName="Plan Review"
    >
      <div className="flex flex-col gap-4" data-testid="canned-findings-page">
        <div
          className="flex items-center"
          style={{ gap: 12, flexWrap: "wrap" }}
        >
          <label className="flex items-center" style={{ gap: 6 }}>
            <span className="sc-label" style={{ fontSize: 11 }}>
              DISCIPLINE
            </span>
            <select
              data-testid="canned-findings-discipline-filter"
              value={discipline}
              onChange={(e) =>
                setDiscipline(
                  e.target.value as CannedFindingDiscipline | "all",
                )
              }
              style={selectStyle}
            >
              <option value="all">All</option>
              {DISCIPLINES.map((d) => (
                <option key={d} value={d}>
                  {DISCIPLINE_LABELS[d]}
                </option>
              ))}
            </select>
          </label>
          <label className="flex items-center" style={{ gap: 6 }}>
            <input
              type="checkbox"
              data-testid="canned-findings-include-archived"
              checked={includeArchived}
              onChange={(e) => setIncludeArchived(e.target.checked)}
            />
            <span className="sc-label" style={{ fontSize: 11 }}>
              INCLUDE ARCHIVED
            </span>
          </label>
          <button
            type="button"
            data-testid="canned-findings-add"
            className="sc-btn sc-btn-primary"
            style={{ marginLeft: "auto" }}
            onClick={() => setCreating(true)}
          >
            + Add canned finding
          </button>
        </div>

        {listQuery.isLoading && (
          <div className="sc-body opacity-60" style={{ fontSize: 12 }}>
            Loading…
          </div>
        )}
        {listQuery.error && (
          <div className="sc-body" style={{ fontSize: 12, color: "var(--text-danger)" }}>
            Failed to load canned findings.
          </div>
        )}

        {!listQuery.isLoading && rows.length === 0 && (
          <div
            data-testid="canned-findings-empty"
            className="sc-body opacity-60"
            style={{ fontSize: 12 }}
          >
            No canned findings yet. Click <em>Add canned finding</em> to start.
          </div>
        )}

        <div
          data-testid="canned-findings-list"
          style={{ display: "flex", flexDirection: "column", gap: 8 }}
        >
          {rows.map((row) => (
            <CannedFindingRow
              key={row.id}
              row={row}
              onEdit={() => setEditing(row)}
              onArchive={() => {
                if (!tenantId) return;
                archive.mutate({ tenantId, cannedFindingId: row.id });
              }}
              onUnarchive={() => {
                if (!tenantId) return;
                update.mutate({
                  tenantId,
                  cannedFindingId: row.id,
                  data: { archivedAt: null },
                });
              }}
            />
          ))}
        </div>

        {tenantId && (creating || editing) && (
          <CannedFindingEditor
            tenantId={tenantId}
            existing={editing}
            onClose={() => {
              setEditing(null);
              setCreating(false);
            }}
            onSaved={() => {
              setEditing(null);
              setCreating(false);
              void invalidate();
            }}
          />
        )}
      </div>
    </DashboardLayout>
  );
}

function CannedFindingRow({
  row,
  onEdit,
  onArchive,
  onUnarchive,
}: {
  row: CannedFinding;
  onEdit: () => void;
  onArchive: () => void;
  onUnarchive: () => void;
}) {
  const archived = !!row.archivedAt;
  return (
    <div
      data-testid={`canned-finding-row-${row.id}`}
      style={{
        border: "1px solid var(--border-subtle)",
        borderRadius: 6,
        padding: 12,
        display: "flex",
        gap: 12,
        background: archived ? "var(--surface-2, transparent)" : undefined,
        opacity: archived ? 0.65 : 1,
      }}
    >
      <span
        aria-hidden
        style={{
          width: 8,
          alignSelf: "stretch",
          background: row.color,
          borderRadius: 2,
          flexShrink: 0,
        }}
      />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="flex items-center" style={{ gap: 8, flexWrap: "wrap" }}>
          <strong style={{ fontSize: 13 }}>{row.title}</strong>
          <span className="sc-pill" style={{ fontSize: 10 }}>
            {DISCIPLINE_LABELS[row.discipline]}
          </span>
          <span className="sc-pill" style={{ fontSize: 10 }}>
            {FINDING_SEVERITY_LABELS[row.severity]}
          </span>
          <span className="sc-pill" style={{ fontSize: 10 }}>
            {FINDING_CATEGORY_LABELS[row.category]}
          </span>
          {archived && (
            <span
              className="sc-pill"
              style={{ fontSize: 10, color: "var(--text-secondary)" }}
            >
              Archived
            </span>
          )}
        </div>
        {row.defaultBody && (
          <div
            className="sc-body opacity-80"
            style={{
              fontSize: 12,
              marginTop: 4,
              whiteSpace: "pre-wrap",
            }}
          >
            {row.defaultBody}
          </div>
        )}
        {row.codeAtomCitations.length > 0 && (
          <div
            className="sc-meta opacity-70"
            style={{ fontSize: 11, marginTop: 4 }}
          >
            Citations: {row.codeAtomCitations.map((c) => c.atomId).join(", ")}
          </div>
        )}
      </div>
      <div style={{ display: "flex", gap: 6, alignItems: "flex-start" }}>
        <button
          type="button"
          className="sc-btn"
          data-testid={`canned-finding-edit-${row.id}`}
          onClick={onEdit}
          style={{ fontSize: 12 }}
        >
          Edit
        </button>
        {archived ? (
          <button
            type="button"
            className="sc-btn"
            data-testid={`canned-finding-unarchive-${row.id}`}
            onClick={onUnarchive}
            style={{ fontSize: 12 }}
          >
            Restore
          </button>
        ) : (
          <button
            type="button"
            className="sc-btn"
            data-testid={`canned-finding-archive-${row.id}`}
            onClick={onArchive}
            style={{ fontSize: 12 }}
          >
            Archive
          </button>
        )}
      </div>
    </div>
  );
}

function CannedFindingEditor({
  tenantId,
  existing,
  onClose,
  onSaved,
}: {
  tenantId: string;
  existing: CannedFinding | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const isEdit = !!existing;
  const [discipline, setDiscipline] = useState<CannedFindingDiscipline>(
    existing?.discipline ?? "building",
  );
  const [title, setTitle] = useState(existing?.title ?? "");
  const [defaultBody, setDefaultBody] = useState(existing?.defaultBody ?? "");
  const [severity, setSeverity] = useState<FindingSeverity>(
    existing?.severity ?? "concern",
  );
  const [category, setCategory] = useState<FindingCategory>(
    existing?.category ?? "other",
  );
  const [color, setColor] = useState<string>(existing?.color ?? "#6b7280");
  const [citationsText, setCitationsText] = useState<string>(
    (existing?.codeAtomCitations ?? []).map((c) => c.atomId).join(", "),
  );
  const [error, setError] = useState<string | null>(null);

  const create = useCreateCannedFinding();
  const update = useUpdateCannedFinding();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    const trimmed = title.trim();
    if (!trimmed) {
      setError("Title is required.");
      return;
    }
    const codeAtomCitations = citationsText
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((atomId) => ({ kind: "code-section" as const, atomId }));
    try {
      if (isEdit) {
        await update.mutateAsync({
          tenantId,
          cannedFindingId: existing!.id,
          data: {
            discipline,
            title: trimmed,
            defaultBody,
            severity,
            category,
            color,
            codeAtomCitations,
          },
        });
      } else {
        await create.mutateAsync({
          tenantId,
          data: {
            discipline,
            title: trimmed,
            defaultBody,
            severity,
            category,
            color,
            codeAtomCitations,
          },
        });
      }
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save.");
    }
  };

  return (
    <div
      data-testid="canned-finding-editor"
      role="dialog"
      aria-modal="true"
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.4)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 100,
      }}
      onClick={onClose}
    >
      <form
        onSubmit={handleSubmit}
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "var(--surface-1, #1a1a1a)",
          color: "var(--text-primary)",
          borderRadius: 8,
          padding: 16,
          width: "min(560px, 92vw)",
          maxHeight: "90vh",
          overflow: "auto",
          display: "flex",
          flexDirection: "column",
          gap: 10,
          border: "1px solid var(--border-default)",
        }}
      >
        <h2 style={{ margin: 0, fontSize: 14 }}>
          {isEdit ? "Edit canned finding" : "Add canned finding"}
        </h2>
        <div style={{ display: "flex", gap: 8 }}>
          <label style={{ flex: 1 }} className="flex flex-col">
            <span className="sc-label" style={{ fontSize: 10 }}>DISCIPLINE</span>
            <select
              data-testid="canned-finding-editor-discipline"
              value={discipline}
              onChange={(e) =>
                setDiscipline(e.target.value as CannedFindingDiscipline)
              }
              style={selectStyle}
            >
              {DISCIPLINES.map((d) => (
                <option key={d} value={d}>
                  {DISCIPLINE_LABELS[d]}
                </option>
              ))}
            </select>
          </label>
          <label style={{ width: 90 }} className="flex flex-col">
            <span className="sc-label" style={{ fontSize: 10 }}>COLOR</span>
            <input
              type="color"
              data-testid="canned-finding-editor-color"
              value={color}
              onChange={(e) => setColor(e.target.value)}
              style={{ height: 28, padding: 0, border: "none", background: "transparent" }}
            />
          </label>
        </div>
        <label className="flex flex-col">
          <span className="sc-label" style={{ fontSize: 10 }}>TITLE</span>
          <input
            data-testid="canned-finding-editor-title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            required
            style={inputStyle}
          />
        </label>
        <label className="flex flex-col">
          <span className="sc-label" style={{ fontSize: 10 }}>DEFAULT BODY</span>
          <textarea
            data-testid="canned-finding-editor-body"
            value={defaultBody}
            onChange={(e) => setDefaultBody(e.target.value)}
            rows={5}
            style={{ ...inputStyle, resize: "vertical" }}
          />
        </label>
        <div style={{ display: "flex", gap: 8 }}>
          <label className="flex flex-col" style={{ flex: 1 }}>
            <span className="sc-label" style={{ fontSize: 10 }}>SEVERITY</span>
            <select
              data-testid="canned-finding-editor-severity"
              value={severity}
              onChange={(e) => setSeverity(e.target.value as FindingSeverity)}
              style={selectStyle}
            >
              {SEVERITIES.map((s) => (
                <option key={s} value={s}>
                  {FINDING_SEVERITY_LABELS[s]}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col" style={{ flex: 1 }}>
            <span className="sc-label" style={{ fontSize: 10 }}>CATEGORY</span>
            <select
              data-testid="canned-finding-editor-category"
              value={category}
              onChange={(e) => setCategory(e.target.value as FindingCategory)}
              style={selectStyle}
            >
              {CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {FINDING_CATEGORY_LABELS[c]}
                </option>
              ))}
            </select>
          </label>
        </div>
        <label className="flex flex-col">
          <span className="sc-label" style={{ fontSize: 10 }}>
            CODE ATOM CITATIONS (comma separated atom ids)
          </span>
          <input
            data-testid="canned-finding-editor-citations"
            value={citationsText}
            onChange={(e) => setCitationsText(e.target.value)}
            placeholder="e.g. zoning-19.3.2, building-503.1"
            style={inputStyle}
          />
        </label>
        {error && (
          <div className="sc-body" style={{ fontSize: 12, color: "var(--text-danger)" }}>
            {error}
          </div>
        )}
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button type="button" className="sc-btn" onClick={onClose}>
            Cancel
          </button>
          <button
            type="submit"
            className="sc-btn sc-btn-primary"
            data-testid="canned-finding-editor-save"
            disabled={create.isPending || update.isPending}
          >
            {isEdit ? "Save" : "Create"}
          </button>
        </div>
      </form>
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  background: "var(--bg-input)",
  border: "1px solid var(--border-default)",
  borderRadius: 4,
  padding: "6px 8px",
  fontSize: 12,
  color: "var(--text-primary)",
  fontFamily: "inherit",
};
const selectStyle: React.CSSProperties = { ...inputStyle, padding: "4px 6px" };
