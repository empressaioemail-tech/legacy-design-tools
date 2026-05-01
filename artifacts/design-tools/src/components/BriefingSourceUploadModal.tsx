import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useCreateEngagementBriefingSource,
  getGetEngagementBriefingQueryKey,
} from "@workspace/api-client-react";
import { useUpload } from "@workspace/object-storage-web";

/**
 * One closed-set option in the layer-kind picker. The router and
 * database treat `layerKind` as free-form text so DA-PI-2's federal
 * adapters can register new values without a UI change, but the manual
 * upload UI surfaces a curated list of the layers QGIS exports today
 * so an architect does not have to memorize the slug. The "Other"
 * entry opens a free-text field for the long-tail.
 *
 * DA-MV-1 — `kind` discriminates which upload modality the picker
 * sends to the route: `qgis` rows go through the existing 2D-overlay
 * branch, `dxf` rows go through the new DXF→glb conversion branch
 * and feed the 3D viewer. The two groups render as separate
 * `<optgroup>` blocks so the visual grouping mirrors the route's
 * branching contract — there is no "DXF easements" catch-all today.
 */
interface LayerKindOption {
  value: string;
  label: string;
  kind: "qgis" | "dxf";
  hint?: string;
}

const LAYER_KIND_OPTIONS: LayerKindOption[] = [
  // -- 2D overlays (QGIS / GeoJSON) --
  {
    value: "qgis-zoning",
    label: "Zoning",
    kind: "qgis",
    hint: "Zoning districts and overlays exported from QGIS.",
  },
  {
    value: "qgis-parcel",
    label: "Parcel boundaries",
    kind: "qgis",
    hint: "Parcel polygons + attributes exported from QGIS.",
  },
  {
    value: "qgis-flood",
    label: "Flood / hazard",
    kind: "qgis",
    hint: "FEMA flood zones or other hazard overlays.",
  },
  {
    value: "qgis-utilities",
    label: "Utilities",
    kind: "qgis",
    hint: "Sewer / water / power infrastructure layers.",
  },
  // -- 3D geometry (DXF) — DA-MV-1, Spec 52 §2 materializable variants --
  {
    value: "terrain",
    label: "Terrain mesh",
    kind: "dxf",
    hint: "Site terrain mesh (DXF, exported from civil software).",
  },
  {
    value: "property-line",
    label: "Property line",
    kind: "dxf",
    hint: "Site boundary polyline (DXF).",
  },
  {
    value: "setback-plane",
    label: "Setback plane",
    kind: "dxf",
    hint: "Translucent setback envelope volume (DXF).",
  },
  {
    value: "buildable-envelope",
    label: "Buildable envelope",
    kind: "dxf",
    hint: "Allowable building volume (DXF).",
  },
  {
    value: "floodplain",
    label: "Floodplain",
    kind: "dxf",
    hint: "FEMA floodplain volume (DXF).",
  },
  {
    value: "wetland",
    label: "Wetland",
    kind: "dxf",
    hint: "Wetland boundary volume (DXF).",
  },
  {
    value: "neighbor-mass",
    label: "Neighboring mass",
    kind: "dxf",
    hint: "Neighboring building mass (DXF).",
  },
];

const OTHER_OPTION_VALUE = "__other__";
const LAYER_KIND_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$/;

/** Allowed file extensions per upload kind. The picker rejects
 * mismatched files in the client so a wrong extension doesn't
 * round-trip to the server's 400. The lists are intentionally
 * permissive — a `.geojson.txt` is still a GeoJSON in spirit, but
 * the route's content-type check is the authoritative gate. */
const ALLOWED_EXTENSIONS: Record<"qgis" | "dxf", readonly string[]> = {
  qgis: [".geojson", ".json", ".shp", ".kml", ".gpkg", ".zip"],
  dxf: [".dxf"],
};

function fileExtension(name: string): string {
  const i = name.lastIndexOf(".");
  return i >= 0 ? name.slice(i).toLowerCase() : "";
}

