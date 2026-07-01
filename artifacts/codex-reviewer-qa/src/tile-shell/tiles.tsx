import type { TileDef } from "./types";
import IntakeQueueTile from "../tiles/Compliance/intake-queue";
import ComplianceRunTile from "../tiles/Compliance/compliance-run";
import LetterTile from "../tiles/Deliverable/letter";
import MapTile from "../tiles/Site Analysis/map";
import TopographyTile from "../tiles/Site Analysis/topography";
import DrainageTile from "../tiles/Site Analysis/drainage";
import HydrologyTile from "../tiles/Site Analysis/hydrology";
import SubsurfaceTile from "../tiles/Site Analysis/subsurface";
import { makeStubTile } from "../tiles/stubFactory";

type TileMeta = Omit<TileDef, "el"> & { component: () => React.ReactElement };

const TILE_META: TileMeta[] = [
  // Compliance
  { id: "intake-queue", label: "Intake & Queue", category: "Compliance", engine: "engagement", status: "live", component: () => <IntakeQueueTile /> },
  { id: "compliance-run", label: "Compliance Run", category: "Compliance", engine: "engagement", status: "live", component: () => <ComplianceRunTile /> },
  { id: "findings-library", label: "Findings Library", category: "Compliance", engine: "engagement", status: "live", component: () => makeStubTile("findings-library")() },
  { id: "calibration", label: "Finding Calibration", category: "Compliance", engine: "engagement", status: "live", component: () => makeStubTile("calibration")() },
  { id: "precedence", label: "Precedence Engine", category: "Compliance", engine: "code", status: "degraded", degradedReason: "Production gate not activated; most-stringent-governs logic built but disabled in production.", component: () => makeStubTile("precedence")() },
  { id: "icc-ingest", label: "ICC Code Connect Ingest", category: "Compliance", engine: "code", status: "partial", degradedReason: "Credentials live; API contract not verified.", component: () => makeStubTile("icc-ingest")() },
  { id: "ahj-precedent", label: "Permit AHJ Precedent", category: "Compliance", status: "planned", component: () => makeStubTile("ahj-precedent")() },
  { id: "code-broadcast", label: "Code Change Broadcast", category: "Compliance", status: "planned", component: () => makeStubTile("code-broadcast")() },
  // Site Analysis
  { id: "topography", label: "Topography", category: "Site Analysis", engine: "spatial", status: "live", component: () => <TopographyTile /> },
  { id: "drainage", label: "Drainage", category: "Site Analysis", engine: "spatial", status: "live", component: () => <DrainageTile /> },
  { id: "hydrology", label: "Hydrology", category: "Site Analysis", engine: "spatial", status: "degraded", degradedReason: "pysheds not installed in Cloud Run worker.", component: () => <HydrologyTile /> },
  { id: "subsurface", label: "Subsurface Suitability", category: "Site Analysis", engine: "spatial", status: "partial", degradedReason: "SSURGO ECONNRESET — USDA TLS issue.", component: () => <SubsurfaceTile /> },
  { id: "stormwater", label: "Stormwater / Detention", category: "Site Analysis", status: "planned", component: () => makeStubTile("stormwater")() },
  { id: "cut-fill", label: "Grading / Cut-Fill", category: "Site Analysis", status: "planned", component: () => makeStubTile("cut-fill")() },
  { id: "solar", label: "Solar / Aspect", category: "Site Analysis", status: "planned", component: () => makeStubTile("solar")() },
  { id: "viewshed", label: "Viewshed", category: "Site Analysis", status: "planned", component: () => makeStubTile("viewshed")() },
  { id: "map", label: "Map", category: "Site Analysis", engine: "spatial", status: "live", minColShare: 0.3, component: () => <MapTile /> },
  // Property Intel
  { id: "property-brief", label: "Property Brief", category: "Property Intel", engine: "engagement", status: "live", component: () => makeStubTile("property-brief")() },
  { id: "hazard", label: "Hazard Profile", category: "Property Intel", engine: "spatial", status: "live", component: () => makeStubTile("hazard")() },
  { id: "place-dossier", label: "Place Dossier", category: "Property Intel", engine: "engagement", status: "live", component: () => makeStubTile("place-dossier")() },
  { id: "encumbrances", label: "Encumbrance Report", category: "Property Intel", engine: "engagement", status: "live", component: () => makeStubTile("encumbrances")() },
  { id: "setbacks", label: "Local Setbacks", category: "Property Intel", engine: "code", status: "live", component: () => makeStubTile("setbacks")() },
  { id: "climate-risk", label: "Climate Risk Trajectory", category: "Property Intel", status: "planned", component: () => makeStubTile("climate-risk")() },
  { id: "insurance-estimate", label: "Insurance Cost Estimate", category: "Property Intel", status: "planned", component: () => makeStubTile("insurance-estimate")() },
  { id: "jurisdiction-rank", label: "Jurisdiction Comparison", category: "Property Intel", status: "planned", component: () => makeStubTile("jurisdiction-rank")() },
  // Design Accelerator
  { id: "sheet-extraction", label: "Sheet Extraction", category: "Design Accelerator", engine: "engagement", status: "live", component: () => makeStubTile("sheet-extraction")() },
  { id: "doc-parsing", label: "Document Parsing", category: "Design Accelerator", engine: "engagement", status: "live", component: () => makeStubTile("doc-parsing")() },
  { id: "product-spec", label: "Product Spec Reference", category: "Design Accelerator", engine: "code", status: "live", component: () => makeStubTile("product-spec")() },
  { id: "detail-callouts", label: "Detail Callout Specs", category: "Design Accelerator", engine: "engagement", status: "live", component: () => makeStubTile("detail-callouts")() },
  { id: "response-tasks", label: "Response Tasks", category: "Design Accelerator", engine: "engagement", status: "live", component: () => makeStubTile("response-tasks")() },
  { id: "bim-query", label: "BIM Model Query", category: "Design Accelerator", engine: "engagement", status: "live", component: () => makeStubTile("bim-query")() },
  { id: "ifc-ingest", label: "IFC Ingest", category: "Design Accelerator", engine: "engagement", status: "live", component: () => makeStubTile("ifc-ingest")() },
  { id: "engagement-match", label: "Engagement Match (Revit)", category: "Design Accelerator", engine: "engagement", status: "live", component: () => makeStubTile("engagement-match")() },
  { id: "renders", label: "Renders", category: "Design Accelerator", engine: "engagement", status: "live", component: () => makeStubTile("renders")() },
  { id: "collateral-export", label: "Collateral Export", category: "Design Accelerator", engine: "engagement", status: "live", component: () => makeStubTile("collateral-export")() },
  // Deliverable
  { id: "letter", label: "Deliverable Letter", category: "Deliverable", engine: "engagement", status: "live", component: () => <LetterTile /> },
  { id: "letter-render", label: "Letter Render", category: "Deliverable", engine: "engagement", status: "live", component: () => makeStubTile("letter-render")() },
  { id: "letter-send", label: "Letter Send", category: "Deliverable", engine: "engagement", status: "live", component: () => makeStubTile("letter-send")() },
  // Market
  { id: "avm", label: "AVM / Valuation", category: "Market", engine: "engagement", status: "partial", degradedReason: "Cotality AVM keys present; not fully wired.", component: () => makeStubTile("avm")() },
  { id: "rent-comps", label: "Rent / Comps", category: "Market", engine: "engagement", status: "partial", degradedReason: "Cotality demo quota: 100 req/day, expires ~2026-07-06.", component: () => makeStubTile("rent-comps")() },
  { id: "pro-forma", label: "Cash-Flow Pro Forma", category: "Market", status: "planned", component: () => makeStubTile("pro-forma")() },
  { id: "deal-score", label: "Deal Score", category: "Market", status: "planned", component: () => makeStubTile("deal-score")() },
  { id: "motivated-seller", label: "Motivated Seller Heat", category: "Market", status: "planned", component: () => makeStubTile("motivated-seller")() },
  { id: "rehab-opportunity", label: "Rehab Opportunity", category: "Market", status: "planned", component: () => makeStubTile("rehab-opportunity")() },
];

export const TILE_REGISTRY: Record<string, TileDef> = Object.fromEntries(
  TILE_META.map(({ component, ...meta }) => [
    meta.id,
    { ...meta, el: component },
  ]),
);

export const ALL_TILES: TileDef[] = TILE_META.map(({ component, ...meta }) => ({
  ...meta,
  el: component,
}));

export const TILE_CATEGORIES = [
  "Compliance",
  "Site Analysis",
  "Property Intel",
  "Design Accelerator",
  "Deliverable",
  "Market",
] as const;

export function getTile(id: string): TileDef | undefined {
  return TILE_REGISTRY[id];
}
