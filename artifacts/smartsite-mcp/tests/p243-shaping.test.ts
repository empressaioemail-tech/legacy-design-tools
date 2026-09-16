import { describe, expect, it } from "vitest";
import { shapeSmartSiteNodeResult } from "../src/tools.js";
import { APP_RESOURCE_URI } from "../src/mcp-app.js";
import { STANDING_VOCAB_CONTENT_PART } from "../src/vocabulary.js";

/**
 * P-243. The exact live production response body for 48021:34137 (908 PINE,
 * Bastrop), captured 2026-09-16 via a real authenticated get_smart_site call
 * against smartsite-mcp-00124-bub, content[0] only (the vocabulary block,
 * content[1], is captured separately below). This is the measured "before"
 * this lane's own falsifier 2 requires: 31,826 bytes total across both
 * content parts, zero ui:// reference anywhere, vocabulary inlined.
 */
const LIVE_CONTENT0_2026_09_16 =
  '{"runId":"pe-r1-NDgwMjE6MzQxMzc.MjAyNi0wOS0xMFQxODo0NToyMy41MzZa","reportFamily":"R1","mode":"baked-facet-intel-v1","parcelNodeId":"48021:34137","onRecord":{"apn":"34137","acreage":{"value":0.3827,"sqft":16673,"method":"shoelace-wgs84"},"countyFips":"48021","countyName":"Bastrop","situsState":"TX","cadRoll":{"marketValue":{"state":"refused","code":"studio-gated","reason":"County tax-assessed valuation (market/land/improvement/assessed value) is Studio or Team only. Anonymous, free, Solo, unlock, and identified-only callers receive no dollar value."},"assessedValue":{"state":"refused","code":"studio-gated","reason":"County tax-assessed valuation (market/land/improvement/assessed value) is Studio or Team only. Anonymous, free, Solo, unlock, and identified-only callers receive no dollar value."},"landValue":{"state":"refused","code":"studio-gated","reason":"County tax-assessed valuation (market/land/improvement/assessed value) is Studio or Team only. Anonymous, free, Solo, unlock, and identified-only callers receive no dollar value."},"improvementValue":{"state":"refused","code":"studio-gated","reason":"County tax-assessed valuation (market/land/improvement/assessed value) is Studio or Team only. Anonymous, free, Solo, unlock, and identified-only callers receive no dollar value."},"livingAreaSqft":{"state":"absent","source":"cad_property","vintage":"2025","basis":"48021:34137: cad_property.livingAreaSqft is absent"}},"asOf":"2026-09-10T18:45:23.536Z"},"brief":{"sections":[{"id":"zoning","title":"Zoning","data":{"district":"SF-1","jurisdictionKey":"bastrop-tx","provenance":"https://services7.arcgis.com/qOeXJdBtGknaCJC4/arcgis/rest/services/Zoned_Parcels/FeatureServer/83"},"citations":[],"asOf":"2026-09-02T14:45:16.934Z","disposition":"present","citationsDegraded":true,"dispositionDisplayText":"Present"},{"id":"setbacks-envelope","title":"Setbacks and buildable envelope","data":{"frontFt":30,"sideFt":10,"rearFt":30,"cornerFt":20},"citations":[],"asOf":"2026-09-10T22:33:31.180Z","disposition":"present","citationsDegraded":true,"dispositionDisplayText":"Present"},{"id":"flood","title":"Flood","data":{"state":"value","source":"parcel_record","placeKey":"48021:34137","floodZone":"X","floodway":false,"baseFloodElevation":null,"method":"point-on-surface","sourceVintage":"NFHL_48_20260101"},"citations":[],"asOf":"NFHL_48_20260101","disposition":"present","citationsDegraded":true,"dispositionDisplayText":"Present"},{"id":"land-use","title":"Land use","data":{"landUseCode":"A1","landUseLabel":null},"citations":[],"asOf":"2026-08-12T15:29:51.070Z","disposition":"present","citationsDegraded":true,"dispositionDisplayText":"Present"},{"id":"drainage","title":"Drainage","data":null,"citations":[],"asOf":"2026-09-10T18:45:23.536Z","disposition":"unread","reason":"drainage facet not produced for this parcel","dispositionDisplayText":"Not read","agentGuidance":"This facet is not read for this parcel on this call. Do not invent drainage infrastructure, capacity, or a compliance state."}],"disclosure":[]},"citations":[],"structuralFact":{"state":"present","source":"structural-fact","provenanceClass":"Record","subjectKind":"extensional","chainAnchoring":"backfill","serveLayer":"cad","entityType":"cad_property","countyFips":"48021","propId":"34137","taxYear":2025,"tier":"cad-export","livingAreaSqft":null,"yearBuilt":1910,"sourceVintage":"tier:stratmap-roll;adapter:stratmap;drop:stratmap25-landparcels_48021_lp"},"cityLimitsFact":{"status":"incorporated","etjStatus":"unresolved","source":"tx_city_boundary","basis":"parcel_record cityLimits: incorporated, city \'Bastrop\' (source: landing_parcel_jurisdiction, vintage: 2026-09-02T18:13:56.751Z).","cityName":"Bastrop","queryPoint":{"longitude":-97.31654,"latitude":30.10981}},"utilityServiceFact":{"state":"present","source":"utility-service-fact","entityId":"48021:34137","water":null,"sewer":{"ccnNo":"20466","utility":"CITY OF BASTROP","status":"Commission Approved","ccnType":"Bounded Service Area"},"electric":{"ccnNo":"1324","utility":"CITY OF BASTROP - (TX)","status":"NOT AVAILABLE","ccnType":"MUNICIPAL"},"sourceAdapter":"parcel_record","sourceVintage":"2026-09-03T18:38:34.997Z","evaluatedAt":"2026-09-03T18:38:34.997Z"},"overlayDistrictsFact":{"state":"present","source":"overlay-districts-fact","entityId":"48021:34137","districts":[{"city":"Bastrop","attributes":{"CD_Desc":"Downtown Bastrop is laid out in an almost perfect series of small gridded blocks.","CD_Name":"Downtown","OBJECTID":2,"Shape__Area":4285163.396484375,"overlayName":"Downtown","Shape__Length":8810.829531821902,"CD_DevelopmentPatterns":"TND"}}],"sourceAdapter":"parcel_record","sourceVintage":"2026-09-05T00:49:23.452Z","evaluatedAt":"2026-09-05T00:49:23.452Z"},"agValuationFact":{"state":"refused","code":"not-cut-over","source":"ag-valuation-fact","entityId":"48021:34137","reason":"agValuation has no legacy serve path -- it is served only from parcel_record (Williamson and Travis counties only), and only once this (county, rail) pair is slated with a passing gate verdict. Not there yet for this parcel."},"schoolDistrictFact":{"state":"present","source":"school-district-fact","entityId":"48021:34137","districtName":"Bastrop ISD","districtCode":"011-901","geoid":"4809570","sourceAdapter":"parcel_record","sourceVintage":"2026-09-03T16:50:31.471Z","evaluatedAt":"2026-09-03T16:50:31.471Z"},"maxImperviousCoverPctFact":{"state":"refused","code":"not-cut-over","source":"max-impervious-cover-pct-fact","entityId":"48021:34137","reason":"maxImperviousCoverPct has no legacy serve path -- it is served only from parcel_record (Travis/Austin only), and only once this (county, rail) pair is slated with a passing gate verdict. Not there yet for this parcel."},"buildingFootprintFact":{"state":"present","source":"building-footprint","boundAs":"48021:34137:footprint","tried":["48021:34137","48021:34137.00000000"],"entityId":"48021:34137:footprint","footprintId":"primary","structureRole":"primary","sourceTier":"ml-derived","verificationStatus":"unsurveyed","confidence":null,"footprintGeometry":{"type":"Polygon","coordinates":[[[-97.316627,30.109681],[-97.316458,30.109685],[-97.316462,30.109859],[-97.316631,30.109855],[-97.316627,30.109681]]]},"footprints":[{"entityId":"48021:34137:footprint","footprintId":"primary","structureRole":"primary","sourceTier":"ml-derived","verificationStatus":"unsurveyed","confidence":null,"footprintGeometry":{"type":"Polygon","coordinates":[[[-97.316627,30.109681],[-97.316458,30.109685],[-97.316462,30.109859],[-97.316631,30.109855],[-97.316627,30.109681]]]}}],"sourceAdapter":"ml-global-building-footprints-v1","sourceVintage":"GlobalMLBuildingFootprints-Texas","evaluatedAt":"2026-09-13T05:06:52.372Z"},"valueHistoryFact":{"state":"present","source":"value-history-fact","entityId":"48021:34137","entries":[{"taxYear":2025,"marketValue":511345,"assessedValue":null,"landValue":106715,"improvementValue":404630,"viaCrosswalk":false}],"sourceAdapter":"parcel_record","sourceVintage":"2025","evaluatedAt":"2025"},"setbackRulesFact":{"state":"present","source":"setback-rules-fact","entityId":"48021:34137","matchKind":"matched","citationUrl":"https://www.cityofbastrop.org/page/open/18744/0/ORDINANCE.pdf","districtCode":"SF-1","districtName":"SF-1 Single-Family Residential","effectiveDate":"2026-04-14","jurisdictionKey":"bastrop-development-code","resolvedTableKey":"bastrop-development-code","note":"WDLL 2026-07-29 BDC STEP 3 item 1.","sourceAdapter":"parcel_record","sourceVintage":"2026-09-10T22:33:31.180Z","evaluatedAt":"2026-09-10T22:33:31.180Z"},"parcelAreaSqFtFact":{"state":"present","source":"parcel-area-sqft-fact","entityId":"48021:34137","sqFt":16616.91,"method":"ST_Area(geography) over ST_MakeValid(ST_Union(...)) of all fragments for this prop_id","fragmentCount":1,"sourceAdapter":"parcel_record","sourceVintage":"2026-09-11T01:11:32.598Z","evaluatedAt":"2026-09-11T01:11:32.598Z"},"maxHeightFtFact":{"state":"present","source":"max-height-ft-fact","entityId":"48021:34137","feet":35,"citationUrl":"https://www.cityofbastrop.org/page/open/18744/0/ORDINANCE.pdf","districtCode":"SF-1","districtName":"SF-1 Single-Family Residential","jurisdictionKey":"bastrop-development-code","sourceAdapter":"parcel_record","sourceVintage":"2026-09-11T01:11:32.598Z","evaluatedAt":"2026-09-11T01:11:32.598Z"},"maxLotCoveragePctFact":{"state":"absent","source":"max-lot-coverage-pct-fact","entityId":"48021:34137","absence":{"kind":"absent-verified","reason":"ENVELOPE_ROUTER_FIELD_NOT_SPECIFIED"},"verifiedAbsence":true,"sourceTier":"envelope-corpus-lookup.resolveEnvelopeForParcel","sourceAdapter":"parcel_record","sourceVintage":"2026-09-11T01:11:32.598Z"},"maxFootprintSqFtFact":{"state":"absent","source":"max-footprint-sqft-fact","entityId":"48021:34137","absence":{"kind":"absent-verified","reason":"maxLotCoveragePct is not a value for this parcel"},"verifiedAbsence":true,"sourceTier":"parcelAreaSqFt x maxLotCoveragePct / 100","sourceAdapter":"parcel_record","sourceVintage":"2026-09-11T01:11:32.598Z"},"specialDistrictFact":{"state":"absent","source":"special-district-fact","boundAs":"48021:34137","tried":["48021:34137","48021:34137"],"entityId":"48021:34137","absence":{"kind":"absent-verified","reason":"no tx_special_district polygon intersects this parcel\'s geometry"},"verifiedAbsence":true,"sourceTier":"zone-major-sweep","sourceAdapter":"parcel_record","sourceVintage":"2026-09-02T14:46:32.344Z"},"pipelineFact":{"state":"present","source":"rrc-pipeline-fact","boundAs":"48021:34137","tried":["48021:34137","48021:34137.00000000"],"entityId":"48021:34137","nearPipeline":false,"bufferMeters":152.4,"nearestPipelineDistanceMeters":null,"t4permit":null,"p5Num":null,"operatorName":null,"systemName":null,"commodity":null,"commodityDescription":null,"systemType":null,"status":"active","diameter":null,"interstate":null,"sourceAdapter":"tx-rrc-pipeline-staged-v1","sourceVintage":"UNKNOWN","evaluatedAt":"2026-08-16T15:30:55.035Z"},"wellFact":{"state":"absent","source":"well-fact","boundAs":"48021:34137","tried":["48021:34137","48021:34137"],"entityId":"48021:34137","absence":{"kind":"absent-verified","reason":"no tx_rrc_well point falls within this parcel\'s geometry"},"verifiedAbsence":true,"sourceTier":"zone-major-sweep","sourceAdapter":"parcel_record","sourceVintage":"2026-09-02T14:46:32.344Z"},"ownerFact":{"state":"refused","code":"studio-gated","source":"owner-fact","reason":"owner-fact is Studio or Team only, or requires an active property unlock on this parcel. This tool does not carry owner data at any depth without one of those."},"landUseFact":{"state":"present","source":"land-use-fact","boundAs":"48021:34137:2025","tried":["48021:34137","48021:34137.00000000"],"entityId":"48021:34137:2025","taxYear":2025,"landUseCode":"A1","landUseLabel":null,"sourceAdapter":"cad-property-land-use-v1","sourceVintage":"data-export-01.14.2026","evaluatedAt":"2026-08-12T15:29:51.070Z"},"bakedAt":"2026-09-10T18:45:23.536Z","source":"baked-snapshot","draw":{"node":"48021:34137","kind":"parcel","label":"908 PINE , BASTROP, TX 78602","url":"https://smartsite.cloud/p/48021:34137","asOf":"2026-09-10T18:45:23.536Z","frame":{"units":"ft","origin":"centroid"},"attrs":{"zoning":{"v":"SF-1","state":"present"}},"overlays":[{"id":"flood","label":"Zone X","sfha":false,"state":"present"},{"id":"footprint","label":"Structure of record (1910), footprint unmeasured","state":"unknown"},{"id":"envelope","label":"Buildable envelope (modelled from setbacks)","state":"present","basis":"modelled-figure-withheld"},{"id":"pipeline","label":"No pipeline within 500 ft","draw":"legend-only","state":"unknown","reason":"provenance degraded; vintage unknown","provenance":"degraded","vintage":"UNKNOWN","reasonDisplayText":"provenance degraded; vintage unknown","finding":null},{"id":"specialDistrict","label":"Outside mapped special districts","state":"absent-verified"},{"id":"well","label":"No well of record within screening distance","state":"absent-verified"}],"confidence":"seed","ring":[[48.6,83.94],[-50.37,83.7],[-49.07,-84.28],[50.84,-83.36]]},"anchor":{"lat":30.10981,"lon":-97.31654,"precision":"1e-5-deg","source":"bake-latlng-index"},"anchorRead":{"status":"ok"}}';

