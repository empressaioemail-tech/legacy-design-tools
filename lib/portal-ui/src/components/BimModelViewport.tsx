import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import {
  getGetBriefingSourceGlbUrl,
  getGetMaterializableElementGlbUrl,
  type MaterializableElement,
} from "@workspace/api-client-react";

/**
 * Read-only Three.js viewer for the engagement's bim-model
 * (Task #370 — building on Task #343's cross-tab "Show in 3D
 * viewer" jump).
 *
 * Two element-geometry sources are honoured:
 *
 *   1. **Inline polygon rings** (`geometry.ring` /
 *      `geometry.rings`) — property-line, floodplain, wetland,
 *      buildable-envelope kinds the briefing engine derives
 *      natively. These are extruded to a thin slab in the scene
 *      so they read as 3D objects (not just lines on a plane).
 *
 *   2. **briefingSource GLBs** — terrain, setback-plane,
 *      neighbor-mass, and any other element whose geometry came
 *      from a converted DXF. These are loaded from
 *      `GET /api/briefing-sources/:id/glb` (the same endpoint
 *      design-tools' SiteContextViewer uses); the loaded mesh is
 *      attributed back to the materializable element via
 *      `userData.elementId`, so the same selection / camera-fit
 *      pipeline frames them.
 *
 * The genuinely-no-fallback case is when the element has neither
 * inline ring data nor a `briefingSourceId` — for those, the
 * viewport keeps scene-bounds framing and surfaces a
 * "no renderable polygon" overlay that defers to the
 * MaterializableElementsList's row pulse + aria-live announcement
 * (the existing Task #343 surface).
 *
 * Test contract (data attributes on the wrapper div) — these are
 * derived from React state synchronously and therefore work under
 * happy-dom even though the WebGL pipeline is stubbed:
 *
 *   - `data-renderable-element-count` — elements with at least
 *     one renderable representation (inline ring or
 *     briefingSourceId).
 *   - `data-selected-element-id` — id of the currently-selected
 *     renderable element. Empty string when no selection is in
 *     flight or the selected element is unrenderable.
 *   - `data-selected-element-source` — `"ring"` | `"glb"` | `""`
 *     so tests can distinguish the two scene-representation
 *     paths.
 *   - `data-camera-target` — `"<x>,<y>,<z>"` of the framed
 *     bounds center (3 components — true 3D target, not a 2D
 *     plan-view fallback).
 *   - `data-camera-distance` — the larger axis of the framed
 *     bounds, in scene units (the OrbitControls camera sits
 *     at this distance from the target along an iso vector).
 *   - `data-source-load-{briefingSourceId}` — `"loading"` |
 *     `"loaded"` | `"error"` for each glb-bound element's
 *     briefing source.
 *   - `data-webgl-available` — `"true"` | `"false"` so tests
 *     don't have to introspect the fallback child to know
 *     whether the canvas is live.
 *   - `data-camera-fit-applied-count` — number of times the
 *     auto-framing has actually been applied to the live
 *     OrbitControls camera. Increments on (a) the first
 *     selection-driven jump, (b) each subsequent change of the
 *     `selectedElementRef` prop, (c) the moment the selected
 *     element's GLB bounds resolve, and (d) every "Reset view"
 *     button click. It does NOT increment for unrelated
 *     re-renders (e.g. a non-selected GLB finishing loading) so
 *     reviewers' manual pan/zoom isn't undone out from under
 *     them — see Task #380.
 *   - `data-camera-live-target` — `"<x>,<y>,<z>"` of the live
 *     OrbitControls target, written from the rAF render loop so
 *     it tracks every pan/zoom/reset gesture (in contrast to
 *     `data-camera-target`, which only reflects the auto-fit
 *     center derived from React state). The values are
 *     formatted to 2 decimals so an end-to-end spec can detect
 *     "the camera moved off the auto-fit center" without
 *     reading three.js internals from the page. Only populated
 *     when WebGL is live and the controls' target exposes
 *     numeric x/y/z (i.e. the real OrbitControls — under the
 *     unit-test stub the attribute is absent). Added in
 *     Task #401 to give the BIM-viewer pan/zoom + Reset view
 *     e2e spec a stable, deterministic read-side proof.
 *
 * Reviewer interaction model (Task #380):
 *   - Wheel scroll zooms around the cursor (`zoomToCursor`).
 *   - Click-and-drag (left mouse button) pans the camera in
 *     screen space.
 *   - Right mouse button still rotates the orbit, in case a
 *     reviewer wants to look at a wall from a different angle —
 *     not requested by the task but cheap to keep enabled.
 *   - The "Reset view" button restores the auto-framed bounds
 *     for the current selection (or the full scene when there's
 *     no selection in flight).
 *
 * The viewport intentionally does *not* own the aria-live
 * announcement — that lives in {@link MaterializableElementsList}
 * (asserted in BimModelTab.test) and is unaffected by this
 * component.
 */

export interface BimModelViewportProps {
  elements: MaterializableElement[];
  /**
   * The same `highlightElementRef` the
   * {@link MaterializableElementsList} resolves — a free-form ref
   * the AI emitted on a finding (`wall:north-side-l2`), the
   * server-side element id, or a label string. Resolved with the
   * same matcher the list uses (id → label → ci-label →
   * trailing-segment) so the viewport's selection always agrees
   * with the row pulse sitting next to it.
   *
   * Null means "no selection in flight" — the camera frames the
   * full scene.
   */
  selectedElementRef?: string | null;
  /**
   * Task #409 — the current reviewer's session user id, used to
   * scope the localStorage-backed "graduated" gesture-legend
   * preference per user. Two reviewers sharing one browser
   * profile each keep their own graduation state; A's
   * dismissals don't graduate B. The wrapping `BimModelTab`
   * resolves this from the session endpoint; tests that exercise
   * the per-user contract pass it directly.
   *
   * Defaults to a shared anonymous bucket so the unauth and
   * undefined-prop paths still work, and so callers that don't
   * care about the per-user dimension still benefit from the
   * graduation behaviour.
   */
  currentUserId?: string;
}

