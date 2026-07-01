import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type { PrecedenceResultWire } from "../types";

type CodeContextValue = {
  jurisdictionKey: string | null;
  atomChainResults: unknown[];
  precedenceResult: PrecedenceResultWire[] | null;
  setJurisdictionKey: (key: string | null) => void;
  setAtomChainResults: (results: unknown[]) => void;
  setPrecedenceResult: (result: PrecedenceResultWire[] | null) => void;
};

const CodeContext = createContext<CodeContextValue | null>(null);

export function CodeProvider({ children }: { children: ReactNode }) {
  const [jurisdictionKey, setJurisdictionKey] = useState<string | null>(null);
  const [atomChainResults, setAtomChainResults] = useState<unknown[]>([]);
  const [precedenceResult, setPrecedenceResult] = useState<
    PrecedenceResultWire[] | null
  >(null);

  const value = useMemo(
    () => ({
      jurisdictionKey,
      atomChainResults,
      precedenceResult,
      setJurisdictionKey,
      setAtomChainResults,
      setPrecedenceResult,
    }),
    [jurisdictionKey, atomChainResults, precedenceResult],
  );

  return (
    <CodeContext.Provider value={value}>{children}</CodeContext.Provider>
  );
}

export function useCode(): CodeContextValue {
  const ctx = useContext(CodeContext);
  if (!ctx) {
    throw new Error("useCode must be used within CodeProvider");
  }
  return ctx;
}
