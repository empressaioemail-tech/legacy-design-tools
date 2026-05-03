import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useUpdateEngagement,
  getGetEngagementQueryKey,
  getListEngagementsQueryKey,
  type EngagementDetail,
} from "@workspace/api-client-react";

const PROJECT_TYPE_OPTIONS: Array<{
  value: "new_build" | "renovation" | "addition" | "tenant_improvement" | "other";
  label: string;
}> = [
  { value: "new_build", label: "New build" },
  { value: "renovation", label: "Renovation" },
  { value: "addition", label: "Addition" },
  { value: "tenant_improvement", label: "Tenant improvement" },
  { value: "other", label: "Other" },
];

const STATUS_OPTIONS: Array<{
  value: "active" | "on_hold" | "archived";
  label: string;
}> = [
  { value: "active", label: "Active" },
  { value: "on_hold", label: "On hold" },
  { value: "archived", label: "Archived" },
];

export interface EngagementDetailsModalProps {
  engagement: EngagementDetail;
  isOpen: boolean;
  onClose: () => void;
  mode: "intake" | "edit";
  onSkip?: () => void;
}

interface FormState {
  name: string;
  address: string;
  jurisdiction: string;
  projectType: "" | (typeof PROJECT_TYPE_OPTIONS)[number]["value"];
  zoningCode: string;
  lotAreaSqft: string;
  status: (typeof STATUS_OPTIONS)[number]["value"];
  applicantFirm: string;
}

function buildInitial(e: EngagementDetail): FormState {
  return {
    name: e.name,
    address: e.address ?? "",
    jurisdiction: e.jurisdiction ?? "",
    projectType: (e.site?.projectType ?? "") as FormState["projectType"],
    zoningCode: e.site?.zoningCode ?? "",
    lotAreaSqft:
      e.site?.lotAreaSqft !== null && e.site?.lotAreaSqft !== undefined
        ? String(e.site.lotAreaSqft)
        : "",
    status: (e.status ?? "active") as FormState["status"],
    applicantFirm: e.applicantFirm ?? "",
  };
}

