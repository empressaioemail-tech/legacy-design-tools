import { useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListDetailCalloutSpecs,
  getListDetailCalloutSpecsQueryKey,
  useCreateDetailCalloutSpec,
  useUpdateDetailCalloutSpecPushState,
  useAttachDetailCalloutSpecApsRef,
  ApiError,
  type DetailCalloutSpecAtom,
  type DetailCalloutPushState,
  type DetailCalloutType,
  type DetailCalloutSpecPayload,
  type WallAssemblyLayer,
  type DoorScheduleRow,
} from "@workspace/api-client-react";
import { relativeTime } from "../../lib/relativeTime";

/**
 * Cortex L4 (Lane C.4 / C.4.4) — architect-side detail-callout-spec
 * surface.
 *
 * Lists the engagement's detail-callout specs, defines a new spec
 * (detail type + structured content), triggers the Revit push
 * (`pending → pushed`), and surfaces the push lifecycle
 * (`pending → pushed → applied | rejected-by-user`). Co-designed with
 * cc-agent-M's `cortex_detail_callout_spec_*` MCP tools.
 */

const DETAIL_TYPES: ReadonlyArray<DetailCalloutType> = [
  "door-schedule",
  "wall-section",
  "wall-type",
  "room-finish",
];

/** Legal push transitions — mirrors the engine `LEGAL_PUSH_TRANSITIONS`. */
const NEXT_PUSH_ACTIONS: Record<
  DetailCalloutPushState,
  ReadonlyArray<{ to: DetailCalloutPushState; label: string }>
> = {
  pending: [{ to: "pushed", label: "Push to Revit" }],
  pushed: [
    { to: "applied", label: "Mark applied" },
    { to: "rejected-by-user", label: "Mark rejected" },
  ],
  applied: [],
  "rejected-by-user": [{ to: "pending", label: "Revise (back to pending)" }],
};

const PUSH_STATE_COLORS: Record<
  DetailCalloutPushState,
  { bg: string; fg: string }
> = {
  pending: { bg: "var(--bg-input)", fg: "var(--text-muted)" },
  pushed: { bg: "var(--info-dim)", fg: "var(--info-text)" },
  applied: { bg: "var(--success-dim)", fg: "var(--success-text)" },
  "rejected-by-user": { bg: "var(--danger-dim)", fg: "var(--danger-text)" },
};

const inputStyle: React.CSSProperties = {
  width: "100%",
  background: "var(--bg-input)",
  border: "1px solid var(--border-default)",
  color: "var(--text-primary)",
  padding: "6px 8px",
  borderRadius: 4,
  outline: "none",
  fontSize: 12,
};

function formatSpecError(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 409) {
      return "That push-state change isn't legal from the spec's current state.";
    }
    if (err.status === 404) return "This spec no longer exists. Refresh.";
    if (err.status === 400) return "The spec payload was rejected as invalid.";
    if (err.status >= 500) return "The server hit a snag. Try again.";
    return err.message;
  }
  if (err instanceof Error) return err.message;
  return "Something went wrong — please try again.";
}

function PushStateBadge({ state }: { state: DetailCalloutPushState }) {
  const palette = PUSH_STATE_COLORS[state] ?? PUSH_STATE_COLORS.pending;
  return (
    <span
      data-testid={`detail-callout-push-state-${state}`}
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
      {state}
    </span>
  );
}

/** One-line human summary of a discriminated spec payload. */
function specSummary(spec: DetailCalloutSpecPayload): string {
  switch (spec.detailType) {
    case "door-schedule":
      return `Door schedule — ${spec.rows.length} row${
        spec.rows.length === 1 ? "" : "s"
      }`;
    case "wall-section":
      return `Wall section ${spec.sectionMark} — ${spec.assemblyLayers.length} layers`;
    case "wall-type":
      return `Wall type ${spec.typeMark} — ${spec.assemblyLayers.length} layers`;
    case "room-finish":
      return `Room finish — ${spec.roomName} (${spec.roomNumber})`;
  }
}

/* -------------------------------------------------------------------------- */
/*                              Create dialog                                  */
/* -------------------------------------------------------------------------- */

const EMPTY_DOOR_ROW: DoorScheduleRow = {
  doorMark: "",
  doorType: "",
  width: "",
  height: "",
  material: "",
  fireRating: "",
  hardwareSet: "",
};

const EMPTY_LAYER: WallAssemblyLayer = {
  material: "",
  thickness: "",
  function: "",
};

