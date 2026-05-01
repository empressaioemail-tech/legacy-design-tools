import { useEffect, useState } from "react";
import type { EngagementBriefingSource } from "@workspace/api-client-react";

export function formatByteSize(bytes: number | null): string {
  if (bytes === null) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) {
    const kb = bytes / 1024;
    return `${kb.toFixed(kb < 10 ? 1 : 0)} KB`;
  }
  const mb = bytes / (1024 * 1024);
  return `${mb.toFixed(mb < 10 ? 1 : 0)} MB`;
}

export function formatCacheAgeLabel(cachedAt: string | null): string {
  if (!cachedAt) return "cached";
  const captured = Date.parse(cachedAt);
  if (Number.isNaN(captured)) return "cached";
  const diffMs = Date.now() - captured;
  if (diffMs < 60_000) return "cached just now";
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 60) return `cached ${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `cached ${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `cached ${days}d ago`;
}

export const CONVERSION_STATUS_STYLE: Record<
  "pending" | "converting" | "ready" | "failed" | "dxf-only",
  { label: string; bg: string; fg: string }
> = {
  pending: {
    label: "Conversion pending",
    bg: "var(--info-dim)",
    fg: "var(--info-text)",
  },
  converting: {
    label: "Converting…",
    bg: "var(--info-dim)",
    fg: "var(--info-text)",
  },
  ready: {
    label: "3D ready",
    bg: "var(--success-dim)",
    fg: "var(--success-text)",
  },
  failed: {
    label: "Conversion failed",
    bg: "var(--danger-dim)",
    fg: "var(--danger-text)",
  },
  "dxf-only": {
    label: "DXF only",
    bg: "var(--neutral-dim, var(--info-dim))",
    fg: "var(--text-muted)",
  },
};

export const SOURCE_KIND_BADGE_LABEL: Record<
  EngagementBriefingSource["sourceKind"],
  string
> = {
  "manual-upload": "Manual upload",
  "federal-adapter": "Federal adapter",
  "state-adapter": "State adapter",
  "local-adapter": "Local adapter",
};

export const BRIEFING_GENERATE_LAYERS_ACTOR_LABEL = "Generate Layers";

export function isAdapterSourceKind(
  kind: EngagementBriefingSource["sourceKind"],
): boolean {
  return (
    kind === "federal-adapter" ||
    kind === "state-adapter" ||
    kind === "local-adapter"
  );
}

const BRIEFING_DIFF_FIELDS = [
  "snapshotDate",
  "provider",
  "note",
  "sourceKind",
] as const satisfies readonly (keyof EngagementBriefingSource)[];

export function diffBriefingSourceFields(
  prior: EngagementBriefingSource,
  current: EngagementBriefingSource,
): readonly (typeof BRIEFING_DIFF_FIELDS)[number][] {
  return BRIEFING_DIFF_FIELDS.filter((f) => prior[f] !== current[f]);
}

export function formatBriefingDiffValue(
  field: (typeof BRIEFING_DIFF_FIELDS)[number],
  value: string | null,
): string {
  if (value === null) return "(none)";
  if (field === "snapshotDate") return value.slice(0, 10);
  return value;
}

export function extractAdapterKeyFromProvider(
  provider: string | null,
): string | null {
  if (!provider) return null;
  const tailStart = provider.indexOf(" (");
  if (tailStart <= 0) return null;
  if (!provider.endsWith(")")) return null;
  const key = provider.slice(0, tailStart).trim();
  if (!key.includes(":")) return null;
  return key;
}

export const BRIEFING_SOURCE_STALE_THRESHOLD_DAYS = 30;

export function computeBriefingSourceRange(
  rows: ReadonlyArray<{ createdAt: string }>,
): { oldest: string; newest: string } | null {
  if (rows.length === 0) return null;
  let oldest = rows[0]!.createdAt;
  let newest = rows[0]!.createdAt;
  for (let i = 1; i < rows.length; i += 1) {
    const c = rows[i]!.createdAt;
    if (c < oldest) oldest = c;
    if (c > newest) newest = c;
  }
  return { oldest, newest };
}

export function isBriefingSourceRangeStale(
  range: { oldest: string; newest: string } | null,
  now: number = Date.now(),
): boolean {
  if (range === null) return false;
  const newest = new Date(range.newest).getTime();
  if (Number.isNaN(newest)) return false;
  const ageMs = now - newest;
  return ageMs > BRIEFING_SOURCE_STALE_THRESHOLD_DAYS * 24 * 60 * 60 * 1000;
}

