import { useEffect, useMemo, useState } from "react";
import {
  CortexShell,
  type ActiveParcel,
  type InitialSpaceSeed,
  type SpaceSnapshot,
} from "@empressaio/tile-shell";
import { useCortexClient } from "@empressaio/cortex-tiles";
import { getTile, ALL_TILES, TILE_CATEGORIES } from "./tiles";
import { PRESET_SPACES } from "./presets";
import { fetchAdminFunctions, exportEngagementPdf } from "../lib/planReviewBff";
import { createSavedSpacesApi } from "../lib/workspaceSpaces";

/**
 * Read the deep-link space params off the current URL.
 *
 * `?share=<token>` opens a shared space by its unguessable share token (the
 * server route is deliberately owner-agnostic); `?space=<name>` opens one of the
 * caller's own saved spaces by name. `share` wins if both are present. Returns
 * null when neither param is set (default mount, unchanged).
 */
function readDeepLinkParams(): { share?: string; space?: string } | null {
  if (typeof window === "undefined") return null;
  const params = new URLSearchParams(window.location.search);
  const share = params.get("share")?.trim() || undefined;
  const space = params.get("space")?.trim() || undefined;
  if (!share && !space) return null;
  return { share, space };
}

/**
 * App-level wrapper that injects the still-app-resident tile registry,
 * presets, admin-functions client, saved-space persistence (server-backed via
 * the BFF, localStorage fast-path), and the header address search into the
 * package-level CortexShell. Keeps @empressaio/tile-shell free of any app-lib
 * dependency (the registry + BFF client stay in the app per the dispatch).
 *
 * Deep-link consumer: on load it reads a `?share=<token>` / `?space=<name>` URL
 * param and, when present, resolves the shared/named space through the BFF
 * (`GET /plan-review/spaces/shared/:token` or `.../spaces/by-name/:name`) and
 * seeds the workspace on that space (tiles + layout + pinned parcel context)
 * instead of the default preset. No param → default behavior is unchanged.
 */
export default function AppCortexShell({
  initialPresetId = "plan-review",
}: {
  initialPresetId?: string;
}) {
  const client = useCortexClient();
  const savedSpaces = useMemo(() => createSavedSpacesApi(client), [client]);

  // Deep-link seed resolution. `pending` while we resolve a param so we don't
  // flash the default preset then swap; `null` seed means default mount.
  const [deepLink] = useState(readDeepLinkParams);
  const [seed, setSeed] = useState<InitialSpaceSeed | null>(null);
  const [seedPending, setSeedPending] = useState<boolean>(() => deepLink != null);

  useEffect(() => {
    if (!deepLink) return;
    let cancelled = false;
    void (async () => {
      try {
        if (deepLink.share) {
          const rec = await client.loadSharedSpace(deepLink.share);
          if (!cancelled && rec) {
            setSeed({
              label: rec.name,
              snapshot: rec.snapshot as SpaceSnapshot,
            });
          }
        } else if (deepLink.space) {
          const rec = await client.loadSavedSpace(deepLink.space);
          if (!cancelled && rec) {
            setSeed({
              label: rec.name,
              snapshot: rec.snapshot as SpaceSnapshot,
            });
          }
        }
      } catch {
        // A bad/expired token or a missing space falls through to the default
        // preset rather than blocking the workspace.
      } finally {
        if (!cancelled) setSeedPending(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client, deepLink]);

  // Geocode a free-text query to a parcel for the shared active-parcel context.
  // A bare address search scopes the parcel (apn / lat / lng / jurisdiction)
  // WITHOUT auto-creating an engagement — a read gesture should not write.
  const geocodeToParcel = async (
    query: string,
  ): Promise<ActiveParcel | null> => {
    const g = await client.geocode({ address: query });
    return {
      engagementId: null,
      apn: g.apn,
      jurisdiction: g.jurisdiction,
      address: g.address ?? query,
      lat: g.lat,
      lng: g.lng,
    };
  };

  // The shell seeds its layout/context ONCE on mount, so hold the mount until a
  // deep-link param has resolved — otherwise we'd mount on the default preset and
  // a later seed would never take. A remount (keyed on resolution) is the clean
  // way to apply a resolved seed exactly once; the no-param path never waits.
  if (seedPending) return null;

  return (
    <CortexShell
      key={seed ? `seed:${seed.label ?? ""}` : "default"}
      initialPresetId={initialPresetId}
      initialSpaceSeed={seed}
      getTile={getTile}
      allTiles={ALL_TILES}
      categories={TILE_CATEGORIES}
      presets={PRESET_SPACES}
      fetchAdminFunctions={fetchAdminFunctions}
      savedSpaces={savedSpaces}
      onAddressSearch={geocodeToParcel}
      onAddressPreview={geocodeToParcel}
      onExportEngagement={async (engagementId) => {
        const { url } = await exportEngagementPdf(engagementId);
        const a = document.createElement("a");
        a.href = url;
        a.download = `review-${engagementId.slice(0, 8)}.pdf`;
        a.rel = "noopener";
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
      }}
    />
  );
}
