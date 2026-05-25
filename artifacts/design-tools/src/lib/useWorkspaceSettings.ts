import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import {
  fetchWorkspaceSettings,
  type WorkspaceSettingsWire,
} from "./workspaceSettingsApi";
import { applyWorkspaceAccent } from "./workspaceBranding";

export const WORKSPACE_SETTINGS_QUERY_KEY = ["workspace-settings"] as const;

export function useWorkspaceSettings() {
  return useQuery({
    queryKey: WORKSPACE_SETTINGS_QUERY_KEY,
    queryFn: fetchWorkspaceSettings,
    staleTime: 60_000,
  });
}

/** Applies persisted accent to document root when settings load or change. */
export function useApplyWorkspaceAccent(settings: WorkspaceSettingsWire | undefined) {
  useEffect(() => {
    applyWorkspaceAccent(settings?.primaryColor ?? null);
  }, [settings?.primaryColor]);
}

export function useInvalidateWorkspaceSettings() {
  const qc = useQueryClient();
  return () =>
    void qc.invalidateQueries({ queryKey: WORKSPACE_SETTINGS_QUERY_KEY });
}
