const API_BASE = import.meta.env.VITE_API_BASE_URL ?? "/api";

export interface WorkspaceSettingsWire {
  id: string;
  firmDisplayName: string;
  logoUrl: string | null;
  updatedAt: string;
}

export async function fetchWorkspaceSettings(): Promise<WorkspaceSettingsWire> {
  const res = await fetch(`${API_BASE}/workspace/settings`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as WorkspaceSettingsWire;
}

export async function patchWorkspaceSettings(patch: {
  firmDisplayName?: string;
  logoUrl?: string | null;
}): Promise<WorkspaceSettingsWire> {
  const res = await fetch(`${API_BASE}/workspace/settings`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as WorkspaceSettingsWire;
}