function CreateDetailCalloutSpecDialog({
  engagementId,
  isOpen,
  onClose,
}: {
  engagementId: string;
  isOpen: boolean;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [detailType, setDetailType] = useState<DetailCalloutType>("room-finish");
  const [flat, setFlat] = useState<Record<string, string>>({});
  const [rows, setRows] = useState<DoorScheduleRow[]>([{ ...EMPTY_DOOR_ROW }]);
  const [layers, setLayers] = useState<WallAssemblyLayer[]>([
    { ...EMPTY_LAYER },
  ]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (isOpen) {
      setDetailType("room-finish");
      setFlat({});
      setRows([{ ...EMPTY_DOOR_ROW }]);
      setLayers([{ ...EMPTY_LAYER }]);
      setError(null);
    }
  }, [isOpen]);

  const mutation = useCreateDetailCalloutSpec({
    mutation: {
      onSuccess: async () => {
        await qc.invalidateQueries({
          queryKey: getListDetailCalloutSpecsQueryKey(engagementId),
        });
        onClose();
      },
      onError: (err: unknown) => setError(formatSpecError(err)),
    },
  });

  if (!isOpen) return null;
  const submitting = mutation.isPending;
  const f = (k: string) => flat[k] ?? "";
  const setF = (k: string, v: string) =>
    setFlat((prev) => ({ ...prev, [k]: v }));

  function buildSpec(): DetailCalloutSpecPayload {
    switch (detailType) {
      case "door-schedule":
        return { detailType, rows };
      case "wall-section":
        return {
          detailType,
          sectionMark: f("sectionMark"),
          cutLocation: f("cutLocation"),
          assemblyLayers: layers,
          baseDatum: f("baseDatum"),
          topDatum: f("topDatum"),
        };
      case "wall-type":
        return {
          detailType,
          typeMark: f("typeMark"),
          assemblyLayers: layers,
          fireRating: f("fireRating"),
          stcRating: f("stcRating"),
        };
      case "room-finish":
        return {
          detailType,
          roomName: f("roomName"),
          roomNumber: f("roomNumber"),
          floorFinish: f("floorFinish"),
          baseFinish: f("baseFinish"),
          wallFinish: f("wallFinish"),
          ceilingFinish: f("ceilingFinish"),
          ceilingHeight: f("ceilingHeight"),
        };
    }
  }

  const flatField = (key: string, label: string) => (
    <label
      key={key}
      style={{ display: "flex", flexDirection: "column", gap: 3 }}
    >
      <span className="sc-label" style={{ color: "var(--text-secondary)" }}>
        {label}
      </span>
      <input
        type="text"
        value={f(key)}
        disabled={submitting}
        data-testid={`detail-callout-field-${key}`}
        onChange={(e) => setF(key, e.target.value)}
        style={inputStyle}
      />
    </label>
  );

  return (
    <div
      onClick={() => !submitting && onClose()}
      data-testid="create-detail-callout-spec-dialog"
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
        style={{
          width: "100%",
          maxWidth: 560,
          maxHeight: "90vh",
          overflow: "auto",
          display: "flex",
          flexDirection: "column",
        }}
      >
        <div className="sc-card-header">
          <span
            style={{ fontSize: 16, fontWeight: 600, color: "var(--text-primary)" }}
          >
            New detail-callout spec
          </span>
        </div>

        <div className="p-4 flex flex-col" style={{ gap: 10 }}>
          <label style={{ display: "flex", flexDirection: "column", gap: 3 }}>
            <span className="sc-label" style={{ color: "var(--text-secondary)" }}>
              Detail type
            </span>
            <select
              value={detailType}
              disabled={submitting}
              data-testid="detail-callout-type-select"
              onChange={(e) =>
                setDetailType(e.target.value as DetailCalloutType)
              }
              style={{ ...inputStyle, width: "auto" }}
            >
              {DETAIL_TYPES.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </label>

          {detailType === "room-finish" && (
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
              {flatField("roomName", "Room name")}
              {flatField("roomNumber", "Room number")}
              {flatField("floorFinish", "Floor finish")}
              {flatField("baseFinish", "Base finish")}
              {flatField("wallFinish", "Wall finish")}
              {flatField("ceilingFinish", "Ceiling finish")}
              {flatField("ceilingHeight", "Ceiling height")}
            </div>
          )}

          {detailType === "wall-section" && (
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
              {flatField("sectionMark", "Section mark")}
              {flatField("cutLocation", "Cut location")}
              {flatField("baseDatum", "Base datum")}
              {flatField("topDatum", "Top datum")}
            </div>
          )}

          {detailType === "wall-type" && (
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
              {flatField("typeMark", "Type mark")}
              {flatField("fireRating", "Fire rating")}
              {flatField("stcRating", "STC rating")}
            </div>
          )}

          {(detailType === "wall-section" || detailType === "wall-type") && (
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <span className="sc-label" style={{ color: "var(--text-secondary)" }}>
                Assembly layers
              </span>
              {layers.map((layer, i) => (
                <div
                  key={i}
                  data-testid={`detail-callout-layer-${i}`}
                  style={{ display: "flex", gap: 6 }}
                >
                  {(["material", "thickness", "function"] as const).map((k) => (
                    <input
                      key={k}
                      type="text"
                      value={layer[k]}
                      disabled={submitting}
                      placeholder={k}
                      onChange={(e) =>
                        setLayers((prev) =>
                          prev.map((l, j) =>
                            j === i ? { ...l, [k]: e.target.value } : l,
                          ),
                        )
                      }
                      style={inputStyle}
                    />
                  ))}
                </div>
              ))}
              <button
                type="button"
                className="sc-btn-ghost sc-btn-sm"
                disabled={submitting}
                data-testid="detail-callout-add-layer"
                onClick={() => setLayers((prev) => [...prev, { ...EMPTY_LAYER }])}
              >
                Add layer
              </button>
            </div>
          )}

          {detailType === "door-schedule" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <span className="sc-label" style={{ color: "var(--text-secondary)" }}>
                Door rows
              </span>
              {rows.map((row, i) => (
                <div
                  key={i}
                  data-testid={`detail-callout-row-${i}`}
                  style={{
                    display: "grid",
                    gridTemplateColumns: "1fr 1fr 1fr 1fr",
                    gap: 6,
                  }}
                >
                  {(
                    [
                      "doorMark",
                      "doorType",
                      "width",
                      "height",
                      "material",
                      "fireRating",
                      "hardwareSet",
                    ] as const
                  ).map((k) => (
                    <input
                      key={k}
                      type="text"
                      value={row[k]}
                      disabled={submitting}
                      placeholder={k}
                      onChange={(e) =>
                        setRows((prev) =>
                          prev.map((r, j) =>
                            j === i ? { ...r, [k]: e.target.value } : r,
                          ),
                        )
                      }
                      style={inputStyle}
                    />
                  ))}
                </div>
              ))}
              <button
                type="button"
                className="sc-btn-ghost sc-btn-sm"
                disabled={submitting}
                data-testid="detail-callout-add-row"
                onClick={() => setRows((prev) => [...prev, { ...EMPTY_DOOR_ROW }])}
              >
                Add door row
              </button>
            </div>
          )}

          {error && (
            <div
              data-testid="create-detail-callout-spec-error"
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
            disabled={submitting}
            data-testid="create-detail-callout-spec-submit"
            onClick={() => {
              setError(null);
              mutation.mutate({
                engagementId,
                data: { spec: buildSpec() },
              });
            }}
          >
            {submitting ? "Creating…" : "Create spec"}
          </button>
        </div>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*                               Spec row                                     */
/* -------------------------------------------------------------------------- */

function SpecRow({
  engagementId,
  spec,
}: {
  engagementId: string;
  spec: DetailCalloutSpecAtom;
}) {
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [apsOpen, setApsOpen] = useState(false);
  const [apsValue, setApsValue] = useState("");

  const invalidate = () =>
    qc.invalidateQueries({
      queryKey: getListDetailCalloutSpecsQueryKey(engagementId),
    });

  const pushState = useUpdateDetailCalloutSpecPushState({
    mutation: {
      onSuccess: async () => {
        setError(null);
        await invalidate();
      },
      onError: (err: unknown) => setError(formatSpecError(err)),
    },
  });

  const apsRef = useAttachDetailCalloutSpecApsRef({
    mutation: {
      onSuccess: async () => {
        setError(null);
        setApsOpen(false);
        setApsValue("");
        await invalidate();
      },
      onError: (err: unknown) => setError(formatSpecError(err)),
    },
  });

  const busy = pushState.isPending || apsRef.isPending;
  const state = spec.pushState as DetailCalloutPushState;

  return (
    <div
      data-testid={`detail-callout-spec-row-${spec.entityId}`}
      style={{
        padding: "12px 16px",
        borderBottom: "1px solid var(--border-default)",
        display: "flex",
        flexDirection: "column",
        gap: 8,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span
          className="sc-medium"
          style={{ color: "var(--text-primary)", fontSize: 13, flex: 1 }}
        >
          {specSummary(spec.spec)}
        </span>
        <PushStateBadge state={state} />
      </div>

      <div
        className="sc-meta"
        style={{ display: "flex", gap: 12, flexWrap: "wrap", fontSize: 11 }}
      >
        <span>Created {relativeTime(spec.createdAt)}</span>
        {spec.pushedAt && <span>Pushed {relativeTime(spec.pushedAt)}</span>}
        <span data-testid={`detail-callout-aps-ref-${spec.entityId}`}>
          {spec.apsTaskRef ? `APS ref: ${spec.apsTaskRef}` : "No APS ref"}
        </span>
      </div>

      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        {NEXT_PUSH_ACTIONS[state].map((action) => (
          <button
            key={action.to}
            type="button"
            className="sc-btn-ghost sc-btn-sm"
            disabled={busy}
            data-testid={`detail-callout-${spec.entityId}-to-${action.to}`}
            onClick={() =>
              pushState.mutate({
                specId: spec.entityId,
                data: { pushState: action.to },
              })
            }
          >
            {action.label}
          </button>
        ))}
        <button
          type="button"
          className="sc-btn-ghost sc-btn-sm"
          disabled={busy}
          data-testid={`detail-callout-${spec.entityId}-aps-toggle`}
          onClick={() => {
            setApsValue(spec.apsTaskRef ?? "");
            setApsOpen((v) => !v);
          }}
        >
          {spec.apsTaskRef ? "Change APS ref" : "Set APS ref"}
        </button>
      </div>

      {apsOpen && (
        <div style={{ display: "flex", gap: 6 }}>
          <input
            type="text"
            value={apsValue}
            disabled={busy}
            placeholder="APS Design Automation work-item ref"
            data-testid={`detail-callout-${spec.entityId}-aps-input`}
            onChange={(e) => setApsValue(e.target.value)}
            style={{ ...inputStyle, flex: 1 }}
          />
          <button
            type="button"
            className="sc-btn-primary sc-btn-sm"
            disabled={busy || apsValue.trim().length === 0}
            data-testid={`detail-callout-${spec.entityId}-aps-save`}
            onClick={() =>
              apsRef.mutate({
                specId: spec.entityId,
                data: { apsTaskRef: apsValue.trim() },
              })
            }
          >
            Save
          </button>
        </div>
      )}

      {error && (
        <div
          data-testid={`detail-callout-${spec.entityId}-error`}
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

export function DetailCalloutSpecsTab({
  engagementId,
}: {
  engagementId: string;
}) {
  const [createOpen, setCreateOpen] = useState(false);
  const { data, isLoading } = useListDetailCalloutSpecs(
    engagementId,
    undefined,
    {
      query: {
        enabled: !!engagementId,
        queryKey: getListDetailCalloutSpecsQueryKey(engagementId),
      },
    },
  );

  const specs = useMemo(() => data?.detailCalloutSpecs ?? [], [data]);

  return (
    <>
      <div
        className="sc-card flex flex-col"
        data-testid="detail-callout-specs-list"
      >
        <div className="sc-card-header sc-row-sb">
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <span className="sc-label">DETAIL-CALLOUT SPECS</span>
            <span className="sc-meta" style={{ opacity: 0.7 }}>
              {specs.length} {specs.length === 1 ? "spec" : "specs"}
            </span>
          </div>
          <button
            type="button"
            className="sc-btn-primary"
            data-testid="detail-callout-specs-new"
            onClick={() => setCreateOpen(true)}
          >
            New spec
          </button>
        </div>

        {isLoading ? (
          <div
            className="p-6 text-center"
            data-testid="detail-callout-specs-loading"
          >
            <div className="sc-body opacity-60">Loading specs…</div>
          </div>
        ) : specs.length === 0 ? (
          <div
            className="p-6 text-center"
            data-testid="detail-callout-specs-empty"
          >
            <div className="sc-prose opacity-70" style={{ maxWidth: 460 }}>
              No detail-callout specs yet. Create one to define a Revit
              detail the connector can push.
            </div>
          </div>
        ) : (
          <div className="flex flex-col">
            {specs.map((spec) => (
              <SpecRow
                key={spec.entityId}
                engagementId={engagementId}
                spec={spec}
              />
            ))}
          </div>
        )}
      </div>

      <CreateDetailCalloutSpecDialog
        engagementId={engagementId}
        isOpen={createOpen}
        onClose={() => setCreateOpen(false)}
      />
    </>
  );
}