interface Bounds2D {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

interface Bounds3D {
  minX: number;
  minY: number;
  minZ: number;
  maxX: number;
  maxY: number;
  maxZ: number;
}

/**
 * Extracts a 2D bounding box (top-down plan view) from an
 * element's inline polygon geometry. Null when geometry is
 * absent / unsupported / glb-only / empty / degenerate — the
 * caller treats null as "this element has no inline-renderable
 * footprint" and either falls back to the briefingSource GLB
 * (when the element has a `briefingSourceId`) or to the
 * unrenderable-overlay fallback.
 *
 * Supported shapes:
 *   - `{ ring: [[x, y], ...] }` and `{ ring: [[x, y, z], ...] }`
 *   - `{ rings: [[[x, y], ...], ...] }` (multi-ring polygons)
 */
export function extractElementBounds(
  element: MaterializableElement,
): Bounds2D | null {
  const geom = element.geometry as Record<string, unknown> | null;
  if (!geom || typeof geom !== "object") return null;

  const collectFromRing = (ring: unknown, acc: Bounds2D | null): Bounds2D | null => {
    if (!Array.isArray(ring) || ring.length === 0) return acc;
    let next = acc;
    for (const pt of ring) {
      if (!Array.isArray(pt) || pt.length < 2) continue;
      const x = Number(pt[0]);
      const y = Number(pt[1]);
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      if (next === null) {
        next = { minX: x, minY: y, maxX: x, maxY: y };
      } else {
        if (x < next.minX) next.minX = x;
        if (x > next.maxX) next.maxX = x;
        if (y < next.minY) next.minY = y;
        if (y > next.maxY) next.maxY = y;
      }
    }
    return next;
  };

  let bounds: Bounds2D | null = null;
  if (Array.isArray((geom as { ring?: unknown }).ring)) {
    bounds = collectFromRing((geom as { ring: unknown }).ring, bounds);
  }
  if (Array.isArray((geom as { rings?: unknown }).rings)) {
    for (const ring of (geom as { rings: unknown[] }).rings) {
      bounds = collectFromRing(ring, bounds);
    }
  }
  if (bounds === null) return null;
  // Reject zero-area degenerate bounds — a single repeated point
  // would otherwise frame the camera onto a 0×0 box and the
  // reviewer would see nothing.
  if (bounds.minX === bounds.maxX && bounds.minY === bounds.maxY) {
    return null;
  }
  return bounds;
}

/**
 * Outer (first) ring as `[x, y]` pairs (z dropped) — used to
 * build the extruded polygon mesh in the scene. Empty array
 * when no ring is extractable.
 */
export function extractElementRing(
  element: MaterializableElement,
): Array<[number, number]> {
  const geom = element.geometry as Record<string, unknown> | null;
  if (!geom || typeof geom !== "object") return [];
  const candidate =
    Array.isArray((geom as { ring?: unknown }).ring)
      ? ((geom as { ring: unknown[] }).ring)
      : Array.isArray((geom as { rings?: unknown }).rings) &&
          Array.isArray((geom as { rings: unknown[] }).rings[0])
        ? ((geom as { rings: unknown[][] }).rings[0])
        : null;
  if (!candidate) return [];
  const out: Array<[number, number]> = [];
  for (const pt of candidate) {
    if (!Array.isArray(pt) || pt.length < 2) continue;
    const x = Number(pt[0]);
    const y = Number(pt[1]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    out.push([x, y]);
  }
  return out;
}

/**
 * Same matcher contract the {@link MaterializableElementsList}
 * uses (id → label → ci-label → trailing-segment) so the
 * viewport's selection state always agrees with the row pulse.
 * Duplicated rather than imported to keep the viewport a
 * standalone component — the helper is small enough that the
 * cost of duplication is lower than the cost of a shared
 * helper module.
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

interface Renderable {
  element: MaterializableElement;
  /**
   * Which scene-representation path the element uses.
   *   - `"ring"` — inline polygon, extruded into a slab in-scene.
   *   - `"glb"` — fetched from one of two glb endpoints:
   *       * `GET /briefing-sources/:id/glb` when the element has
   *         a `briefingSourceId` (the typical converted-DXF case;
   *         multiple elements may share one source so the load
   *         effect dedups by `glbKey === briefingSourceId`).
   *       * `GET /materializable-elements/:id/glb` when the
   *         element has only a `glbObjectPath` (an architect-
   *         supplied mesh that didn't go through the briefing-
   *         source converter pipeline; Task #379 added this
   *         fallback so the orphan case is no longer treated as
   *         an unfetchable hint). The dedup key is the element id
   *         itself — by definition unique.
   */
  source: "ring" | "glb";
  /** Inline 2D bounds — populated only when source === "ring". */
  inlineBounds: Bounds2D | null;
  /** Inline outer ring — populated only when source === "ring". */
  inlineRing: Array<[number, number]>;
  /**
   * Stable key for dedup + per-source load-status reporting —
   * populated only when source === "glb". `briefingSourceId` for
   * elements backed by a briefing source (multiple elements may
   * share); `element.id` for direct-element fetches (Task #379's
   * `/materializable-elements/:id/glb` fallback).
   */
  glbKey: string | null;
  /**
   * Pre-resolved fetch URL for the glb bytes — populated only when
   * source === "glb". Lifting URL resolution here keeps the load
   * effect agnostic to which endpoint backs the bytes.
   */
  glbUrl: string | null;
}

function classifyElements(elements: MaterializableElement[]): Renderable[] {
  const out: Renderable[] = [];
  for (const el of elements) {
    const bounds = extractElementBounds(el);
    if (bounds !== null) {
      out.push({
        element: el,
        source: "ring",
        inlineBounds: bounds,
        inlineRing: extractElementRing(el),
        glbKey: null,
        glbUrl: null,
      });
      continue;
    }
    if (el.briefingSourceId) {
      out.push({
        element: el,
        source: "glb",
        inlineBounds: null,
        inlineRing: [],
        glbKey: el.briefingSourceId,
        glbUrl: getGetBriefingSourceGlbUrl(el.briefingSourceId),
      });
      continue;
    }
    if (el.glbObjectPath) {
      // Task #379 — an element row may advertise a `glbObjectPath`
      // without a `briefingSourceId` (e.g. an architect-supplied
      // mesh that didn't pass through the briefing-source converter
      // pipeline). Before #379 these were classed as "glb-orphan"
      // and the viewer surfaced a "can't fetch" hint; now we route
      // the load through `/materializable-elements/:id/glb` so the
      // bytes load and the camera frames the mesh exactly like a
      // briefing-source-backed element.
      out.push({
        element: el,
        source: "glb",
        inlineBounds: null,
        inlineRing: [],
        glbKey: el.id,
        glbUrl: getGetMaterializableElementGlbUrl(el.id),
      });
      continue;
    }
    // Genuinely no scene representation — skipped from the
    // renderable list, picked up by the no-geometry overlay
    // fallback when the reviewer jumps to it.
  }
  return out;
}

/**
 * Inflate the bounds by `paddingFraction` on every side so the
 * framed element doesn't sit flush against the viewport edge.
 * 0.4 (40%) is generous on selection because the highlighted
 * element should clearly dominate the viewport but the reviewer
 * still wants a sliver of context around it; 0.1 on the
 * full-scene fall-through is enough to stop the outermost
 * polygons brushing the canvas border.
 */
function padBounds(bounds: Bounds2D, paddingFraction: number): Bounds2D {
  const w = Math.max(bounds.maxX - bounds.minX, 0);
  const h = Math.max(bounds.maxY - bounds.minY, 0);
  const pad = Math.max(w, h) * paddingFraction;
  const absPad = Math.max(pad, 0.5);
  return {
    minX: bounds.minX - absPad,
    minY: bounds.minY - absPad,
    maxX: bounds.maxX + absPad,
    maxY: bounds.maxY + absPad,
  };
}

function unionBounds(a: Bounds2D, b: Bounds2D): Bounds2D {
  return {
    minX: Math.min(a.minX, b.minX),
    minY: Math.min(a.minY, b.minY),
    maxX: Math.max(a.maxX, b.maxX),
    maxY: Math.max(a.maxY, b.maxY),
  };
}

function unionBounds3(a: Bounds3D, b: Bounds3D): Bounds3D {
  return {
    minX: Math.min(a.minX, b.minX),
    minY: Math.min(a.minY, b.minY),
    minZ: Math.min(a.minZ, b.minZ),
    maxX: Math.max(a.maxX, b.maxX),
    maxY: Math.max(a.maxY, b.maxY),
    maxZ: Math.max(a.maxZ, b.maxZ),
  };
}

/**
 * Inline polygon rings get extruded to this slab height so they
 * read as 3D objects. The exact height isn't material — it's
 * cosmetic — but it has to be small relative to typical parcel
 * dimensions or the "iso camera looking down at the plan" mental
 * model breaks.
 */
const RING_EXTRUDE_HEIGHT = 0.5;

/**
 * Compute the OrbitControls target + camera distance for a given
 * 3D bounds. Pure so it's testable independent of the WebGL
 * pipeline. The camera sits along an iso (-1, 1, 1) unit vector
 * at `distance` from the target so the reviewer always sees the
 * scene from a recognisable above-and-southwest viewpoint
 * (matching SiteContextViewer's default).
 */
export function computeCameraFit(bounds: Bounds3D): {
  target: [number, number, number];
  distance: number;
} {
  const cx = (bounds.minX + bounds.maxX) / 2;
  const cy = (bounds.minY + bounds.maxY) / 2;
  const cz = (bounds.minZ + bounds.maxZ) / 2;
  const sx = bounds.maxX - bounds.minX;
  const sy = bounds.maxY - bounds.minY;
  const sz = bounds.maxZ - bounds.minZ;
  // 1.5 × longest axis is the standard "fit-to-bounds" multiplier
  // for a 45° FOV perspective camera — close enough for both
  // very small (a single setback ring) and very large (whole
  // parcel) bounds without over-zooming on one extreme.
  const distance = Math.max(sx, sy, sz, 0.01) * 1.5;
  return { target: [cx, cy, cz], distance };
}

const KIND_COLOR: Record<string, number> = {
  terrain: 0x8b7355,
  "property-line": 0xff3344,
  "setback-plane": 0xe8a23a,
  "buildable-envelope": 0xcccccc,
  floodplain: 0x4488cc,
  wetland: 0x55aa77,
  "neighbor-mass": 0xb8c0cc,
};
const SELECTED_COLOR = 0x2266dd;
const DEFAULT_COLOR = 0xb8c0cc;

function detectWebGl(): boolean {
  if (typeof document === "undefined") return false;
  try {
    const canvas = document.createElement("canvas");
    const gl = canvas.getContext("webgl2") ?? canvas.getContext("webgl");
    return Boolean(gl);
  } catch {
    return false;
  }
}

/**
 * Task #409 — "graduate" power users out of the per-engagement
 * legend cycle.
 *
 * Task #405 fades the legend down to a "?" affordance the moment
 * the reviewer demonstrates the gestures (pan/wheel) on a given
 * engagement, but each fresh engagement starts with the full
 * legend again. That's the right default for a brand-new reviewer,
 * but a high-volume reviewer who works through dozens of
 * engagements per day proves they know the gesture model after
 * the first few — surfacing the full banner on every new
 * engagement after that becomes visual noise.
 *
 * This supersedes the simpler "persist on first dismissal"
 * behaviour Task #410 briefly shipped: graduating only after
 * `GRADUATE_THRESHOLD` distinct engagements gives a brand-new
 * reviewer time to learn the gestures before we permanently
 * collapse the legend on them, while still delivering the
 * cross-session memory #410 was after.
 *
 * Per-user scoping: every storage key is suffixed with the
 * reviewer's session user id (resolved from the same session
 * endpoint `useSessionPermissions` consumes). Two reviewers
 * sharing one browser profile (a kiosk machine, a shared QA
 * laptop) keep independent graduation state — A's dismissals
 * don't graduate B. The fallback id `"_anon"` is used when no
 * session user is available (logged-out / unauth), giving a
 * single shared default rather than collapsing every reviewer
 * onto one global key.
 *
 * Streak semantics: graduation only triggers after the reviewer
 * dismisses the legend on `GRADUATE_THRESHOLD` *consecutive*
 * engagements. Visiting an engagement without dismissing the
 * legend resets the streak — power-user discipline is the only
 * signal the storage actually trusts. We track this via a
 * `lastVisited` cursor: when the reviewer enters engagement E
 * and the previously-tracked `lastVisited` engagement is NOT in
 * the dismissed list (i.e. they walked away from a still-visible
 * legend), we clear the streak.
 *
 * Storage contract (per-user):
 *   - `bim-gesture-legend:<userId>:graduated` — `"1"` once the
 *     reviewer has dismissed the legend on
 *     `GRADUATE_THRESHOLD` consecutive engagements. Once set,
 *     every future engagement opens straight into the "?"
 *     affordance. Reviewers can still re-summon the full legend
 *     on demand (the existing hover/focus toggle from #405).
 *   - `bim-gesture-legend:<userId>:streak` — JSON
 *     `{ lastVisited: string | null, dismissed: string[] }`
 *     describing the current run. `dismissed` lists every
 *     engagement key the reviewer has dismissed in the current
 *     consecutive streak (set semantics — re-dismissing the same
 *     engagement is a no-op). `lastVisited` is the most recent
 *     engagement key the reviewer has visited; an entering
 *     engagement that doesn't match `lastVisited` AND finds
 *     `lastVisited` missing from `dismissed` resets the streak.
 *     Cleared once the reviewer graduates (the individual keys
 *     are no longer interesting once the flag is set).
 *
 * All helpers are defensive against environments without
 * localStorage (SSR, private browsing with quota errors) — they
 * silently treat the lookups as "not graduated, no history" so
 * the default Task #405 behaviour applies.
 */
const GRADUATE_THRESHOLD = 3;
const STORAGE_PREFIX = "bim-gesture-legend";
const ANON_USER_ID = "_anon";

function graduatedKey(userId: string): string {
  return `${STORAGE_PREFIX}:${userId}:graduated`;
}

function streakKey(userId: string): string {
  return `${STORAGE_PREFIX}:${userId}:streak`;
}

interface GestureHintStreak {
  lastVisited: string | null;
  dismissed: string[];
}

function emptyStreak(): GestureHintStreak {
  return { lastVisited: null, dismissed: [] };
}

function readGestureHintGraduated(userId: string): boolean {
  try {
    if (typeof window === "undefined") return false;
    return window.localStorage.getItem(graduatedKey(userId)) === "1";
  } catch {
    return false;
  }
}

function readStreak(userId: string): GestureHintStreak {
  try {
    if (typeof window === "undefined") return emptyStreak();
    const raw = window.localStorage.getItem(streakKey(userId));
    if (!raw) return emptyStreak();
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return emptyStreak();
    const obj = parsed as { lastVisited?: unknown; dismissed?: unknown };
    const lastVisited =
      typeof obj.lastVisited === "string" ? obj.lastVisited : null;
    const dismissed = Array.isArray(obj.dismissed)
      ? obj.dismissed.filter((s): s is string => typeof s === "string")
      : [];
    return { lastVisited, dismissed };
  } catch {
    return emptyStreak();
  }
}

function writeStreak(userId: string, next: GestureHintStreak): void {
  try {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(streakKey(userId), JSON.stringify(next));
  } catch {
    /* ignore quota errors — graduation just won't persist */
  }
}

/**
 * Record that the reviewer is now looking at `engagementKey`. If
 * the previously-tracked engagement has NOT been dismissed (i.e.
 * the reviewer walked away from a still-visible legend), reset
 * the consecutive-dismissal streak — graduation requires
 * back-to-back dismissals, not a sparse pattern.
 *
 * No-op once the reviewer is graduated (the streak is moot at
 * that point) and no-op for a same-engagement re-visit (a
 * rerender shouldn't trigger streak bookkeeping).
 */
function noteEngagementVisit(userId: string, engagementKey: string): void {
  try {
    if (typeof window === "undefined") return;
    if (window.localStorage.getItem(graduatedKey(userId)) === "1") return;
    const streak = readStreak(userId);
    if (streak.lastVisited === engagementKey) return;
    let nextDismissed = streak.dismissed;
    if (
      streak.lastVisited !== null &&
      !streak.dismissed.includes(streak.lastVisited)
    ) {
      // Reviewer left the previous engagement without dismissing
      // its legend → streak broken.
      nextDismissed = [];
    }
    writeStreak(userId, {
      lastVisited: engagementKey,
      dismissed: nextDismissed,
    });
  } catch {
    /* ignore — falling back to default behaviour */
  }
}

/**
 * Record that the reviewer dismissed the legend on `engagementKey`
 * and report whether that dismissal pushed them over the
 * graduation threshold. Idempotent for a given key — re-dismissing
 * on the same engagement is a no-op so we don't trivially graduate
 * a reviewer who keeps poking the same model.
 *
 * Returns `{ graduated }` so callers don't have to re-read storage
 * just to detect the transition.
 */
function recordDismissedEngagement(
  userId: string,
  engagementKey: string,
): { graduated: boolean } {
  try {
    if (typeof window === "undefined") return { graduated: false };
    if (window.localStorage.getItem(graduatedKey(userId)) === "1") {
      return { graduated: true };
    }
    const streak = readStreak(userId);
    if (streak.dismissed.includes(engagementKey)) {
      return { graduated: false };
    }
    const nextDismissed = [...streak.dismissed, engagementKey];
    if (nextDismissed.length >= GRADUATE_THRESHOLD) {
      window.localStorage.setItem(graduatedKey(userId), "1");
      window.localStorage.removeItem(streakKey(userId));
      return { graduated: true };
    }
    writeStreak(userId, {
      lastVisited: engagementKey,
      dismissed: nextDismissed,
    });
    return { graduated: false };
  } catch {
    return { graduated: false };
  }
}

function disposeObject(obj: THREE.Object3D): void {
  obj.traverse((child) => {
    const mesh = child as Partial<THREE.Mesh> & Partial<THREE.Line>;
    if (mesh.geometry && typeof mesh.geometry.dispose === "function") {
      mesh.geometry.dispose();
    }
    const material = mesh.material;
    if (Array.isArray(material)) {
      material.forEach((m) => m.dispose());
    } else if (material && typeof material.dispose === "function") {
      material.dispose();
    }
  });
  obj.parent?.remove(obj);
}

export function BimModelViewport({
  elements,
  selectedElementRef = null,
  currentUserId = ANON_USER_ID,
}: BimModelViewportProps) {
  const renderable = useMemo(() => classifyElements(elements), [elements]);

  // Track C — IFC ingest surfaces. The consolidated glTF bundle row
  // (sourceKind "as-built-ifc-bundle") loads through the existing
  // glb-orphan branch in classifyElements above, so no special render
  // pipeline is needed. We just need to know the bundle row is present
  // (legend visibility) and which per-entity rows it represents
  // (legend counts + IFC-detail panel content).
  const ifcBundle = useMemo<MaterializableElement | null>(() => {
    return (
      elements.find(
        (el) =>
          el.sourceKind === "as-built-ifc-bundle" &&
          el.glbObjectPath !== null &&
          el.glbObjectPath !== "",
      ) ?? null
    );
  }, [elements]);

  // Per-IFC-type counts driven off the per-entity (`as-built-ifc`) rows.
  // The bundle row carries a sentinel `<bundle>` ifc_type that we
  // intentionally exclude from the legend — it isn't a real entity.
  const ifcEntityCounts = useMemo<Array<[string, number]>>(() => {
    const counts: Record<string, number> = {};
    for (const el of elements) {
      if (el.sourceKind !== "as-built-ifc") continue;
      const t = el.ifcType ?? "Unknown";
      counts[t] = (counts[t] ?? 0) + 1;
    }
    // Sorted by count desc then ifcType asc so the legend reads
    // "47 IfcWall · 12 IfcDoor · …" — the most common entity first.
    return Object.entries(counts).sort(
      (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
    );
  }, [elements]);

  const ifcEntityTotal = useMemo(
    () => ifcEntityCounts.reduce((acc, [, n]) => acc + n, 0),
    [ifcEntityCounts],
  );

  // Three.js scene refs — the React state below mirrors what the
  // scene shows, and effects further down apply that state to
  // the scene (selection, camera fit, mesh add/remove).
  const containerRef = useRef<HTMLDivElement | null>(null);
  // Separate ref for the outer viewport wrapper. The rAF render
  // loop writes `data-camera-live-target` here (Task #401) so the
  // attribute lives on the same element as `data-camera-target` /
  // `data-camera-fit-applied-count` — anything else would be a
  // surprise for callers walking the viewport's data attributes.
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const controlsRef = useRef<OrbitControls | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  // Map of elementId → its scene Object3D, so selection /
  // camera-fit / disposal can find a mesh by the id the React
  // tree knows about.
  const elementMeshesRef = useRef<Map<string, THREE.Object3D>>(new Map());

  const [webGlOk] = useState<boolean>(detectWebGl);
  // Per-source GLB load state, plus the bounds the load
  // resolved (used to camera-fit onto a glb-only element after
  // its mesh is in the scene).
  const [glbState, setGlbState] = useState<
    Record<string, { status: "loading" | "loaded" | "error"; error?: string }>
  >({});
  const [glbBounds, setGlbBounds] = useState<Record<string, Bounds3D>>({});

  // Task #405 — gesture legend fade. The Task #402 legend reads
  // naturally on a fresh canvas but turns into visual noise for
  // power users who already know the gesture model. Once the
  // reviewer demonstrates they know the gestures (first
  // pan/rotate via pointerdown on the canvas, or first wheel
  // zoom), we collapse the legend down to a small "?" affordance
  // in the same corner. Hovering or focusing the "?" re-summons
  // the full legend on demand. The dismissed state is per-engagement
  // (keyed by `briefingId` — see the reset effect below) so a fresh
  // BIM model still gets the full affordance even within the same
  // session.
  // Task #409 — graduated power users
  // (`bim-gesture-legend:<userId>:graduated` in localStorage) skip
  // the full legend on every new engagement and land directly in
  // the "?" affordance state. Reading the flag lazily inside
  // `useState` so the very first paint of the very first
  // engagement still respects it (no full-legend flash before an
  // effect collapses it down).
  const [hintDismissed, setHintDismissed] = useState<boolean>(
    () => readGestureHintGraduated(currentUserId),
  );
  const [hintRevealed, setHintRevealed] = useState(false);
  // Task #408 — sticky tap/click reveal. Tablet reviewers have no
  // hover state and don't typically Tab through the review flow,
  // so the hover/focus reveals from Task #405 are unreachable for
  // them. Tapping the "?" toggles this latched state, which keeps
  // the legend open until the reviewer either taps the "?" again
  // or interacts with the canvas (the dismiss ref below clears it
  // alongside the dismissed flag, matching the canvas-closes-it
  // half of the task contract).
  const [hintStickyOpen, setHintStickyOpen] = useState(false);

  // Reset the dismissed state when the engagement changes — keyed
  // by the briefing id since BimModelViewport is engagement-scoped
  // (one BIM model per engagement, all elements share a briefingId).
  // A reviewer who has dismissed the legend on engagement A still
  // sees the full legend when they jump to engagement B's BIM model
  // — UNLESS they've graduated (Task #409), in which case engagement
  // B opens straight into the "?" state too.
  //
  // The transition also feeds into the consecutive-streak bookkeeping
  // via `noteEngagementVisit` — moving away from an engagement
  // without dismissing its legend resets the streak, so a reviewer
  // who only dismisses sporadically never trivially graduates.
  const engagementKey = elements[0]?.briefingId ?? null;
  const lastEngagementKeyRef = useRef<string | null>(engagementKey);
  // Register the very first engagement visit on mount. The reset
  // effect below short-circuits on the initial render (because
  // `lastEngagementKeyRef.current === engagementKey`), so without
  // this we'd never record the opening engagement and the
  // streak-reset logic would never see a `lastVisited` to compare
  // against.
  useEffect(() => {
    if (engagementKey !== null) {
      noteEngagementVisit(currentUserId, engagementKey);
    }
    // Mount-only: the engagement-change branch handles subsequent
    // transitions.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (lastEngagementKeyRef.current !== engagementKey) {
      lastEngagementKeyRef.current = engagementKey;
      if (engagementKey !== null) {
        noteEngagementVisit(currentUserId, engagementKey);
      }
      setHintDismissed(readGestureHintGraduated(currentUserId));
      setHintRevealed(false);
      setHintStickyOpen(false);
    }
  }, [engagementKey, currentUserId]);

  // Stable callback ref so the scene-lifecycle effect (which only
  // re-runs on `webGlOk`) can dismiss the hint without taking
  // `setHintDismissed` as a dependency — bringing setState into
  // that effect would tear down and rebuild the entire Three.js
  // scene on every state transition. The ref also persists the
  // dismissal to localStorage (Task #409) so the graduation streak
  // can be tracked across engagements; we read the latest
  // engagementKey + userId off refs rather than closing over them
  // directly so the ref stays valid even as those props change
  // during a long session.
  const engagementKeyRef = useRef<string | null>(engagementKey);
  const currentUserIdRef = useRef<string>(currentUserId);
  useEffect(() => {
    engagementKeyRef.current = engagementKey;
    currentUserIdRef.current = currentUserId;
  });
  const dismissHintRef = useRef<() => void>(() => {});
  useEffect(() => {
    dismissHintRef.current = () => {
      setHintDismissed(true);
      const key = engagementKeyRef.current;
      if (key) {
        recordDismissedEngagement(currentUserIdRef.current, key);
      }
      // Task #408 — a canvas pan/zoom/rotate is the reviewer's
      // signal that they're done reading the legend, so clear the
      // sticky tap-open state too. Otherwise a reviewer who tapped
      // "?" to see the legend, then panned the canvas, would see
      // the legend stay open on top of their newly-framed scene.
      setHintStickyOpen(false);
    };
  });

  // Resolve the current selection. May resolve to an element
  // that has no scene representation — that's the fallback
  // overlay path.
  const selected = useMemo(() => {
    if (!selectedElementRef) return null;
    return findElementByRef(elements, selectedElementRef);
  }, [elements, selectedElementRef]);

  // Track C — when the selection resolves to an IFC row (per-entity
  // or bundle), surface a small detail panel with the row's IFC
  // metadata. Phase 1 stops at the JSON dump of `propertySet`; the
  // panel is the foundation for Plan Review's "show me where" jump
  // (Phase 2). Bundle rows have a sentinel ifc_type / ifc_global_id
  // that we surface verbatim — the panel header marks them as
  // "Bundle" so the reviewer doesn't mistake the synthetic for a
  // real entity.
  const selectedIfc = useMemo<MaterializableElement | null>(() => {
    if (!selected) return null;
    if (
      selected.sourceKind !== "as-built-ifc" &&
      selected.sourceKind !== "as-built-ifc-bundle"
    ) {
      return null;
    }
    return selected;
  }, [selected]);

  const selectedRenderable = useMemo<Renderable | null>(() => {
    if (!selected) return null;
    return renderable.find((r) => r.element.id === selected.id) ?? null;
  }, [selected, renderable]);

  // Compute the framed bounds. For a ring-source selection we
  // extrude the inline 2D bounds to the slab height. For a
  // glb-source selection we use the GLB-derived bounds once
  // they're known — until then we fall back to scene bounds so
  // the camera doesn't snap to (0,0,0). For no selection / no
  // renderable selection we frame the whole scene.
  const sceneBounds = useMemo<Bounds3D | null>(() => {
    let acc: Bounds3D | null = null;
    for (const r of renderable) {
      if (r.source === "ring" && r.inlineBounds) {
        const b: Bounds3D = {
          minX: r.inlineBounds.minX,
          minY: r.inlineBounds.minY,
          minZ: 0,
          maxX: r.inlineBounds.maxX,
          maxY: r.inlineBounds.maxY,
          maxZ: RING_EXTRUDE_HEIGHT,
        };
        acc = acc ? unionBounds3(acc, b) : b;
      } else if (r.source === "glb" && r.glbKey && glbBounds[r.glbKey]) {
        acc = acc ? unionBounds3(acc, glbBounds[r.glbKey]) : glbBounds[r.glbKey];
      }
    }
    return acc;
  }, [renderable, glbBounds]);

  const framedBounds = useMemo<Bounds3D | null>(() => {
    if (selectedRenderable) {
      if (selectedRenderable.source === "ring" && selectedRenderable.inlineBounds) {
        const padded = padBounds(selectedRenderable.inlineBounds, 0.4);
        return {
          minX: padded.minX,
          minY: padded.minY,
          minZ: 0,
          maxX: padded.maxX,
          maxY: padded.maxY,
          maxZ: RING_EXTRUDE_HEIGHT,
        };
      }
      if (
        selectedRenderable.source === "glb" &&
        selectedRenderable.glbKey &&
        glbBounds[selectedRenderable.glbKey]
      ) {
        const b = glbBounds[selectedRenderable.glbKey];
        // Manual 3D padding (the 2D padBounds doesn't know about
        // z). 25% of the longest axis is enough to keep a tall
        // mass like a neighbor-building visible inside the frame.
        const sx = b.maxX - b.minX;
        const sy = b.maxY - b.minY;
        const sz = b.maxZ - b.minZ;
        const pad = Math.max(sx, sy, sz, 0.5) * 0.25;
        return {
          minX: b.minX - pad,
          minY: b.minY - pad,
          minZ: b.minZ - pad,
          maxX: b.maxX + pad,
          maxY: b.maxY + pad,
          maxZ: b.maxZ + pad,
        };
      }
    }
    // Selection unrenderable / loading / absent → scene-bounds
    // framing (or the "100×100" placeholder when there's no
    // scene at all).
    if (sceneBounds) {
      const padded = padBounds(
        {
          minX: sceneBounds.minX,
          minY: sceneBounds.minY,
          maxX: sceneBounds.maxX,
          maxY: sceneBounds.maxY,
        },
        0.1,
      );
      return {
        minX: padded.minX,
        minY: padded.minY,
        minZ: sceneBounds.minZ,
        maxX: padded.maxX,
        maxY: padded.maxY,
        maxZ: sceneBounds.maxZ,
      };
    }
    return null;
  }, [selectedRenderable, sceneBounds, glbBounds]);

  const cameraFit = useMemo(
    () => (framedBounds ? computeCameraFit(framedBounds) : null),
    [framedBounds],
  );

  // ---------- Three.js scene lifecycle ----------
  useEffect(() => {
    const container = containerRef.current;
    if (!container || !webGlOk) return;

    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    } catch {
      return;
    }
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.setSize(
      container.clientWidth || 1,
      container.clientHeight || 1,
      false,
    );
    renderer.setClearColor(0x000000, 0);
    container.appendChild(renderer.domElement);
    rendererRef.current = renderer;

    const scene = new THREE.Scene();
    sceneRef.current = scene;

    const ambient = new THREE.AmbientLight(0xffffff, 0.45);
    scene.add(ambient);
    const sun = new THREE.DirectionalLight(0xffffff, 0.85);
    // Z-up world: light sits above scene (positive Z) and slightly
    // off-axis so extruded slabs cast a visible top-vs-side shading
    // rather than rendering as flat colour blocks.
    sun.position.set(0, -100, 200);
    scene.add(sun);

    const camera = new THREE.PerspectiveCamera(
      45,
      (container.clientWidth || 1) / (container.clientHeight || 1),
      0.1,
      5000,
    );
    // Engineering / CAD convention: Z is "up". This matches the
    // mesh-coordinate system the inline-ring extrude produces
    // (polygon flat in the XY plane, slab height along +Z) and
    // keeps the camera-fit math (`computeCameraFit`) consistent
    // with the geometry actually in the scene — no rotateX
    // mismatch. OrbitControls reads `camera.up` so target /
    // pan / zoom all stay world-Z-up.
    camera.up.set(0, 0, 1);
    camera.position.set(-80, -80, 80);
    camera.lookAt(0, 0, 0);
    cameraRef.current = camera;

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.target.set(0, 0, 0);
    // Task #380 — reviewer pan/zoom interaction model:
    //   - Left mouse drags pan the camera (the most common gesture
    //     reviewers reach for when verifying a finding's neighbour
    //     context). Screen-space panning so the gesture moves the
    //     scene 1:1 with the cursor regardless of camera tilt.
    //   - Wheel zooms toward the cursor (handled by the custom
    //     `wheel` capture-phase listener below — three@0.128
    //     predates OrbitControls' built-in `zoomToCursor`, and
    //     bumping the dependency for one UX nicety would regress
    //     too many other consumers).
    //   - Right mouse still rotates the orbit so reviewers can
    //     pivot to read a setback-plane from a different angle.
    //     The task didn't ask for this but the alternative is to
    //     disable rotation entirely, which would regress today's
    //     OrbitControls default for no good reason.
    controls.enablePan = true;
    controls.enableZoom = true;
    controls.enableRotate = true;
    controls.screenSpacePanning = true;
    if (THREE.MOUSE) {
      controls.mouseButtons = {
        LEFT: THREE.MOUSE.PAN,
        MIDDLE: THREE.MOUSE.DOLLY,
        RIGHT: THREE.MOUSE.ROTATE,
      };
    }
    if (THREE.TOUCH) {
      controls.touches = {
        ONE: THREE.TOUCH.PAN,
        TWO: THREE.TOUCH.DOLLY_ROTATE,
      };
    }
    controlsRef.current = controls;

    // Custom wheel-zoom that anchors on the cursor instead of the
    // orbit target. We compute the world position under the cursor
    // by intersecting the camera ray with a plane through the
    // current orbit target (perpendicular to the camera->target
    // axis), then uniformly scale both the camera position and
    // the orbit target around that anchor. The OrbitControls
    // built-in dolly is suppressed via stopImmediatePropagation —
    // we register in capture phase so we run before the bubble-
    // phase listener OrbitControls attaches.
    const handleWheelZoom = (event: WheelEvent) => {
      const cam = cameraRef.current;
      const ctrls = controlsRef.current;
      if (!cam || !ctrls) return;
      // Task #405 — wheel zoom is one of the gestures the legend
      // teaches; the moment the reviewer uses it we collapse the
      // legend to the "?" affordance. Done before the rect-zero
      // early return so we still credit the gesture in headless /
      // unmeasured layouts (the legend is purely informational —
      // its dismiss state shouldn't depend on the zoom math
      // succeeding).
      dismissHintRef.current();
      event.preventDefault();
      event.stopImmediatePropagation();
      const rect = renderer.domElement.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;
      const ndcX = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      const ndcY = -((event.clientY - rect.top) / rect.height) * 2 + 1;
      const raycaster = new THREE.Raycaster();
      raycaster.setFromCamera(new THREE.Vector2(ndcX, ndcY), cam);
      const planeNormal = new THREE.Vector3()
        .subVectors(cam.position, ctrls.target)
        .normalize();
      // If the camera and target coincide (degenerate), bail —
      // there's no well-defined plane to zoom around.
      if (planeNormal.lengthSq() === 0) return;
      const plane = new THREE.Plane();
      plane.setFromNormalAndCoplanarPoint(planeNormal, ctrls.target);
      const anchor = new THREE.Vector3();
      if (!raycaster.ray.intersectPlane(plane, anchor)) return;
      // Per-tick scale factor: positive deltaY (scroll down) zooms
      // out, negative zooms in. Clamped so a stray high-resolution
      // trackpad event can't crash the camera through the geometry.
      const rawScale = Math.pow(0.95, -event.deltaY * 0.01);
      const scale = Math.max(0.5, Math.min(2.0, rawScale));
      const camOffset = new THREE.Vector3()
        .subVectors(cam.position, anchor)
        .multiplyScalar(scale);
      const targetOffset = new THREE.Vector3()
        .subVectors(ctrls.target, anchor)
        .multiplyScalar(scale);
      cam.position.copy(anchor).add(camOffset);
      ctrls.target.copy(anchor).add(targetOffset);
      if (typeof ctrls.update === "function") ctrls.update();
    };
    renderer.domElement.addEventListener("wheel", handleWheelZoom, {
      capture: true,
      passive: false,
    });

    // Task #405 — pointerdown on the canvas catches the other two
    // gestures the legend teaches: left-drag pan and right-drag
    // rotate. We listen passively (no preventDefault) so OrbitControls'
    // own pointerdown handler still receives the event and starts
    // the drag normally — we only piggyback to mark the legend as
    // dismissed.
    const handlePointerDown = () => {
      dismissHintRef.current();
    };
    renderer.domElement.addEventListener("pointerdown", handlePointerDown, {
      passive: true,
    });

    const animate = () => {
      animationFrameRef.current = requestAnimationFrame(animate);
      controls.update();
      renderer.render(scene, camera);
      // Live test diagnostic (Task #401) — mirror the current
      // OrbitControls target into a data attribute so e2e specs
      // can detect that wheel-zoom / drag-pan / Reset view moved
      // the camera off the auto-fit center. Defensive against the
      // unit-test OrbitControls stub, whose `target` is a plain
      // `{ set }` object with no x/y/z; in that environment the
      // attribute is simply never set, which is what the unit
      // tests expect.
      const t = controls.target as { x?: unknown; y?: unknown; z?: unknown };
      const viewportEl = viewportRef.current;
      if (
        viewportEl &&
        typeof t.x === "number" &&
        typeof t.y === "number" &&
        typeof t.z === "number" &&
        Number.isFinite(t.x) &&
        Number.isFinite(t.y) &&
        Number.isFinite(t.z)
      ) {
        const next = `${t.x.toFixed(2)},${t.y.toFixed(2)},${t.z.toFixed(2)}`;
        // Avoid no-op writes so MutationObservers (and Playwright
        // attribute waits) only fire when the value actually moved.
        if (viewportEl.dataset.cameraLiveTarget !== next) {
          viewportEl.dataset.cameraLiveTarget = next;
        }
      }
    };
    animate();

    const resize = () => {
      const w = container.clientWidth;
      const h = container.clientHeight;
      if (w === 0 || h === 0) return;
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    };
    const observer =
      typeof ResizeObserver !== "undefined" ? new ResizeObserver(resize) : null;
    observer?.observe(container);
    resize();

    return () => {
      if (animationFrameRef.current !== null) {
        cancelAnimationFrame(animationFrameRef.current);
        animationFrameRef.current = null;
      }
      observer?.disconnect();
      renderer.domElement.removeEventListener(
        "wheel",
        handleWheelZoom,
        { capture: true } as EventListenerOptions,
      );
      renderer.domElement.removeEventListener(
        "pointerdown",
        handlePointerDown,
      );
      controls.dispose();
      controlsRef.current = null;
      elementMeshesRef.current.forEach(disposeObject);
      elementMeshesRef.current.clear();
      renderer.dispose();
      renderer.domElement.parentNode?.removeChild(renderer.domElement);
      rendererRef.current = null;
      sceneRef.current = null;
      cameraRef.current = null;
    };
  }, [webGlOk]);