const LIVE_VOCAB_BLOCK_BYTES = Buffer.byteLength(STANDING_VOCAB_CONTENT_PART.text, "utf8");

describe("P-243: get_smart_site single-node shaping", () => {
  it("parses as the same JSON object measured live 2026-09-16 (self-check on the fixture)", () => {
    expect(() => JSON.parse(LIVE_CONTENT0_2026_09_16)).not.toThrow();
  });

  it("binds the app resource via a spec-standard resource_link the dispatch found missing", () => {
    const result = shapeSmartSiteNodeResult(LIVE_CONTENT0_2026_09_16);
    const link = result.content.find((c) => c.type === "resource_link");
    expect(link).toBeDefined();
    expect((link as { uri: string }).uri).toBe(APP_RESOURCE_URI);
  });

  it("carries the full original record in structuredContent, byte-identical to the old content[0]", () => {
    const result = shapeSmartSiteNodeResult(LIVE_CONTENT0_2026_09_16);
    expect(result.structuredContent).toEqual(JSON.parse(LIVE_CONTENT0_2026_09_16));
  });

  it("skips the standing vocabulary block (content[0] is composed prose, not raw tokens)", () => {
    const result = shapeSmartSiteNodeResult(LIVE_CONTENT0_2026_09_16);
    expect(result.skipStandingVocab).toBe(true);
    expect(result.content.some((c) => c.type === "text" && c.text.includes("smartSiteVocabulary"))).toBe(false);
  });

  it("shrinks content[0] well below the 31,826-byte live-measured total (falsifier 2)", () => {
    const result = shapeSmartSiteNodeResult(LIVE_CONTENT0_2026_09_16);
    const shapedText = (result.content.find((c) => c.type === "text") as { text: string }).text;
    const before = Buffer.byteLength(LIVE_CONTENT0_2026_09_16, "utf8") + LIVE_VOCAB_BLOCK_BYTES;
    const after = Buffer.byteLength(shapedText, "utf8");
    // eslint-disable-next-line no-console
    console.log(`P-243 payload measurement: before=${before}B (content[0]+vocab) after=${after}B (shaped content[0])`);
    expect(after).toBeLessThan(6000);
    expect(after).toBeLessThan(before * 0.25);
  });

  it("never invents a citation where citationsDegraded is true (falsifier 3 / degraded-citation honesty)", () => {
    const result = shapeSmartSiteNodeResult(LIVE_CONTENT0_2026_09_16);
    const shapedText = (result.content.find((c) => c.type === "text") as { text: string }).text;
    // Every present brief section in the fixture has citationsDegraded true
    // and an empty citations[] -- the table must say so, never print a URL.
    expect(shapedText).toContain("citation degraded");
    expect(shapedText).not.toMatch(/https?:\/\//);
  });

  it("renders the P-217 pipeline disagreement honestly, both halves, never collapsed (known trap)", () => {
    const result = shapeSmartSiteNodeResult(LIVE_CONTENT0_2026_09_16);
    const shapedText = (result.content.find((c) => c.type === "text") as { text: string }).text;
    expect(shapedText).toContain("no pipeline within ~500 ft");
    expect(shapedText).toMatch(/unknown/);
    expect(shapedText).toContain("UNKNOWN");
  });

  it("never renders owner data or valueHistoryFact's dollar figures in the shaped table (P-220 / P-246 scope discipline)", () => {
    const result = shapeSmartSiteNodeResult(LIVE_CONTENT0_2026_09_16);
    const shapedText = (result.content.find((c) => c.type === "text") as { text: string }).text;
    expect(shapedText).not.toContain("511345");
    expect(shapedText).not.toContain("106715");
    expect(shapedText).not.toContain("404630");
    // The full figures still travel in structuredContent for a caller entitled to read them.
    expect((result.structuredContent as { valueHistoryFact: { entries: Array<{ marketValue: number }> } }).valueHistoryFact.entries[0].marketValue).toBe(511345);
  });

  it("still shows zoning, setbacks, flood, and drainage's honest not-read state", () => {
    const result = shapeSmartSiteNodeResult(LIVE_CONTENT0_2026_09_16);
    const shapedText = (result.content.find((c) => c.type === "text") as { text: string }).text;
    expect(shapedText).toContain("SF-1");
    expect(shapedText).toContain("30/10/30/20");
    expect(shapedText).toMatch(/\| Flood \| `X` \|/);
    expect(shapedText).toContain("Not read");
  });
});
