import type { TileDef } from "./types";
import IntakeQueueTile from "../tiles/Compliance/intake-queue";
import IntakeTile from "../tiles/intake/IntakeTile";
import ComplianceRunTile from "../tiles/Compliance/compliance-run";
import LetterTile from "../tiles/Deliverable/letter";
import MapTile from "../tiles/Site Analysis/map";
import TopographyTile from "../tiles/Site Analysis/topography";
import DrainageTile from "../tiles/Site Analysis/drainage";
import HydrologyTile from "../tiles/Site Analysis/hydrology";
import SubsurfaceTile from "../tiles/Site Analysis/subsurface";
import PropertyBriefTile from "../tiles/property-intel/PropertyBriefTile";
import HazardProfileTile from "../tiles/property-intel/HazardProfileTile";
import EncumbranceTile from "../tiles/property-intel/EncumbranceTile";
import SheetExtractionTile from "../tiles/design-accelerator/SheetExtractionTile";
import ResponseTasksTile from "../tiles/design-accelerator/ResponseTasksTile";
import { makeStubTile, type StubTileMeta } from "../tiles/stubFactory";

type TileMeta = Omit<TileDef, "el"> & { component: () => React.ReactElement };

function stub(meta: StubTileMeta): () => React.ReactElement {
  return makeStubTile(meta);
}