  // ---------- Inline-ring meshes: build / sync / dispose ----------
  useEffect(() => {
    if (!webGlOk) return;
    const scene = sceneRef.current;
    if (!scene) return;

    const meshes = elementMeshesRef.current;
    const wantedIds = new Set(
      renderable.filter((r) => r.source === "ring").map((r) => r.element.id),
    );
    // Drop ring meshes that no longer correspond to a renderable.
    for (const [id, mesh] of meshes.entries()) {
      if (mesh.userData.source === "ring" && !wantedIds.has(id)) {
        disposeObject(mesh);
        meshes.delete(id);
      }
    }

    for (const r of renderable) {
      if (r.source !== "ring" || !r.inlineRing.length) continue;
      if (meshes.has(r.element.id)) continue;
      const shape = new THREE.Shape();
      const [first, ...rest] = r.inlineRing;
      shape.moveTo(first[0], first[1]);
      for (const [x, y] of rest) shape.lineTo(x, y);
      shape.closePath();
      const geometry = new THREE.ExtrudeGeometry(shape, {
        depth: RING_EXTRUDE_HEIGHT,
        bevelEnabled: false,
      });
      // Z-up world (camera.up = (0,0,1)): the polygon stays flat in
      // the XY plane and ExtrudeGeometry's default +Z extrusion is
      // already "upward". No rotation needed — and crucially, this
      // keeps the mesh coordinate system aligned with the
      // computeCameraFit math (which treats inline ring (x, y) as
      // scene XY and the extruded slab as Z), so the camera target
      // resolves to the actual centre of the rendered slab and not
      // a rotated phantom.
      const color = KIND_COLOR[r.element.elementKind] ?? DEFAULT_COLOR;
      const material = new THREE.MeshLambertMaterial({
        color,
        transparent: true,
        opacity: 0.55,
        side: THREE.DoubleSide,
      });
      const mesh = new THREE.Mesh(geometry, material);
      mesh.userData.elementId = r.element.id;
      mesh.userData.elementKind = r.element.elementKind;
      mesh.userData.source = "ring";
      mesh.userData.baseColor = color;
      scene.add(mesh);
      meshes.set(r.element.id, mesh);
    }
  }, [renderable, webGlOk]);

