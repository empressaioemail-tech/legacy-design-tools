import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type { OverlaySpec } from "../types";

type SpatialContextValue = {
  overlays: OverlaySpec[];
  pushOverlay: (spec: OverlaySpec) => void;
  clearOverlays: () => void;
};

const SpatialContext = createContext<SpatialContextValue | null>(null);

export function SpatialProvider({ children }: { children: ReactNode }) {
  const [overlays, setOverlays] = useState<OverlaySpec[]>([]);

  const pushOverlay = useCallback((spec: OverlaySpec) => {
    setOverlays((prev) => {
      const without = prev.filter((o) => o.id !== spec.id);
      return [...without, spec];
    });
  }, []);

  const clearOverlays = useCallback(() => setOverlays([]), []);

  const value = useMemo(
    () => ({ overlays, pushOverlay, clearOverlays }),
    [overlays, pushOverlay, clearOverlays],
  );

  return (
    <SpatialContext.Provider value={value}>{children}</SpatialContext.Provider>
  );
}

export function useSpatial(): SpatialContextValue {
  const ctx = useContext(SpatialContext);
  if (!ctx) {
    throw new Error("useSpatial must be used within SpatialProvider");
  }
  return ctx;
}
