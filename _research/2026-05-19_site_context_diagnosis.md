---
id: 2026-05-19_site_context_diagnosis
title: Diagnosis — Site Context 3D sub-tab blank on Musgrave_A
date: 2026-05-19
agent: cc-agent-C
repo: legacy-design-tools
kind: diagnosis
related: [_dispatches/2026-05-19_cc-agent-C_quick_wins_and_schema (C.1.6)]
---

# Site Context 3D sub-tab blank — diagnosis

## TL;DR

**Revised after the second screenshot (DevTools open).** Two distinct issues, only one of which is what the dispatch framed:

1. **The 3D Site Context tab is working as designed.** The empty-state placeholder ("No 3D geometry yet. Upload a DXF…") **does** render on Musgrave_A — visible in the second screenshot, just low-contrast gray-on-dark against a much larger dark canvas. The "blank" perception was an *information-density* problem (placeholder reads as nothing because it's small/muted), not a render bug. Fix surface: cosmetic (~5 LoC) at most, OR rework the copy to direct the operator to "Run Generate Layers" (~30 LoC).

2. **Real, separate finding**: the DevTools Console shows **46+ errors**, all auth/authorization failures:
   - `/api/me/notifications` → **401 Unauthorized**, repeating every 5s (the inbox-polling from `AppShell.tsx:39-44`).
   - `/api/engagements/{id}/bim-model` → **403 Forbidden**, repeating (the BIM-model fetch that backs the 3D viewer's "Show building" toggle).

   The 401 vs 403 distinction: the session IS valid (the federal-banner + parcel-briefing fetches work), but one route 401s and another 403s. Suggests two separate auth-gating regressions, not a global session breakage.

The bug is **not** in the ingestion pipeline (federal adapters, 3DEP, DXF→GLB conversion). Map view works; federal banner renders; parcel-briefing section renders. The 3D viewer mounts and shows the empty-state placeholder + the "Show building" toggle.

Fix surface estimate: depends on which surface (1 or 2) the operator wants C.1.6 to address. Either ~5-30 LoC (cosmetic / UX) or a Lane A bridge to investigate the auth/authz routes.

## Observed state (from operator screenshots, 2026-05-19)

Engagement: **Musgrave_A** (`e03b3520-ccc9-43fe-aac2-f5f7910f71ca`), jurisdiction Bastrop, TX.

- Federal-eligibility banner renders: `"Federal layers will load — state/local pending"` (correct for an in-pilot federal-only branch with no run yet).
- Map view: Leaflet renders, parcel pin visible at Musgrave Creek.
- 3D view: visibly blank below the `Map view | 3D view` toggle. No terrain, no placeholder text, no error.
- Below the viewer: `"No briefing sources yet. Upload a QGIS export…"` — confirms `sources = []`.
- "Site briefing (A–G)" section: `"Synthesized by the briefing engine from the 0 cited sources above."` — confirms briefing has not been generated.
- No error strings on the page (neither `"Site Context failed to load: …"` nor `"Failed to load briefing sources."`).

## Code path

The 3D sub-tab content renders [`<SiteContextViewer />`](../lib/portal-ui/src/components/SiteContextViewer.tsx) at [EngagementDetail.tsx:2961-2978](../artifacts/design-tools/src/pages/EngagementDetail.tsx#L2961-L2978) with `sources` passed through from `briefingQuery.data?.sources ?? []`.

Inside SiteContextViewer:
- [Line 344-355](../lib/portal-ui/src/components/SiteContextViewer.tsx#L344-L355): `readySources = sources.filter(s => s.conversionStatus === "ready" && s.glbObjectPath)`.
- For `sources = []` → `readySources = []`.
- [Line 787-806](../lib/portal-ui/src/components/SiteContextViewer.tsx#L787-L806): `{webGlOk && readySources.length === 0 && <div data-testid="site-context-viewer-empty">No 3D geometry yet. Upload a DXF…</div>}` — the empty-state placeholder.
- [Line 757-768](../lib/portal-ui/src/components/SiteContextViewer.tsx#L757-L768): the container has `minHeight: 320, position: relative` — placeholder is absolutely-positioned inside.

For Musgrave_A's observed state (`sources = []`, WebGL presumably OK in Chrome), the placeholder SHOULD render. The operator sees nothing.

## Hypothesis ranking

### H1 (most likely): Empty-state placeholder text is invisible due to color contrast

[`SiteContextViewer.tsx:796`](../lib/portal-ui/src/components/SiteContextViewer.tsx#L796) styles the placeholder with `color: "var(--text-muted)"`. On the current dark theme, `--text-muted` may be too close to the container background (or the absolutely-positioned div may sit on a transparent canvas over the dark page bg). The DOM node likely exists; it just isn't visible.

**Disambiguation**: in the running browser, open DevTools → inspect the area below the `Map view | 3D view` toggle → look for `[data-testid="site-context-viewer-empty"]`. If present, it's a CSS contrast bug. If absent, it's H2 or H3.

### H2: WebGL detection failing → `webGlOk === false` and neither block renders

[`SiteContextViewer.tsx:274-283`](../lib/portal-ui/src/components/SiteContextViewer.tsx#L274-L283) `detectWebGl()` calls `canvas.getContext('webgl2') ?? canvas.getContext('webgl')`. In normal Chrome this returns truthy, but a corrupted GPU profile or hardware-accel-disabled flag could make it null.

If `webGlOk === false`, the WebGL-fallback message ("Your browser doesn't support 3D viewing.") at [line 769-786](../lib/portal-ui/src/components/SiteContextViewer.tsx#L769-L786) should show. If THAT'S not visible either, it's the same color-contrast bug (H1).

**Disambiguation**: in the running browser, run `document.querySelector('canvas')?.getContext('webgl2')` from DevTools → returns a WebGL2RenderingContext if WebGL is fine.

### H3: SiteContextViewer crashed silently during mount

If a Three.js initializer threw (e.g. `new THREE.WebGLRenderer` failure caught at [line 363-365](../lib/portal-ui/src/components/SiteContextViewer.tsx#L361-L365) and silently swallowed), the effect-side scene setup wouldn't run, but the JSX should still render the placeholder. **Unlikely.**

C.1.4's ErrorBoundary (PR #32, now in main) would catch *render*-time exceptions and show its recovery card — so "blank" rules out render-throw. *Effect*-time errors don't trigger ErrorBoundary, but those wouldn't blank the JSX either.

### H4: Container has zero effective height

The 3D sub-tab wrapper at [EngagementDetail.tsx:2962-2968](../artifacts/design-tools/src/pages/EngagementDetail.tsx#L2962-L2968) is `display: flex, flexDirection: column, minHeight: 320, flex: 1`. The SiteContextViewer's outer div is `flex: 1, minHeight: 0`. If the parent's effective height is 0 and `minHeight: 320` is overridden somewhere, the canvas + placeholder both collapse.

**Disambiguation**: DevTools → inspect `[data-testid="site-context-viewer"]` → its computed height. Should be ≥ 320px.

## What's NOT the cause (ruled out by observed state)

- **Briefing GET route failure**: would render `"Failed to load briefing sources."` (not seen).
- **Briefing-generation job failure**: would render `"Site Context failed to load: …"` (not seen).
- **Auto-fire briefing regression (PR `30dfad4`)**: same as above — would surface as briefingJobError.
- **Federal adapter regression (PL-04 / PR `66a8b11`)**: would surface only after a Generate Layers click. The operator hasn't clicked it (banner says "will load").
- **DXF-to-GLB conversion failure**: applies only when DXFs are uploaded. Musgrave has zero sources.
- **3DEP elevation ingest failure**: applies only after Generate Layers triggers federal adapters. Hasn't run yet.
- **`@workspace/site-context` (Leaflet `SiteMap`) regression**: the Map view works.

## Fix-surface options

### Option A (smallest, ~5 LoC): Fix the empty-state CSS

Tighten the placeholder styling — bump color contrast (`var(--text-primary)` for the headline + `var(--text-muted)` for the supporting line), add a subtle background panel so the text doesn't sit on a transparent canvas. Verify in dark mode.

### Option B (~30 LoC): Make the empty-state operator-actionable

Current placeholder text: "No 3D geometry yet. Upload a DXF (terrain, property line, buildable envelope, …) to populate the scene."

This is wrong for a federal-pilot jurisdiction (Bastrop, TX). The operator doesn't *need* to upload a DXF — running Generate Layers will fetch federal terrain from 3DEP. Better:

> No 3D geometry yet. Click **Generate Layers** to fetch federal terrain (3DEP), or upload a DXF overlay manually.

…with a small CTA button that scrolls to the Generate Layers control. Surface the message regardless of `webGlOk` so a WebGL-disabled browser also gets it.

### Option C (larger): Bridge to Lane A

If diagnosis reveals the actual bug is in the federal-adapter pipeline (Generate Layers run produces no GLB sources for Bastrop), this stops being a UI fix and routes to cc-agent-E for an engine-side investigation. Not C.1.6 scope per the dispatch's own escape hatch.

## Recommended next step

Before writing any fix code, **one runtime check from the operator**:

> In the running browser on the broken 3D view, open DevTools → Elements panel → search the DOM for `data-testid="site-context-viewer-empty"`.
>
> - If the element exists → CSS contrast bug. Apply Option A (~5 LoC).
> - If the element doesn't exist → run `document.querySelector('canvas')?.getContext('webgl2')`:
>   - Returns a WebGL2RenderingContext → conditions wrong; needs deeper trace.
>   - Returns null → WebGL detection failing; either fix detection or fallback-render unconditionally.

Once the answer is in hand, the fix is small enough to land as part of this dispatch.

## Out-of-scope follow-ons

- **Empty-state copy review across all federal-pilot vs non-pilot variants**: probably worth a small follow-up to align the placeholder messaging with each branch's actual operator next-step.
- **"Generate Layers wasn't auto-fired for Musgrave_A"**: if you'd expect it to have fired by now (per `30dfad4`), worth checking that the auto-fire ran and what the job state is. Outside C.1.6's surface.

## Console-error addendum (from second screenshot, DevTools open)

Two distinct route-level auth failures are flooding the console:

### `/api/me/notifications` → 401

Polled every 5s by `AppShell.tsx:39-44` (inbox badge count). Returns 401 even though the session has access to other authenticated endpoints (federal banner, parcel briefing).

Hypotheses to investigate:
- Recent change tightened the audience/permission gate on this specific route (e.g. requires `notifications:read`).
- A CSRF or cookie attribute (SameSite, secure) is mis-set on the polled request specifically.
- The session middleware fail-closes for a particular path prefix the polling URL hits.

Search starting points: `routes/notifications*.ts`, `lib/audienceGuards`, recent commits touching `/api/me/*`.

### `/api/engagements/{id}/bim-model` → 403

The BIM-model fetch for the "Show building" 3D overlay. 403 = authenticated but not authorized. Either:
- The engagement's `bim_models` row doesn't exist yet and the route 403s instead of 404s on missing (likely a misconfigured route).
- The operator's audience lacks a permission the route now requires.
- A new auth check added recently for this route (check git log on `routes/bimModels.ts`).

Search starting points: `routes/bimModels.ts` GET handlers, recent commits touching it (PR #28 / DA-BIM-Symmetry, PR #29 / array-order regression, PR #33 / C.1.5 — though C.1.5 only added `isNull(supersededAt)` filter and shouldn't have changed auth).

These are NOT C.1.6's original scope (Site Context tab break). Routing them to a follow-on dispatch (or to cc-agent-E if engine-side) is the recommended path unless the operator wants them folded into the same fix surface.