  // ---------- GLB loads: per briefingSource ----------
  // glbState is held in a ref alongside the React state so the
  // load effect can read it without rerunning on every state
  // transition. If we put glbState in the dependency array, the
  // first setGlbState({status:"loading"}) call would tear down
  // the in-flight fetch via the cleanup's controller.abort(),
  // and the load would never resolve to loaded / error.
  const glbStateRef = useRef(glbState);
  useEffect(() => {
    glbStateRef.current = glbState;
  }, [glbState]);

  useEffect(() => {
    if (!webGlOk) return;
    const scene = sceneRef.current;
    if (!scene) return;

    // Dedupe by glbKey. For briefing-source-backed elements the key
    // is the briefingSourceId so multiple elements sharing one
    // source coalesce into a single fetch. For element-id-backed
    // elements (Task #379's `/materializable-elements/:id/glb`
    // fallback) the key is the element id itself — no coalescing
    // possible since the URL is unique per element.
    const wantedSources = new Map<
      string,
      { url: string; elementIds: string[] }
    >();
    for (const r of renderable) {
      if (r.source !== "glb" || !r.glbKey || !r.glbUrl) continue;
      const entry = wantedSources.get(r.glbKey) ?? {
        url: r.glbUrl,
        elementIds: [],
      };
      entry.elementIds.push(r.element.id);
      wantedSources.set(r.glbKey, entry);
    }

    const controller = new AbortController();
    const loader = new GLTFLoader();

    for (const [sourceId, { url, elementIds }] of wantedSources.entries()) {
      const currentStatus = glbStateRef.current[sourceId]?.status;
      // Skip sources that are already in any terminal / in-flight
      // state — only "no entry yet" should trigger a fresh fetch.
      if (currentStatus === "loaded") continue;
      if (currentStatus === "loading") continue;
      if (currentStatus === "error") continue;

      setGlbState((prev) => ({ ...prev, [sourceId]: { status: "loading" } }));
      void fetch(url, { signal: controller.signal })
        .then(async (res) => {
          if (!res.ok) {
            throw new Error(`HTTP ${res.status} ${res.statusText}`);
          }
          const buffer = await res.arrayBuffer();
          await new Promise<void>((resolve, reject) => {
            loader.parse(
              buffer,
              "",
              (gltf) => {
                if (controller.signal.aborted) {
                  resolve();
                  return;
                }
                // Compute the GLB's bounds from its own
                // `boundingBox` (computed by three when the user
                // calls `geometry.computeBoundingBox()`). For the
                // test's stubbed loader the bounds may be all
                // zeros — that still resolves the load and
                // exposes a `loaded` state, which is what the
                // test contract checks.
                const root = new THREE.Group();
                root.userData.briefingSourceId = sourceId;
                gltf.scene.children
                  .slice()
                  .forEach((child) => root.add(child));
                const box = new THREE.Box3().setFromObject(root);
                const bounds3: Bounds3D = {
                  minX: Number.isFinite(box.min.x) ? box.min.x : 0,
                  minY: Number.isFinite(box.min.y) ? box.min.y : 0,
                  minZ: Number.isFinite(box.min.z) ? box.min.z : 0,
                  maxX: Number.isFinite(box.max.x) ? box.max.x : 0,
                  maxY: Number.isFinite(box.max.y) ? box.max.y : 0,
                  maxZ: Number.isFinite(box.max.z) ? box.max.z : 0,
                };
                // Mount one per element id consuming this source
                // (clone to keep selection-highlight isolation).
                for (const elementId of elementIds) {
                  if (elementMeshesRef.current.has(elementId)) continue;
                  const cloneRoot = elementIds.length === 1 ? root : root.clone(true);
                  cloneRoot.userData.elementId = elementId;
                  cloneRoot.userData.briefingSourceId = sourceId;
                  cloneRoot.userData.source = "glb";
                  scene.add(cloneRoot);
                  elementMeshesRef.current.set(elementId, cloneRoot);
                }
                setGlbBounds((prev) => ({ ...prev, [sourceId]: bounds3 }));
                setGlbState((prev) => ({
                  ...prev,
                  [sourceId]: { status: "loaded" },
                }));
                resolve();
              },
              (err) => reject(err as unknown),
            );
          });
        })
        .catch((err: unknown) => {
          if (controller.signal.aborted) return;
          const message =
            err instanceof Error ? err.message : "Failed to load 3D mesh.";
          setGlbState((prev) => ({
            ...prev,
            [sourceId]: { status: "error", error: message },
          }));
        });
    }

    return () => {
      controller.abort();
    };
  }, [renderable, webGlOk]);

