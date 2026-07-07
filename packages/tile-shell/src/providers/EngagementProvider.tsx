import {
  createContext,
  useCallback,
  useContext,
  useEffect,
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
  projectDid?: string | null;
  label?: string | null;
};

export type ActiveContext = ActiveParcel;

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
  contextEpoch: number;
};

const EngagementContext = createContext<EngagementContextValue | null>(null);

type EngagementProviderProps = {
  children: ReactNode;
  initialParcel?: Partial<ActiveParcel>;
  onActiveParcelChange?: (p: ActiveParcel) => void;
};

function EngagementProviderInner({
  children,
  initialParcel,
  onActiveParcelChange,
}: EngagementProviderProps) {
  const [engagementId, setEngagementId] = useState<string | null>(
    initialParcel?.engagementId ?? null,
  );
  const [engagement, setEngagementState] = useState<EngagementDetail | null>(
    null,
  );
  const [parcelOverride, setParcelOverride] = useState<ActiveParcel | null>(
    initialParcel
      ? {
          ...EMPTY_PARCEL,
          ...initialParcel,
        }
      : null,
  );
  const [loading, setLoading] = useState(false);
  const [queueRefreshToken, setQueueRefreshToken] = useState(0);
  const [contextEpoch, setContextEpoch] = useState(0);

  const bumpQueueRefresh = useCallback(() => {
    setQueueRefreshToken((t) => t + 1);
  }, []);

  const setEngagement = useCallback(
    (id: string | null, detail?: EngagementDetail | null) => {
      setEngagementId(id);
      setEngagementState(detail ?? null);
      setParcelOverride(null);
      setContextEpoch((e) => e + 1);
    },
    [],
  );

  const setActiveParcel = useCallback((parcel: Partial<ActiveParcel>) => {
    setParcelOverride((prev) => ({
      ...(prev ?? EMPTY_PARCEL),
      ...parcel,
    }));
    if (parcel.engagementId) {
      setEngagementId(parcel.engagementId);
    }
    setContextEpoch((e) => e + 1);
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

  const activeParcel = useMemo<ActiveParcel>(() => {
    const overrideHasCoords =
      parcelOverride != null &&
      parcelOverride.lat != null &&
      parcelOverride.lng != null;

    if (overrideHasCoords) {
      return {
        engagementId: engagement?.id ?? parcelOverride!.engagementId ?? engagementId,
        apn: parcelOverride!.apn ?? engagement?.apn ?? null,
        jurisdiction: parcelOverride!.jurisdiction ?? engagement?.jurisdiction ?? null,
        address: parcelOverride!.address ?? engagement?.address ?? null,
        lat: parcelOverride!.lat,
        lng: parcelOverride!.lng,
        projectDid: parcelOverride!.projectDid ?? null,
        label: parcelOverride!.label ?? null,
      };
    }

    if (engagement) {
      return {
        engagementId: engagement.id,
        apn: engagement.apn ?? parcelOverride?.apn ?? null,
        jurisdiction:
          engagement.jurisdiction ?? parcelOverride?.jurisdiction ?? null,
        address: engagement.address ?? parcelOverride?.address ?? null,
        lat: engagement.latitude ?? parcelOverride?.lat ?? null,
        lng: engagement.longitude ?? parcelOverride?.lng ?? null,
        projectDid: parcelOverride?.projectDid ?? null,
        label: parcelOverride?.label ?? null,
      };
    }
    if (parcelOverride) return parcelOverride;
    return { ...EMPTY_PARCEL, engagementId };
  }, [engagement, parcelOverride, engagementId]);

  useEffect(() => {
    if (onActiveParcelChange) {
      onActiveParcelChange(activeParcel);
    }
  }, [activeParcel, onActiveParcelChange]);

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
      contextEpoch,
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
      contextEpoch,
    ],
  );

  return (
    <EngagementContext.Provider value={value}>
      {children}
    </EngagementContext.Provider>
  );
}

/**
 * EngagementProvider: THE single shared active-parcel / engagement authority for
 * the workspace.
 *
 * Context adoption: if a parent EngagementProvider already exists, this provider
 * renders `children` directly against the parent's state WITHOUT creating a
 * second state layer. This defuses nested CortexShell mounts (e.g. a panel-mounted
 * shell inside a root provider) from shadowing the hoisted root context.
 *
 * New in 0.2.0:
 * - `initialParcel` seeds the initial state (merge over null defaults).
 * - `onActiveParcelChange` is called after every state commit with the new parcel.
 * - `contextEpoch` increments on every setEngagement / setActiveParcel commit;
 *   tiles use it to discard stale in-flight fetches after a context switch.
 */
export function EngagementProvider(props: EngagementProviderProps) {
  const parentContext = useContext(EngagementContext);

  if (parentContext) {
    return <>{props.children}</>;
  }

  return <EngagementProviderInner {...props} />;
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
