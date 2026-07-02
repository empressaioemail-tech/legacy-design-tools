// Tile capability registry — the SERIALIZABLE, React-FREE source of truth.
//
// PURE DATA MODULE — no runtime deps, no React. This is imported by BOTH:
//   - the SPA app (artifacts/codex-reviewer-qa/src/tile-shell/tiles.tsx), which
//     derives its TILE_REGISTRY capability fields from here and attaches the
//     React `el` factories locally; and
//   - the api-server BFF (artifacts/api-server/src/routes/planReviewBff.ts),
//     which serves this array verbatim over
//     GET /api/plan-review/admin/tile-registry so the Hauska MCP server's
//     compose_workspace tool can read the capability contract server-to-server.
//
// Because both consumers read the same array there is exactly one source of
// truth and the endpoint and the app cannot drift. The app's TileDef adds the
// `el: () => React.ReactElement` factory on top of each entry here; that factory
// is the ONLY field intentionally absent from TileCapability (it is not
// serializable and the server does not need it).
//
// Keep this module free of React and of any @workspace/* import — the api-server
// must be able to import it in a Node process.

export type TileCapabilityStatus = 'live' | 'degraded' | 'partial' | 'planned'

export type TileCapabilityCategory =
  | 'Compliance'
  | 'Site Analysis'
  | 'Property Intel'
  | 'Design Accelerator'
  | 'Deliverable'
  | 'Market'

/**
 * The machine-readable capability descriptor for a single tile. Mirrors the
 * app-side TileDef exactly EXCEPT for the non-serializable `el` React factory.
 * `compose_workspace` reads requires/produces/modes/mcpTools to decide which
 * tiles a given engagement context can satisfy.
 */
export type TileCapability = {
  id: string
  label: string
  category: TileCapabilityCategory
  status: TileCapabilityStatus
  degradedReason?: string
  /** Which shell provider backs this tile. */
  engine?: 'engagement' | 'spatial' | 'code'
  requires: {
    engagementId?: boolean
    apn?: boolean
    jurisdiction?: boolean
    uploadedDocuments?: boolean
    completedFindings?: boolean
  }
  produces: {
    spatialOverlays?: boolean
    findings?: boolean
    annotations?: boolean
    letter?: boolean
  }
  modes: Array<'full' | 'card' | 'inline' | 'raw'>
  minWidth?: number
  /** Minimum grid column share the tile prefers (0..1). */
  minColShare?: number
  /** Which MCP tools back this tile. Empty [] is honest (planned/client-only). */
  mcpTools: string[]
}

