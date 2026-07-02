// Shell/registry types now live in the @hauska/tile-shell package (the single
// authoritative TileDef). Re-export them so app modules keep importing from
// "../tile-shell/types" unchanged.
export type {
  TileDef,
  TileCategory,
  TileStatus,
  WorkspaceComposition,
  OverlaySpec,
  PresetSpace,
  EngagementDetail,
  EngagementReportResult,
  PrecedenceResultWire,
} from "@hauska/tile-shell";

// App-only types the package shell does not need.
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
