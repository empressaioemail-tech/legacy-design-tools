/** Wire shapes for workspace product preferences (mirrors API). */

export type FederalLayerKey = "fema" | "usgs" | "epa" | "fcc";

export type CoverTemplateId = "cockpit-cyan" | "minimal-dark" | "minimal-light";

export type PdfWatermarkId = "standard" | "draft" | "confidential" | "none";

export type RetentionPolicyId = "indefinite" | "365_days" | "90_days";

export interface WorkspacePreferencesWire {
  federalLayers: Record<FederalLayerKey, boolean>;
  includeSiteLayers: boolean;
  presentation: {
    coverTemplate: CoverTemplateId;
    pdfWatermark: PdfWatermarkId;
  };
  storage: {
    retentionPolicy: RetentionPolicyId;
  };
}

export interface WorkspaceStorageDisplayWire {
  uploadsBucket: string | null;
  provider: string;
  retentionPolicy: RetentionPolicyId;
}

export const FEDERAL_LAYER_OPTIONS: Array<{
  key: FederalLayerKey;
  label: string;
  hint: string;
}> = [
  { key: "fema", label: "FEMA NFHL", hint: "Flood hazard zones" },
  { key: "usgs", label: "USGS NED", hint: "Elevation / terrain" },
  { key: "epa", label: "EPA EJScreen", hint: "Environmental justice" },
  { key: "fcc", label: "FCC broadband", hint: "Connectivity maps" },
];

export const COVER_TEMPLATE_OPTIONS: Array<{
  id: CoverTemplateId;
  label: string;
}> = [
  { id: "cockpit-cyan", label: "Cockpit / Cyan" },
  { id: "minimal-dark", label: "Minimal / Dark" },
  { id: "minimal-light", label: "Minimal / Light" },
];

export const PDF_WATERMARK_OPTIONS: Array<{
  id: PdfWatermarkId;
  label: string;
}> = [
  { id: "standard", label: "Standard (platform)" },
  { id: "draft", label: "Draft" },
  { id: "confidential", label: "Confidential" },
  { id: "none", label: "None" },
];

export const RETENTION_POLICY_OPTIONS: Array<{
  id: RetentionPolicyId;
  label: string;
  hint: string;
}> = [
  {
    id: "indefinite",
    label: "Indefinite (pilot)",
    hint: "Policy recorded; automated purge not enabled yet.",
  },
  {
    id: "365_days",
    label: "365 days",
    hint: "Policy recorded; automated purge not enabled yet.",
  },
  {
    id: "90_days",
    label: "90 days",
    hint: "Policy recorded; automated purge not enabled yet.",
  },
];

export function formatFederalSummary(
  layers: Record<FederalLayerKey, boolean>,
): string {
  const on = FEDERAL_LAYER_OPTIONS.filter((o) => layers[o.key]).map(
    (o) => o.label,
  );
  return on.length > 0 ? on.join(", ") : "None enabled";
}

export function formatCoverLabel(id: CoverTemplateId): string {
  return COVER_TEMPLATE_OPTIONS.find((o) => o.id === id)?.label ?? id;
}

export function formatWatermarkLabel(id: PdfWatermarkId): string {
  return PDF_WATERMARK_OPTIONS.find((o) => o.id === id)?.label ?? id;
}

export function formatRetentionLabel(id: RetentionPolicyId): string {
  return RETENTION_POLICY_OPTIONS.find((o) => o.id === id)?.label ?? id;
}