  // ---------- Selection highlight: swap material on the selected mesh ----------
  const selectedElementId = selectedRenderable?.element.id ?? "";
  useEffect(() => {
    if (!webGlOk) return;
    for (const [elementId, mesh] of elementMeshesRef.current.entries()) {
      const isSelected = elementId === selectedElementId;
      mesh.traverse((child) => {
        const m = child as THREE.Mesh;
        if (!m.isMesh) return;
        const mat = m.material as THREE.MeshLambertMaterial | undefined;
        if (!mat || typeof mat.color?.setHex !== "function") return;
        if (isSelected) {
          mat.color.setHex(SELECTED_COLOR);
          if ("opacity" in mat) mat.opacity = 0.85;
        } else {
          const baseColor =
            (mesh.userData.baseColor as number | undefined) ??
            KIND_COLOR[(mesh.userData.elementKind as string) ?? ""] ??
            DEFAULT_COLOR;
          mat.color.setHex(baseColor);
          if ("opacity" in mat) mat.opacity = 0.55;
        }
      });
    }
  }, [selectedElementId, webGlOk, renderable]);

  // ---------- Camera fit: update OrbitControls target + camera position ----------
  // The reviewer is allowed to pan / zoom freely (Task #380), so we
  // can't re-apply the auto-frame on every cameraFit recompute —
  // that would yank their viewport back whenever an unrelated GLB
  // finishes loading or a new element is appended. Instead we
  // re-frame only on selection-driven events:
  //   1. The very first cameraFit becomes available (initial
  //      scene framing on mount).
  //   2. The `selectedElementRef` prop changes — this is the
  //      "Show in 3D viewer" jump from MaterializableElementsList.
  //   3. The selected element's GLB bounds resolve from
  //      "pending" → "ready" (so a glb-source jump still snaps to
  //      the GLB-derived frame once the bytes land, even though
  //      the prop never changed).
  //   4. The reviewer explicitly clicks "Reset view" — handled
  //      via `handleResetView` below, not this effect.
  const [cameraFitAppliedCount, setCameraFitAppliedCount] = useState(0);

