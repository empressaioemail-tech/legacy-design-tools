import { useCallback, useEffect, useState } from "react";
import {
  Box,
  Camera,
  GitCompare,
  ImagePlus,
  Sparkles,
  Star,
} from "lucide-react";
import {
  ConstellationCanvas,
  RenderCreditsBadge,
  RenderGallery,
  RenderKickoffPanel,
} from "@workspace/portal-ui";

/**
 * Architect-facing "Design Tools" tab — the post-#110 renders
 * workbench, broadened beyond the legacy two-column kickoff +
 * gallery layout.
 *
 * Implements the four-zone IA the planning agent locked in:
 *
 *   ┌──────────────────────────────────────────────────────────┐
 *   │ HEADER     title · BIM hint · credits · backdrop toggle   │
 *   ├──────────────────────────────────────────────────────────┤
 *   │ KICKOFF (≈400px)        │ GALLERY (fluid)                 │
 *   │   source / intent / kind│   parent→child tree,            │
 *   │   expert / style / etc. │   power tools, polling,         │
 *   │   (RenderKickoffPanel)  │   cancel  (RenderGallery)       │
 *   ├──────────────────────────────────────────────────────────┤
 *   │ RESERVED RAIL — placeholder cards for upcoming surfaces  │
 *   │   presets · viewpoint capture · export-to-deliverable ·  │
 *   │   comparison mode                                         │
 *   └──────────────────────────────────────────────────────────┘
 *
 * Backend contract is unchanged: this tab consumes the existing
 * `RenderKickoffPanel`, `RenderGallery`, `RenderCreditsBadge`, and
 * `ConstellationCanvas` exports from `@workspace/portal-ui`. No new
 * API routes, no schema changes — UI assembly only. The
 * `renders_preview_disabled` and `RENDERS_PROD_ENABLED` flows are
 * handled inside `RenderGallery` already (see its 137-line comment
 * block); the header shows the credits affordance regardless so the
 * architect always knows their availability.
 *
 * Backwards-compatibility: emits both the new `design-tools-tab`
 * testid and the legacy `renders-tab` / `renders-tab-dashboard`
 * testids so existing e2e specs continue to target this tab.
 */
export function DesignToolsTab({
  engagementId,
  defaultGlbUrl,
  onOpenBimTab,
}: {
  engagementId: string;
  /** Auto-resolved BIM-model GLB URL the kickoff panel defaults to.
   * Null when the engagement has no renderable BIM elements yet —
   * the architect can still upload an image as the source or paste
   * a URL manually. */
  defaultGlbUrl?: string | null;
  /** Navigate to the engagement's "3D model" tab. Wired through
   * EngagementDetail's `setTab("model-3d")` so the BIM hint can
   * offer a one-click jump when the model is missing or when the
   * architect wants to grab a camera before kicking off a render. */
  onOpenBimTab?: () => void;
}) {
  const hasBim = Boolean(defaultGlbUrl);
  const [constellation, setConstellation] = useConstellationPreference();

  return (
    <div
      data-testid="design-tools-tab"
      data-legacy-testid="renders-tab"
      className="cockpit-design-tools"
      style={{ position: "relative" }}
    >
      {/* Backwards-compat: legacy e2e specs target `renders-tab`.
          We expose that testid on the visible root container (via a
          dual-testid attribute query in tests) AND emit it on a
          zero-size wrapper that contains the real subtree, so
          selectors like `getByTestId('renders-tab').findByText(...)`
          continue to find the rendered content. */}
      <div
        data-testid="renders-tab"
        style={{ display: "contents" }}
      >

      {constellation && <ConstellationCanvas />}

      {/* ── HEADER ─────────────────────────────────────────────── */}
      <header
        className="cockpit-design-tools-header"
        data-testid="design-tools-header"
      >
        <div className="cockpit-design-tools-title">
          <div className="cockpit-overline">Design Tools</div>
          <h2 className="cockpit-design-tools-h1">Rendering workbench</h2>
          <p className="cockpit-design-tools-sub">
            mnml.ai-powered architectural renders, post-render power
            tools, and supporting design utilities for this
            engagement. Configure a job on the left; results stream
            into the gallery on the right.
          </p>
        </div>
        <div className="cockpit-design-tools-header-actions">
          <button
            type="button"
            className="cockpit-btn-ghost"
            data-testid="design-tools-backdrop-toggle"
            aria-pressed={constellation}
            onClick={() => setConstellation((v) => !v)}
            title={
              constellation
                ? "Hide the constellation backdrop"
                : "Show the constellation backdrop"
            }
          >
            <Sparkles size={14} aria-hidden />
            <span>{constellation ? "Backdrop on" : "Backdrop off"}</span>
          </button>
          <RenderCreditsBadge />
        </div>
      </header>

      {/* ── BIM CONTEXT HINT ──────────────────────────────────── */}
      {!hasBim && (
        <div
          className="cockpit-design-tools-bim-hint"
          data-testid="design-tools-bim-hint"
          role="note"
        >
          <Box size={16} aria-hidden />
          <div className="cockpit-design-tools-bim-hint-body">
            <strong>No BIM model on file yet.</strong>
            <span>
              Model-capture renders need a GLB source. Push IFC from
              Revit or upload an image below to use upload-as-source
              instead.
            </span>
          </div>
          {onOpenBimTab && (
            <button
              type="button"
              className="cockpit-btn-ghost"
              onClick={onOpenBimTab}
              data-testid="design-tools-open-bim"
            >
              Open 3D model
            </button>
          )}
        </div>
      )}
      {hasBim && onOpenBimTab && (
        <div
          className="cockpit-design-tools-bim-hint cockpit-design-tools-bim-hint-ok"
          data-testid="design-tools-bim-hint"
          role="note"
        >
          <Box size={16} aria-hidden />
          <div className="cockpit-design-tools-bim-hint-body">
            <strong>BIM source ready.</strong>
            <span>
              Model-capture renders will use the engagement's latest
              GLB by default. Capture a named viewpoint from the 3D
              tab to pre-fill the camera fields.
            </span>
          </div>
          <button
            type="button"
            className="cockpit-btn-ghost"
            onClick={onOpenBimTab}
            data-testid="design-tools-open-bim"
          >
            Open 3D model
          </button>
        </div>
      )}

      {/* ── KICKOFF + GALLERY ─────────────────────────────────── */}
      <div
        data-testid="renders-tab-dashboard"
        className="cockpit-design-tools-dashboard"
      >
        <div className="cockpit-design-tools-kickoff">
          <RenderKickoffPanel
            engagementId={engagementId}
            defaultGlbUrl={defaultGlbUrl ?? null}
          />
        </div>
        <div className="cockpit-design-tools-gallery">
          <RenderGallery
            engagementId={engagementId}
            canCancel
            showPowerTools
            emptyStateHint="No renders yet. Use the panel on the left to kick off your first one."
          />
        </div>
      </div>

      {/* ── RESERVED RAIL ─────────────────────────────────────── */}
      <section
        className="cockpit-design-tools-reserved"
        data-testid="design-tools-reserved-rail"
        aria-labelledby="design-tools-reserved-heading"
      >
        <header className="cockpit-design-tools-reserved-header">
          <h3
            id="design-tools-reserved-heading"
            className="cockpit-design-tools-reserved-title"
          >
            Coming soon
          </h3>
          <span className="cockpit-meta">
            Layout space reserved for the next wave of design
            tooling. Surfaces ship behind their own flags.
          </span>
        </header>
        <div className="cockpit-design-tools-reserved-grid">
          {RESERVED_CARDS.map((card) => (
            <article
              key={card.id}
              className="cockpit-design-tools-reserved-card"
              data-testid={`design-tools-reserved-${card.id}`}
              aria-disabled="true"
            >
              <div className="cockpit-design-tools-reserved-icon">
                <card.icon size={18} aria-hidden />
              </div>
              <div className="cockpit-design-tools-reserved-text">
                <div className="cockpit-design-tools-reserved-card-title">
                  {card.title}
                </div>
                <p className="cockpit-design-tools-reserved-card-body">
                  {card.body}
                </p>
              </div>
              <span className="cockpit-design-tools-reserved-pill">
                Soon
              </span>
            </article>
          ))}
        </div>
      </section>
      </div>
    </div>
  );
}