export const TILE_CAPABILITIES: TileCapability[] = [
  // ─── Compliance ──────────────────────────────────────────────────
  {
    id: 'intake',
    label: 'Intake & Upload',
    category: 'Compliance',
    engine: 'engagement',
    status: 'live',
    requires: { engagementId: false },
    produces: {},
    modes: ['full', 'card', 'raw'],
    mcpTools: ['create_engagement', 'upload_document', 'parse_intake'],
  },
  {
    id: 'intake-queue',
    label: 'Intake & Queue',
    category: 'Compliance',
    engine: 'engagement',
    status: 'live',
    requires: {},
    produces: {},
    modes: ['full', 'card', 'raw'],
    mcpTools: ['get_queue'],
  },
  {
    id: 'compliance-run',
    label: 'Compliance Run',
    category: 'Compliance',
    engine: 'engagement',
    status: 'live',
    requires: { engagementId: true, uploadedDocuments: true },
    produces: { findings: true, spatialOverlays: true },
    modes: ['full', 'card', 'raw'],
    mcpTools: ['run_compliance_pass', 'get_compliance_findings'],
  },
  {
    id: 'document-viewer',
    label: 'Document Viewer',
    category: 'Compliance',
    engine: 'engagement',
    status: 'live',
    requires: { engagementId: true, uploadedDocuments: true },
    produces: { annotations: true },
    modes: ['full'],
    mcpTools: [],
  },
  {
    id: 'findings-library',
    label: 'Findings Library',
    category: 'Compliance',
    engine: 'engagement',
    status: 'live',
    requires: { engagementId: true },
    produces: { findings: true },
    modes: ['full', 'card', 'raw'],
    mcpTools: ['get_compliance_findings'],
  },
  {
    id: 'calibration',
    label: 'Finding Calibration',
    category: 'Compliance',
    engine: 'engagement',
    status: 'live',
    requires: { engagementId: true, completedFindings: true },
    produces: {},
    modes: ['full', 'card', 'raw'],
    mcpTools: ['get_calibration_report'],
  },
  {
    id: 'precedence',
    label: 'Precedence Engine',
    category: 'Compliance',
    engine: 'code',
    status: 'degraded',
    degradedReason:
      'Production gate not activated; most-stringent-governs logic built but disabled in production.',
    requires: { jurisdiction: true },
    produces: {},
    modes: ['full', 'raw'],
    mcpTools: ['get_precedence'],
  },
  {
    id: 'icc-ingest',
    label: 'ICC Code Connect Ingest',
    category: 'Compliance',
    engine: 'code',
    status: 'partial',
    degradedReason: 'Credentials live; API contract not verified.',
    requires: { jurisdiction: true },
    produces: {},
    modes: ['full', 'raw'],
    mcpTools: [],
  },
  {
    id: 'ahj-precedent',
    label: 'Permit AHJ Precedent',
    category: 'Compliance',
    status: 'planned',
    requires: { jurisdiction: true },
    produces: {},
    modes: ['full'],
    mcpTools: [],
  },
  {
    id: 'code-broadcast',
    label: 'Code Change Broadcast',
    category: 'Compliance',
    status: 'planned',
    requires: { jurisdiction: true },
    produces: {},
    modes: ['full'],
    mcpTools: [],
  },
  // ─── Site Analysis ───────────────────────────────────────────────
  {
    id: 'topography',
    label: 'Topography',
    category: 'Site Analysis',
    engine: 'spatial',
    status: 'live',
    requires: { engagementId: true },
    produces: { spatialOverlays: true },
    modes: ['full', 'card', 'raw'],
    mcpTools: ['get_topography'],
  },
  {
    id: 'drainage',
    label: 'Drainage',
    category: 'Site Analysis',
    engine: 'spatial',
    status: 'live',
    requires: { engagementId: true },
    produces: { spatialOverlays: true },
    modes: ['full', 'card', 'raw'],
    mcpTools: ['get_drainage'],
  },
  {
    id: 'hydrology',
    label: 'Hydrology',
    category: 'Site Analysis',
    engine: 'spatial',
    status: 'degraded',
    degradedReason: 'pysheds not installed in Cloud Run worker.',
    requires: { engagementId: true },
    produces: { spatialOverlays: true },
    modes: ['full', 'card', 'raw'],
    mcpTools: ['get_hydrology'],
  },
  {
    id: 'subsurface',
    label: 'Subsurface Suitability',
    category: 'Site Analysis',
    engine: 'spatial',
    status: 'partial',
    degradedReason: 'SSURGO ECONNRESET — USDA TLS issue.',
    requires: { engagementId: true },
    produces: { spatialOverlays: true },
    modes: ['full', 'card', 'raw'],
    mcpTools: ['get_subsurface'],
  },
  {
    id: 'stormwater',
    label: 'Stormwater / Detention',
    category: 'Site Analysis',
    status: 'planned',
    requires: { engagementId: true },
    produces: { spatialOverlays: true },
    modes: ['full'],
    mcpTools: [],
  },
  {
    id: 'cut-fill',
    label: 'Grading / Cut-Fill',
    category: 'Site Analysis',
    status: 'planned',
    requires: { engagementId: true },
    produces: { spatialOverlays: true },
    modes: ['full'],
    mcpTools: [],
  },
  {
    id: 'solar',
    label: 'Solar / Aspect',
    category: 'Site Analysis',
    status: 'planned',
    requires: { engagementId: true },
    produces: { spatialOverlays: true },
    modes: ['full'],
    mcpTools: [],
  },
  {
    id: 'viewshed',
    label: 'Viewshed',
    category: 'Site Analysis',
    status: 'planned',
    requires: { engagementId: true },
    produces: { spatialOverlays: true },
    modes: ['full'],
    mcpTools: [],
  },
  {
    id: 'map',
    label: 'Map',
    category: 'Site Analysis',
    engine: 'spatial',
    status: 'live',
    minColShare: 0.3,
    requires: {},
    produces: { spatialOverlays: true },
    modes: ['full', 'raw'],
    mcpTools: [],
  },
  // ─── Property Intel ──────────────────────────────────────────────
  {
    id: 'property-brief',
    label: 'Property Brief',
    category: 'Property Intel',
    engine: 'engagement',
    status: 'live',
    requires: { engagementId: true, apn: true },
    produces: {},
    modes: ['full', 'card', 'inline', 'raw'],
    mcpTools: ['get_property_brief'],
  },
  {
    id: 'hazard',
    label: 'Hazard Profile',
    category: 'Property Intel',
    engine: 'spatial',
    status: 'live',
    requires: { engagementId: true, apn: true },
    produces: { spatialOverlays: true },
    modes: ['full', 'card', 'inline', 'raw'],
    mcpTools: ['get_hazard_profile'],
  },
  {
    id: 'place-dossier',
    label: 'Place Dossier',
    category: 'Property Intel',
    engine: 'engagement',
    status: 'live',
    requires: { engagementId: true },
    produces: {},
    modes: ['full', 'card', 'raw'],
    mcpTools: ['get_place_dossier'],
  },
  {
    id: 'encumbrances',
    label: 'Encumbrance Report',
    category: 'Property Intel',
    engine: 'engagement',
    status: 'live',
    requires: { engagementId: true, apn: true },
    produces: {},
    modes: ['full', 'card', 'raw'],
    mcpTools: ['get_encumbrances'],
  },
  {
    id: 'setbacks',
    label: 'Local Setbacks',
    category: 'Property Intel',
    engine: 'code',
    status: 'live',
    requires: { apn: true, jurisdiction: true },
    produces: {},
    modes: ['full', 'card', 'inline', 'raw'],
    mcpTools: ['get_setbacks'],
  },
  {
    id: 'climate-risk',
    label: 'Climate Risk Trajectory',
    category: 'Property Intel',
    status: 'planned',
    requires: { apn: true },
    produces: {},
    modes: ['full'],
    mcpTools: [],
  },
  {
    id: 'insurance-estimate',
    label: 'Insurance Cost Estimate',
    category: 'Property Intel',
    status: 'planned',
    requires: { apn: true },
    produces: {},
    modes: ['full'],
    mcpTools: [],
  },
  {
    id: 'jurisdiction-rank',
    label: 'Jurisdiction Comparison',
    category: 'Property Intel',
    status: 'planned',
    requires: { jurisdiction: true },
    produces: {},
    modes: ['full'],
    mcpTools: [],
  },
  // ─── Design Accelerator ──────────────────────────────────────────
  {
    id: 'sheet-extraction',
    label: 'Sheet Extraction',
    category: 'Design Accelerator',
    engine: 'engagement',
    status: 'live',
    requires: { engagementId: true, uploadedDocuments: true },
    produces: {},
    modes: ['full', 'card', 'raw'],
    mcpTools: ['extract_sheets', 'get_sheets'],
  },
  {
    id: 'doc-parsing',
    label: 'Document Parsing',
    category: 'Design Accelerator',
    engine: 'engagement',
    status: 'live',
    requires: { engagementId: true, uploadedDocuments: true },
    produces: {},
    modes: ['full', 'card', 'raw'],
    mcpTools: ['parse_document'],
  },
  {
    id: 'product-spec',
    label: 'Product Spec Reference',
    category: 'Design Accelerator',
    engine: 'code',
    status: 'live',
    requires: {},
    produces: {},
    modes: ['full', 'card', 'raw'],
    mcpTools: ['get_product_spec'],
  },
  {
    id: 'detail-callouts',
    label: 'Detail Callout Specs',
    category: 'Design Accelerator',
    engine: 'engagement',
    status: 'live',
    requires: { engagementId: true },
    produces: {},
    modes: ['full', 'card', 'raw'],
    mcpTools: ['get_detail_callouts'],
  },
  {
    id: 'response-tasks',
    label: 'Response Tasks',
    category: 'Design Accelerator',
    engine: 'engagement',
    status: 'live',
    requires: { engagementId: true, completedFindings: true },
    produces: {},
    modes: ['full', 'card', 'raw'],
    mcpTools: ['get_response_tasks'],
  },
  {
    id: 'bim-query',
    label: 'BIM Model Query',
    category: 'Design Accelerator',
    engine: 'engagement',
    status: 'live',
    requires: { engagementId: true },
    produces: {},
    modes: ['full', 'card', 'raw'],
    mcpTools: ['query_bim_model'],
  },
  {
    id: 'ifc-ingest',
    label: 'IFC Ingest',
    category: 'Design Accelerator',
    engine: 'engagement',
    status: 'live',
    requires: { engagementId: true, uploadedDocuments: true },
    produces: {},
    modes: ['full', 'card', 'raw'],
    mcpTools: ['ingest_ifc'],
  },
  {
    id: 'engagement-match',
    label: 'Engagement Match (Revit)',
    category: 'Design Accelerator',
    engine: 'engagement',
    status: 'live',
    requires: { engagementId: true },
    produces: {},
    modes: ['full', 'card', 'raw'],
    mcpTools: ['match_engagement'],
  },
  {
    id: 'renders',
    label: 'Renders',
    category: 'Design Accelerator',
    engine: 'engagement',
    status: 'live',
    requires: { engagementId: true },
    produces: {},
    modes: ['full', 'card', 'raw'],
    mcpTools: ['generate_render'],
  },
  {
    id: 'collateral-export',
    label: 'Collateral Export',
    category: 'Design Accelerator',
    engine: 'engagement',
    status: 'live',
    requires: { engagementId: true },
    produces: {},
    modes: ['full', 'card', 'raw'],
    mcpTools: ['export_collateral'],
  },
  // ─── Deliverable ─────────────────────────────────────────────────
  {
    id: 'letter',
    label: 'Deliverable Letter',
    category: 'Deliverable',
    engine: 'engagement',
    status: 'live',
    requires: { engagementId: true, completedFindings: true },
    produces: { letter: true },
    modes: ['full', 'card', 'raw'],
    mcpTools: ['generate_letter'],
  },
  {
    id: 'letter-render',
    label: 'Letter Render',
    category: 'Deliverable',
    engine: 'engagement',
    status: 'live',
    requires: { engagementId: true, completedFindings: true },
    produces: { letter: true },
    modes: ['full', 'card', 'raw'],
    mcpTools: ['render_letter'],
  },
  {
    id: 'letter-send',
    label: 'Letter Send',
    category: 'Deliverable',
    engine: 'engagement',
    status: 'live',
    requires: { engagementId: true, completedFindings: true },
    produces: { letter: true },
    modes: ['full', 'card', 'raw'],
    mcpTools: ['send_letter'],
  },
  // ─── Market ──────────────────────────────────────────────────────
  {
    id: 'avm',
    label: 'AVM / Valuation',
    category: 'Market',
    engine: 'engagement',
    status: 'partial',
    degradedReason: 'Cotality AVM keys present; not fully wired.',
    requires: { apn: true },
    produces: {},
    modes: ['full', 'card', 'raw'],
    mcpTools: ['get_avm'],
  },
  {
    id: 'rent-comps',
    label: 'Rent / Comps',
    category: 'Market',
    engine: 'engagement',
    status: 'partial',
    degradedReason: 'Cotality demo quota: 100 req/day, expires ~2026-07-06.',
    requires: { apn: true },
    produces: {},
    modes: ['full', 'card', 'raw'],
    mcpTools: ['get_rent_comps'],
  },
  {
    id: 'pro-forma',
    label: 'Cash-Flow Pro Forma',
    category: 'Market',
    status: 'planned',
    requires: { apn: true },
    produces: {},
    modes: ['full'],
    mcpTools: [],
  },
  {
    id: 'deal-score',
    label: 'Deal Score',
    category: 'Market',
    status: 'planned',
    requires: { apn: true },
    produces: {},
    modes: ['full'],
    mcpTools: [],
  },
  {
    id: 'motivated-seller',
    label: 'Motivated Seller Heat',
    category: 'Market',
    status: 'planned',
    requires: { apn: true },
    produces: { spatialOverlays: true },
    modes: ['full'],
    mcpTools: [],
  },
  {
    id: 'rehab-opportunity',
    label: 'Rehab Opportunity',
    category: 'Market',
    status: 'planned',
    requires: { apn: true },
    produces: {},
    modes: ['full'],
    mcpTools: [],
  },
]

/** Fast id → capability lookup. */
export const TILE_CAPABILITY_BY_ID: Record<string, TileCapability> =
  Object.fromEntries(TILE_CAPABILITIES.map((c) => [c.id, c]))
