import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

type RequestPageCallback = (page: number, findingId?: string) => void;

type DocumentViewerNavigationValue = {
  // event bus: ComplianceRunTile calls requestPage; DocumentViewerTile subscribes
  requestPage: (page: number, findingId?: string) => void;
  onRequestPage: (cb: RequestPageCallback) => () => void; // returns unsubscribe
  // finding->page map, published by the viewer (source of truth for annotation pages)
  findingPages: Record<string, number>;
  publishFindingPages: (map: Record<string, number>) => void;
};

const DocumentViewerNavigationContext =
  createContext<DocumentViewerNavigationValue | null>(null);

export function DocumentViewerNavigationProvider({
  children,
}: {
  children: ReactNode;
}) {
  const subscribersRef = useRef<Set<RequestPageCallback>>(new Set());
  const [findingPages, setFindingPages] = useState<Record<string, number>>({});

  const requestPage = useCallback((page: number, findingId?: string) => {
    for (const cb of subscribersRef.current) {
      cb(page, findingId);
    }
  }, []);

  const onRequestPage = useCallback((cb: RequestPageCallback) => {
    subscribersRef.current.add(cb);
    return () => {
      subscribersRef.current.delete(cb);
    };
  }, []);

  const publishFindingPages = useCallback((map: Record<string, number>) => {
    setFindingPages(map);
  }, []);

  const value = useMemo(
    () => ({
      requestPage,
      onRequestPage,
      findingPages,
      publishFindingPages,
    }),
    [requestPage, onRequestPage, findingPages, publishFindingPages],
  );

  return (
    <DocumentViewerNavigationContext.Provider value={value}>
      {children}
    </DocumentViewerNavigationContext.Provider>
  );
}

export function useDocumentViewerNavigation(): DocumentViewerNavigationValue {
  const ctx = useContext(DocumentViewerNavigationContext);
  if (!ctx) {
    throw new Error(
      "useDocumentViewerNavigation must be used within DocumentViewerNavigationProvider",
    );
  }
  return ctx;
}