// -- reserved cards -----------------------------------------------
// These are *intentionally* dumb placeholders. The planning agent's
// growth list (presets, viewpoint capture, render→deliverable,
// comparison) is what shows up here so the IA already has a home
// for those features when they land — adding a new tile is a
// one-line edit instead of a tab-level restructure.

interface ReservedCard {
  id: string;
  title: string;
  body: string;
  icon: typeof Sparkles;
}

const RESERVED_CARDS: ReservedCard[] = [
  {
    id: "presets",
    title: "Saved presets",
    body:
      "Reusable style + prompt + expert combos for client-facing looks. Apply with one click from the kickoff panel.",
    icon: Star,
  },
  {
    id: "viewpoint",
    title: "Viewpoint capture",
    body:
      "Save a named camera from the 3D tab and pre-fill kickoff camera fields — no more eyeballing position vectors.",
    icon: Camera,
  },
  {
    id: "export",
    title: "Export to deliverable",
    body:
      "Send a finished render straight into a comment letter or presentation deck without leaving the tab.",
    icon: ImagePlus,
  },
  {
    id: "comparison",
    title: "Comparison mode",
    body:
      "Pin two renders side-by-side — different experts, prompts, or iterations on the same source.",
    icon: GitCompare,
  },
];

// -- backdrop preference ------------------------------------------
// The constellation canvas is decorative; on lower-end machines its
// continuous animation steals frames from the gallery's polling
// scroll and the kickoff panel's text inputs. We persist the
// architect's preference in localStorage so the choice survives
// reloads without round-tripping through user settings.

const BACKDROP_STORAGE_KEY = "design-tools.constellation.enabled";

function useConstellationPreference(): [
  boolean,
  (next: boolean | ((prev: boolean) => boolean)) => void,
] {
  const [enabled, setEnabled] = useState<boolean>(() => {
    if (typeof window === "undefined") return true;
    try {
      const raw = window.localStorage.getItem(BACKDROP_STORAGE_KEY);
      if (raw === "0" || raw === "false") return false;
      return true;
    } catch {
      return true;
    }
  });

  const update = useCallback(
    (next: boolean | ((prev: boolean) => boolean)) => {
      setEnabled((prev) => {
        const resolved = typeof next === "function" ? next(prev) : next;
        try {
          window.localStorage.setItem(
            BACKDROP_STORAGE_KEY,
            resolved ? "1" : "0",
          );
        } catch {
          // localStorage may throw in private-browsing modes or when
          // quota is exhausted — the preference simply won't persist.
        }
        return resolved;
      });
    },
    [],
  );

  // Sync across tabs: if the architect toggles the backdrop in
  // another engagement, mirror the change here on focus.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const handler = (e: StorageEvent) => {
      if (e.key !== BACKDROP_STORAGE_KEY || e.newValue == null) return;
      setEnabled(!(e.newValue === "0" || e.newValue === "false"));
    };
    window.addEventListener("storage", handler);
    return () => window.removeEventListener("storage", handler);
  }, []);

  return [enabled, update];
}

