import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type { EngagementDetail, EngagementReportResult } from "../types";

/**
 * The single shared active-parcel identity read by every address-scoped tile.
 *
 * There is ONE authority for "what property is the workspace looking at" and it
 * lives here, on the engagement context. Tiles must NOT hold their own apn /
 * lat / lng / jurisdiction — they read `activeParcel` (or the `engagement`) from
 * this provider. The three setters (intake-queue row-click, the top-bar address
 * search, and map-click) all route through `setEngagement` / `setActiveParcel`
 * so the map, the property brief, the hazard profile, setbacks, encumbrances,
 * and every other address-scoped surface react to the same selection.
 */
export type ActiveParcel = {
  engagementId: string | null;
  apn: string | null;
  jurisdiction: string | null;
  address: string | null;
  lat: number | null;
  lng: number | null;
};

const EMPTY_PARCEL: ActiveParcel = {
  engagementId: null,
  apn: null,
  jurisdiction: null,
  address: null,
  lat: null,
  lng: null,
};

type EngagementContextValue = {
  engagementId: string | null;
  engagement: EngagementDetail | null;
  /**
   * The unified active-parcel identity, derived from the current engagement and
   * layered with any parcel-only selection (address search / map-click that has
   * no engagement yet). This is the field address-scoped tiles read.
   */
  activeParcel: ActiveParcel;
  setEngagement: (id: string | null, detail?: EngagementDetail | null) => void;
  /**
   * Set the active parcel WITHOUT (necessarily) a full engagement — used by the
   * address-search box and by map-click. Passing an engagementId here scopes the
   * parcel to that engagement; omitting it sets an engagement-less parcel that
   * apn/jurisdiction-scoped tiles can still key on. Setting a parcel that
   * matches the current engagement leaves the engagement selection intact.
   */
  setActiveParcel: (parcel: Partial<ActiveParcel>) => void;
  setEngagementReportResult: (
    type: string,
    result: EngagementReportResult,
  ) => void;
  loading: boolean;
  setLoading: (v: boolean) => void;
  queueRefreshToken: number;
  bumpQueueRefresh: () => void;
};

const EngagementContext = createContext<EngagementContextValue | null>(null);

export function EngagementProvider({ children }: { children: ReactNode }) {
  const [engagementId, setEngagementId] = useState<string | null>(null);
  const [engagement, setEngagementState] = useState<EngagementDetail | null>(
    null,
  );
  // A parcel selection that is NOT (yet) backed by a loaded engagement — set by
  // the address-search box or a map-click on a parcel with no engagement.
  // Cleared whenever a real engagement is selected so the engagement is the
  // authority when one exists.
  const [parcelOverride, setParcelOverride] = useState<ActiveParcel | null>(
    null,
  );
  const [loading, setLoading] = useState(false);
  const [queueRefreshToken, setQueueRefreshToken] = useState(0);

  const bumpQueueRefresh = useCallback(() => {
    setQueueRefreshToken((t) => t + 1);
  }, []);

  const setEngagement = useCallback(
    (id: string | null, detail?: EngagementDetail | null) => {
      setEngagementId(id);
      setEngagementState(detail ?? null);
      // A concrete engagement is now the authority; drop any parcel-only override.
      setParcelOverride(null);
    },
    [],
  );

  const setActiveParcel = useCallback((parcel: Partial<ActiveParcel>) => {
    setParcelOverride((prev) => ({
      ...(prev ?? EMPTY_PARCEL),
      ...parcel,
    }));
    // If the caller scoped the parcel to a specific engagement id, adopt it as
    // the active engagement id (detail is loaded separately by the caller).
    if (parcel.engagementId !== undefined) {
      setEngagementId(parcel.engagementId);
    }
  }, []);

  const setEngagementReportResult = useCallback(
    (type: string, result: EngagementReportResult) => {
      setEngagementState((prev: EngagementDetail | null) => {
        if (!prev) return prev;
        return {
          ...prev,
          reportResults: { ...prev.reportResults, [type]: result },
        };
      });
    },
    [],
  );

  // Derive the unified active parcel. The loaded engagement is the authority;
  // a parcel-only override fills fields the engagement does not carry (or drives
  // the whole thing when no engagement is loaded).
  const activeParcel = useMemo<ActiveParcel>(() => {
    if (engagement) {
      return {
        engagementId: engagement.id,
        apn: engagement.apn ?? parcelOverride?.apn ?? null,
        jurisdiction:
          engagement.jurisdiction ?? parcelOverride?.jurisdiction ?? null,
        address: engagement.address ?? parcelOverride?.address ?? null,
        lat: engagement.latitude ?? parcelOverride?.lat ?? null,
        lng: engagement.longitude ?? parcelOverride?.lng ?? null,
      };
    }
    if (parcelOverride) return parcelOverride;
    return { ...EMPTY_PARCEL, engagementId };
  }, [engagement, parcelOverride, engagementId]);

  const value = useMemo(
    () => ({
      engagementId,
      engagement,
      activeParcel,
      setEngagement,
      setActiveParcel,
      setEngagementReportResult,
      loading,
      setLoading,
      queueRefreshToken,
      bumpQueueRefresh,
    }),
    [
      engagementId,
      engagement,
      activeParcel,
      setEngagement,
      setActiveParcel,
      setEngagementReportResult,
      loading,
      queueRefreshToken,
      bumpQueueRefresh,
    ],
  );

  return (
    <EngagementContext.Provider value={value}>
      {children}
    </EngagementContext.Provider>
  );
}

export function useEngagement(): EngagementContextValue {
  const ctx = useContext(EngagementContext);
  if (!ctx) {
    throw new Error("useEngagement must be used within EngagementProvider");
  }
  return ctx;
}

/**
 * Convenience hook for address-scoped tiles: returns the single shared active
 * parcel. Equivalent to `useEngagement().activeParcel` — provided so tiles read
 * an obviously-shared surface rather than reaching for engagement internals.
 */
export function useActiveParcel(): ActiveParcel {
  return useEngagement().activeParcel;
}
