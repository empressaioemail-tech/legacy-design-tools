import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  P85_LIVE_EASEMENT_GIS_LAYERS,
  esriPolygonFromGeojson,
  queryLiveEasementGisForParcel,
} from "../liveEasementGisQuery";

const parcelPolygon = {
  type: "Polygon",
  coordinates: [
    [
      [-97.74, 30.26],
      [-97.739, 30.26],
      [-97.739, 30.261],
      [-97.74, 30.261],
      [-97.74, 30.26],
    ],
  ],
};

describe("queryLiveEasementGisForParcel (P-85 item 2)", () => {
  const fetchMock = vi.fn();
  /** The form body of the nth ArcGIS request (the query is POSTed, not put in the URL). */
  const formOf = (n: number) => new URLSearchParams(String((fetchMock.mock.calls[n]![1] as RequestInit).body));

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("skips city-scoped layers when county FIPS does not match", async () => {
    const audit = await queryLiveEasementGisForParcel({
      parcelKey: "48453:TEST",
      countyFips: "48453",
      parcelGeometryGeojson: parcelPolygon,
    });

    expect(fetchMock).not.toHaveBeenCalled();
    const skipped = audit.layers.filter((l) => l.skippedReason === "county_fips_mismatch");
    expect(skipped.length).toBe(P85_LIVE_EASEMENT_GIS_LAYERS.length);
    expect(audit.hits).toEqual([]);
  });

  it("skips layers outside city limits when isInsideCityScope returns false", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ features: [] }),
    });

    const audit = await queryLiveEasementGisForParcel({
      parcelKey: "48491:TEST",
      countyFips: "48491",
      parcelGeometryGeojson: parcelPolygon,
      isInsideCityScope: () => false,
    });

    expect(fetchMock).not.toHaveBeenCalled();
    const williamsonLayers = audit.layers.filter((l) =>
      ["round-rock-easements", "cedar-park-easements"].includes(l.sourceLayerId),
    );
    expect(williamsonLayers).toHaveLength(2);
    expect(
      williamsonLayers.every((l) => l.skippedReason === "outside_city_limits"),
    ).toBe(true);
  });

  it("records ArcGIS hits with recording ref and type from the first intersecting feature", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        features: [
          {
            id: 42,
            properties: {
              Recordation_Num: "2020-12345",
              Type: "Utility",
            },
            geometry: { type: "LineString", coordinates: [[-97.74, 30.26]] },
          },
        ],
      }),
    });

    const audit = await queryLiveEasementGisForParcel({
      parcelKey: "48491:ROUND-ROCK",
      countyFips: "48491",
      parcelGeometryGeojson: parcelPolygon,
      isInsideCityScope: () => true,
    });

    expect(fetchMock).toHaveBeenCalled();
    expect(audit.hits.length).toBeGreaterThan(0);
    const roundRockHit = audit.hits.find(
      (h) => h.sourceLayerId === "round-rock-easements",
    );
    expect(roundRockHit).toMatchObject({
      recordingRef: "2020-12345",
      easementType: "Utility",
      featureIds: [42],
    });
    expect(audit.layers.some((l) => l.featureCount === 1)).toBe(true);
  });

  it("records http failures without fabricating hits", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 503 });

    const audit = await queryLiveEasementGisForParcel({
      parcelKey: "48491:TEST",
      countyFips: "48491",
      parcelGeometryGeojson: parcelPolygon,
      isInsideCityScope: () => true,
    });

    expect(audit.hits).toEqual([]);
    expect(audit.layers.some((l) => l.skippedReason === "http_503")).toBe(true);
  });

  it("FALSIFIER: the geometry is Esri rings encoded once (main sent GeoJSON URL-encoded twice, which ArcGIS refuses)", async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ features: [] }) });
    await queryLiveEasementGisForParcel({
      parcelKey: "48021:TEST",
      countyFips: "48021",
      parcelGeometryGeojson: parcelPolygon,
    });
    const geometry = JSON.parse(formOf(0).get("geometry")!);
    expect(geometry.spatialReference).toEqual({ wkid: 4326 });
    expect(geometry.rings).toHaveLength(1);
    expect(geometry).not.toHaveProperty("type");
  });

  it("FALSIFIER: the query is POSTed as a form, never put in the URL (by GET services7 answered 404 for a 60-vertex Bastrop parcel)", async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ features: [] }) });
    await queryLiveEasementGisForParcel({
      parcelKey: "48021:TEST",
      countyFips: "48021",
      parcelGeometryGeojson: parcelPolygon,
    });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe(
      "https://services7.arcgis.com/qOeXJdBtGknaCJC4/arcgis/rest/services/Easements_/FeatureServer/43/query",
    );
    expect(init).toMatchObject({ method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" } });
    expect(formOf(0).get("geometryType")).toBe("esriGeometryPolygon");
    expect(formOf(0).get("f")).toBe("geojson");
  });

  it("orients rings the Esri way: outer clockwise, holes counter-clockwise", () => {
    const ccwOuter = [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]];
    const cwHole = [[4, 4], [4, 6], [6, 6], [6, 4], [4, 4]];
    const esri = esriPolygonFromGeojson({ type: "Polygon", coordinates: [ccwOuter, cwHole] })!;
    const area = (r: number[][]) => r.slice(0, -1).reduce((a, p, i) => a + p[0]! * r[i + 1]![1]! - r[i + 1]![0]! * p[1]!, 0) / 2;
    expect(area(esri.rings[0]!)).toBeLessThan(0);
    expect(area(esri.rings[1]!)).toBeGreaterThan(0);
    expect(esriPolygonFromGeojson({ type: "Point", coordinates: [0, 0] })).toBeNull();
  });

  it("FALSIFIER: an ArcGIS error body (HTTP 200) is recorded as an error, never as zero easements", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ error: { code: 400, message: "Cannot perform query. Invalid query parameters." } }),
    });
    const audit = await queryLiveEasementGisForParcel({
      parcelKey: "48021:TEST",
      countyFips: "48021",
      parcelGeometryGeojson: parcelPolygon,
    });
    const bastrop = audit.layers.find((l) => l.sourceLayerId === "bastrop-city-easements")!;
    expect(bastrop.skippedReason).toBe("arcgis_error_400: Cannot perform query. Invalid query parameters.");
    expect(audit.hits).toEqual([]);
  });

  it("pages while ArcGIS reports the transfer limit exceeded", async () => {
    fetchMock
      .mockResolvedValueOnce({ ok: true, json: async () => ({ features: [{ id: 1, properties: {} }], properties: { exceededTransferLimit: true } }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ features: [{ id: 2, properties: {} }] }) });
    const audit = await queryLiveEasementGisForParcel({
      parcelKey: "48021:TEST",
      countyFips: "48021",
      parcelGeometryGeojson: parcelPolygon,
    });
    const bastrop = audit.layers.find((l) => l.sourceLayerId === "bastrop-city-easements")!;
    expect(bastrop).toMatchObject({ featureCount: 2, featureIds: [1, 2], pages: 2 });
    expect(formOf(1).get("resultOffset")).toBe("1");
  });

  it("Bastrop: every feature carries its own recording reference (DocumentNo, Record, RecordedID) and City document link", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        features: [
          { id: 14, properties: { Status: "PUE", DocumentNo: 202303679, Record: "202303679", RecordedID: 0, Link: "https://laserfiche.cityofbastrop.org/WebLink/DocView.aspx?id=626868&dbid=0&repo=Bastrop" } },
          { id: 93, properties: { Status: "DRAINAGE EASEMENT", DocumentNo: 20251807, Record: "202501807", RecordedID: 0, Link: " " } },
          { id: 63, properties: { Status: "PUE", DocumentNo: 2, Record: "2", RecordedID: 0, Link: "http://laserfiche.cityofbastrop.org/x" } },
        ],
      }),
    });
    const audit = await queryLiveEasementGisForParcel({
      parcelKey: "48021:TEST",
      countyFips: "48021",
      parcelGeometryGeojson: parcelPolygon,
    });
    const hit = audit.hits.find((h) => h.sourceLayerId === "bastrop-city-easements")!;
    expect(hit.recordingRef).toBe("202303679");
    expect(hit.features).toEqual([
      { featureId: 14, recordingRef: "202303679", easementType: "PUE", corridorWidthFt: null, sourceDocumentUrl: "https://laserfiche.cityofbastrop.org/WebLink/DocView.aspx?id=626868&dbid=0&repo=Bastrop" },
      { featureId: 93, recordingRef: "202501807", easementType: "DRAINAGE EASEMENT", corridorWidthFt: null, sourceDocumentUrl: null },
      { featureId: 63, recordingRef: null, easementType: "PUE", corridorWidthFt: null, sourceDocumentUrl: null },
    ]);
    expect(hit.recordingRefs).toEqual(["202303679", "202501807"]);
  });
});
