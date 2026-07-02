import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type { EngagementDetail, EngagementReportResult } from "../types";

type EngagementContextValue = {
  engagementId: string | null;
  engagement: EngagementDetail | null;
  setEngagement: (id: string | null, detail?: EngagementDetail | null) => void;
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
  const [loading, setLoading] = useState(false);
  const [queueRefreshToken, setQueueRefreshToken] = useState(0);

  const bumpQueueRefresh = useCallback(() => {
    setQueueRefreshToken((t) => t + 1);
  }, []);

  const setEngagement = useCallback(
    (id: string | null, detail?: EngagementDetail | null) => {
      setEngagementId(id);
      setEngagementState(detail ?? null);
    },
    [],
  );

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

  const value = useMemo(
    () => ({
      engagementId,
      engagement,
      setEngagement,
      setEngagementReportResult,
      loading,
      setLoading,
      queueRefreshToken,
      bumpQueueRefresh,
    }),
    [
      engagementId,
      engagement,
      setEngagement,
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