  const applyCameraFit = useCallback((): boolean => {
    if (!webGlOk) return false;
    const camera = cameraRef.current;
    const controls = controlsRef.current;
    if (!camera || !controls || !cameraFit) return false;
    const [tx, ty, tz] = cameraFit.target;
    controls.target.set(tx, ty, tz);
    // Z-up iso camera vector: south-west-above of target, so the
    // reviewer sees the polygon top-down with a slight perspective
    // tilt. Iso (-1, -1, 1) unit vector × distance + target.
    const iso = 1 / Math.sqrt(3);
    camera.position.set(
      tx + -iso * cameraFit.distance,
      ty + -iso * cameraFit.distance,
      tz + iso * cameraFit.distance,
    );
    camera.lookAt(tx, ty, tz);
    if (typeof controls.update === "function") controls.update();
    return true;
  }, [cameraFit, webGlOk]);

  // Stable identity for "what we last fit". Includes the selected
  // ref AND a flag for whether the selection's GLB bounds have
  // resolved, so the GLB-load promotion (case #3 above) still
  // triggers a reframe even when the prop didn't change. For
  // ring/glb-orphan/no-selection cases the GLB-resolved flag is
  // a no-op constant, so unrelated GLB loads don't churn the
  // signature.
  const fitSignature = useMemo(() => {
    const ref = selectedElementRef ?? "<scene>";
    if (
      selectedRenderable?.source === "glb" &&
      selectedRenderable.glbKey
    ) {
      const ready = glbBounds[selectedRenderable.glbKey] ? "ready" : "pending";
      return `${ref}|glb:${ready}`;
    }
    return `${ref}|static`;
  }, [selectedElementRef, selectedRenderable, glbBounds]);

