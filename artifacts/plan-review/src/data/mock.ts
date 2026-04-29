export const KPIS = {
  avgReviewTime: { value: "2.4d", trend: "down" as const, trendLabel: "12% faster than last month" },
  aiAccuracy:    { value: "94%",  trend: "up"   as const, trendLabel: "+3 pts vs Q1" },
  complianceRate:{ value: "87%",  trend: "up"   as const, trendLabel: "+5 pts vs Q1" },
  backlog:       { value: "12",   trend: "down" as const, trendLabel: "Down from 18" }
};

export type Status = "draft" | "intake" | "ai-review" | "in-review" | "rejected" | "approved";
export type Discipline = "architectural" | "structural" | "mep" | "civil" | "fire-life-safety" | "landscape" | "zoning";

export interface Submittal {
  id: string;            // e.g., "SUB-2026-0142"
  projectName: string;
  address: string;
  firm: string;
  firmInitials: string;  // e.g., "S&C"
  submittedAt: string;   // ISO
  disciplines: Discipline[];
  status: Status;
  aiFindingsCount: number;
  blockingCount: number;
  reviewProgress: number; // 0-100
}

export interface Finding {
  id: string;            // e.g., "F-A2.04-001"
  submittalId: string;
  discipline: Discipline;
  severity: "blocking" | "warning" | "info";
  source: "ai-reviewer" | "human-reviewer";
  title: string;
  detail: string;
  codeRef: string;       // e.g., "IBC §1010.1.2"
  edition: string;       // e.g., "IBC 2021"
  identifiedAt: string;  // ISO
  status: "open" | "acknowledged" | "resolved";
}

export const SUBMITTALS: Submittal[] = [
  { id: "SUB-2026-0142", projectName: "Lost Pines Townhomes — Phase 2", address: "1400 Pine St, Bastrop, TX", firm: "Studio Architecture", firmInitials: "SA", submittedAt: "2026-04-12T10:00:00Z", disciplines: ["architectural", "civil", "landscape"], status: "in-review", aiFindingsCount: 3, blockingCount: 1, reviewProgress: 60 },
  { id: "SUB-2026-0143", projectName: "Bastrop Brewing — Tasting Room Addition", address: "812 Main St, Bastrop, TX", firm: "Design Co", firmInitials: "DC", submittedAt: "2026-04-14T11:30:00Z", disciplines: ["architectural", "mep", "fire-life-safety"], status: "ai-review", aiFindingsCount: 0, blockingCount: 0, reviewProgress: 15 },
  { id: "SUB-2026-0144", projectName: "Colorado River Trail — Visitor Center", address: "River Rd, Bastrop, TX", firm: "Civil Works", firmInitials: "CW", submittedAt: "2026-04-01T09:15:00Z", disciplines: ["civil", "landscape"], status: "approved", aiFindingsCount: 2, blockingCount: 0, reviewProgress: 100 },
  { id: "SUB-2026-0145", projectName: "Highland Estates Lot 7 — New SFR", address: "7 Highland Dr, Bastrop, TX", firm: "Smith Builders", firmInitials: "SB", submittedAt: "2026-04-16T14:20:00Z", disciplines: ["architectural", "structural", "mep"], status: "in-review", aiFindingsCount: 4, blockingCount: 2, reviewProgress: 40 },
  { id: "SUB-2026-0146", projectName: "Main St. Adaptive Reuse — Loft Conversion", address: "1015 Main St, Bastrop, TX", firm: "Urban Concepts", firmInitials: "UC", submittedAt: "2026-04-10T08:45:00Z", disciplines: ["architectural", "structural", "fire-life-safety"], status: "rejected", aiFindingsCount: 8, blockingCount: 3, reviewProgress: 100 },
  { id: "SUB-2026-0147", projectName: "Pecan Park Pavilion", address: "Pecan Park, Bastrop, TX", firm: "Parks & Rec", firmInitials: "PR", submittedAt: "2026-04-17T13:10:00Z", disciplines: ["structural", "civil"], status: "draft", aiFindingsCount: 0, blockingCount: 0, reviewProgress: 0 },
  { id: "SUB-2026-0148", projectName: "Bastrop ISD — Maintenance Annex", address: "1602 Hill St, Bastrop, TX", firm: "Education Planners", firmInitials: "EP", submittedAt: "2026-04-05T15:30:00Z", disciplines: ["architectural", "mep", "civil"], status: "approved", aiFindingsCount: 1, blockingCount: 0, reviewProgress: 100 },
  { id: "SUB-2026-0149", projectName: "Riverside Clinic — Phase 1", address: "1200 Riverside Dr, Bastrop, TX", firm: "HealthArch", firmInitials: "HA", submittedAt: "2026-04-15T09:00:00Z", disciplines: ["architectural", "mep", "zoning"], status: "ai-review", aiFindingsCount: 0, blockingCount: 0, reviewProgress: 10 },
  { id: "SUB-2026-0150", projectName: "Old Iron Bridge Plaza", address: "Water St, Bastrop, TX", firm: "Civic Design", firmInitials: "CD", submittedAt: "2026-04-13T10:45:00Z", disciplines: ["landscape", "civil"], status: "in-review", aiFindingsCount: 2, blockingCount: 0, reviewProgress: 75 },
  { id: "SUB-2026-0151", projectName: "Sage Hill Subdivision — Common House", address: "Sage Hill Blvd, Bastrop, TX", firm: "Community Builders", firmInitials: "CB", submittedAt: "2026-03-28T11:20:00Z", disciplines: ["architectural", "structural", "mep"], status: "rejected", aiFindingsCount: 5, blockingCount: 2, reviewProgress: 100 },
  { id: "SUB-2026-0152", projectName: "Tahitian Village SFR — Block 12", address: "Tahitian Dr, Bastrop, TX", firm: "Island Homes", firmInitials: "IH", submittedAt: "2026-04-18T08:15:00Z", disciplines: ["architectural", "civil"], status: "draft", aiFindingsCount: 0, blockingCount: 0, reviewProgress: 0 },
  { id: "SUB-2026-0153", projectName: "El Camino Real Mixed-Use", address: "Hwy 71, Bastrop, TX", firm: "Commercial Dev", firmInitials: "CD", submittedAt: "2026-04-02T14:50:00Z", disciplines: ["architectural", "zoning", "civil", "mep"], status: "approved", aiFindingsCount: 6, blockingCount: 0, reviewProgress: 100 }
];

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
