import type React from "react";

export type TileStatus = "live" | "degraded" | "partial" | "planned";

export type TileCategory =
  | "Compliance"
  | "Site Analysis"
  | "Property Intel"
  | "Design Accelerator"
  | "Deliverable"
  | "Market";

export type TileDef = {
  id: string;
  label: string;
  category: TileCategory;
  engine?: "engagement" | "spatial" | "code";
  el: () => React.ReactElement;
  minColShare?: number;
  status: TileStatus;
  degradedReason?: string;
};

export type WorkspaceComposition = {
  engagementId?: string;
  tiles: string[];
  layoutId: string;
  why: string;
};

export type PresetSpace = {
  id: string;
  label: string;
  tiles: string[];
  layoutId: string;
};

export type OverlaySpec = {
  id: string;
  kind: string;
  label: string;
  geojson?: {
    type: string;
    features: unknown[];
  };
  opacity?: number;
};

export type EngagementReportResult = {
  status: "running" | "not-run" | "error" | "ok";
  result?: unknown;
  error?: string;
  generationId?: string;
};

export type EngagementDetail = {
  id: string;
  name: string;
  jurisdiction: string | null;
  address: string | null;
  apn: string | null;
  applicantName: string | null;
  reportResults: Record<string, EngagementReportResult>;
};

export type EngagementQueueItem = {
  id: string;
  engagementId: string;
  engagementName: string;
  status: string;
  reportRunState: string | null;
  openFindingCount: number;
  daysInQueue: number;
};

export type IntakeParseResult = {
  projectName: string;
  address: string;
  jurisdiction: string;
  projectType: string;
  clientName: string;
  clientEmail: string;
  clientNotes: string;
  unverifiedFields: string[];
  sources: Array<{ kind: string; label: string }>;
};

export type PrecedenceResultWire = {
  topic: string;
  ruleApplied: string;
  governingAtomId: string;
  comparedAtomIds: string[];
};
