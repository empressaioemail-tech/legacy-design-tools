import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useKickoffRender,
  getListEngagementRendersQueryKey,
  getGetRenderCreditsQueryKey,
  getGenerateRenderPromptUrl,
  customFetch,
  ApiError,
  type DomainRenderKind,
  type KickoffRenderBody,
  type KickoffRenderCommonFieldsExpertName,
  type KickoffRenderCommonFieldsRenderStyle,
  type KickoffRenderResponse,
  type PromptGeneratorResponse,
  type RenderListItem,
} from "@workspace/api-client-react";

interface ListEngagementRendersCache {
  items: RenderListItem[];
}

/**
 * Architect-only dialog for kicking off a mnml.ai render. Captures
 * the discriminated kickoff body for one of three render kinds
 * (still / elevation-set / video) and POSTs to
 * `/api/engagements/{id}/renders` via the generated
 * `useKickoffRender` mutation hook.
 *
 * On a successful 202 the dialog optimistically inserts the new row
 * at the top of the listing cache so the gallery shows it
 * immediately, then invalidates the list so the next refetch
 * reconciles with the server.
 *
 * `glbUrl` is the absolute URL the headless capture browser fetches
 * the BIM model from; the architect typically pastes the URL their
 * viewer surfaces.
 */

export interface RenderKickoffDialogProps {
  engagementId: string;
  /**
   * Optional default GLB URL — typically the URL the BIM viewer
   * has loaded for the active engagement. The architect can
   * override it inline before submitting.
   */
  defaultGlbUrl?: string | null;
  isOpen: boolean;
  onClose: () => void;
  /**
   * Fires after a successful kickoff, just before `onClose` runs.
   * Parent uses this to advance selection in the gallery to the
   * just-created render id.
   */
  onKickedOff?: (response: KickoffRenderResponse) => void;
}

const KIND_LABEL: Record<DomainRenderKind, string> = {
  still: "Still render",
  "elevation-set": "Elevation set (4 directions)",
  video: "Video render",
};

const PROMPT_MAX = 2000;

// ─────────────────────────────────────────────────────────────────────
// doc 40c gap-fill — intent / expert / style / Prompt Generator
// ─────────────────────────────────────────────────────────────────────

/**
 * The two render intents (doc 40c). The engine handles every expert
 * and style; intent just drives the sensible default pair and frames
 * the surface for the architect.
 */
type RenderIntent = "deliverable" | "concept";

const INTENT_LABEL: Record<RenderIntent, string> = {
  deliverable: "Deliverable render",
  concept: "Concept imagery",
};

const INTENT_HINT: Record<RenderIntent, string> = {
  deliverable:
    "Client-facing photoreal exterior / interior renders off the BIM model.",
  concept:
    "Early-design exploration — floor plans, massing, sketch and illustration styles.",
};

// String literals (not the imported const objects) so this module has
// no runtime dependency on `KickoffRenderCommonFieldsExpertName` /
// `KickoffRenderCommonFieldsRenderStyle` — that lets unrelated tests
// `vi.mock("@workspace/api-client-react")` without having to mirror
// every const export. The types still pin the literals to the schema.
const INTENT_DEFAULTS: Record<
  RenderIntent,
  {
    expert: KickoffRenderCommonFieldsExpertName;
    style: KickoffRenderCommonFieldsRenderStyle;
  }
> = {
  deliverable: { expert: "exterior", style: "photoreal" },
  concept: { expert: "plan", style: "freehand_sketch" },
};

const EXPERT_LABEL: Record<KickoffRenderCommonFieldsExpertName, string> = {
  exterior: "Exterior",
  interior: "Interior",
  masterplan: "Masterplan",
  landscape: "Landscape",
  plan: "Plan (floor plan)",
  product: "Product",
};

const RENDER_STYLE_LABEL: Record<
  KickoffRenderCommonFieldsRenderStyle,
  string
> = {
  raw: "Raw",
  photoreal: "Photoreal",
  cgi_render: "CGI render",
  cad: "CAD",
  freehand_sketch: "Freehand sketch",
  clay_model: "Clay model",
  illustration: "Illustration",
  watercolor: "Watercolor",
};

/** mnml's Prompt Generator accepts JPEG/PNG/GIF/WebP up to 8MB. */
const PROMPT_GENERATOR_MAX_BYTES = 8 * 1024 * 1024;
const PROMPT_GENERATOR_ACCEPT = "image/png,image/jpeg,image/gif,image/webp";