const TILE_META: TileMeta[] = [
  // Compliance
  { id: "intake", label: "Intake & Upload", category: "Compliance", engine: "engagement", status: "live", component: () => <IntakeTile /> },
  { id: "intake-queue", label: "Intake & Queue", category: "Compliance", engine: "engagement", status: "live", component: () => <IntakeQueueTile /> },
  { id: "compliance-run", label: "Compliance Run", category: "Compliance", engine: "engagement", status: "live", component: () => <ComplianceRunTile /> },
  { id: "findings-library", label: "Findings Library", category: "Compliance", engine: "engagement", status: "live", component: stub({ id: "findings-library", label: "Findings Library", category: "Compliance", status: "live" }) },
  { id: "calibration", label: "Finding Calibration", category: "Compliance", engine: "engagement", status: "live", component: stub({ id: "calibration", label: "Finding Calibration", category: "Compliance", status: "live" }) },
  { id: "precedence", label: "Precedence Engine", category: "Compliance", engine: "code", status: "degraded", degradedReason: "Production gate not activated; most-stringent-governs logic built but disabled in production.", component: stub({ id: "precedence", label: "Precedence Engine", category: "Compliance", status: "degraded", degradedReason: "Production gate not activated; most-stringent-governs logic built but disabled in production." }) },
  { id: "icc-ingest", label: "ICC Code Connect Ingest", category: "Compliance", engine: "code", status: "partial", degradedReason: "Credentials live; API contract not verified.", component: stub({ id: "icc-ingest", label: "ICC Code Connect Ingest", category: "Compliance", status: "partial", degradedReason: "Credentials live; API contract not verified." }) },
  { id: "ahj-precedent", label: "Permit AHJ Precedent", category: "Compliance", status: "planned", component: stub({ id: "ahj-precedent", label: "Permit AHJ Precedent", category: "Compliance", status: "planned" }) },
  { id: "code-broadcast", label: "Code Change Broadcast", category: "Compliance", status: "planned", component: stub({ id: "code-broadcast", label: "Code Change Broadcast", category: "Compliance", status: "planned" }) },
  // Site Analysis
  { id: "topography", label: "Topography", category: "Site Analysis", engine: "spatial", status: "live", component: () => <TopographyTile /> },
  { id: "drainage", label: "Drainage", category: "Site Analysis", engine: "spatial", status: "live", component: () => <DrainageTile /> },
  { id: "hydrology", label: "Hydrology", category: "Site Analysis", engine: "spatial", status: "degraded", degradedReason: "pysheds not installed in Cloud Run worker.", component: () => <HydrologyTile /> },
  { id: "subsurface", label: "Subsurface Suitability", category: "Site Analysis", engine: "spatial", status: "partial", degradedReason: "SSURGO ECONNRESET — USDA TLS issue.", component: () => <SubsurfaceTile /> },
  { id: "stormwater", label: "Stormwater / Detention", category: "Site Analysis", status: "planned", component: stub({ id: "stormwater", label: "Stormwater / Detention", category: "Site Analysis", status: "planned" }) },
  { id: "cut-fill", label: "Grading / Cut-Fill", category: "Site Analysis", status: "planned", component: stub({ id: "cut-fill", label: "Grading / Cut-Fill", category: "Site Analysis", status: "planned" }) },
  { id: "solar", label: "Solar / Aspect", category: "Site Analysis", status: "planned", component: stub({ id: "solar", label: "Solar / Aspect", category: "Site Analysis", status: "planned" }) },
  { id: "viewshed", label: "Viewshed", category: "Site Analysis", status: "planned", component: stub({ id: "viewshed", label: "Viewshed", category: "Site Analysis", status: "planned" }) },
  { id: "map", label: "Map", category: "Site Analysis", engine: "spatial", status: "live", minColShare: 0.3, component: () => <MapTile /> },
  // Property Intel
  { id: "property-brief", label: "Property Brief", category: "Property Intel", engine: "engagement", status: "live", component: () => <PropertyBriefTile /> },
  { id: "hazard", label: "Hazard Profile", category: "Property Intel", engine: "spatial", status: "live", component: () => <HazardProfileTile /> },
  { id: "place-dossier", label: "Place Dossier", category: "Property Intel", engine: "engagement", status: "live", component: stub({ id: "place-dossier", label: "Place Dossier", category: "Property Intel", status: "live" }) },
  { id: "encumbrances", label: "Encumbrance Report", category: "Property Intel", engine: "engagement", status: "live", component: () => <EncumbranceTile /> },
  { id: "setbacks", label: "Local Setbacks", category: "Property Intel", engine: "code", status: "live", component: stub({ id: "setbacks", label: "Local Setbacks", category: "Property Intel", status: "live" }) },
  { id: "climate-risk", label: "Climate Risk Trajectory", category: "Property Intel", status: "planned", component: stub({ id: "climate-risk", label: "Climate Risk Trajectory", category: "Property Intel", status: "planned" }) },
  { id: "insurance-estimate", label: "Insurance Cost Estimate", category: "Property Intel", status: "planned", component: stub({ id: "insurance-estimate", label: "Insurance Cost Estimate", category: "Property Intel", status: "planned" }) },
  { id: "jurisdiction-rank", label: "Jurisdiction Comparison", category: "Property Intel", status: "planned", component: stub({ id: "jurisdiction-rank", label: "Jurisdiction Comparison", category: "Property Intel", status: "planned" }) },
  // Design Accelerator
  { id: "sheet-extraction", label: "Sheet Extraction", category: "Design Accelerator", engine: "engagement", status: "live", component: () => <SheetExtractionTile /> },
  { id: "doc-parsing", label: "Document Parsing", category: "Design Accelerator", engine: "engagement", status: "live", component: stub({ id: "doc-parsing", label: "Document Parsing", category: "Design Accelerator", status: "live" }) },
  { id: "product-spec", label: "Product Spec Reference", category: "Design Accelerator", engine: "code", status: "live", component: stub({ id: "product-spec", label: "Product Spec Reference", category: "Design Accelerator", status: "live" }) },
  { id: "detail-callouts", label: "Detail Callout Specs", category: "Design Accelerator", engine: "engagement", status: "live", component: stub({ id: "detail-callouts", label: "Detail Callout Specs", category: "Design Accelerator", status: "live" }) },
  { id: "response-tasks", label: "Response Tasks", category: "Design Accelerator", engine: "engagement", status: "live", component: () => <ResponseTasksTile /> },
  { id: "bim-query", label: "BIM Model Query", category: "Design Accelerator", engine: "engagement", status: "live", component: stub({ id: "bim-query", label: "BIM Model Query", category: "Design Accelerator", status: "live" }) },
  { id: "ifc-ingest", label: "IFC Ingest", category: "Design Accelerator", engine: "engagement", status: "live", component: stub({ id: "ifc-ingest", label: "IFC Ingest", category: "Design Accelerator", status: "live" }) },
  { id: "engagement-match", label: "Engagement Match (Revit)", category: "Design Accelerator", engine: "engagement", status: "live", component: stub({ id: "engagement-match", label: "Engagement Match (Revit)", category: "Design Accelerator", status: "live" }) },
  { id: "renders", label: "Renders", category: "Design Accelerator", engine: "engagement", status: "live", component: stub({ id: "renders", label: "Renders", category: "Design Accelerator", status: "live" }) },
  { id: "collateral-export", label: "Collateral Export", category: "Design Accelerator", engine: "engagement", status: "live", component: stub({ id: "collateral-export", label: "Collateral Export", category: "Design Accelerator", status: "live" }) },
  // Deliverable
  { id: "letter", label: "Deliverable Letter", category: "Deliverable", engine: "engagement", status: "live", component: () => <LetterTile /> },
  { id: "letter-render", label: "Letter Render", category: "Deliverable", engine: "engagement", status: "live", component: stub({ id: "letter-render", label: "Letter Render", category: "Deliverable", status: "live" }) },
  { id: "letter-send", label: "Letter Send", category: "Deliverable", engine: "engagement", status: "live", component: stub({ id: "letter-send", label: "Letter Send", category: "Deliverable", status: "live" }) },
  // Market
  { id: "avm", label: "AVM / Valuation", category: "Market", engine: "engagement", status: "partial", degradedReason: "Cotality AVM keys present; not fully wired.", component: stub({ id: "avm", label: "AVM / Valuation", category: "Market", status: "partial", degradedReason: "Cotality AVM keys present; not fully wired." }) },
  { id: "rent-comps", label: "Rent / Comps", category: "Market", engine: "engagement", status: "partial", degradedReason: "Cotality demo quota: 100 req/day, expires ~2026-07-06.", component: stub({ id: "rent-comps", label: "Rent / Comps", category: "Market", status: "partial", degradedReason: "Cotality demo quota: 100 req/day, expires ~2026-07-06." }) },
  { id: "pro-forma", label: "Cash-Flow Pro Forma", category: "Market", status: "planned", component: stub({ id: "pro-forma", label: "Cash-Flow Pro Forma", category: "Market", status: "planned" }) },
  { id: "deal-score", label: "Deal Score", category: "Market", status: "planned", component: stub({ id: "deal-score", label: "Deal Score", category: "Market", status: "planned" }) },
  { id: "motivated-seller", label: "Motivated Seller Heat", category: "Market", status: "planned", component: stub({ id: "motivated-seller", label: "Motivated Seller Heat", category: "Market", status: "planned" }) },
  { id: "rehab-opportunity", label: "Rehab Opportunity", category: "Market", status: "planned", component: stub({ id: "rehab-opportunity", label: "Rehab Opportunity", category: "Market", status: "planned" }) },
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
