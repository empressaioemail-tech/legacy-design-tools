export type SpaceSnapshot = {
  tileIds: string[];
  layoutId: string;
  colFr: number[];
  rowFr: number[];
};

export const WORKSPACE_SPACES_STORAGE_KEY = "cortex-workspace-spaces";

export function savedSpaceId(name: string): string {
  return `saved:${name}`;
}

export function isSavedSpaceId(id: string): boolean {
  return id.startsWith("saved:");
}

export function savedSpaceName(id: string): string {
  return id.slice("saved:".length);
}

export function loadSavedSpaces(): Record<string, SpaceSnapshot> {
  try {
    const raw = localStorage.getItem(WORKSPACE_SPACES_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, SpaceSnapshot>;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export function saveCurrentSpace(name: string, state: SpaceSnapshot): void {
  const trimmed = name.trim();
  if (!trimmed) return;
  const existing = loadSavedSpaces();
  existing[trimmed] = state;
  localStorage.setItem(
    WORKSPACE_SPACES_STORAGE_KEY,
    JSON.stringify(existing),
  );
}

export function listSavedSpaceEntries(): Array<{ id: string; label: string }> {
  return Object.keys(loadSavedSpaces())
    .sort((a, b) => a.localeCompare(b))
    .map((name) => ({ id: savedSpaceId(name), label: name }));
}

export function deleteSavedSpace(name: string): void {
  const trimmed = name.trim();
  if (!trimmed) return;
  const existing = loadSavedSpaces();
  delete existing[trimmed];
  localStorage.setItem(
    WORKSPACE_SPACES_STORAGE_KEY,
    JSON.stringify(existing),
  );
}