export interface BriefingSourceUploadModalProps {
  engagementId: string;
  isOpen: boolean;
  onClose: () => void;
  /**
   * Layer kinds that already have a current source. Surfaced under the
   * picker so the architect knows a re-upload will mark the prior
   * source superseded — Spec 51 §4 contract is intentional, and the
   * modal makes it visible rather than silent.
   */
  existingLayerKinds: string[];
}

interface FormState {
  layerKindChoice: string;
  customLayerKind: string;
  provider: string;
  snapshotDate: string;
  note: string;
  file: File | null;
}

const EMPTY_FORM: FormState = {
  layerKindChoice: LAYER_KIND_OPTIONS[0]!.value,
  customLayerKind: "",
  provider: "",
  snapshotDate: "",
  note: "",
  file: null,
};

/**
 * Modal: pick a layer kind, attach a file, and (optionally) supply a
 * provider / snapshot date / note. On submit we run the existing
 * presigned-URL flow (`useUpload` from `@workspace/object-storage-web`)
 * to land the bytes, then call the briefing-source create mutation
 * with the resulting `objectPath` + file metadata. After success the
 * `engagement-briefing` query is invalidated so the parent tab re-
 * renders with the new (or superseded) source.
 *
 * The modal does no lazy briefing creation of its own — the route is
 * the one responsible for first-upload-creates-briefing. The UI just
 * sends the metadata.
 */