export function RenderKickoffDialog({
  engagementId,
  defaultGlbUrl,
  isOpen,
  onClose,
  onKickedOff,
}: RenderKickoffDialogProps) {
  const qc = useQueryClient();
  const [kind, setKind] = useState<DomainRenderKind>("still");
  const [glbUrl, setGlbUrl] = useState<string>(defaultGlbUrl ?? "");
  const [prompt, setPrompt] = useState<string>("");
  // Camera fields (still / video).
  const [cameraPos, setCameraPos] = useState<string>("0,0,10");
  const [cameraTarget, setCameraTarget] = useState<string>("0,0,0");
  // Elevation-set fields.
  const [buildingCenter, setBuildingCenter] = useState<string>("0,0,0");
  const [cameraDistance, setCameraDistance] = useState<string>("20");
  const [cameraHeight, setCameraHeight] = useState<string>("2");
  // Video field.
  const [duration, setDuration] = useState<5 | 10>(5);
  const [error, setError] = useState<string | null>(null);

  // doc 40c gap-fill — intent / expert / style / Prompt Generator state.
  const [intent, setIntent] = useState<RenderIntent>("deliverable");
  const [expertName, setExpertName] = useState<KickoffRenderCommonFieldsExpertName>(
    INTENT_DEFAULTS.deliverable.expert,
  );
  const [renderStyle, setRenderStyle] = useState<KickoffRenderCommonFieldsRenderStyle>(
    INTENT_DEFAULTS.deliverable.style,
  );
  const [pgFile, setPgFile] = useState<File | null>(null);
  const [pgBusy, setPgBusy] = useState(false);
  const [pgError, setPgError] = useState<string | null>(null);

  useEffect(() => {
    if (isOpen) {
      setKind("still");
      setGlbUrl(defaultGlbUrl ?? "");
      setPrompt("");
      setCameraPos("0,0,10");
      setCameraTarget("0,0,0");
      setBuildingCenter("0,0,0");
      setCameraDistance("20");
      setCameraHeight("2");
      setDuration(5);
      setError(null);
      // doc 40c gap-fill resets.
      setIntent("deliverable");
      setExpertName(INTENT_DEFAULTS.deliverable.expert);
      setRenderStyle(INTENT_DEFAULTS.deliverable.style);
      setPgFile(null);
      setPgBusy(false);
      setPgError(null);
    }
  }, [isOpen, defaultGlbUrl]);

  /**
   * Intent switch: pin the expert + style to the intent's defaults so
   * the architect lands on a sensible starting pair. They can still
   * override either select afterwards — the intent is a UI affordance,
   * not a constraint on the engine.
   */
  function applyIntent(next: RenderIntent) {
    setIntent(next);
    setExpertName(INTENT_DEFAULTS[next].expert);
    setRenderStyle(INTENT_DEFAULTS[next].style);
  }

  /**
   * Upload the picked image to `POST /api/renders/prompt-generator` and
   * drop the generated prompt straight into the textarea, replacing
   * whatever was there. Costs 1 mnml credit; invalidates the credits
   * query key on success so `RenderCreditsBadge` refreshes.
   *
   * If the architect typed keywords into the prompt textarea first,
   * those round-trip to mnml as the `keywords` form field — i.e. the
   * generator treats them as hints to emphasize.
   */
  async function handleGeneratePrompt() {
    if (!pgFile || pgBusy) return;
    if (pgFile.size > PROMPT_GENERATOR_MAX_BYTES) {
      setPgError(
        `Image is too large (${(pgFile.size / 1024 / 1024).toFixed(1)}MB; max 8MB).`,
      );
      return;
    }
    setPgBusy(true);
    setPgError(null);
    try {
      const form = new FormData();
      form.append("image", pgFile);
      const keywords = prompt.trim();
      if (keywords) form.append("keywords", keywords);
      const result = await customFetch<PromptGeneratorResponse>(
        getGenerateRenderPromptUrl(),
        { method: "POST", body: form, responseType: "json" },
      );
      setPrompt(result.prompt);
      qc.invalidateQueries({ queryKey: getGetRenderCreditsQueryKey() });
    } catch (err) {
      setPgError(formatPromptGenError(err));
    } finally {
      setPgBusy(false);
    }
  }

  const mutation = useKickoffRender({
    mutation: {
      onSuccess: async (response) => {
        const listKey = getListEngagementRendersQueryKey(engagementId);
        const optimistic: RenderListItem = {
          id: response.renderId,
          kind: response.kind,
          status: response.state,
          errorCode: null,
          requestedBy: "user:current",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          completedAt: null,
        };
        qc.setQueryData<ListEngagementRendersCache | undefined>(
          listKey,
          (prev: ListEngagementRendersCache | undefined) => {
            if (!prev) return { items: [optimistic] };
            if (prev.items.some((r: RenderListItem) => r.id === optimistic.id))
              return prev;
            return { items: [optimistic, ...prev.items] };
          },
        );
        await qc.invalidateQueries({ queryKey: listKey });
        // doc 40c B.6 — a kickoff just debited credits; refresh the
        // RenderCreditsBadge.
        qc.invalidateQueries({ queryKey: getGetRenderCreditsQueryKey() });
        onKickedOff?.(response);
        onClose();
      },
      onError: (err) => {
        setError(formatKickoffError(err));
      },
    },
  });

  if (!isOpen) return null;

  const trimmedGlb = glbUrl.trim();
  const trimmedPrompt = prompt.trim();
  const promptOverLimit = prompt.length > PROMPT_MAX;
  const submitting = mutation.isPending;

  const buildBody = (): KickoffRenderBody | null => {
    if (!trimmedGlb || !trimmedPrompt || promptOverLimit) return null;
    // doc 40c B.1 — surface the expert + style on every kickoff so the
    // engine routes the request correctly. Both flow through
    // KickoffRenderCommonFields and are read by routes/renders.ts.
    const expertFields = { expertName, renderStyle };
    if (kind === "still") {
      const cp = parseVec3(cameraPos);
      const ct = parseVec3(cameraTarget);
      if (!cp || !ct) return null;
      return {
        kind: "still",
        glbUrl: trimmedGlb,
        prompt: trimmedPrompt,
        ...expertFields,
        cameraPosition: cp,
        cameraTarget: ct,
      };
    }
    if (kind === "elevation-set") {
      const bc = parseVec3(buildingCenter);
      const dist = Number(cameraDistance);
      const height = Number(cameraHeight);
      if (!bc || !Number.isFinite(dist) || dist <= 0) return null;
      if (!Number.isFinite(height)) return null;
      return {
        kind: "elevation-set",
        glbUrl: trimmedGlb,
        prompt: trimmedPrompt,
        ...expertFields,
        buildingCenter: bc,
        cameraDistance: dist,
        cameraHeight: height,
      };
    }
    // video
    const cp = parseVec3(cameraPos);
    const ct = parseVec3(cameraTarget);
    if (!cp || !ct) return null;
    return {
      kind: "video",
      glbUrl: trimmedGlb,
      prompt: trimmedPrompt,
      ...expertFields,
      cameraPosition: cp,
      cameraTarget: ct,
      duration,
    };
  };

  const body = buildBody();
  const canSubmit = !!body && !submitting;

  const handleSubmit = () => {
    if (!body) return;
    setError(null);
    mutation.mutate({ id: engagementId, data: body });
  };

  return (
    <div
      onClick={() => {
        if (!submitting) onClose();
      }}
      data-testid="render-kickoff-dialog"
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
          <div className="flex flex-col gap-1">
            <span
              style={{
                fontSize: 16,
                fontWeight: 600,
                color: "var(--text-primary)",
              }}
            >
              Kick off a render
            </span>
            <span className="sc-meta opacity-70">
              The polling worker advances the render's status; you'll
              see it appear in the gallery as soon as it's queued.
            </span>
          </div>
        </div>

        <div className="p-4 flex flex-col" style={{ gap: 12 }}>
          <div
            data-testid="render-kickoff-intent"
            style={{ display: "flex", flexDirection: "column", gap: 6 }}
          >
            <span
              className="sc-label"
              style={{ color: "var(--text-secondary)" }}
            >
              Render intent
            </span>
            <div
              role="radiogroup"
              aria-label="Render intent"
              style={{
                display: "grid",
                gridTemplateColumns: "1fr 1fr",
                gap: 8,
              }}
            >
              {(Object.keys(INTENT_LABEL) as RenderIntent[]).map((value) => {
                const active = intent === value;
                return (
                  <button
                    key={value}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    disabled={submitting}
                    onClick={() => applyIntent(value)}
                    data-testid={`render-kickoff-intent-${value}`}
                    className={active ? "sc-btn-primary" : "sc-btn-ghost"}
                    style={{
                      padding: "10px 12px",
                      display: "flex",
                      flexDirection: "column",
                      alignItems: "flex-start",
                      gap: 2,
                      textAlign: "left",
                    }}
                  >
                    <span style={{ fontWeight: 600, fontSize: 13 }}>
                      {INTENT_LABEL[value]}
                    </span>
                    <span
                      className="sc-meta"
                      style={{
                        opacity: 0.85,
                        fontSize: 11.5,
                        fontWeight: 400,
                      }}
                    >
                      {INTENT_HINT[value]}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <span
              className="sc-label"
              style={{ color: "var(--text-secondary)" }}
            >
              Render kind
            </span>
            <select
              value={kind}
              onChange={(e) => setKind(e.target.value as DomainRenderKind)}
              disabled={submitting}
              data-testid="render-kickoff-kind"
              className="sc-ui"
              style={{
                background: "var(--bg-input)",
                color: "var(--text-primary)",
                border: "1px solid var(--border-default)",
                padding: "6px 8px",
                borderRadius: 4,
                fontSize: 12.5,
              }}
            >
              {(Object.keys(KIND_LABEL) as DomainRenderKind[]).map((k) => (
                <option key={k} value={k}>
                  {KIND_LABEL[k]}
                </option>
              ))}
            </select>
          </label>

          <div
            data-testid="render-kickoff-expert-style"
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 1fr",
              gap: 8,
            }}
          >
            <label
              style={{ display: "flex", flexDirection: "column", gap: 4 }}
            >
              <span
                className="sc-label"
                style={{ color: "var(--text-secondary)" }}
              >
                Expert type
              </span>
              <select
                value={expertName}
                onChange={(e) =>
                  setExpertName(
                    e.target.value as KickoffRenderCommonFieldsExpertName,
                  )
                }
                disabled={submitting}
                data-testid="render-kickoff-expert"
                className="sc-ui"
                style={{
                  background: "var(--bg-input)",
                  color: "var(--text-primary)",
                  border: "1px solid var(--border-default)",
                  padding: "6px 8px",
                  borderRadius: 4,
                  fontSize: 12.5,
                }}
              >
                {(
                  Object.keys(
                    EXPERT_LABEL,
                  ) as KickoffRenderCommonFieldsExpertName[]
                ).map((k) => (
                  <option key={k} value={k}>
                    {EXPERT_LABEL[k]}
                  </option>
                ))}
              </select>
            </label>
            <label
              style={{ display: "flex", flexDirection: "column", gap: 4 }}
            >
              <span
                className="sc-label"
                style={{ color: "var(--text-secondary)" }}
              >
                Render style
              </span>
              <select
                value={renderStyle}
                onChange={(e) =>
                  setRenderStyle(
                    e.target.value as KickoffRenderCommonFieldsRenderStyle,
                  )
                }
                disabled={submitting}
                data-testid="render-kickoff-style"
                className="sc-ui"
                style={{
                  background: "var(--bg-input)",
                  color: "var(--text-primary)",
                  border: "1px solid var(--border-default)",
                  padding: "6px 8px",
                  borderRadius: 4,
                  fontSize: 12.5,
                }}
              >
                {(
                  Object.keys(
                    RENDER_STYLE_LABEL,
                  ) as KickoffRenderCommonFieldsRenderStyle[]
                ).map((k) => (
                  <option key={k} value={k}>
                    {RENDER_STYLE_LABEL[k]}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <span
              className="sc-label"
              style={{ color: "var(--text-secondary)" }}
            >
              GLB URL (required)
            </span>
            <input
              type="url"
              value={glbUrl}
              onChange={(e) => setGlbUrl(e.target.value)}
              disabled={submitting}
              placeholder="https://…/model.glb"
              data-testid="render-kickoff-glb-url"
              className="sc-ui"
              style={{
                background: "var(--bg-input)",
                color: "var(--text-primary)",
                border: "1px solid var(--border-default)",
                padding: "6px 8px",
                borderRadius: 4,
                fontSize: 12.5,
              }}
            />
          </label>

          <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <span
              className="sc-label"
              style={{ color: "var(--text-secondary)" }}
            >
              Prompt (required)
            </span>
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              disabled={submitting}
              rows={4}
              placeholder='e.g. "Modern desert house, golden hour, photoreal."'
              data-testid="render-kickoff-prompt"
              className="sc-ui sc-scroll"
              style={{
                background: "var(--bg-input)",
                color: "var(--text-primary)",
                border: `1px solid ${
                  promptOverLimit ? "#ef4444" : "var(--border-default)"
                }`,
                padding: "6px 8px",
                borderRadius: 4,
                outline: "none",
                fontSize: 12.5,
                resize: "vertical",
                minHeight: 80,
              }}
            />
            <div
              className="sc-meta"
              style={{
                display: "flex",
                justifyContent: "flex-end",
                color: promptOverLimit ? "#ef4444" : "var(--text-muted)",
              }}
              data-testid="render-kickoff-prompt-count"
            >
              {prompt.length} / {PROMPT_MAX}
            </div>
          </label>

          <div
            data-testid="render-kickoff-prompt-generator"
            style={{
              border: "1px dashed var(--border-default)",
              borderRadius: 4,
              padding: 10,
              display: "flex",
              flexDirection: "column",
              gap: 8,
            }}
          >
            <div className="sc-meta" style={{ opacity: 0.85 }}>
              <span aria-hidden style={{ opacity: 0.7, marginRight: 4 }}>
                ✦
              </span>
              Generate a prompt from a reference image{" "}
              <span style={{ opacity: 0.6 }}>· 1 credit</span>
              {intent === "concept" && (
                <span style={{ opacity: 0.6 }}>
                  {" "}
                  · ideal for sketches and concept references
                </span>
              )}
            </div>
            <div
              style={{ display: "flex", gap: 8, alignItems: "center" }}
            >
              <input
                type="file"
                accept={PROMPT_GENERATOR_ACCEPT}
                disabled={submitting || pgBusy}
                onChange={(e) => {
                  const f = e.target.files?.[0] ?? null;
                  setPgFile(f);
                  setPgError(null);
                }}
                data-testid="render-kickoff-pg-file"
                style={{ flex: 1, fontSize: 12 }}
              />
              <button
                type="button"
                className="sc-btn-ghost"
                onClick={handleGeneratePrompt}
                disabled={!pgFile || pgBusy || submitting}
                data-testid="render-kickoff-pg-generate"
              >
                {pgBusy ? "Generating…" : "Generate prompt"}
              </button>
            </div>
            {pgError && (
              <div
                role="alert"
                className="sc-meta"
                style={{ color: "#ef4444" }}
                data-testid="render-kickoff-pg-error"
              >
                {pgError}
              </div>
            )}
          </div>

          {(kind === "still" || kind === "video") && (
            <div
              data-testid="render-kickoff-camera-fields"
              style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}
            >
              <Vec3Field
                label="Camera position (x,y,z)"
                value={cameraPos}
                onChange={setCameraPos}
                disabled={submitting}
                testId="render-kickoff-camera-pos"
              />
              <Vec3Field
                label="Camera target (x,y,z)"
                value={cameraTarget}
                onChange={setCameraTarget}
                disabled={submitting}
                testId="render-kickoff-camera-target"
              />
            </div>
          )}

          {kind === "elevation-set" && (
            <div
              data-testid="render-kickoff-elevation-fields"
              style={{ display: "flex", flexDirection: "column", gap: 8 }}
            >
              <Vec3Field
                label="Building center (x,y,z)"
                value={buildingCenter}
                onChange={setBuildingCenter}
                disabled={submitting}
                testId="render-kickoff-building-center"
              />
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                <NumberField
                  label="Camera distance (m)"
                  value={cameraDistance}
                  onChange={setCameraDistance}
                  disabled={submitting}
                  testId="render-kickoff-camera-distance"
                />
                <NumberField
                  label="Camera height (m)"
                  value={cameraHeight}
                  onChange={setCameraHeight}
                  disabled={submitting}
                  testId="render-kickoff-camera-height"
                />
              </div>
            </div>
          )}

          {kind === "video" && (
            <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <span
                className="sc-label"
                style={{ color: "var(--text-secondary)" }}
              >
                Duration (seconds)
              </span>
              <select
                value={duration}
                onChange={(e) => setDuration(Number(e.target.value) as 5 | 10)}
                disabled={submitting}
                data-testid="render-kickoff-duration"
                className="sc-ui"
                style={{
                  background: "var(--bg-input)",
                  color: "var(--text-primary)",
                  border: "1px solid var(--border-default)",
                  padding: "6px 8px",
                  borderRadius: 4,
                  fontSize: 12.5,
                }}
              >
                <option value={5}>5</option>
                <option value={10}>10</option>
              </select>
            </label>
          )}

          {error && (
            <div
              data-testid="render-kickoff-error"
              role="alert"
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
            onClick={handleSubmit}
            disabled={!canSubmit}
            data-testid="render-kickoff-confirm"
          >
            {submitting ? "Kicking off…" : "Kick off render"}
          </button>
        </div>
      </div>
    </div>
  );
}

function Vec3Field({
  label,
  value,
  onChange,
  disabled,
  testId,
}: {
  label: string;
  value: string;
  onChange: (next: string) => void;
  disabled: boolean;
  testId: string;
}) {
  const parsed = parseVec3(value);
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <span className="sc-label" style={{ color: "var(--text-secondary)" }}>
        {label}
      </span>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        placeholder="0,0,0"
        data-testid={testId}
        className="sc-ui"
        style={{
          background: "var(--bg-input)",
          color: "var(--text-primary)",
          border: `1px solid ${parsed ? "var(--border-default)" : "#ef4444"}`,
          padding: "6px 8px",
          borderRadius: 4,
          fontSize: 12.5,
        }}
      />
    </label>
  );
}

function NumberField({
  label,
  value,
  onChange,
  disabled,
  testId,
}: {
  label: string;
  value: string;
  onChange: (next: string) => void;
  disabled: boolean;
  testId: string;
}) {
  const n = Number(value);
  const ok = Number.isFinite(n);
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <span className="sc-label" style={{ color: "var(--text-secondary)" }}>
        {label}
      </span>
      <input
        type="number"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        data-testid={testId}
        className="sc-ui"
        style={{
          background: "var(--bg-input)",
          color: "var(--text-primary)",
          border: `1px solid ${ok ? "var(--border-default)" : "#ef4444"}`,
          padding: "6px 8px",
          borderRadius: 4,
          fontSize: 12.5,
        }}
      />
    </label>
  );
}

function parseVec3(input: string): { x: number; y: number; z: number } | null {
  const parts = input.split(",").map((s) => s.trim());
  if (parts.length !== 3) return null;
  const nums = parts.map(Number);
  if (nums.some((n) => !Number.isFinite(n))) return null;
  return { x: nums[0], y: nums[1], z: nums[2] };
}

function formatKickoffError(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 503) {
      const code = extractErrorCode(err);
      if (code === "renders_preview_disabled") {
        return "Renders preview is disabled in this environment. Ask an operator to enable mnml.ai integration.";
      }
      return "The render service is unavailable. Try again in a moment.";
    }
    if (err.status === 400) {
      return extractApiDetail(err) ?? "The kickoff payload was rejected — check the GLB URL and prompt.";
    }
    if (err.status === 402) {
      return extractApiDetail(err) ?? "Insufficient mnml credits to kick off this render.";
    }
    if (err.status === 404) {
      return "This engagement no longer exists. Refresh and try again.";
    }
    if (err.status === 403) {
      return "Only architects can kick off renders.";
    }
    if (err.status >= 500) {
      return "The render service hit a snag. Try again in a moment.";
    }
    return extractApiDetail(err) ?? err.message;
  }
  if (err instanceof Error) return err.message;
  return "Failed to kick off render — please try again.";
}

function formatPromptGenError(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 402) {
      return "Insufficient mnml credits to generate a prompt.";
    }
    if (err.status === 413) {
      return "Image is too large (max 8MB).";
    }
    if (err.status === 415) {
      return "Unsupported file type — pick a JPEG, PNG, GIF, or WebP.";
    }
    if (err.status === 503) {
      const code = extractErrorCode(err);
      if (code === "renders_preview_disabled") {
        return "Renders preview is disabled in this environment.";
      }
      return "The render service is unavailable. Try again in a moment.";
    }
    if (err.status === 403) {
      return "Only architects can generate prompts.";
    }
    return extractApiDetail(err) ?? err.message;
  }
  if (err instanceof Error) return err.message;
  return "Failed to generate a prompt — please try again.";
}

function extractErrorCode(err: ApiError<unknown>): string | null {
  const data = err.data;
  if (data && typeof data === "object") {
    const code = (data as Record<string, unknown>).errorCode;
    if (typeof code === "string") return code;
  }
  return null;
}

function extractApiDetail(err: ApiError<unknown>): string | null {
  const data = err.data;
  if (data && typeof data === "object") {
    const record = data as Record<string, unknown>;
    for (const key of ["detail", "message", "title", "error"] as const) {
      const value = record[key];
      if (typeof value === "string" && value.trim().length > 0) {
        return value.trim();
      }
    }
  }
  if (typeof data === "string" && data.trim().length > 0) {
    return data.trim();
  }
  return null;
}
