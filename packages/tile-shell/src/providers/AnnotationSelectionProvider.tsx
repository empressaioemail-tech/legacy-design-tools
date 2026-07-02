import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";

type AnnotationSelectionContextValue = {
  selectedFindingId: string | null;
  selectAnnotation: (findingId: string | null) => void;
};

const AnnotationSelectionContext =
  createContext<AnnotationSelectionContextValue | null>(null);

export function AnnotationSelectionProvider({
  children,
}: {
  children: ReactNode;
}) {
  const [selectedFindingId, setSelectedFindingId] = useState<string | null>(
    null,
  );

  const selectAnnotation = useCallback((findingId: string | null) => {
    setSelectedFindingId(findingId);
  }, []);

  const value = useMemo(
    () => ({ selectedFindingId, selectAnnotation }),
    [selectedFindingId, selectAnnotation],
  );

  return (
    <AnnotationSelectionContext.Provider value={value}>
      {children}
    </AnnotationSelectionContext.Provider>
  );
}

export function useAnnotationSelection(): AnnotationSelectionContextValue {
  const ctx = useContext(AnnotationSelectionContext);
  if (!ctx) {
    throw new Error(
      "useAnnotationSelection must be used within AnnotationSelectionProvider",
    );
  }
  return ctx;
}
