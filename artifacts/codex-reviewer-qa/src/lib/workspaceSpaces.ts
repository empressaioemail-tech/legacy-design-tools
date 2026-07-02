import type { CortexClient } from "@hauska/cortex-client";
import type { SavedSpacesApi, SpaceSnapshot } from "@hauska/tile-shell";

export type { SpaceSnapshot };

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

// ─── localStorage fast-path cache ──────────────────────────────────
// The server (BFF `saved_workspace_spaces`, tenant-ready) is the source of
// truth; localStorage is a same-browser cache so the SpaceBar paints saved
// spaces instantly on load and a save/delete is reflected without waiting on a
// round-trip. The cache is best-effort — a server read always reconciles it.

function readCache(): Record<string, SpaceSnapshot> {
  try {
    const raw = localStorage.getItem(WORKSPACE_SPACES_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, SpaceSnapshot>;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function writeCache(map: Record<string, SpaceSnapshot>): void {
  try {
    localStorage.setItem(WORKSPACE_SPACES_STORAGE_KEY, JSON.stringify(map));
  } catch {
    /* cache is best-effort */
  }
}

function cachePut(name: string, snap: SpaceSnapshot): void {
  const m = readCache();
  m[name] = snap;
  writeCache(m);
}

function cacheDelete(name: string): void {
  const m = readCache();
  delete m[name];
  writeCache(m);
}

/**
 * Build the server-backed SavedSpacesApi the CortexShell consumes. Server is
 * authoritative; localStorage is a fast-path cache. On a server failure the
 * cache still answers so the workspace degrades gracefully offline.
 */
export function createSavedSpacesApi(client: CortexClient): SavedSpacesApi {
  return {
    savedSpaceId,
    isSavedSpaceId,
    savedSpaceName,

    async listSavedSpaceEntries() {
      try {
        const rows = await client.listSavedSpaces();
        return rows.map((r) => ({ id: savedSpaceId(r.name), label: r.name }));
      } catch {
        // Fall back to the cache so the SpaceBar still shows known spaces.
        return Object.keys(readCache())
          .sort((a, b) => a.localeCompare(b))
          .map((name) => ({ id: savedSpaceId(name), label: name }));
      }
    },

    async loadSavedSpace(name) {
      try {
        const rec = await client.loadSavedSpace(name);
        if (rec) {
          const snap = rec.snapshot as SpaceSnapshot;
          cachePut(name, snap);
          return snap;
        }
        return readCache()[name] ?? null;
      } catch {
        return readCache()[name] ?? null;
      }
    },

    async saveCurrentSpace(name, state) {
      const trimmed = name.trim();
      if (!trimmed) return;
      // Write-through: cache first (instant), then persist to the server.
      cachePut(trimmed, state);
      await client.saveSpace(trimmed, state);
    },

    async deleteSavedSpace(name) {
      const trimmed = name.trim();
      if (!trimmed) return;
      cacheDelete(trimmed);
      await client.deleteSpace(trimmed);
    },
  };
}
