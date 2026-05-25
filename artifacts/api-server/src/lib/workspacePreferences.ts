import { DEFAULT_FOOTER_WATERMARK } from "@workspace/briefing-pdf-tokens";

export type FederalLayerKey = "fema" | "usgs" | "epa" | "fcc";

export type CoverTemplateId = "cockpit-cyan" | "minimal-dark" | "minimal-light";

export type PdfWatermarkId = "standard" | "draft" | "confidential" | "none";

export type RetentionPolicyId = "indefinite" | "365_days" | "90_days";

export interface WorkspacePreferences {
  federalLayers: Record<FederalLayerKey, boolean>;
  /** County + state GIS adapters on layer generation (Regrid baseline stays on). */
  includeSiteLayers: boolean;
  presentation: {
    coverTemplate: CoverTemplateId;
    pdfWatermark: PdfWatermarkId;
  };
  storage: {
    retentionPolicy: RetentionPolicyId;
  };
}

export const FEDERAL_ADAPTER_KEYS: Record<FederalLayerKey, string> = {
  fema: "fema:nfhl-flood-zone",
  usgs: "usgs:ned-elevation",
  epa: "epa:ejscreen",
  fcc: "fcc:broadband",
};

export const DEFAULT_WORKSPACE_PREFERENCES: WorkspacePreferences = {
  federalLayers: { fema: true, usgs: true, epa: true, fcc: false },
  includeSiteLayers: true,
  presentation: {
    coverTemplate: "cockpit-cyan",
    pdfWatermark: "standard",
  },
  storage: { retentionPolicy: "indefinite" },
};

const COVER_ACCENT: Record<CoverTemplateId, string> = {
  "cockpit-cyan": "#00b4d8",
  "minimal-dark": "#0d0d0d",
  "minimal-light": "#0284c7",
};

const PDF_WATERMARK_TEXT: Record<PdfWatermarkId, string> = {
  standard: DEFAULT_FOOTER_WATERMARK,
  draft:
    "DRAFT — Preliminary briefing. Not for distribution or compliance reliance.",
  confidential:
    "CONFIDENTIAL — For intended recipients only. Do not distribute without permission.",
  none: "",
};

export function coverAccentColor(template: CoverTemplateId): string {
  return COVER_ACCENT[template];
}

export function pdfWatermarkText(id: PdfWatermarkId): string {
  return PDF_WATERMARK_TEXT[id];
}

export function resolveStorageBucketDisplay(): {
  uploadsBucket: string | null;
  provider: string;
} {
  const dir = process.env.PRIVATE_OBJECT_DIR?.trim();
  if (!dir) {
    return { uploadsBucket: null, provider: "object-storage" };
  }
  const parts = dir.split("/").filter(Boolean);
  return {
    uploadsBucket: parts[0] ?? null,
    provider: "object-storage",
  };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function parseFederalLayers(raw: unknown): Record<FederalLayerKey, boolean> {
  const out = { ...DEFAULT_WORKSPACE_PREFERENCES.federalLayers };
  if (!isRecord(raw)) return out;
  for (const key of ["fema", "usgs", "epa", "fcc"] as const) {
    if (typeof raw[key] === "boolean") out[key] = raw[key];
  }
  return out;
}

function parsePresentation(raw: unknown): WorkspacePreferences["presentation"] {
  const base = { ...DEFAULT_WORKSPACE_PREFERENCES.presentation };
  if (!isRecord(raw)) return base;
  const cover = raw.coverTemplate;
  if (
    cover === "cockpit-cyan" ||
    cover === "minimal-dark" ||
    cover === "minimal-light"
  ) {
    base.coverTemplate = cover;
  }
  const wm = raw.pdfWatermark;
  if (
    wm === "standard" ||
    wm === "draft" ||
    wm === "confidential" ||
    wm === "none"
  ) {
    base.pdfWatermark = wm;
  }
  return base;
}

function parseStorage(raw: unknown): WorkspacePreferences["storage"] {
  const base = { ...DEFAULT_WORKSPACE_PREFERENCES.storage };
  if (!isRecord(raw)) return base;
  const rp = raw.retentionPolicy;
  if (rp === "indefinite" || rp === "365_days" || rp === "90_days") {
    base.retentionPolicy = rp;
  }
  return base;
}

export function mergeWorkspacePreferences(
  raw: unknown,
): WorkspacePreferences {
  if (!isRecord(raw)) return { ...DEFAULT_WORKSPACE_PREFERENCES };
  return {
    federalLayers: parseFederalLayers(raw.federalLayers),
    includeSiteLayers:
      typeof raw.includeSiteLayers === "boolean"
        ? raw.includeSiteLayers
        : DEFAULT_WORKSPACE_PREFERENCES.includeSiteLayers,
    presentation: parsePresentation(raw.presentation),
    storage: parseStorage(raw.storage),
  };
}

export function normalizePreferencesPatch(
  body: Record<string, unknown>,
):
  | { ok: true; value: Partial<WorkspacePreferences> }
  | { ok: false; error: string } {
  if (body.preferences === undefined) {
    return { ok: true, value: {} };
  }
  if (!isRecord(body.preferences)) {
    return { ok: false, error: "invalid_preferences" };
  }
  const p = body.preferences;
  const patch: Partial<WorkspacePreferences> = {};
  if (p.federalLayers !== undefined) {
    patch.federalLayers = parseFederalLayers(p.federalLayers);
  }
  if (typeof p.includeSiteLayers === "boolean") {
    patch.includeSiteLayers = p.includeSiteLayers;
  }
  if (p.presentation !== undefined) {
    patch.presentation = parsePresentation(p.presentation);
  }
  if (p.storage !== undefined) {
    patch.storage = parseStorage(p.storage);
  }
  return { ok: true, value: patch };
}

export function preferencesToStored(
  current: WorkspacePreferences,
  patch: Partial<WorkspacePreferences>,
): WorkspacePreferences {
  return mergeWorkspacePreferences({
    ...current,
    ...patch,
    federalLayers: patch.federalLayers ?? current.federalLayers,
    presentation: patch.presentation
      ? { ...current.presentation, ...patch.presentation }
      : current.presentation,
    storage: patch.storage
      ? { ...current.storage, ...patch.storage }
      : current.storage,
  });
}

/** Drop federal-tier adapters disabled in workspace preferences. */
export function filterAdaptersByPreferences<
  T extends { tier: string; adapterKey: string },
>(adapters: ReadonlyArray<T>, prefs: WorkspacePreferences): T[] {
  return adapters.filter((a) => {
    if (a.tier === "federal") {
      for (const [key, adapterKey] of Object.entries(FEDERAL_ADAPTER_KEYS)) {
        if (a.adapterKey === adapterKey) {
          return prefs.federalLayers[key as FederalLayerKey] !== false;
        }
      }
      return true;
    }
    if (a.tier === "state" || a.tier === "local") {
      return prefs.includeSiteLayers !== false;
    }
    return true;
  });
}