export function formatBriefingSourceRangeShort(
  oldestIso: string,
  newestIso: string,
): string | null {
  const oldest = new Date(oldestIso);
  const newest = new Date(newestIso);
  if (Number.isNaN(oldest.getTime()) || Number.isNaN(newest.getTime())) {
    return null;
  }
  const fmt = (d: Date) =>
    d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  const a = fmt(oldest);
  const b = fmt(newest);
  return a === b ? a : `${a} → ${b}`;
}

export function formatBriefingSourceRangeTitle(
  oldestIso: string,
  newestIso: string,
): string | undefined {
  const oldest = new Date(oldestIso);
  const newest = new Date(newestIso);
  if (Number.isNaN(oldest.getTime()) || Number.isNaN(newest.getTime())) {
    return undefined;
  }
  const fmt = (d: Date) =>
    d.toLocaleDateString(undefined, {
      month: "long",
      day: "numeric",
      year: "numeric",
    });
  const a = fmt(oldest);
  const b = fmt(newest);
  return a === b ? a : `oldest ${a} → newest ${b}`;
}

export const BRIEFING_SOURCE_HISTORY_TIER_STORAGE_PREFIX =
  "briefing-source-history-tier:";

export function briefingSourceHistoryTierStorageKey(engagementId: string) {
  return `${BRIEFING_SOURCE_HISTORY_TIER_STORAGE_PREFIX}${engagementId}`;
}

const BRIEFING_SOURCE_HISTORY_TIER_CHANGE_EVENT =
  "briefing-source-history-tier:change";

export function readBriefingSourceHistoryTier(
  storageKey: string,
): "all" | "adapter" | "manual" {
  if (typeof window === "undefined") return "all";
  try {
    const stored = window.localStorage.getItem(storageKey);
    if (stored === "all" || stored === "adapter" || stored === "manual") {
      return stored;
    }
  } catch {
    /* localStorage may throw in private mode / disabled storage */
  }
  return "all";
}

const briefingSourceHistoryTierSubscribers = new Map<
  string,
  Set<(value: "all" | "adapter" | "manual") => void>
>();

export function subscribeBriefingSourceHistoryTier(
  storageKey: string,
  listener: (value: "all" | "adapter" | "manual") => void,
): () => void {
  let listeners = briefingSourceHistoryTierSubscribers.get(storageKey);
  if (!listeners) {
    listeners = new Set();
    briefingSourceHistoryTierSubscribers.set(storageKey, listeners);
  }
  listeners.add(listener);
  return () => {
    const current = briefingSourceHistoryTierSubscribers.get(storageKey);
    if (!current) return;
    current.delete(listener);
    if (current.size === 0) {
      briefingSourceHistoryTierSubscribers.delete(storageKey);
    }
  };
}

export function writeBriefingSourceHistoryTier(
  storageKey: string,
  value: "all" | "adapter" | "manual",
) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(storageKey, value);
    window.dispatchEvent(
      new CustomEvent(BRIEFING_SOURCE_HISTORY_TIER_CHANGE_EVENT, {
        detail: storageKey,
      }),
    );
  } catch {
    /* ignore — falling back to in-memory state is acceptable */
  }
  const listeners = briefingSourceHistoryTierSubscribers.get(storageKey);
  if (!listeners) return;
  for (const listener of Array.from(listeners)) {
    listener(value);
  }
}

export function useBriefingSourceHistoryTier(
  engagementId: string,
): "all" | "adapter" | "manual" {
  const storageKey = briefingSourceHistoryTierStorageKey(engagementId);
  const [tier, setTier] = useState<"all" | "adapter" | "manual">(() =>
    readBriefingSourceHistoryTier(storageKey),
  );
  useEffect(() => {
    if (typeof window === "undefined") return;
    setTier(readBriefingSourceHistoryTier(storageKey));
    const handleCustom = (event: Event) => {
      if (
        event instanceof CustomEvent &&
        typeof event.detail === "string" &&
        event.detail === storageKey
      ) {
        setTier(readBriefingSourceHistoryTier(storageKey));
      }
    };
    const handleStorage = (event: StorageEvent) => {
      if (event.key === storageKey) {
        setTier(readBriefingSourceHistoryTier(storageKey));
      }
    };
    window.addEventListener(
      BRIEFING_SOURCE_HISTORY_TIER_CHANGE_EVENT,
      handleCustom,
    );
    window.addEventListener("storage", handleStorage);
    return () => {
      window.removeEventListener(
        BRIEFING_SOURCE_HISTORY_TIER_CHANGE_EVENT,
        handleCustom,
      );
      window.removeEventListener("storage", handleStorage);
    };
  }, [storageKey]);
  return tier;
}

export const BRIEFING_SOURCE_HISTORY_TIER_LABEL = {
  all: null,
  adapter: "Generate Layers",
  manual: "Manual uploads",
} as const satisfies Record<
  "all" | "adapter" | "manual",
  string | null
>;