  const lastFitSignatureRef = useRef<string | null>(null);

  useEffect(() => {
    if (!webGlOk) return;
    if (!cameraFit) return;
    if (lastFitSignatureRef.current === fitSignature) return;
    if (applyCameraFit()) {
      lastFitSignatureRef.current = fitSignature;
      setCameraFitAppliedCount((n) => n + 1);
    }
  }, [cameraFit, fitSignature, applyCameraFit, webGlOk]);

  const handleResetView = useCallback(() => {
    if (applyCameraFit()) {
      // Re-syncs the signature so the next selection-change /
      // GLB-load is still detected as "different from what's on
      // screen" — without this, a reviewer who pans away after a
      // reset wouldn't be re-framed if they later jumped to the
      // *same* element they reset onto. The increment is the
      // observable "yes, the reset clicked through to the camera".
      lastFitSignatureRef.current = fitSignature;
      setCameraFitAppliedCount((n) => n + 1);
    }
  }, [applyCameraFit, fitSignature]);

  const cameraTargetAttr = cameraFit
    ? `${cameraFit.target[0].toFixed(2)},${cameraFit.target[1].toFixed(2)},${cameraFit.target[2].toFixed(2)}`
    : "";
  const cameraDistanceAttr = cameraFit ? cameraFit.distance.toFixed(2) : "";
  const selectedSourceAttr = selectedRenderable?.source ?? "";

  // Per-source load-state attributes — we splat them onto the
  // wrapper rather than per-element so tests don't have to walk
  // the renderable list to find a status.
  const sourceLoadAttrs: Record<string, string> = {};
  for (const [sourceId, state] of Object.entries(glbState)) {
    sourceLoadAttrs[`data-source-load-${sourceId}`] = state.status;
  }