export function BriefingSourceUploadModal({
  engagementId,
  isOpen,
  onClose,
  existingLayerKinds,
}: BriefingSourceUploadModalProps) {
  const queryClient = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [error, setError] = useState<string | null>(null);

  // Reset form whenever the modal re-opens so a previous attempt does
  // not leak across openings (mirrors the EngagementDetailsModal
  // pattern).
  useEffect(() => {
    if (isOpen) {
      setForm(EMPTY_FORM);
      setError(null);
    }
  }, [isOpen]);

  const upload = useUpload();
  const createMutation = useCreateEngagementBriefingSource({
    mutation: {
      onSuccess: () => {
        void queryClient.invalidateQueries({
          queryKey: getGetEngagementBriefingQueryKey(engagementId),
        });
      },
    },
  });

  if (!isOpen) return null;

  const submitting = upload.isUploading || createMutation.isPending;

  const resolvedLayerKind =
    form.layerKindChoice === OTHER_OPTION_VALUE
      ? form.customLayerKind.trim().toLowerCase()
      : form.layerKindChoice;

  // Picker selection drives the upload modality: any of the curated
  // 3D-geometry rows resolves to `dxf`, everything else (curated
  // QGIS rows + the free-text `OTHER` slug) resolves to `qgis`. The
  // route enforces the same pairing server-side, so a mismatch here
  // fails closed.
  const selectedOption = LAYER_KIND_OPTIONS.find(
    (o) => o.value === form.layerKindChoice,
  );
  const resolvedUploadKind: "qgis" | "dxf" =
    selectedOption?.kind === "dxf" ? "dxf" : "qgis";

  const willSupersede =
    resolvedLayerKind.length > 0 &&
    existingLayerKinds.includes(resolvedLayerKind);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0] ?? null;
    setForm((prev) => ({ ...prev, file }));
  };

  const handleSubmit = async () => {
    setError(null);
    if (!form.file) {
      setError("Pick a file to upload.");
      return;
    }
    if (!resolvedLayerKind) {
      setError("Pick a layer kind (or fill in the custom slug).");
      return;
    }
    if (
      form.layerKindChoice === OTHER_OPTION_VALUE &&
      !LAYER_KIND_PATTERN.test(resolvedLayerKind)
    ) {
      setError(
        "Layer slug must be lowercase letters / digits / dashes (e.g. qgis-zoning).",
      );
      return;
    }
    // Client-side extension check. The server accepts content-type
    // strings (not extensions) so this is a UX guardrail, not a
    // security boundary — its job is to catch a `.dxf` accidentally
    // landing on the QGIS branch (or vice versa) before bytes hit the
    // network.
    const ext = fileExtension(form.file.name);
    const allowed = ALLOWED_EXTENSIONS[resolvedUploadKind];
    if (ext && !allowed.includes(ext)) {
      setError(
        resolvedUploadKind === "dxf"
          ? `3D-geometry layers expect a DXF file (.dxf); picked ${ext}.`
          : `2D-overlay layers expect a vector file (${allowed.join(", ")}); picked ${ext}.`,
      );
      return;
    }

    const uploadResponse = await upload.uploadFile(form.file);
    if (!uploadResponse) {
      // useUpload populated `error`; surface its message verbatim so a
      // 4xx from the storage route shows up in the modal rather than
      // getting silently dropped.
      setError(upload.error?.message ?? "Upload failed.");
      return;
    }

    let snapshotDate: string | undefined;
    if (form.snapshotDate.trim()) {
      // <input type="date"> emits "YYYY-MM-DD"; widen to an ISO
      // timestamp at noon UTC so the resulting `snapshotDate` lands on
      // the picked calendar day in every timezone the architect might
      // load the page from. (Picking midnight UTC would shift back a
      // day for users west of UTC.)
      snapshotDate = new Date(`${form.snapshotDate}T12:00:00Z`).toISOString();
    }

    const trimmedNote = form.note.trim();
    const trimmedProvider = form.provider.trim();

    try {
      await createMutation.mutateAsync({
        id: engagementId,
        data: {
          layerKind: resolvedLayerKind,
          provider: trimmedProvider.length > 0 ? trimmedProvider : null,
          snapshotDate: snapshotDate ?? null,
          note: trimmedNote.length > 0 ? trimmedNote : null,
          upload: {
            kind: resolvedUploadKind,
            objectPath: uploadResponse.objectPath,
            originalFilename: form.file.name,
            contentType: form.file.type || "application/octet-stream",
            byteSize: form.file.size,
          },
        },
      });
      onClose();
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to record briefing source.";
      setError(message);
    }
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
          maxWidth: 520,
          maxHeight: "90vh",
          overflow: "auto",
          display: "flex",
          flexDirection: "column",
        }}
      >
        <div className="sc-card-header">
          <div className="flex flex-col gap-1">
            <span
              style={{
                fontSize: 16,
                fontWeight: 600,
                color: "var(--text-primary)",
              }}
            >
              Upload site context source
            </span>
            <span style={{ fontSize: 12, color: "var(--text-muted)" }}>
              Manually-exported QGIS overlays (2D) and DXF site geometry (3D)
              attach to this engagement's parcel briefing. Re-uploading the
              same layer kind supersedes the prior source.
            </span>
          </div>
        </div>

        <div className="p-4 flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <label
              className="sc-label"
              htmlFor="briefing-source-layer-kind"
              style={{ fontSize: 12, fontWeight: 600 }}
            >
              Layer kind
            </label>
            <select
              id="briefing-source-layer-kind"
              className="sc-input"
              value={form.layerKindChoice}
              disabled={submitting}
              onChange={(e) =>
                setForm((prev) => ({
                  ...prev,
                  layerKindChoice: e.target.value,
                }))
              }
            >
              <optgroup label="2D overlays (QGIS)">
                {LAYER_KIND_OPTIONS.filter((o) => o.kind === "qgis").map(
                  (opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ),
                )}
                <option value={OTHER_OPTION_VALUE}>Other (custom slug)</option>
              </optgroup>
              <optgroup label="3D geometry (DXF)">
                {LAYER_KIND_OPTIONS.filter((o) => o.kind === "dxf").map(
                  (opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ),
                )}
              </optgroup>
            </select>
            {form.layerKindChoice !== OTHER_OPTION_VALUE && (
              <span style={{ fontSize: 11, color: "var(--text-muted)" }}>
                {
                  LAYER_KIND_OPTIONS.find(
                    (o) => o.value === form.layerKindChoice,
                  )?.hint
                }
              </span>
            )}
            {form.layerKindChoice === OTHER_OPTION_VALUE && (
              <input
                type="text"
                className="sc-input"
                placeholder="qgis-easements"
                value={form.customLayerKind}
                disabled={submitting}
                onChange={(e) =>
                  setForm((prev) => ({
                    ...prev,
                    customLayerKind: e.target.value,
                  }))
                }
              />
            )}
            {willSupersede && (
              <span style={{ fontSize: 11, color: "var(--warning-text)" }}>
                A current source already exists for{" "}
                <code>{resolvedLayerKind}</code>; this upload will mark the
                prior one superseded.
              </span>
            )}
          </div>

          <div className="flex flex-col gap-2">
            <label
              className="sc-label"
              htmlFor="briefing-source-file"
              style={{ fontSize: 12, fontWeight: 600 }}
            >
              File
            </label>
            <input
              id="briefing-source-file"
              ref={fileInputRef}
              type="file"
              className="sc-input"
              disabled={submitting}
              // `accept` is a UX nudge — the file picker still allows
              // overriding via "All files". The submit-time extension
              // check is the actual enforcement.
              accept={ALLOWED_EXTENSIONS[resolvedUploadKind].join(",")}
              onChange={handleFileChange}
            />
            {form.file && (
              <span style={{ fontSize: 11, color: "var(--text-muted)" }}>
                {form.file.name} ·{" "}
                {(form.file.size / 1024).toFixed(form.file.size < 10240 ? 1 : 0)}{" "}
                KB
              </span>
            )}
          </div>

          <div className="flex flex-col gap-2">
            <label
              className="sc-label"
              htmlFor="briefing-source-provider"
              style={{ fontSize: 12, fontWeight: 600 }}
            >
              Provider <span style={{ color: "var(--text-muted)" }}>(optional)</span>
            </label>
            <input
              id="briefing-source-provider"
              type="text"
              className="sc-input"
              placeholder="City of Boulder QGIS export"
              value={form.provider}
              disabled={submitting}
              maxLength={256}
              onChange={(e) =>
                setForm((prev) => ({ ...prev, provider: e.target.value }))
              }
            />
          </div>

          <div className="flex flex-col gap-2">
            <label
              className="sc-label"
              htmlFor="briefing-source-snapshot-date"
              style={{ fontSize: 12, fontWeight: 600 }}
            >
              Snapshot date{" "}
              <span style={{ color: "var(--text-muted)" }}>
                (optional — defaults to today)
              </span>
            </label>
            <input
              id="briefing-source-snapshot-date"
              type="date"
              className="sc-input"
              value={form.snapshotDate}
              disabled={submitting}
              onChange={(e) =>
                setForm((prev) => ({ ...prev, snapshotDate: e.target.value }))
              }
            />
          </div>

          <div className="flex flex-col gap-2">
            <label
              className="sc-label"
              htmlFor="briefing-source-note"
              style={{ fontSize: 12, fontWeight: 600 }}
            >
              Note <span style={{ color: "var(--text-muted)" }}>(optional)</span>
            </label>
            <textarea
              id="briefing-source-note"
              className="sc-input"
              rows={3}
              placeholder="Exported from QGIS 3.34 with the city's basemap layer applied."
              value={form.note}
              disabled={submitting}
              maxLength={2048}
              onChange={(e) =>
                setForm((prev) => ({ ...prev, note: e.target.value }))
              }
            />
          </div>

          {error && (
            <div
              role="alert"
              style={{
                fontSize: 12,
                color: "var(--danger-text)",
                background: "var(--danger-dim)",
                padding: 8,
                borderRadius: 4,
              }}
            >
              {error}
            </div>
          )}

          {upload.isUploading && (
            <div style={{ fontSize: 12, color: "var(--text-muted)" }}>
              Uploading… {upload.progress}%
            </div>
          )}
        </div>

        <div
          className="sc-card-footer"
          style={{
            display: "flex",
            gap: 8,
            justifyContent: "flex-end",
            padding: 12,
          }}
        >
          <button
            type="button"
            className="sc-btn"
            onClick={onClose}
            disabled={submitting}
          >
            Cancel
          </button>
          <button
            type="button"
            className="sc-btn sc-btn-primary"
            onClick={handleSubmit}
            disabled={submitting}
          >
            {submitting ? "Uploading…" : "Upload"}
          </button>
        </div>
      </div>
    </div>
  );
}
