/**
 * Plan Review mock data — narrowed to the FINDINGS surface only.
 * Consumed by FindingsLibrary and AIBriefingPanel.
 */

export type Discipline =
  | "architectural"
  | "structural"
  | "mep"
  | "civil"
  | "fire-life-safety"
  | "landscape"
  | "zoning";

export interface Finding {
  id: string;
  submittalId: string;
  discipline: Discipline;
  severity: "blocking" | "warning" | "info";
  source: "ai-reviewer" | "human-reviewer";
  title: string;
  detail: string;
  codeRef: string;
  edition: string;
  identifiedAt: string;
  status: "open" | "acknowledged" | "resolved";
}

export const FINDINGS: Finding[] = [
  { id: "F-A2.04-001", submittalId: "SUB-2026-0142", discipline: "architectural", severity: "blocking", source: "ai-reviewer", title: "Egress door swing direction", detail: "Door 104B swings against the direction of egress travel.", codeRef: "IBC §1010.1.2", edition: "IBC 2021", identifiedAt: "2026-04-12T10:30:00Z", status: "open" },
  { id: "F-S1.01-002", submittalId: "SUB-2026-0146", discipline: "structural", severity: "warning", source: "ai-reviewer", title: "Floor live load not specified", detail: "Live load for second floor office area is missing from structural notes.", codeRef: "IBC §1607", edition: "IBC 2021", identifiedAt: "2026-04-10T09:05:00Z", status: "open" },
  { id: "F-E3.02-003", submittalId: "SUB-2026-0145", discipline: "mep", severity: "blocking", source: "ai-reviewer", title: "Missing GFCI protection", detail: "Receptacle in garage area lacks required GFCI protection.", codeRef: "NEC §210.8(A)", edition: "NEC 2020", identifiedAt: "2026-04-16T14:45:00Z", status: "open" },
  { id: "F-Z0.01-004", submittalId: "SUB-2026-0151", discipline: "zoning", severity: "blocking", source: "human-reviewer", title: "Setback encroachment", detail: "North side yard setback is 3'-2\", minimum required is 5'-0\".", codeRef: "UDC §4.3.2.B", edition: "Bastrop UDC", identifiedAt: "2026-03-29T10:15:00Z", status: "resolved" },
  { id: "F-L1.00-005", submittalId: "SUB-2026-0144", discipline: "landscape", severity: "info", source: "ai-reviewer", title: "Plant schedule missing", detail: "Required street trees are shown on plan but missing from schedule.", codeRef: "UDC §6.7.1", edition: "Bastrop UDC", identifiedAt: "2026-04-01T09:30:00Z", status: "resolved" },
  { id: "F-F2.01-006", submittalId: "SUB-2026-0145", discipline: "fire-life-safety", severity: "blocking", source: "ai-reviewer", title: "Smoke alarm not shown", detail: "Primary bedroom missing required interconnected smoke alarm.", codeRef: "IRC §R314.3", edition: "IRC 2021", identifiedAt: "2026-04-16T14:48:00Z", status: "open" },
  { id: "F-C1.02-007", submittalId: "SUB-2026-0142", discipline: "civil", severity: "warning", source: "ai-reviewer", title: "Site grading slope", detail: "Slope is > 2% within 10' of foundation on the west elevation.", codeRef: "IRC §R401.3", edition: "IRC 2021", identifiedAt: "2026-04-12T10:35:00Z", status: "open" },
  { id: "F-A3.01-008", submittalId: "SUB-2026-0146", discipline: "architectural", severity: "warning", source: "human-reviewer", title: "Insufficient hand rail height", detail: "Exterior stair handrail shown at 32\", requires minimum 34\".", codeRef: "IBC §1014.2", edition: "IBC 2021", identifiedAt: "2026-04-11T13:20:00Z", status: "open" },
  { id: "F-A1.01-009", submittalId: "SUB-2026-0146", discipline: "architectural", severity: "blocking", source: "ai-reviewer", title: "Missing accessible route", detail: "No accessible route shown from public right-of-way to main entrance.", codeRef: "IBC §1104.1", edition: "IBC 2021", identifiedAt: "2026-04-10T09:08:00Z", status: "open" },
  { id: "F-M2.01-010", submittalId: "SUB-2026-0153", discipline: "mep", severity: "info", source: "ai-reviewer", title: "Equipment clearance", detail: "Verify manufacturer clearance requirements for RTU-1.", codeRef: "IMC §306.1", edition: "IMC 2021", identifiedAt: "2026-04-02T15:10:00Z", status: "resolved" },
  { id: "F-S2.01-011", submittalId: "SUB-2026-0145", discipline: "structural", severity: "warning", source: "ai-reviewer", title: "Header sizing missing", detail: "Garage door header size not specified on framing plan.", codeRef: "IRC §R602.7", edition: "IRC 2021", identifiedAt: "2026-04-16T14:50:00Z", status: "open" },
  { id: "F-C2.01-012", submittalId: "SUB-2026-0150", discipline: "civil", severity: "info", source: "human-reviewer", title: "Erosion control detail", detail: "Silt fence detail missing standard city notes.", codeRef: "UDC §7.1.3", edition: "Bastrop UDC", identifiedAt: "2026-04-14T09:00:00Z", status: "open" },
  { id: "F-A5.01-013", submittalId: "SUB-2026-0151", discipline: "architectural", severity: "blocking", source: "ai-reviewer", title: "Window egress size", detail: "Bedroom 2 window does not meet minimum net clear opening area.", codeRef: "IRC §R310.2.1", edition: "IRC 2021", identifiedAt: "2026-03-28T11:45:00Z", status: "resolved" },
  { id: "F-P1.01-014", submittalId: "SUB-2026-0145", discipline: "mep", severity: "warning", source: "ai-reviewer", title: "Water heater pan", detail: "Drain pan not shown for water heater located in attic.", codeRef: "IPC §504.7", edition: "IPC 2021", identifiedAt: "2026-04-16T14:55:00Z", status: "open" },
  { id: "F-Z0.02-015", submittalId: "SUB-2026-0153", discipline: "zoning", severity: "info", source: "ai-reviewer", title: "Parking count", detail: "Provided parking (42) slightly exceeds minimum required (40).", codeRef: "UDC §5.2.1", edition: "Bastrop UDC", identifiedAt: "2026-04-02T15:15:00Z", status: "resolved" },
  { id: "F-A1.02-016", submittalId: "SUB-2026-0142", discipline: "architectural", severity: "info", source: "ai-reviewer", title: "Fire rating unverified", detail: "Corridor wall fire rating callout missing on sheet A1.02.", codeRef: "IBC §708.1", edition: "IBC 2021", identifiedAt: "2026-04-12T10:38:00Z", status: "open" },
  { id: "F-S1.02-017", submittalId: "SUB-2026-0151", discipline: "structural", severity: "warning", source: "ai-reviewer", title: "Foundation detail", detail: "Slab-on-grade detail missing vapor retarder note.", codeRef: "IRC §R506.2.3", edition: "IRC 2021", identifiedAt: "2026-03-28T11:50:00Z", status: "resolved" },
  { id: "F-L1.01-018", submittalId: "SUB-2026-0150", discipline: "landscape", severity: "info", source: "ai-reviewer", title: "Irrigation controller", detail: "Location of irrigation controller not indicated on plan.", codeRef: "UDC §6.8.2", edition: "Bastrop UDC", identifiedAt: "2026-04-13T11:00:00Z", status: "open" }
];