  return (
    <div
      ref={viewportRef}
      data-testid="bim-model-viewport"
      data-renderable-element-count={renderable.length}
      data-selected-element-id={selectedElementId}
      data-selected-element-source={selectedSourceAttr}
      data-camera-target={cameraTargetAttr}
      data-camera-distance={cameraDistanceAttr}
      data-camera-fit-applied-count={cameraFitAppliedCount}
      data-webgl-available={webGlOk ? "true" : "false"}
      data-ifc-bundle-element-id={ifcBundle?.id ?? ""}
      data-ifc-entity-count={ifcEntityTotal}
      data-ifc-selected-element-id={selectedIfc?.id ?? ""}
      {...sourceLoadAttrs}
      style={{
        padding: 12,
        border: "1px solid var(--border-default)",
        borderRadius: 6,
        display: "flex",
        flexDirection: "column",
        gap: 8,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          justifyContent: "space-between",
          gap: 8,
        }}
      >
        <div style={{ fontSize: 14, fontWeight: 500 }}>BIM model viewer</div>
        <div
          data-testid="bim-model-viewport-element-count"
          style={{
            fontSize: 11,
            color: "var(--text-muted)",
            fontVariantNumeric: "tabular-nums",
          }}
        >
          {renderable.length}{" "}
          {renderable.length === 1 ? "element" : "elements"} renderable
        </div>
      </div>

      <div
        ref={containerRef}
        data-testid="bim-model-viewport-canvas"
        style={{
          position: "relative",
          background: "var(--bg-input)",
          borderRadius: 4,
          overflow: "hidden",
          minHeight: 280,
          aspectRatio: "16 / 9",
        }}
      >
        {/*
          Task #402 — gesture legend. Reviewers used to land on the
          interactive 3D viewport (Task #380) with no on-canvas
          affordance other than the Reset view button, so the
          pan/zoom/rotate gestures were easy to miss. A small
          persistent legend in the top-left corner surfaces those
          gestures without dominating the canvas — top-right is
          already the Reset view button, and bottom is reserved for
          the GLB-loading / GLB-error / no-geometry overlays. We
          only render the legend when there's actually a live scene
          to interact with (WebGL available AND a frameable scene),
          so it doesn't sit on top of the WebGL-fallback or
          empty-state full-canvas overlays.
        */}
        {webGlOk &&
          cameraFit &&
          (!hintDismissed || hintRevealed || hintStickyOpen) && (
          <div
            data-testid="bim-model-viewport-gesture-hint"
            data-hint-source={hintDismissed ? "revealed" : "initial"}
            aria-label="3D viewer controls: drag to pan, scroll to zoom, right-drag to rotate, Reset view to recenter"
            style={{
              position: "absolute",
              top: 8,
              left: 8,
              background: "var(--bg-elevated)",
              color: "var(--text-muted)",
              border: "1px solid var(--border-default)",
              borderRadius: 4,
              padding: "4px 8px",
              fontSize: 11,
              lineHeight: 1.35,
              maxWidth: "60%",
              opacity: 0.9,
              pointerEvents: "none",
              zIndex: 2,
            }}
          >
            Drag to pan · Scroll to zoom · Right-drag to rotate ·
            Reset view to recenter
          </div>
        )}
        {webGlOk && cameraFit && hintDismissed && (
          // Task #405 — collapsed "?" affordance the reviewer can
          // hover or focus to re-summon the full legend. Sits in
          // the same top-left corner the legend used so the
          // reviewer's eye doesn't have to hunt for it. The "?"
          // owns the hover/focus handlers; the legend itself stays
          // pointerEvents:none so it never absorbs canvas gestures
          // (Task #380 contract). zIndex 1 keeps it under the
          // re-summoned legend (zIndex 2) so the legend visually
          // covers and replaces the "?" while it's revealed —
          // and because the legend stays pointerEvents:none, taps
          // on the "?" still land on the button beneath, which
          // is what makes the Task #408 tap-to-toggle workable on
          // touch devices (the "?" is reachable through the
          // visually-overlapping legend).
          //
          // Task #408 — onClick toggles a sticky reveal so tablet
          // reviewers (no hover, no Tab nav) can tap to open the
          // legend and tap again to close it. Hover/focus still
          // drive the transient `hintRevealed` reveal independently
          // for desktop / keyboard reviewers, so all three input
          // models work side-by-side without stepping on each other.
          <button
            type="button"
            data-testid="bim-model-viewport-gesture-hint-toggle"
            aria-label="Show 3D viewer controls"
            aria-pressed={hintStickyOpen}
            title="Show 3D viewer controls"
            onClick={(e) => {
              setHintStickyOpen((prev) => !prev);
              // Pointer-driven clicks (mouse / touch tap) also
              // focus the button as part of the browser's tap
              // pipeline, which fires `onFocus` → `hintRevealed
              // = true`. Without the blur below, a tablet
              // reviewer's *second* tap would toggle the sticky
              // state back off but the legend would stay visible
              // because the focus-driven reveal is still latched
              // — effectively breaking the "tap to open / tap to
              // close" contract this affordance was added for
              // (Task #408). Detecting `e.detail > 0` is the
              // standard distinguisher between pointer-initiated
              // clicks (always >= 1) and keyboard-initiated
              // clicks (always 0 from Enter / Space), so
              // keyboard reviewers keep their focus position for
              // continued Tab navigation. The Task #408 e2e spec
              // pins this down for the touch path through real
              // `page.touchscreen.tap` events.
              if (e.detail > 0) {
                e.currentTarget.blur();
              }
            }}
            onMouseEnter={() => setHintRevealed(true)}
            onMouseLeave={() => setHintRevealed(false)}
            onFocus={() => setHintRevealed(true)}
            onBlur={() => setHintRevealed(false)}
            style={{
              position: "absolute",
              top: 8,
              left: 8,
              width: 20,
              height: 20,
              padding: 0,
              background: "var(--bg-elevated)",
              color: "var(--text-muted)",
              border: "1px solid var(--border-default)",
              borderRadius: 10,
              fontSize: 12,
              lineHeight: 1,
              cursor: "help",
              opacity: 0.7,
              zIndex: 1,
            }}
          >
            ?
          </button>
        )}
        {webGlOk && cameraFit && (
          <button
            type="button"
            data-testid="bim-model-viewport-reset-view"
            onClick={handleResetView}
            title={
              selectedRenderable
                ? "Reset view to the selected element"
                : "Reset view to the full scene"
            }
            style={{
              position: "absolute",
              top: 8,
              right: 8,
              background: "var(--bg-elevated)",
              color: "var(--text-default)",
              border: "1px solid var(--border-default)",
              borderRadius: 4,
              padding: "4px 8px",
              fontSize: 11,
              cursor: "pointer",
              lineHeight: 1.2,
              zIndex: 1,
            }}
          >
            Reset view
          </button>
        )}
        {!webGlOk && (
          <div
            data-testid="bim-model-viewport-webgl-fallback"
            style={{
              position: "absolute",
              inset: 0,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: "var(--text-muted)",
              fontSize: 13,
              padding: 16,
              textAlign: "center",
            }}
          >
            Your browser doesn&apos;t support 3D viewing.
          </div>
        )}
        {webGlOk && renderable.length === 0 && (
          <div
            data-testid="bim-model-viewport-empty"
            style={{
              position: "absolute",
              inset: 0,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: "var(--text-muted)",
              fontSize: 13,
              padding: 16,
              textAlign: "center",
              pointerEvents: "none",
            }}
          >
            No renderable geometry yet — the briefing engine has not
            produced inline rings or converted DXFs for this model.
            The element list below still highlights the matched row.
          </div>
        )}
        {selected && !selectedRenderable && (
          <div
            data-testid="bim-model-viewport-no-geometry"
            style={{
              position: "absolute",
              left: 8,
              bottom: 8,
              right: 8,
              background: "var(--warning-dim)",
              color: "var(--warning-text)",
              border: "1px solid var(--warning-text)",
              borderRadius: 4,
              padding: "6px 8px",
              fontSize: 11,
              lineHeight: 1.35,
            }}
          >
            <strong style={{ fontWeight: 600 }}>
              {selected.label ?? selected.id}
            </strong>{" "}
            has no renderable geometry yet — see the highlighted row
            below.
          </div>
        )}
        {selectedRenderable?.source === "glb" &&
          selectedRenderable.glbKey &&
          glbState[selectedRenderable.glbKey]?.status === "loading" && (
            <div
              data-testid="bim-model-viewport-glb-loading"
              style={{
                position: "absolute",
                left: 8,
                bottom: 8,
                right: 8,
                background: "var(--bg-elevated)",
                color: "var(--text-muted)",
                border: "1px solid var(--border-default)",
                borderRadius: 4,
                padding: "6px 8px",
                fontSize: 11,
              }}
            >
              Loading 3D mesh…
            </div>
          )}
        {selectedRenderable?.source === "glb" &&
          selectedRenderable.glbKey &&
          glbState[selectedRenderable.glbKey]?.status === "error" && (
            <div
              data-testid="bim-model-viewport-glb-error"
              style={{
                position: "absolute",
                left: 8,
                bottom: 8,
                right: 8,
                background: "var(--danger-dim)",
                color: "var(--danger-text)",
                border: "1px solid var(--danger-text)",
                borderRadius: 4,
                padding: "6px 8px",
                fontSize: 11,
              }}
            >
              Couldn&apos;t load the 3D mesh for{" "}
              <strong>{selectedRenderable.element.label ?? selectedRenderable.element.id}</strong>
              . The element list still highlights its row below.
            </div>
          )}
        {/*
          Track C — IFC entity-type legend. Sits in the bottom-right
          corner when the engagement has a parsed IFC bundle so the
          reviewer can see what's loaded ("47 IfcWall · 8 IfcSpace
          · 12 IfcDoor"). Bottom-right keeps top-left (gesture hint)
          and top-right (Reset view) reserved for the existing
          affordances. Only renders when the bundle is present AND
          there's at least one per-entity row to count — an empty IFC
          would otherwise float a "0 entities" pill on top of the
          scene.
        */}
        {webGlOk && ifcBundle && ifcEntityCounts.length > 0 && (
          <div
            data-testid="bim-model-viewport-ifc-legend"
            style={{
              position: "absolute",
              right: 8,
              bottom: 8,
              maxWidth: "55%",
              background: "var(--bg-elevated)",
              color: "var(--text-muted)",
              border: "1px solid var(--border-default)",
              borderRadius: 4,
              padding: "4px 8px",
              fontSize: 11,
              lineHeight: 1.35,
              opacity: 0.92,
              pointerEvents: "none",
              zIndex: 2,
            }}
          >
            {ifcEntityCounts
              .map(([type, count]) => `${count} ${type}`)
              .join(" · ")}
          </div>
        )}
      </div>
      {/*
        Track C — IFC element-detail panel. Sits below the canvas
        rather than on top so the reviewer can read the JSON dump
        without obscuring the geometry. Phase 1: ifcGlobalId, ifcType,
        and the property_set jsonb. Phase 2 will replace the JSON
        dump with a typed "show me where" affordance.
      */}
      {selectedIfc && (
        <div
          data-testid="bim-model-viewport-ifc-detail"
          data-ifc-detail-element-id={selectedIfc.id}
          style={{
            border: "1px solid var(--border-default)",
            borderRadius: 4,
            padding: "8px 10px",
            background: "var(--bg-input)",
            fontSize: 12,
            lineHeight: 1.4,
            display: "flex",
            flexDirection: "column",
            gap: 4,
          }}
        >
          <div
            style={{
              display: "flex",
              gap: 8,
              alignItems: "baseline",
              justifyContent: "space-between",
            }}
          >
            <span style={{ fontWeight: 600 }}>
              {selectedIfc.sourceKind === "as-built-ifc-bundle"
                ? "IFC Bundle"
                : selectedIfc.ifcType ?? "IFC entity"}
            </span>
            <span
              style={{
                fontVariantNumeric: "tabular-nums",
                color: "var(--text-muted)",
              }}
            >
              {selectedIfc.ifcGlobalId ?? "<no GUID>"}
            </span>
          </div>
          {selectedIfc.label !== null && selectedIfc.label !== "" && (
            <div data-testid="bim-model-viewport-ifc-detail-label">
              <strong style={{ fontWeight: 500 }}>Label:</strong>{" "}
              {selectedIfc.label}
            </div>
          )}
          <div data-testid="bim-model-viewport-ifc-detail-pset">
            <strong style={{ fontWeight: 500 }}>Pset:</strong>{" "}
            {selectedIfc.propertySet
              ? Object.keys(selectedIfc.propertySet).length === 0
                ? "—"
                : null
              : "—"}
            {selectedIfc.propertySet &&
              Object.keys(selectedIfc.propertySet).length > 0 && (
                <pre
                  style={{
                    margin: "4px 0 0",
                    padding: 6,
                    background: "var(--bg-elevated)",
                    border: "1px solid var(--border-default)",
                    borderRadius: 3,
                    fontSize: 11,
                    overflow: "auto",
                    maxHeight: 160,
                    whiteSpace: "pre-wrap",
                    wordBreak: "break-word",
                  }}
                >
                  {JSON.stringify(selectedIfc.propertySet, null, 2)}
                </pre>
              )}
          </div>
        </div>
      )}
    </div>
  );
}