export function EngagementDetailsModal({
  engagement,
  isOpen,
  onClose,
  mode,
  onSkip,
}: EngagementDetailsModalProps) {
  const qc = useQueryClient();
  const [form, setForm] = useState<FormState>(() => buildInitial(engagement));
  const [warnings, setWarnings] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  // Reset the form when the modal opens for a different engagement.
  useEffect(() => {
    if (isOpen) {
      setForm(buildInitial(engagement));
      setWarnings([]);
      setError(null);
    }
  }, [isOpen, engagement]);

  const mutation = useUpdateEngagement({
    mutation: {
      onSuccess: async (data) => {
        const w = (data as EngagementDetail & { warnings?: string[] })
          .warnings;
        if (Array.isArray(w) && w.length > 0) {
          setWarnings(w);
          // Refresh queries but leave the modal open so the user sees
          // the geocoding warning before closing on their own.
          await qc.invalidateQueries({
            queryKey: getGetEngagementQueryKey(engagement.id),
          });
          await qc.invalidateQueries({
            queryKey: getListEngagementsQueryKey(),
          });
          return;
        }
        await qc.invalidateQueries({
          queryKey: getGetEngagementQueryKey(engagement.id),
        });
        await qc.invalidateQueries({
          queryKey: getListEngagementsQueryKey(),
        });
        onClose();
      },
      onError: (err) => {
        setError(
          err instanceof Error
            ? err.message
            : "Failed to save changes — please try again.",
        );
      },
    },
  });

  if (!isOpen) return null;

  const title = mode === "intake" ? "Welcome — quick details" : "Project details";
  const subtitle =
    mode === "intake"
      ? "We'll use this to look up jurisdiction and site context."
      : null;
  const primaryLabel = mode === "intake" ? "Save & continue" : "Save changes";
  const secondaryLabel = mode === "intake" ? "Skip for now" : "Cancel";

  const submitting = mutation.isPending;

  const handleSave = () => {
    setError(null);
    setWarnings([]);
    const data: Record<string, unknown> = {};
    if (form.name.trim() && form.name.trim() !== engagement.name) {
      data["name"] = form.name.trim();
    }
    const newAddress = form.address.trim();
    if (newAddress !== (engagement.address ?? "")) {
      data["address"] = newAddress;
    }
    if (form.projectType !== "" && form.projectType !== engagement.site?.projectType) {
      data["projectType"] = form.projectType;
    }
    const newZoning = form.zoningCode.trim();
    if (newZoning !== (engagement.site?.zoningCode ?? "")) {
      data["zoningCode"] = newZoning;
    }
    const trimmedLot = form.lotAreaSqft.trim();
    const newLotArea = trimmedLot === "" ? null : Number(trimmedLot);
    const currentLotArea = engagement.site?.lotAreaSqft ?? null;
    if (newLotArea !== currentLotArea) {
      if (newLotArea === null) {
        // Allow explicit clear: send null so the backend nulls the column.
        data["lotAreaSqft"] = null;
      } else if (Number.isFinite(newLotArea)) {
        data["lotAreaSqft"] = newLotArea;
      }
    }
    if (mode === "edit" && form.status !== engagement.status) {
      data["status"] = form.status;
    }
    const newFirm = form.applicantFirm.trim();
    const currentFirm = engagement.applicantFirm ?? "";
    if (newFirm !== currentFirm) {
      // Send null for an explicit clear so the backend nulls the
      // column; otherwise send the trimmed value.
      data["applicantFirm"] = newFirm === "" ? null : newFirm;
    }
    const newJurisdiction = form.jurisdiction.trim();
    const currentJurisdiction = engagement.jurisdiction ?? "";
    if (newJurisdiction !== currentJurisdiction) {
      data["jurisdiction"] = newJurisdiction;
    }

    if (Object.keys(data).length === 0) {
      onClose();
      return;
    }

    mutation.mutate({ id: engagement.id, data });
  };

  const handleSecondary = () => {
    if (mode === "intake" && onSkip) onSkip();
    onClose();
  };

  return (
    <div
      onClick={onClose}
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
        style={{
          width: "100%",
          maxWidth: 480,
          maxHeight: "90vh",
          overflow: "auto",
          display: "flex",
          flexDirection: "column",
        }}
      >
        <div className="sc-card-header">
          <div className="flex flex-col gap-1">
            <span style={{ fontSize: 16, fontWeight: 600, color: "var(--text-primary)" }}>
              {title}
            </span>
            {subtitle && <span className="sc-meta opacity-70">{subtitle}</span>}
          </div>
        </div>

        <div className="p-4 flex flex-col" style={{ gap: 12 }}>
          <Field label="Project name">
            <input
              type="text"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              disabled={submitting}
              className="sc-ui"
              style={inputStyle}
            />
          </Field>

          <Field label="Address">
            <textarea
              value={form.address}
              onChange={(e) => setForm({ ...form, address: e.target.value })}
              disabled={submitting}
              rows={2}
              className="sc-ui sc-scroll"
              style={{ ...inputStyle, resize: "vertical", minHeight: 50 }}
              placeholder="Street, city, state, ZIP"
            />
            {warnings.length > 0 && (
              <div
                className="sc-meta"
                style={{
                  marginTop: 4,
                  color: "#f59e0b",
                }}
              >
                {warnings.join(" ")}
              </div>
            )}
          </Field>

          <Field label="Jurisdiction (optional)">
            <input
              type="text"
              value={form.jurisdiction}
              onChange={(e) =>
                setForm({ ...form, jurisdiction: e.target.value })
              }
              disabled={submitting}
              placeholder="e.g., Moab, UT"
              className="sc-ui"
              style={inputStyle}
              data-testid="engagement-jurisdiction-input"
            />
            <span
              className="sc-meta"
              style={{ marginTop: 4, opacity: 0.7 }}
            >
              City, State (e.g. "Moab, UT"). Used to gate which adapters
              fire when the address geocoder can't resolve a city.
            </span>
          </Field>

          <Field label="Project type">
            <select
              value={form.projectType}
              onChange={(e) =>
                setForm({
                  ...form,
                  projectType: e.target.value as FormState["projectType"],
                })
              }
              disabled={submitting}
              className="sc-ui"
              style={inputStyle}
            >
              <option value="">Select…</option>
              {PROJECT_TYPE_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </Field>

          <Field label="Applicant firm (optional)">
            <input
              type="text"
              value={form.applicantFirm}
              onChange={(e) =>
                setForm({ ...form, applicantFirm: e.target.value })
              }
              disabled={submitting}
              placeholder="e.g., Civic Design LLC"
              className="sc-ui"
              style={inputStyle}
              data-testid="engagement-applicant-firm-input"
            />
          </Field>

          <Field label="Zoning code (optional)">
            <input
              type="text"
              value={form.zoningCode}
              onChange={(e) => setForm({ ...form, zoningCode: e.target.value })}
              disabled={submitting}
              placeholder="e.g., R-1A"
              className="sc-ui"
              style={inputStyle}
            />
          </Field>

          <Field label="Lot area (sq ft, optional)">
            <input
              type="number"
              value={form.lotAreaSqft}
              onChange={(e) =>
                setForm({ ...form, lotAreaSqft: e.target.value })
              }
              disabled={submitting}
              min={0}
              className="sc-ui"
              style={inputStyle}
            />
          </Field>

          {mode === "edit" && (
            <Field label="Status">
              <div style={{ display: "flex", gap: 4 }}>
                {STATUS_OPTIONS.map((o) => {
                  const active = form.status === o.value;
                  return (
                    <button
                      key={o.value}
                      type="button"
                      onClick={() => setForm({ ...form, status: o.value })}
                      disabled={submitting}
                      className="sc-ui"
                      style={{
                        flex: 1,
                        padding: "6px 10px",
                        background: active
                          ? "var(--bg-active)"
                          : "var(--bg-input)",
                        color: active
                          ? "var(--text-primary)"
                          : "var(--text-secondary)",
                        border: active
                          ? "1px solid var(--cyan)"
                          : "1px solid var(--border-default)",
                        borderRadius: 4,
                        cursor: submitting ? "not-allowed" : "pointer",
                        fontSize: 12,
                      }}
                    >
                      {o.label}
                    </button>
                  );
                })}
              </div>
            </Field>
          )}

          {error && (
            <div
              className="sc-meta"
              style={{ color: "#ef4444" }}
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
            className="sc-btn-ghost"
            onClick={handleSecondary}
            disabled={submitting}
          >
            {secondaryLabel}
          </button>
          <button
            className="sc-btn-primary"
            onClick={handleSave}
            disabled={submitting}
          >
            {submitting ? "Saving…" : primaryLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  width: "100%",
  background: "var(--bg-input)",
  border: "1px solid var(--border-default)",
  color: "var(--text-primary)",
  padding: "6px 10px",
  borderRadius: 4,
  outline: "none",
  fontSize: 12.5,
};

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <span className="sc-label" style={{ color: "var(--text-secondary)" }}>
        {label}
      </span>
      {children}
    </label>
  );
}
