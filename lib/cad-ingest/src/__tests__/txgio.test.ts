/**
 * TxGIO parcel-store unit tests — grid-cell tile bucketing, bbox math,
 * point-in-polygon (against a REAL Hays parcel), feature
 * normalization, the WGS84 .prj guard, county routing, and the
 * cad-ingest CLI micro-fixes (vintage URL-decode).
 */

import { describe, expect, it } from "vitest";
import {
  TEXAS_WGS84_BOUNDS,
  TXGIO_MAX_FEATURE_CELLS,
  TXGIO_TILE_GRID_DEG,
  bboxOfGeometry,
  bboxesIntersect,
  cellCountForBbox,
  cellKeyForPoint,
  cellKeysForBbox,
  isPlausibleTexasWgs84Bbox,
  normalizeDigitId,
  pointInGeometry,
  trueInteriorPoint,
  type GeoJsonGeometry,
} from "../txgio/geo";
import {
  assertDeclineCeiling,
  assertFinalDeclineCeiling,
  assertTexasWgs84Bbox,
  assertWgs84Prj,
  classifyPrj,
  isNullPlaceholderFeature,
  normalizeTxgioFeature,
  TxgioDeclineCeilingError,
  TxgioProjectionError,
  TXGIO_ENTRY_FILTER,
  TXGIO_MAX_DECLINED_ABSOLUTE,
} from "../txgio/parse";
import {
  reprojectGeometry,
  webMercatorToWgs84,
  wgs84ToWebMercator,
  TxgioReprojectionError,
  WEB_MERCATOR_MAX_M,
  WEB_MERCATOR_RADIUS_M,
} from "../txgio/reproject";
import {
  vintageWithProvenance,
  REPROJECTED_VINTAGE_SUFFIX,
  storeLoadedLabel,
  storeListLoadState,
} from "../txgio/ingest";
import {
  isParcelShapedPropId,
  normalizeStatLandUse,
  normalizeStratMapLandUse,
  NOT_A_PARCEL_PROP_ID_REASON,
} from "../txgio/landuse";
import {
  isTexasCountyFips,
  isTxgioCountyLoaded,
  resolveTxgioCounty,
  TXGIO_ABSENT_FROM_STRATMAP,
  TXGIO_COUNTIES,
  TXGIO_STATEWIDE_COUNTIES,
  txgioDownloadUrl,
} from "../txgio/counties";
import { deriveVintage } from "../download";
import { newCounters } from "../types";
import {
  HAYS_PARCEL_12310,
  HAYS_PARCEL_12310_INSIDE,
  HAYS_PARCEL_12310_OUTSIDE,
  HAYS_PRJ_WGS84,
  KING_48269_REPROJECTED_BBOX,
  KING_48269_WEB_MERCATOR_BBOX,
  KING_48269_WEB_MERCATOR_PARCEL,
  TEXAS_ROUND_TRIP_POINTS,
  TX_STATE_PLANE_PRJ,
  TXGIO_202505_WEB_MERCATOR_PRJ,
  WEB_MERCATOR_REFERENCE_PAIRS,
} from "./__fixtures__/txgioHaysParcel";

const HAYS_GEOMETRY = HAYS_PARCEL_12310.geometry as unknown as GeoJsonGeometry;

describe("grid-cell keys (tile bucketing)", () => {
  it("snaps a point down to its cell's lower-left corner (5dp, byte-stable)", () => {
    // -97.91274 / 0.02 = -4895.637 -> floor -4896 -> -97.92
    expect(cellKeyForPoint(-97.91274, 29.89535)).toBe("g0.02:-97.92000,29.88000");
    // Same cell for any point inside it.
    expect(cellKeyForPoint(-97.9001, 29.8999)).toBe("g0.02:-97.92000,29.88000");
    // Adjacent cell across the boundary.
    expect(cellKeyForPoint(-97.92001, 29.88)).toBe("g0.02:-97.94000,29.88000");
  });

  it("covers a bbox with every intersecting cell, iterated without float drift", () => {
    const keys = cellKeysForBbox({
      westLng: -97.93,
      southLat: 29.89,
      eastLng: -97.9,
      northLat: 29.91,
    });
    // lng cells: -97.94, -97.92, -97.90 (3); lat cells: 29.88, 29.90 (2).
    expect(keys).toHaveLength(6);
    expect(keys).toContain("g0.02:-97.94000,29.88000");
    expect(keys).toContain("g0.02:-97.90000,29.90000");
    // Every key the point helper would produce inside the bbox is covered.
    expect(keys).toContain(cellKeyForPoint(-97.905, 29.895));
  });

  it("returns null above maxCells so readers can fall back to a bbox scan", () => {
    const bbox = { westLng: -98.5, southLat: 29.5, eastLng: -97.5, northLat: 30.5 };
    expect(cellKeysForBbox(bbox, TXGIO_TILE_GRID_DEG, 256)).toBeNull();
    expect(cellKeysForBbox(bbox, TXGIO_TILE_GRID_DEG)).not.toBeNull();
  });

  it("buckets the real Hays parcel into exactly one cell (typical parcel << cell)", () => {
    const bbox = bboxOfGeometry(HAYS_GEOMETRY)!;
    const keys = cellKeysForBbox(bbox)!;
    expect(keys).toEqual(["g0.02:-97.92000,29.88000"]);
    // ...which is the same cell the point-lookup read will scan.
    expect(keys[0]).toBe(
      cellKeyForPoint(
        HAYS_PARCEL_12310_INSIDE.longitude,
        HAYS_PARCEL_12310_INSIDE.latitude,
      ),
    );
  });
});

describe("bboxOfGeometry / bboxesIntersect", () => {
  it("computes the real parcel's bbox", () => {
    const bbox = bboxOfGeometry(HAYS_GEOMETRY)!;
    expect(bbox.westLng).toBeCloseTo(-97.91313552599996, 10);
    expect(bbox.southLat).toBeCloseTo(29.895076204000077, 10);
    expect(bbox.eastLng).toBeCloseTo(-97.91233033799995, 10);
    expect(bbox.northLat).toBeCloseTo(29.895773322000025, 10);
  });

  it("returns null for empty geometry", () => {
    expect(bboxOfGeometry({ type: "Polygon", coordinates: [] })).toBeNull();
  });

  it("intersection test covers touch and containment", () => {
    const a = { westLng: 0, southLat: 0, eastLng: 2, northLat: 2 };
    expect(bboxesIntersect(a, { westLng: 2, southLat: 0, eastLng: 3, northLat: 1 })).toBe(true);
    expect(bboxesIntersect(a, { westLng: 0.5, southLat: 0.5, eastLng: 1, northLat: 1 })).toBe(true);
    expect(bboxesIntersect(a, { westLng: 2.1, southLat: 0, eastLng: 3, northLat: 1 })).toBe(false);
  });
});

describe("pointInGeometry (ray cast) — real Hays parcel 12310", () => {
  it("contains an interior point and rejects an exterior one", () => {
    expect(
      pointInGeometry(
        HAYS_PARCEL_12310_INSIDE.longitude,
        HAYS_PARCEL_12310_INSIDE.latitude,
        HAYS_GEOMETRY,
      ),
    ).toBe(true);
    expect(
      pointInGeometry(
        HAYS_PARCEL_12310_OUTSIDE.longitude,
        HAYS_PARCEL_12310_OUTSIDE.latitude,
        HAYS_GEOMETRY,
      ),
    ).toBe(false);
    // Every polygon vertex is outside-or-boundary; a point epsilon past
    // the east edge must be out.
    expect(pointInGeometry(-97.9123, 29.8956, HAYS_GEOMETRY)).toBe(false);
  });

  it("handles holes via the even-odd rule", () => {
    const donut: GeoJsonGeometry = {
      type: "Polygon",
      coordinates: [
        [
          [0, 0],
          [10, 0],
          [10, 10],
          [0, 10],
          [0, 0],
        ],
        [
          [4, 4],
          [6, 4],
          [6, 6],
          [4, 6],
          [4, 4],
        ],
      ],
    };
    expect(pointInGeometry(2, 2, donut)).toBe(true);
    expect(pointInGeometry(5, 5, donut)).toBe(false); // inside the hole
    expect(pointInGeometry(11, 5, donut)).toBe(false);
  });

  it("handles MultiPolygon parts independently", () => {
    const two: GeoJsonGeometry = {
      type: "MultiPolygon",
      coordinates: [
        [
          [
            [0, 0],
            [1, 0],
            [1, 1],
            [0, 1],
            [0, 0],
          ],
        ],
        [
          [
            [5, 5],
            [6, 5],
            [6, 6],
            [5, 6],
            [5, 5],
          ],
        ],
      ],
    };
    expect(pointInGeometry(0.5, 0.5, two)).toBe(true);
    expect(pointInGeometry(5.5, 5.5, two)).toBe(true);
    expect(pointInGeometry(3, 3, two)).toBe(false);
  });

  it("rejects non-polygon geometry types", () => {
    expect(
      pointInGeometry(0, 0, { type: "Point", coordinates: [0, 0] }),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// trueInteriorPoint (Burnet stage 3 §3 Bug 1) — a point GUARANTEED strictly
// inside a Polygon/MultiPolygon, never a vertex, never outside the ring,
// never inside a hole. Every case below asserts BOTH that the point is
// non-null and that `pointInGeometry` agrees it is strictly inside — the
// contract the bug report named explicitly.
// ---------------------------------------------------------------------------
describe("trueInteriorPoint", () => {
  it("a concave U-shape whose CENTROID is outside the ring", () => {
    // A U: wide base, two tall arms, open notch in the middle. The
    // shoelace centroid of a U sits in the open notch — outside the shape.
    const u: GeoJsonGeometry = {
      type: "Polygon",
      coordinates: [
        [
          [0, 0],
          [10, 0],
          [10, 10],
          [7, 10],
          [7, 3],
          [3, 3],
          [3, 10],
          [0, 10],
          [0, 0],
        ],
      ],
    };
    // Confirm the premise: the plain area-centroid really is outside.
    // (Same shoelace formula as zoning-stamp.ts's representativePoint,
    // reproduced inline so this test does not depend on that module.)
    const area = 10 * 10 - 4 * 7; // base minus the open notch
    expect(pointInGeometry(5, 8, u)).toBe(false); // sanity: notch is a gap
    expect(area).toBeGreaterThan(0);

    const pt = trueInteriorPoint(u);
    expect(pt).not.toBeNull();
    expect(pointInGeometry(pt!.longitude, pt!.latitude, u)).toBe(true);
  });

  it("a thin L-strip (one arm far narrower than the shape's bbox)", () => {
    const l: GeoJsonGeometry = {
      type: "Polygon",
      coordinates: [
        [
          [0, 0],
          [1, 0],
          [1, 8],
          [9, 8],
          [9, 9],
          [0, 9],
          [0, 0],
        ],
      ],
    };
    const pt = trueInteriorPoint(l);
    expect(pt).not.toBeNull();
    expect(pointInGeometry(pt!.longitude, pt!.latitude, l)).toBe(true);
  });

  it("a polygon with a hole whose centroid falls IN the hole", () => {
    // Same donut as the pointInGeometry suite above: centroid of the outer
    // square (5,5) is dead in the hole's center.
    const donut: GeoJsonGeometry = {
      type: "Polygon",
      coordinates: [
        [
          [0, 0],
          [10, 0],
          [10, 10],
          [0, 10],
          [0, 0],
        ],
        [
          [4, 4],
          [6, 4],
          [6, 6],
          [4, 6],
          [4, 4],
        ],
      ],
    };
    expect(pointInGeometry(5, 5, donut)).toBe(false); // the hole itself
    const pt = trueInteriorPoint(donut);
    expect(pt).not.toBeNull();
    expect(pointInGeometry(pt!.longitude, pt!.latitude, donut)).toBe(true);
    // Never IN the hole specifically.
    expect(pt!.longitude > 4 && pt!.longitude < 6 && pt!.latitude > 4 && pt!.latitude < 6).toBe(
      false,
    );
  });

  it("a MultiPolygon: uses the LARGEST part, never a smaller one or a hole", () => {
    const multi: GeoJsonGeometry = {
      type: "MultiPolygon",
      coordinates: [
        // Small part (area 1).
        [
          [
            [20, 20],
            [21, 20],
            [21, 21],
            [20, 21],
            [20, 20],
          ],
        ],
        // Large part (area 100) — this is the one that must be used.
        [
          [
            [0, 0],
            [10, 0],
            [10, 10],
            [0, 10],
            [0, 0],
          ],
        ],
      ],
    };
    const pt = trueInteriorPoint(multi);
    expect(pt).not.toBeNull();
    expect(pointInGeometry(pt!.longitude, pt!.latitude, multi)).toBe(true);
    // Inside the LARGE part's bbox, not the small part's.
    expect(pt!.longitude).toBeGreaterThanOrEqual(0);
    expect(pt!.longitude).toBeLessThanOrEqual(10);
    expect(pt!.latitude).toBeGreaterThanOrEqual(0);
    expect(pt!.latitude).toBeLessThanOrEqual(10);
  });

  it("a simple convex square: still strictly inside (sanity, fast-path shape)", () => {
    const square: GeoJsonGeometry = {
      type: "Polygon",
      coordinates: [
        [
          [0, 0],
          [4, 0],
          [4, 4],
          [0, 4],
          [0, 0],
        ],
      ],
    };
    const pt = trueInteriorPoint(square);
    expect(pt).not.toBeNull();
    expect(pointInGeometry(pt!.longitude, pt!.latitude, square)).toBe(true);
  });

  it("returns null for a degenerate (zero-area / collinear) ring", () => {
    const line: GeoJsonGeometry = {
      type: "Polygon",
      coordinates: [
        [
          [0, 0],
          [1, 0],
          [2, 0],
          [0, 0],
        ],
      ],
    };
    expect(trueInteriorPoint(line)).toBeNull();
  });

  it("returns null for a non-polygon geometry", () => {
    expect(trueInteriorPoint({ type: "Point", coordinates: [0, 0] })).toBeNull();
  });

  it("the REAL Marble Falls sample #41 (48053:112953) parcel: a thin winding road ring", () => {
    // Production geometry for prop_id 112953 (Marble Falls, 3.63-ac road
    // parcel) — the exact ring that exposed Bug 1: its bare shoelace
    // centroid (-98.27717726145636, 30.55312105716379) is OUTSIDE this
    // ring and lands directly inside the NEIGHBOURING "MR" zoning polygon
    // (verified live against production, see the PR body). The new
    // function must still find a point strictly inside THIS ring.
    const ring: [number, number][] = [
      [-98.27576145899997, 30.552891126000077],
      [-98.27575755499998, 30.552875657000072],
      [-98.27592559399994, 30.552860709000072],
      [-98.27592881799995, 30.55286908200003],
      [-98.27593351599995, 30.552876914000024],
      [-98.27593957399995, 30.55288401400003],
      [-98.27594684199994, 30.55289020400005],
      [-98.27595513899996, 30.552895334000027],
      [-98.27596426399998, 30.552899276000062],
      [-98.27597398799998, 30.552901932000054],
      [-98.27598407299996, 30.552903238000056],
      [-98.27599426999996, 30.552903160000028],
      [-98.27607408299997, 30.55289638200003],
      [-98.27616124799994, 30.552890276000028],
      [-98.27630202799998, 30.55287760500005],
      [-98.27636419699996, 30.552870201000076],
      [-98.27647424099996, 30.552854339000078],
      [-98.27658354999994, 30.552835040000048],
      [-98.27669197999995, 30.55281233100004],
      [-98.27774763899998, 30.552573651000046],
      [-98.27928097099999, 30.552235245000077],
      [-98.27935901699999, 30.552214768000056],
      [-98.27943480299996, 30.552188692000072],
      [-98.27950779199995, 30.552157203000036],
      [-98.27957746899995, 30.552120523000042],
      [-98.27964334199999, 30.552078910000034],
      [-98.27970494599998, 30.55203265800003],
      [-98.27976184799996, 30.55198209300005],
      [-98.27978993299996, 30.55195524800007],
      [-98.27985806599997, 30.551885071000072],
      [-98.27992096299994, 30.551811324000028],
      [-98.27997837499998, 30.551734298000042],
      [-98.28001905999997, 30.551672367000037],
      [-98.28005619799995, 30.551608789000056],
      [-98.28009131199997, 30.55154047800005],
      [-98.28012225099997, 30.55147067200005],
      [-98.28014893299996, 30.55139956200003],
      [-98.28019324799999, 30.551268312000047],
      [-98.28038474399995, 30.551290203000065],
      [-98.28033070299995, 30.551444359000072],
      [-98.28032109399999, 30.55147170300006],
      [-98.28031091899999, 30.551498895000066],
      [-98.28030562099997, 30.55151243000006],
      [-98.28029460599998, 30.55153937500006],
      [-98.28028888899996, 30.551552783000034],
      [-98.28024163299995, 30.55165183300005],
      [-98.28018679599995, 30.551747913000042],
      [-98.28012462599997, 30.55184058900005],
      [-98.28005540599997, 30.551929441000027],
      [-98.28004566099997, 30.55194097800006],
      [-98.27998471399997, 30.552008568000076],
      [-98.27993629999997, 30.552057346000026],
      [-98.27990884599996, 30.552083793000065],
      [-98.27989145299995, 30.552100369000073],
      [-98.27982248199999, 30.552159394000057],
      [-98.27974797799999, 30.55221314700003],
      [-98.27966847999994, 30.552261241000053],
      [-98.27958455699996, 30.552303332000065],
      [-98.27949681499996, 30.552339115000052],
      [-98.27940588299998, 30.55236833400005],
      [-98.27939355399997, 30.552371721000043],
      [-98.27936876399997, 30.552378133000047],
      [-98.27934381499995, 30.552384059000076],
      [-98.27847900999996, 30.552579579000053],
      [-98.27784406799998, 30.552723126000046],
      [-98.27678867999998, 30.552961735000054],
      [-98.27678460699997, 30.55296264900005],
      [-98.27664640699999, 30.552990978000025],
      [-98.27650691799994, 30.55301409100008],
      [-98.27636640199995, 30.553031944000054],
      [-98.27622512299996, 30.553044502000034],
      [-98.27621843599997, 30.55304497000003],
      [-98.27604015699995, 30.55305745800007],
      [-98.27602783199995, 30.553059133000033],
      [-98.27601596099998, 30.553062458000056],
      [-98.27600483999998, 30.55306735000005],
      [-98.27599473999999, 30.553073690000076],
      [-98.27598591099996, 30.553081320000047],
      [-98.27597857299997, 30.553090052000073],
      [-98.27597290499995, 30.55309967100004],
      [-98.27596904699999, 30.553109939000024],
      [-98.27596709599999, 30.55312060400007],
      [-98.27596060199994, 30.553172792000055],
      [-98.27595063299998, 30.553224568000076],
      [-98.27593269999994, 30.553290445000073],
      [-98.27590914399997, 30.55335498200003],
      [-98.27579943099994, 30.55362415700006],
      [-98.27574464899999, 30.55375813300003],
      [-98.27561124299996, 30.554085435000047],
      [-98.27560643599998, 30.554097227000057],
      [-98.27552857099994, 30.554288261000067],
      [-98.27550078899998, 30.554349321000075],
      [-98.27546839199994, 30.554408654000042],
      [-98.27543152399994, 30.554466000000048],
      [-98.27539034699998, 30.55452110400006],
      [-98.27534195699997, 30.55457718200006],
      [-98.27528916799997, 30.554630202000055],
      [-98.27523223399999, 30.554679907000036],
      [-98.27517143499995, 30.55472605600005],
      [-98.27510706499999, 30.55476842300004],
      [-98.27506139799999, 30.55480018600008],
      [-98.27502087599999, 30.554836806000026],
      [-98.27498618499999, 30.55487766600004],
      [-98.27495790999996, 30.554922075000036],
      [-98.27493652999999, 30.55496928200006],
      [-98.27492240399994, 30.555018491000055],
      [-98.27491577299998, 30.555068869000024],
      [-98.27491454099999, 30.555132832000027],
      [-98.27491833399995, 30.555196720000026],
      [-98.27492989099994, 30.55527500900007],
      [-98.27494898399999, 30.55535218400007],
      [-98.27497547999997, 30.555427703000078],
      [-98.27487626599998, 30.55545621400006],
      [-98.27484000299995, 30.55546663100006],
      [-98.27479202999996, 30.555480413000055],
      [-98.27478345199995, 30.555458246000057],
      [-98.27476103299995, 30.55539086300007],
      [-98.27474364499994, 30.55532237700004],
      [-98.27473898099998, 30.555299352000077],
      [-98.27472755499997, 30.555222074000028],
      [-98.27472251199998, 30.555144289000054],
      [-98.27472387699999, 30.555066389000046],
      [-98.27472392399994, 30.555065654000032],
      [-98.27472972499999, 30.555014241000038],
      [-98.27474107599994, 30.55496352600005],
      [-98.27475787599997, 30.554913956000064],
      [-98.27477997499994, 30.554865970000037],
      [-98.27479258599999, 30.55484332800006],
      [-98.27481621399994, 30.554806779000046],
      [-98.27482655499995, 30.554792613000075],
      [-98.27483738599994, 30.554778725000062],
      [-98.27487274999999, 30.554738867000026],
      [-98.27487904799995, 30.554732503000025],
      [-98.27491216999994, 30.554701969000064],
      [-98.27494787999996, 30.554673704000038],
      [-98.27495531599999, 30.554668338000056],
      [-98.27498597499994, 30.554647874000068],
      [-98.27499385899995, 30.554643011000053],
      [-98.27506316399996, 30.554596392000064],
      [-98.27512721999994, 30.554544453000062],
      [-98.27514334299997, 30.554529758000058],
      [-98.27518436199995, 30.55448883100007],
      [-98.27518914699999, 30.554483685000037],
      [-98.27520353099999, 30.55446769400004],
      [-98.27523745999997, 30.554426418000048],
      [-98.27526839699999, 30.554383419000033],
      [-98.27527990799996, 30.55436577200004],
      [-98.27531380399995, 30.554306824000037],
      [-98.27534215799994, 30.554245725000044],
      [-98.27538867299995, 30.554131605000066],
      [-98.27552091299998, 30.55380716600007],
      [-98.27560023899997, 30.553612543000042],
      [-98.27572774499998, 30.553299714000048],
      [-98.27575036099995, 30.55323591000007],
      [-98.27576027899994, 30.55319874500003],
      [-98.27576441199994, 30.553180009000073],
      [-98.27577228799998, 30.553132821000077],
      [-98.27577532999999, 30.553104332000032],
      [-98.27577709999997, 30.553075764000027],
      [-98.27577636499996, 30.55301033300003],
      [-98.27577614899997, 30.553001082000037],
      [-98.27577345799995, 30.55296157500004],
      [-98.27576792199994, 30.552922290000026],
      [-98.27576145899997, 30.552891126000077],
    ];
    const geometry: GeoJsonGeometry = { type: "Polygon", coordinates: [ring] };
    // Confirm the premise against this (simplified-but-faithful) ring.
    expect(pointInGeometry(-98.27717726145636, 30.55312105716379, geometry)).toBe(false);
    const pt = trueInteriorPoint(geometry);
    expect(pt).not.toBeNull();
    expect(pointInGeometry(pt!.longitude, pt!.latitude, geometry)).toBe(true);
  });
});

describe("normalizeDigitId", () => {
  it("strips leading zeros from an all-digit id", () => {
    expect(normalizeDigitId("0031131")).toBe("31131");
    expect(normalizeDigitId("31131")).toBe("31131");
  });

  it("leaves a non-numeric id untouched (trimmed)", () => {
    expect(normalizeDigitId("  R-580706  ")).toBe("R-580706");
  });

  it("trims whitespace around an all-digit id", () => {
    expect(normalizeDigitId("  31131  ")).toBe("31131");
  });
});

describe("normalizeTxgioFeature", () => {
  it("normalizes the real Hays feature (situs whitespace collapsed, tile keys bucketed)", () => {
    const counters = newCounters();
    const rec = normalizeTxgioFeature(
      "48209",
      1,
      HAYS_PARCEL_12310 as never,
      counters,
    );
    expect(rec).not.toBeNull();
    expect(rec!.countyFips).toBe("48209");
    expect(rec!.featureIndex).toBe(1);
    expect(rec!.propId).toBe("12310");
    expect(rec!.geoId).toBe("10-0017-2347-00000-3");
    expect(rec!.ownerName).toBe("DELEON FELIX");
    // The genuine double space in the source collapses to one.
    expect(rec!.situsAddress).toBe("707 UHLAND RD, SAN MARCOS, TX 78666");
    expect(rec!.situsCity).toBe("SAN MARCOS");
    expect(rec!.situsState).toBe("TX");
    expect(rec!.situsZip).toBe("78666");
    expect(rec!.tileKeys).toEqual(["g0.02:-97.92000,29.88000"]);
    expect(counters.rowsSkipped).toBe(0);
  });

  it("skips features without polygon geometry, with a counted sample", () => {
    const counters = newCounters();
    const rec = normalizeTxgioFeature(
      "48209",
      7,
      { geometry: null, properties: { Prop_ID: "1" } },
      counters,
    );
    expect(rec).toBeNull();
    expect(counters.rowsSkipped).toBe(1);
    expect(counters.skipSamples[0]).toContain("feature 7");
  });

  it("maps blank/absent attribute strings to null", () => {
    const counters = newCounters();
    const rec = normalizeTxgioFeature(
      "48091",
      0,
      { geometry: HAYS_PARCEL_12310.geometry as never, properties: { SITUS_ADDR: "   " } },
      counters,
    );
    expect(rec!.propId).toBeNull();
    expect(rec!.situsAddress).toBeNull();
    expect(rec!.ownerName).toBeNull();
  });
});

describe("StratMap STAT_LAND_ -> property_use_code", () => {
  it("takes the first non-blank comma segment (repeated-code parcel)", () => {
    // The overwhelmingly common Bexar form: same PTAD code per segment.
    expect(normalizeStatLandUse("A1,A1")).toBe("A1");
    expect(normalizeStatLandUse("F1,F1")).toBe("F1");
    expect(normalizeStatLandUse("A1")).toBe("A1");
  });

  it("takes the first-listed code on a genuine mixed-use parcel", () => {
    // ~1,793 of 709,541 Bexar rows carry two different codes; the
    // choropleth needs one, so the parcel's first-listed real code wins.
    expect(normalizeStatLandUse("A1,F1")).toBe("A1");
    expect(normalizeStatLandUse("B1,B2")).toBe("B1");
  });

  it("uppercases and trims, and skips a leading empty segment", () => {
    expect(normalizeStatLandUse(" a1 ")).toBe("A1");
    expect(normalizeStatLandUse(",A1")).toBe("A1");
    expect(normalizeStatLandUse("A,A1,")).toBe("A");
  });

  it("returns null for a blank field — never a fabricated code", () => {
    expect(normalizeStatLandUse("")).toBeNull();
    expect(normalizeStatLandUse("   ")).toBeNull();
    expect(normalizeStatLandUse(",")).toBeNull();
    expect(normalizeStatLandUse(null)).toBeNull();
    expect(normalizeStatLandUse(undefined)).toBeNull();
  });
});

describe("normalizeStratMapLandUse -> cad_property row", () => {
  // A real Bexar DBF attribute row shape (situs/value fields as the DBF
  // carries them, verified against the 48029 header 2026-07-20).
  const BEXAR_ROW = {
    Prop_ID: "105294",
    STAT_LAND_: "A1,A1",
    LOC_LAND_U: "RES",
    OWNER_NAME: "DOE JANE",
    SITUS_ADDR: "504  LAMAR , SAN ANTONIO, TX 78202",
    SITUS_CITY: "SAN ANTONIO",
    SITUS_ZIP: "78202",
    LEGAL_DESC: "NCB 1234 BLK 5 LOT 6",
    LAND_VALUE: "2.68880000000e+05",
    IMP_VALUE: "1.50000000000e+05",
    MKT_VALUE: "4.18880000000e+05",
    TAX_YEAR: "2025",
    FIPS: "48029",
  };

  it("maps STAT_LAND_ to a clean property_use_code and lands values as whole dollars", () => {
    const counters = newCounters();
    const rec = normalizeStratMapLandUse("48029", 0, BEXAR_ROW, counters);
    expect(rec).not.toBeNull();
    expect(rec!.countyFips).toBe("48029");
    expect(rec!.propId).toBe("105294");
    expect(rec!.taxYear).toBe(2025);
    expect(rec!.propertyUseCode).toBe("A1"); // A1,A1 collapsed
    expect(rec!.ownerName).toBe("DOE JANE");
    // situs whitespace collapsed (matches the parse.ts str() normalizer).
    expect(rec!.situsAddress).toBe("504 LAMAR , SAN ANTONIO, TX 78202");
    expect(rec!.situsCity).toBe("SAN ANTONIO");
    expect(rec!.landValue).toBe(268880);
    expect(rec!.improvementValue).toBe(150000);
    expect(rec!.marketValue).toBe(418880);
    // Fields StratMap does not carry stay null.
    expect(rec!.exemptionCodes).toBeNull();
    expect(rec!.yearBuilt).toBeNull();
    expect(rec!.landAcres).toBeNull();
    expect(counters.rowsSkipped).toBe(0);
  });

  it("strips leading zeros on all-numeric prop_id (matches normalizeCadPropId join key)", () => {
    const counters = newCounters();
    const rec = normalizeStratMapLandUse(
      "48029",
      0,
      { ...BEXAR_ROW, Prop_ID: "0000105294" },
      counters,
    );
    expect(rec!.propId).toBe("105294");
  });

  it("leaves property_use_code null when STAT_LAND_ is blank (commitment #1)", () => {
    const counters = newCounters();
    const rec = normalizeStratMapLandUse(
      "48029",
      0,
      { ...BEXAR_ROW, STAT_LAND_: "" },
      counters,
    );
    expect(rec).not.toBeNull(); // row still lands (owner/situs/value)
    expect(rec!.propertyUseCode).toBeNull();
  });

  it("drops zero/absent values to null rather than storing $0", () => {
    const counters = newCounters();
    const rec = normalizeStratMapLandUse(
      "48029",
      0,
      { ...BEXAR_ROW, LAND_VALUE: "0.00000000000e+00", MKT_VALUE: undefined },
      counters,
    );
    expect(rec!.landValue).toBeNull();
    expect(rec!.marketValue).toBeNull();
    expect(rec!.improvementValue).toBe(150000);
  });

  it("uses the fallback tax year only when the DBF row's TAX_YEAR is blank", () => {
    const counters = newCounters();
    const withRow = normalizeStratMapLandUse(
      "48029",
      0,
      { ...BEXAR_ROW, TAX_YEAR: "2024" },
      counters,
      2025,
    );
    expect(withRow!.taxYear).toBe(2024); // in-row wins
    const blank = normalizeStratMapLandUse(
      "48029",
      1,
      { ...BEXAR_ROW, TAX_YEAR: "" },
      counters,
      2025,
    );
    expect(blank!.taxYear).toBe(2025); // fallback used
  });

  it("skips a row with no Prop_ID or no resolvable tax year, with a counted sample", () => {
    const counters = newCounters();
    const noProp = normalizeStratMapLandUse(
      "48029",
      3,
      { ...BEXAR_ROW, Prop_ID: "   " },
      counters,
    );
    expect(noProp).toBeNull();
    const noYear = normalizeStratMapLandUse(
      "48029",
      4,
      { ...BEXAR_ROW, TAX_YEAR: "" },
      counters, // no fallback provided
    );
    expect(noYear).toBeNull();
    expect(counters.rowsSkipped).toBe(2);
    expect(counters.skipSamples[0]).toContain("feature 3");
  });

  // P-124 CTX-LEAVES2: 48491:PRIVATE ROAD -- a StratMap "leftover farm"
  // lineage artifact (P-78 family) where a right-of-way attribute value
  // landed in the Prop_ID column of one feature and was written verbatim
  // as though it were a taxable account. Live-confirmed 2026-09-09/10: one
  // Williamson (48491) cad_property/landing_cad_property row, source_file
  // stratmap25-landparcels_48491_lp.zip.
  it("admits a real numeric prop_id and Williamson's own R-account convention", () => {
    const counters = newCounters();
    const numeric = normalizeStratMapLandUse("48029", 0, BEXAR_ROW, counters);
    expect(numeric!.propId).toBe("105294");
    const rAccount = normalizeStratMapLandUse(
      "48491",
      1,
      { ...BEXAR_ROW, Prop_ID: "R062578" },
      counters,
    );
    expect(rAccount!.propId).toBe("R062578"); // non-numeric: kept verbatim, never stripped
    const rAccountLower = normalizeStratMapLandUse(
      "48491",
      2,
      { ...BEXAR_ROW, Prop_ID: "r062578" },
      counters,
    );
    expect(rAccountLower!.propId).toBe("r062578");
    expect(counters.rowsSkipped).toBe(0);
  });

  it("REFUSES a non-parcel Prop_ID (the literal PRIVATE ROAD lineage defect), never writing it as an account", () => {
    const counters = newCounters();
    const rec = normalizeStratMapLandUse(
      "48491",
      7,
      { ...BEXAR_ROW, Prop_ID: "PRIVATE ROAD" },
      counters,
    );
    expect(rec).toBeNull();
    expect(counters.rowsSkipped).toBe(1);
    expect(counters.skipSamples[0]).toContain("feature 7");
    expect(counters.skipSamples[0]).toContain("PRIVATE ROAD");
    expect(counters.skipSamples[0]).toContain(NOT_A_PARCEL_PROP_ID_REASON);
  });

  it("isParcelShapedPropId: the guard is neither too strict (real ids pass) nor too loose (PRIVATE ROAD fails)", () => {
    expect(isParcelShapedPropId("105294")).toBe(true);
    expect(isParcelShapedPropId("0000105294")).toBe(true);
    expect(isParcelShapedPropId("R062578")).toBe(true);
    expect(isParcelShapedPropId("r062578")).toBe(true);
    expect(isParcelShapedPropId("PRIVATE ROAD")).toBe(false);
    expect(isParcelShapedPropId("")).toBe(false);
    expect(isParcelShapedPropId("R")).toBe(false);
    expect(isParcelShapedPropId("ROW")).toBe(false);
  });
});

describe("WGS84 .prj guard", () => {
  it("accepts the real stratmap25 geographic .prj", () => {
    expect(() => assertWgs84Prj(HAYS_PRJ_WGS84, "hays.prj")).not.toThrow();
  });

  it("refuses a state-plane .prj instead of storing non-WGS84 coordinates", () => {
    // Caught by the PROJCS branch — a projected CRS is refused before
    // the datum is even considered, which is the correct order.
    expect(() => assertWgs84Prj(TX_STATE_PLANE_PRJ, "bad.prj")).toThrow(
      /PROJECTED coordinate system/,
    );
  });

  it("REGRESSION: refuses the real 202505 Web Mercator .prj whose nested GEOGCS says GCS_WGS_1984", () => {
    // This exact WKT ships on 12 of 12 sampled 202505 counties (57 of
    // 254 statewide). Its nested GEOGCS contains the `GCS_WGS_1984`
    // substring, so the pre-2026-08-08 datum-only guard PASSED on
    // coordinates in meters. It must now be refused.
    expect(TXGIO_202505_WEB_MERCATOR_PRJ.toUpperCase()).toContain(
      "GCS_WGS_1984",
    );
    expect(() =>
      assertWgs84Prj(TXGIO_202505_WEB_MERCATOR_PRJ, "king_48269.prj"),
    ).toThrow(/PROJECTED coordinate system/);
  });

  it("still refuses a geographic CRS on the wrong datum", () => {
    expect(() =>
      assertWgs84Prj(
        'GEOGCS["GCS_North_American_1983",DATUM["D_North_American_1983"]]',
        "nad83.prj",
      ),
    ).toThrow(/not GCS_WGS_1984/);
  });

  it("tolerates leading whitespace before PROJCS", () => {
    expect(() =>
      assertWgs84Prj(`\n  ${TXGIO_202505_WEB_MERCATOR_PRJ}`, "padded.prj"),
    ).toThrow(/PROJECTED coordinate system/);
  });
});

describe("Texas WGS84 coordinate-range assertion (the durable guard)", () => {
  it("accepts the real Hays parcel's bbox", () => {
    const bbox = bboxOfGeometry(HAYS_GEOMETRY)!;
    expect(isPlausibleTexasWgs84Bbox(bbox)).toBe(true);
    expect(() => assertTexasWgs84Bbox(bbox, "hays")).not.toThrow();
  });

  it("REGRESSION: rejects the real King 48269 (202505) Web Mercator header bbox", () => {
    // Real .shp header bbox, meters. xmin=-11189891.31 where a
    // legitimate value for that county is about -100.2 degrees.
    expect(isPlausibleTexasWgs84Bbox(KING_48269_WEB_MERCATOR_BBOX)).toBe(false);
    expect(() =>
      assertTexasWgs84Bbox(KING_48269_WEB_MERCATOR_BBOX, "king 48269"),
    ).toThrow(TxgioProjectionError);
    expect(() =>
      assertTexasWgs84Bbox(KING_48269_WEB_MERCATOR_BBOX, "king 48269"),
    ).toThrow(/outside the plausible Texas WGS84 envelope/);
  });

  it("catches a swapped lat/lng axis order", () => {
    // Hays coordinates with the pair transposed: lng 29.9, lat -97.9.
    expect(() =>
      assertTexasWgs84Bbox(
        { westLng: 29.895, southLat: -97.913, eastLng: 29.896, northLat: -97.912 },
        "swapped",
      ),
    ).toThrow(/outside the plausible Texas WGS84 envelope/);
  });

  it("rejects non-finite coordinates", () => {
    expect(
      isPlausibleTexasWgs84Bbox({
        westLng: NaN,
        southLat: 30,
        eastLng: -97,
        northLat: 31,
      }),
    ).toBe(false);
  });

  it("accepts the true corners of Texas but not a degree past the padded envelope", () => {
    // El Paso's western tip (~-106.65) and the Panhandle top (~36.50)
    // are comfortably inside.
    expect(
      isPlausibleTexasWgs84Bbox({
        westLng: -106.65,
        southLat: 25.84,
        eastLng: -93.51,
        northLat: 36.5,
      }),
    ).toBe(true);
    // Just past the padded envelope is out.
    expect(
      isPlausibleTexasWgs84Bbox({
        westLng: TEXAS_WGS84_BOUNDS.westLng - 0.001,
        southLat: 30,
        eastLng: -97,
        northLat: 31,
      }),
    ).toBe(false);
  });

  it("rejects a bbox that is in-range but spans an implausible number of cells", () => {
    // Whole-state extent: plausible degrees, but no PARCEL is that big.
    // (~730 x 600 cells, far above the per-feature ceiling.)
    const statewide = {
      westLng: -106,
      southLat: 26,
      eastLng: -94,
      northLat: 36,
    };
    expect(isPlausibleTexasWgs84Bbox(statewide)).toBe(true);
    expect(cellCountForBbox(statewide)).toBeGreaterThan(
      TXGIO_MAX_FEATURE_CELLS,
    );
    expect(() => assertTexasWgs84Bbox(statewide, "statewide")).toThrow(
      /per-feature ceiling/,
    );
  });
});

describe("normalizeTxgioFeature — projection fail-closed", () => {
  it("THROWS (does not skip) on a 202505-shaped Web Mercator feature", () => {
    const counters = newCounters();
    // Pre-fix this returned a record whose tileKeys were meter-space
    // keys, after attempting ~9.1e12 of them.
    expect(() =>
      normalizeTxgioFeature(
        "48269",
        0,
        KING_48269_WEB_MERCATOR_PARCEL as never,
        counters,
      ),
    ).toThrow(TxgioProjectionError);
    // A projection error is a whole-county property, so it must NOT be
    // absorbed into the per-feature skip counter and reported as success.
    expect(counters.rowsSkipped).toBe(0);
  });

  it("names the county and feature index in the failure", () => {
    const counters = newCounters();
    expect(() =>
      normalizeTxgioFeature(
        "48269",
        417,
        KING_48269_WEB_MERCATOR_PARCEL as never,
        counters,
      ),
    ).toThrow(/county 48269 feature 417/);
  });
});

/**
 * The W3-PLACEHOLDER-FAMILY defect. Every fixture below is the REAL
 * record measured out of the live StratMap archives on 2026-08-09, not a
 * hand-invented shape — including the coordinates, which is what makes
 * the "still throws" cases meaningful.
 */
describe("null-placeholder declination (W3-PLACEHOLDER-FAMILY)", () => {
  // Wood 48499 record index 43504 — verbatim from the archive.
  const WOOD_PLACEHOLDER = {
    geometry: {
      type: "Polygon",
      coordinates: [
        [
          [-96.11965573099997, 13.923654807000048],
          [-96.11837544999997, 13.923623986000052],
          [-96.11853546299994, 13.919695862000026],
          [-96.11974769799997, 13.919721825000067],
          [-96.11968279199999, 13.921726079000052],
          [-96.11965573099997, 13.923654807000048],
        ],
      ],
    },
    properties: {
      Prop_ID: "0",
      GEO_ID: "",
      OWNER_NAME: "",
      LEGAL_DESC: "",
      SITUS_ADDR: ", ,",
      MKT_VALUE: 0,
      LAND_VALUE: 0,
      OBJECTID_1: 30421,
      FIPS: "48499",
    },
  };

  it("declines the real Wood 48499 placeholder WITH IDENTITY instead of halting", () => {
    const counters = newCounters();
    const rec = normalizeTxgioFeature(
      "48499",
      43504,
      WOOD_PLACEHOLDER as never,
      counters,
    );
    expect(rec).toBeNull();
    expect(counters.declined).toHaveLength(1);
    const d = counters.declined[0];
    // IDENTITY — the whole point. A bare count is what we are replacing.
    expect(d.countyFips).toBe("48499");
    expect(d.featureIndex).toBe(43504);
    expect(d.propId).toBe("0");
    expect(d.objectId).toBe("30421");
    expect(d.reason).toBe("out-of-envelope-null-placeholder");
    // The OFFENDING VALUE travels with the record.
    expect(d.detail).toContain("13.919695862");
    expect(d.detail).toContain("outside Texas");
  });

  it("STILL THROWS on an out-of-envelope feature that has a real Prop_ID", () => {
    // The guard must not be softened: identity present means this is
    // either a projection failure or a real parcel with broken geometry,
    // and both must halt rather than vanish.
    const counters = newCounters();
    const withIdentity = {
      ...WOOD_PLACEHOLDER,
      properties: { ...WOOD_PLACEHOLDER.properties, Prop_ID: "77123" },
    };
    expect(() =>
      normalizeTxgioFeature("48499", 43504, withIdentity as never, counters),
    ).toThrow(TxgioProjectionError);
    expect(counters.declined).toHaveLength(0);
  });

  it("STILL THROWS when only GEO_ID is present (identity is either field)", () => {
    const counters = newCounters();
    const withGeoId = {
      ...WOOD_PLACEHOLDER,
      properties: { ...WOOD_PLACEHOLDER.properties, GEO_ID: "R12345" },
    };
    expect(() =>
      normalizeTxgioFeature("48499", 43504, withGeoId as never, counters),
    ).toThrow(TxgioProjectionError);
    expect(counters.declined).toHaveLength(0);
  });

  it("does NOT decline a placeholder whose geometry is valid Texas land", () => {
    // THE REGRESSION THAT MATTERS MOST. The probe measured 10,837
    // placeholder-ATTRIBUTE features sitting inside the envelope across
    // the three counties (Wood 1,168 / Henderson 8,026 / Liberty 1,643).
    // An attributes-only predicate would destroy every one of them.
    const counters = newCounters();
    const rec = normalizeTxgioFeature(
      "48499",
      43072,
      {
        geometry: HAYS_PARCEL_12310.geometry,
        properties: { Prop_ID: "0", GEO_ID: "", OWNER_NAME: "" },
      } as never,
      counters,
    );
    expect(rec).not.toBeNull();
    expect(counters.declined).toHaveLength(0);
  });

  it("leaves a clean county completely unaffected", () => {
    const counters = newCounters();
    const rec = normalizeTxgioFeature(
      "48209",
      1,
      HAYS_PARCEL_12310 as never,
      counters,
    );
    expect(rec).not.toBeNull();
    expect(counters.declined).toHaveLength(0);
    expect(counters.rowsSkipped).toBe(0);
  });

  it("does NOT decline under --reproject: a bad conversion is whole-county", () => {
    // Under reprojection an out-of-envelope result means the CONVERSION
    // is wrong, which mis-places every feature. Declining the
    // identity-less subset would quietly thin a county whose coordinates
    // are all suspect, so reprojected runs keep the unconditional halt.
    const counters = newCounters();
    expect(() =>
      normalizeTxgioFeature(
        "48499",
        43504,
        {
          geometry: {
            type: "Polygon",
            coordinates: [
              [
                [0, 0],
                [60, 0],
                [60, 45],
                [0, 45],
                [0, 0],
              ],
            ],
          },
          properties: { Prop_ID: "0", GEO_ID: "" },
        } as never,
        counters,
        { reprojectFrom: "EPSG:3857" },
      ),
    ).toThrow(TxgioProjectionError);
    expect(counters.declined).toHaveLength(0);
  });

  it("round-trips the decline record through JSON (the artifact shape)", () => {
    const counters = newCounters();
    normalizeTxgioFeature("48499", 43504, WOOD_PLACEHOLDER as never, counters);
    const roundTripped = JSON.parse(JSON.stringify(counters.declined));
    expect(roundTripped).toEqual(counters.declined);
    expect(roundTripped[0].featureIndex).toBe(43504);
    expect(roundTripped[0].reason).toBe("out-of-envelope-null-placeholder");
  });
});

describe("isNullPlaceholderFeature — the discriminator", () => {
  it("is true only when BOTH identifiers are absent", () => {
    expect(isNullPlaceholderFeature({ Prop_ID: "0", GEO_ID: "" })).toBe(true);
    expect(isNullPlaceholderFeature({ Prop_ID: "", GEO_ID: "" })).toBe(true);
    expect(isNullPlaceholderFeature({})).toBe(true);
  });

  it("is false when either identifier is real", () => {
    expect(isNullPlaceholderFeature({ Prop_ID: "12310", GEO_ID: "" })).toBe(
      false,
    );
    expect(isNullPlaceholderFeature({ Prop_ID: "0", GEO_ID: "R99" })).toBe(
      false,
    );
  });

  it("ignores value fields — a zero-value parcel is ordinary, not a placeholder", () => {
    // Exempt and un-appraised parcels are real and must never be
    // declined on the strength of a zero value.
    expect(
      isNullPlaceholderFeature({ Prop_ID: "12310", MKT_VALUE: 0, LAND_VALUE: 0 }),
    ).toBe(false);
  });
});

describe("every declination carries identity (the 148-skip fix)", () => {
  it("records identity for a feature with no polygon geometry", () => {
    // This is the exact path that fired 148 times across 9 landed
    // counties as a bare integer, leaving nobody able to say which
    // parcels were dropped or whether any were real.
    const counters = newCounters();
    const rec = normalizeTxgioFeature(
      "48203",
      7,
      {
        geometry: null,
        properties: { Prop_ID: "9911", GEO_ID: "R9911", OBJECTID_1: 555 },
      } as never,
      counters,
    );
    expect(rec).toBeNull();
    expect(counters.declined).toHaveLength(1);
    expect(counters.declined[0].propId).toBe("9911");
    expect(counters.declined[0].geoId).toBe("R9911");
    expect(counters.declined[0].objectId).toBe("555");
    expect(counters.declined[0].reason).toBe("no-polygon-geometry");
    // Legacy counters keep working so existing summaries do not shift.
    expect(counters.rowsSkipped).toBe(1);
  });

  it("records identity for an empty geometry", () => {
    const counters = newCounters();
    normalizeTxgioFeature(
      "48203",
      3,
      {
        geometry: { type: "Polygon", coordinates: [] },
        properties: { Prop_ID: "4242" },
      } as never,
      counters,
    );
    expect(counters.declined).toHaveLength(1);
    expect(counters.declined[0].reason).toBe("empty-geometry");
    expect(counters.declined[0].propId).toBe("4242");
  });
});

describe("halt-versus-decline ceiling", () => {
  function declineN(
    n: number,
    read: number,
    reason: "out-of-envelope-null-placeholder" | "empty-geometry" =
      "out-of-envelope-null-placeholder",
  ) {
    const counters = newCounters();
    counters.rowsRead = read;
    for (let i = 0; i < n; i += 1) {
      counters.declined.push({
        countyFips: "48499",
        featureIndex: i,
        propId: null,
        geoId: null,
        objectId: null,
        ownerName: null,
        reason,
        detail: "test",
      });
    }
    return counters;
  }

  it("tolerates the measured real-world geometry-absence rate (Liberty 1.16%)", () => {
    // 1,903 of 164,178 empty-geometry features is the REAL Liberty
    // 48291 measurement. This class is pre-existing and must not halt
    // the county — it must be named instead.
    expect(() =>
      assertFinalDeclineCeiling(
        declineN(1_903, 164_178, "empty-geometry"),
        "48291",
      ),
    ).not.toThrow();
  });

  it("halts a county that is MOSTLY geometry-less (truncated download)", () => {
    expect(() =>
      assertFinalDeclineCeiling(
        declineN(50_000, 164_178, "empty-geometry"),
        "48291",
      ),
    ).toThrow(TxgioDeclineCeilingError);
  });

  it("does NOT judge geometry-absence mid-stream on a clustered prefix", () => {
    // THE REAL HENDERSON TRAP. Its first 1,000 records are 47% empty
    // while the county-wide rate is 1.64%. The streaming check must
    // ignore this class entirely or it halts a county that is fine.
    expect(() =>
      assertDeclineCeiling(declineN(473, 1_000, "empty-geometry"), "48213"),
    ).not.toThrow();
  });

  it("does not let geometry-absence volume mask a coordinate defect", () => {
    // The two classes are counted separately on purpose: 1,903 empty
    // geometries must not raise the bar for out-of-envelope coordinates.
    const counters = declineN(1_903, 164_178, "empty-geometry");
    for (let i = 0; i < 11; i += 1) {
      counters.declined.push({
        countyFips: "48291",
        featureIndex: 900_000 + i,
        propId: null,
        geoId: null,
        objectId: null,
        ownerName: null,
        reason: "out-of-envelope-null-placeholder",
        detail: "test",
      });
    }
    expect(() => assertDeclineCeiling(counters, "48291")).toThrow(
      /out-of-envelope null-placeholder/,
    );
  });

  it("permits the real measured worst case (2 of 164,178)", () => {
    expect(() =>
      assertDeclineCeiling(declineN(2, 164_178), "48291"),
    ).not.toThrow();
  });

  it("halts past the absolute ceiling", () => {
    expect(() =>
      assertDeclineCeiling(
        declineN(TXGIO_MAX_DECLINED_ABSOLUTE + 1, 500_000),
        "48499",
      ),
    ).toThrow(TxgioDeclineCeilingError);
  });

  it("halts a SMALL county on the fraction even under the absolute ceiling", () => {
    // 5 of 1,600 is 0.31% — under 10 absolute, but far past 0.1%. A flat
    // absolute-only ceiling would let a broken small county bleed.
    expect(() => assertDeclineCeiling(declineN(5, 1_600), "48301")).toThrow(
      TxgioDeclineCeilingError,
    );
  });

  it("does not apply the fraction on a tiny sample (1 of 1 is not 100% broken)", () => {
    expect(() => assertDeclineCeiling(declineN(1, 1), "48499")).not.toThrow();
  });

  it("explains itself with counts and named features", () => {
    expect(() =>
      assertDeclineCeiling(declineN(50, 100_000), "48499"),
    ).toThrow(
      /50 out-of-envelope null-placeholder features declined out of 100000 read/,
    );
  });
});

describe("EPSG:3857 -> EPSG:4326 reprojection (webMercatorToWgs84)", () => {
  it("recovers the PUBLISHED EPSG:3857 extent constants exactly", () => {
    // Independent corroboration: these degree values are the CRS's own
    // published limits, not something this codebase derived. A wrong
    // sphere radius or an ellipsoidal inverse misses the latitude limit.
    for (const p of WEB_MERCATOR_REFERENCE_PAIRS) {
      const [lng, lat] = webMercatorToWgs84(p.x, p.y);
      expect(lng, `${p.label} lng`).toBeCloseTo(p.longitude, 9);
      expect(lat, `${p.label} lat`).toBeCloseTo(p.latitude, 9);
    }
  });

  it("uses the SPHERE radius EPSG:3857 defines, not an ellipsoidal inverse", () => {
    expect(WEB_MERCATOR_RADIUS_M).toBe(6378137.0);
    expect(WEB_MERCATOR_MAX_M).toBeCloseTo(20037508.342789244, 6);
    // The defining consequence of the spherical definition: y = pi*R is
    // exactly 85.05112877980659 deg. An ellipsoidal Mercator inverse
    // would put it near 85.084, ~3.7 km away — the exact class of bug
    // this assertion exists to catch.
    const [, lat] = webMercatorToWgs84(0, WEB_MERCATOR_MAX_M);
    expect(lat).toBeCloseTo(85.05112877980659, 9);
    expect(lat).not.toBeCloseTo(85.084, 2);
  });

  it("round-trips Texas points to sub-nanodegree closure", () => {
    // Achieved precision: every component below closes to <1e-9 degrees
    // (~0.1 mm at this latitude) and the metre-space round trip to
    // <1e-6 m. Far tighter than the ~1 m the source data is authored to.
    for (const p of TEXAS_ROUND_TRIP_POINTS) {
      const [x, y] = wgs84ToWebMercator(p.longitude, p.latitude);
      const [lng, lat] = webMercatorToWgs84(x, y);
      expect(Math.abs(lng - p.longitude), `${p.label} lng`).toBeLessThan(1e-9);
      expect(Math.abs(lat - p.latitude), `${p.label} lat`).toBeLessThan(1e-9);
      // ...and the reverse direction closes in metre space too.
      const [x2, y2] = wgs84ToWebMercator(lng, lat);
      expect(Math.abs(x2 - x), `${p.label} x`).toBeLessThan(1e-6);
      expect(Math.abs(y2 - y), `${p.label} y`).toBeLessThan(1e-6);
    }
  });

  it("GROUND TRUTH: the real King 48269 header bbox reprojects onto King County", () => {
    // The source bbox is the REAL 202505 .shp header (metres). The
    // expected degrees are King County's true extent per the US Census
    // county boundary — so this asserts the conversion against the
    // physical world, not against its own arithmetic.
    const [westLng, southLat] = webMercatorToWgs84(
      KING_48269_WEB_MERCATOR_BBOX.westLng,
      KING_48269_WEB_MERCATOR_BBOX.southLat,
    );
    const [eastLng, northLat] = webMercatorToWgs84(
      KING_48269_WEB_MERCATOR_BBOX.eastLng,
      KING_48269_WEB_MERCATOR_BBOX.northLat,
    );
    expect(westLng).toBeCloseTo(KING_48269_REPROJECTED_BBOX.westLng, 9);
    expect(southLat).toBeCloseTo(KING_48269_REPROJECTED_BBOX.southLat, 9);
    expect(eastLng).toBeCloseTo(KING_48269_REPROJECTED_BBOX.eastLng, 9);
    expect(northLat).toBeCloseTo(KING_48269_REPROJECTED_BBOX.northLat, 9);
    // King County, Texas: roughly lng -100.52..-100.00, lat 33.39..33.84.
    expect(westLng).toBeGreaterThan(-100.53);
    expect(eastLng).toBeLessThan(-99.96);
    expect(southLat).toBeGreaterThan(33.39);
    expect(northLat).toBeLessThan(33.84);
    // ...and the converted bbox now PASSES the guard that rejects the raw one.
    expect(isPlausibleTexasWgs84Bbox(KING_48269_REPROJECTED_BBOX)).toBe(true);
    expect(isPlausibleTexasWgs84Bbox(KING_48269_WEB_MERCATOR_BBOX)).toBe(false);
  });

  it("preserves geometry nesting, rings and holes", () => {
    const [x, y] = wgs84ToWebMercator(-97.7431, 30.2672);
    const geom = {
      type: "MultiPolygon",
      coordinates: [
        [
          // outer ring
          [
            [x, y],
            [x + 50, y],
            [x + 50, y + 50],
            [x, y + 50],
            [x, y],
          ],
          // hole
          [
            [x + 10, y + 10],
            [x + 20, y + 10],
            [x + 20, y + 20],
            [x + 10, y + 10],
          ],
        ],
      ],
    };
    const out = reprojectGeometry(geom) as {
      type: string;
      coordinates: number[][][][];
    };
    expect(out.type).toBe("MultiPolygon");
    expect(out.coordinates).toHaveLength(1);
    expect(out.coordinates[0]).toHaveLength(2); // outer + hole preserved
    expect(out.coordinates[0][0]).toHaveLength(5);
    expect(out.coordinates[0][1]).toHaveLength(4);
    expect(out.coordinates[0][0][0][0]).toBeCloseTo(-97.7431, 9);
    expect(out.coordinates[0][0][0][1]).toBeCloseTo(30.2672, 9);
    // Input is not mutated — a caller may keep the source coordinates.
    expect(geom.coordinates[0][0][0][0]).toBe(x);
  });

  it("keeps a Z component untouched", () => {
    const out = reprojectGeometry({
      type: "Polygon",
      coordinates: [[[0, 0, 412.5]]],
    }) as { coordinates: number[][][] };
    expect(out.coordinates[0][0]).toEqual([0, 0, 412.5]);
  });

  it("refuses a source CRS it has no inverse for", () => {
    expect(() =>
      reprojectGeometry({ type: "Polygon", coordinates: [] }, "EPSG:2277" as never),
    ).toThrow(TxgioReprojectionError);
  });

  it("refuses coordinates outside the EPSG:3857 extent", () => {
    expect(() =>
      reprojectGeometry({
        type: "Polygon",
        coordinates: [[[WEB_MERCATOR_MAX_M * 2, 0]]],
      }),
    ).toThrow(/outside the EPSG:3857 valid extent/);
  });
});

describe("classifyPrj — detect, so the CLI can offer the opt-in", () => {
  it("classifies the real 202505 Web Mercator .prj as convertible", () => {
    expect(classifyPrj(TXGIO_202505_WEB_MERCATOR_PRJ)).toBe("web-mercator");
  });

  it("classifies the real geographic .prj as already ingestible", () => {
    expect(classifyPrj(HAYS_PRJ_WGS84)).toBe("wgs84-geographic");
  });

  it("does NOT classify state plane as convertible — the flag cannot launder it", () => {
    // The --reproject=3857 flag authorizes converting Web Mercator
    // specifically. A projection we have no inverse for stays
    // unsupported and still routes to the strict assertWgs84Prj throw.
    expect(classifyPrj(TX_STATE_PLANE_PRJ)).toBe("unsupported");
    expect(() => assertWgs84Prj(TX_STATE_PLANE_PRJ, "bad.prj")).toThrow();
  });

  it("does not sweep in a Mercator on the wrong datum", () => {
    expect(
      classifyPrj(
        'PROJCS["Mercator_Auxiliary_Sphere_NAD83",GEOGCS["GCS_North_American_1983",' +
          'DATUM["D_North_American_1983"]],PROJECTION["Mercator_Auxiliary_Sphere"],UNIT["Meter",1.0]]',
      ),
    ).toBe("unsupported");
  });

  it("does not sweep in a non-metre projected CRS", () => {
    expect(
      classifyPrj(
        'PROJCS["WGS_1984_Web_Mercator_Auxiliary_Sphere",GEOGCS["GCS_WGS_1984",' +
          'DATUM["D_WGS_1984"]],PROJECTION["Mercator_Auxiliary_Sphere"],UNIT["Foot_US",0.3048006096012192]]',
      ),
    ).toBe("unsupported");
  });
});

describe("normalizeTxgioFeature with --reproject=3857", () => {
  it("loads the 202505-shaped feature that fails closed without the opt-in", () => {
    const counters = newCounters();
    // Same fixture the fail-closed test above proves is REFUSED by
    // default. With the explicit opt-in it converts and loads.
    const rec = normalizeTxgioFeature(
      "48269",
      0,
      KING_48269_WEB_MERCATOR_PARCEL as never,
      counters,
      { reprojectFrom: "EPSG:3857" },
    );
    expect(rec).not.toBeNull();
    expect(counters.rowsSkipped).toBe(0);
    // Lands in King County, in degrees, in one grid cell.
    expect(rec!.bbox.westLng).toBeCloseTo(-100.52050395900791, 8);
    expect(rec!.bbox.southLat).toBeCloseTo(33.39353987451293, 8);
    expect(isPlausibleTexasWgs84Bbox(rec!.bbox)).toBe(true);
    // A real parcel's worth of cells (this one's west edge at
    // -100.520504 sits just past the -100.52 cell boundary, so it spans
    // two) — not the ~9.1e12 the unconverted metre coordinates produced.
    expect(rec!.tileKeys).toEqual([
      "g0.02:-100.54000,33.38000",
      "g0.02:-100.52000,33.38000",
    ]);
    // Stored geometry is the CONVERTED geometry, not the source metres.
    const stored = rec!.geometry as unknown as { coordinates: number[][][] };
    expect(stored.coordinates[0][0][0]).toBeCloseTo(-100.5205, 4);
    // Attributes are untouched by the conversion.
    expect(rec!.propId).toBe("5001");
    expect(rec!.ownerName).toBe("KING RANCH TEST");
  });

  it("is OPT-IN: the identical feature still fails closed with no option", () => {
    const counters = newCounters();
    expect(() =>
      normalizeTxgioFeature(
        "48269",
        0,
        KING_48269_WEB_MERCATOR_PARCEL as never,
        counters,
      ),
    ).toThrow(TxgioProjectionError);
  });

  it("THE GUARD STAYS ARMED: a conversion landing outside Texas still throws", () => {
    // Real EPSG:3857 metres for a point in KANSAS (lng -98.0, lat
    // 38.5) — a perfectly valid Web Mercator conversion whose RESULT is
    // not in Texas. Proves the envelope assertion runs AFTER the
    // reprojection rather than being bypassed by it.
    const [x, y] = wgs84ToWebMercator(-98.0, 38.5);
    const counters = newCounters();
    expect(() =>
      normalizeTxgioFeature(
        "48269",
        7,
        {
          geometry: {
            type: "Polygon",
            coordinates: [
              [
                [x, y],
                [x + 60, y],
                [x + 60, y + 45],
                [x, y + 45],
                [x, y],
              ],
            ],
          },
          properties: { Prop_ID: "9001" },
        } as never,
        counters,
        { reprojectFrom: "EPSG:3857" },
      ),
    ).toThrow(TxgioProjectionError);
    expect(() =>
      normalizeTxgioFeature(
        "48269",
        7,
        {
          geometry: {
            type: "Polygon",
            coordinates: [[[x, y], [x + 60, y], [x + 60, y + 45], [x, y]]],
          },
          properties: {},
        } as never,
        counters,
        { reprojectFrom: "EPSG:3857" },
      ),
    ).toThrow(/outside the plausible Texas WGS84 envelope/);
    // Never absorbed into the per-feature skip counter.
    expect(counters.rowsSkipped).toBe(0);
  });

  it("does not corrupt an already-geographic feature when the flag is absent", () => {
    const counters = newCounters();
    const rec = normalizeTxgioFeature(
      "48209",
      0,
      HAYS_PARCEL_12310 as never,
      counters,
    );
    expect(rec).not.toBeNull();
    expect(rec!.bbox.westLng).toBeCloseTo(-97.91313552599996, 10);
  });
});

describe("reprojection provenance on the row", () => {
  it("stamps the vintage so a converted county is self-describing", () => {
    expect(
      vintageWithProvenance(
        "stratmap25-landparcels_48269_king_202505",
        "EPSG:3857",
      ),
    ).toBe(
      `stratmap25-landparcels_48269_king_202505${REPROJECTED_VINTAGE_SUFFIX}`,
    );
    expect(REPROJECTED_VINTAGE_SUFFIX).toBe("+reprojected-from-epsg3857");
  });

  it("leaves an unconverted county's vintage byte-identical", () => {
    // No marker on a county that was already in degrees — the absence of
    // the suffix is itself the claim that nothing was converted.
    expect(
      vintageWithProvenance("stratmap25-landparcels_48209_hays_202503"),
    ).toBe("stratmap25-landparcels_48209_hays_202503");
  });
});

describe("cellKeysForBbox hardening", () => {
  it("throws rather than attempting an absurd key set when uncapped", () => {
    // The exact pre-fix failure path: ingest calls with maxCells
    // undefined, so the cap never engaged and the run died on memory.
    expect(() => cellKeysForBbox(KING_48269_WEB_MERCATOR_BBOX)).toThrow(
      /hard ceiling/,
    );
  });

  it("throws on non-finite coordinates instead of looping forever", () => {
    expect(() =>
      cellKeysForBbox({
        westLng: -Infinity,
        southLat: 29,
        eastLng: -97,
        northLat: 30,
      }),
    ).toThrow(/non-finite cell count/);
  });

  it("leaves the reader's maxCells fallback contract intact", () => {
    // A large-but-legitimate viewport still returns null (not a throw)
    // so api-server's bbox-column fallback keeps working.
    const viewport = {
      westLng: -98.5,
      southLat: 29.5,
      eastLng: -97.5,
      northLat: 30.5,
    };
    expect(cellKeysForBbox(viewport, TXGIO_TILE_GRID_DEG, 256)).toBeNull();
    expect(cellKeysForBbox(viewport, TXGIO_TILE_GRID_DEG)).not.toBeNull();
  });

  it("cellCountForBbox agrees with the materialized key count", () => {
    const bbox = {
      westLng: -97.93,
      southLat: 29.89,
      eastLng: -97.9,
      northLat: 29.91,
    };
    expect(cellCountForBbox(bbox)).toBe(cellKeysForBbox(bbox)!.length);
  });
});

describe("TxGIO county registry + zip entry filter", () => {
  it("resolves the loaded counties by fips and name, returning the registry object by identity", () => {
    expect(resolveTxgioCounty("48209")?.name).toBe("Hays");
    expect(resolveTxgioCounty("comal")?.fips).toBe("48091");
    expect(resolveTxgioCounty("48453")?.name).toBe("Travis");
    expect(resolveTxgioCounty("mclennan")?.fips).toBe("48309");
    expect(resolveTxgioCounty("48187")?.name).toBe("Guadalupe");
    // Identity matters: jurisdictions.ts composes these exact objects.
    expect(resolveTxgioCounty("48209")).toBe(TXGIO_COUNTIES["48209"]);
    expect(resolveTxgioCounty("travis")).toBe(TXGIO_COUNTIES["48453"]);
  });

  it("resolves UNLOADED counties too — the 19-county allowlist no longer gates the CLI", () => {
    // The blocker: these counties could not previously be resolved at
    // all, so the ingest CLI failed closed before any network call and
    // an unloaded county could not even be dry-run.
    const king = resolveTxgioCounty("48269");
    expect(king?.name).toBe("King");
    expect(king?.downloadUrl).toBe(txgioDownloadUrl("48269"));
    expect(resolveTxgioCounty("harris")?.fips).toBe("48201");
    expect(resolveTxgioCounty("48035")?.name).toBe("Bosque");
    // ...and they are correctly reported as NOT loaded.
    expect(isTxgioCountyLoaded("48269")).toBe(false);
    expect(isTxgioCountyLoaded("48209")).toBe(true);
  });

  it("carries all 254 Texas counties, and only real ones", () => {
    expect(Object.keys(TXGIO_STATEWIDE_COUNTIES)).toHaveLength(254);
    // Texas county codes are the odd numbers 001..507, exactly.
    for (const fips of Object.keys(TXGIO_STATEWIDE_COUNTIES)) {
      expect(fips).toMatch(/^48\d{3}$/);
      const code = Number(fips.slice(2));
      expect(code % 2).toBe(1);
      expect(code).toBeGreaterThanOrEqual(1);
      expect(code).toBeLessThanOrEqual(507);
    }
    // Every loaded county is a real one, with a matching name.
    for (const [fips, entry] of Object.entries(TXGIO_COUNTIES)) {
      expect(TXGIO_STATEWIDE_COUNTIES[fips]).toBe(entry.name);
    }
  });

  it("still fails closed on a typo, a non-county, or an out-of-state FIPS", () => {
    // 48999 and 48200 are not Texas counties (999 out of range; 200 even).
    expect(resolveTxgioCounty("48999")).toBeUndefined();
    expect(resolveTxgioCounty("48200")).toBeUndefined();
    expect(resolveTxgioCounty("49037")).toBeUndefined(); // San Juan, UT
    expect(resolveTxgioCounty("notacounty")).toBeUndefined();
    expect(isTexasCountyFips("48999")).toBe(false);
    expect(isTexasCountyFips("48269")).toBe(true);
  });

  it("names Donley 48129 as an honest absence rather than pretending it fetches", () => {
    // Resolvable (it IS a Texas county) but its StratMap archive 404s,
    // so the CLI refuses with an explanation instead of a stack trace.
    expect(resolveTxgioCounty("48129")?.name).toBe("Donley");
    expect(TXGIO_ABSENT_FROM_STRATMAP["48129"]).toMatch(/404/);
    expect(TXGIO_ABSENT_FROM_STRATMAP["48269"]).toBeUndefined();
  });

  it("storeLoadedLabel is store-derived, not the hand TXGIO_COUNTIES map", () => {
    // Kenedy (48261) is NOT on the hand map, but prior wave proof left
    // rows in the store — CLI "loaded before" must follow row count.
    expect(isTxgioCountyLoaded("48261")).toBe(false);
    expect(storeLoadedLabel(2400)).toBe("yes");
    expect(storeLoadedLabel(1)).toBe("yes");
    expect(storeLoadedLabel(0)).toBe("no");
    expect(storeLoadedLabel(null)).toBe("unknown (no DATABASE_URL)");
    // A hand-map county with zero store rows is still "no".
    expect(isTxgioCountyLoaded("48209")).toBe(true);
    expect(storeLoadedLabel(0)).toBe("no");
  });

  it("storeListLoadState queries store set; UNKNOWN when DATABASE_URL absent", () => {
    const store = new Set(["48209", "48261"]);
    expect(storeListLoadState("48261", store, false)).toBe("LOADED");
    expect(storeListLoadState("48269", store, false)).toBe("-     ");
    expect(storeListLoadState("48129", store, true)).toBe("ABSENT");
    // No store observation: never fall back to the hand map.
    expect(storeListLoadState("48209", null, false)).toBe("UNKNOWN");
    expect(storeListLoadState("48261", null, false)).toBe("UNKNOWN");
    expect(storeListLoadState("48129", null, true)).toBe("ABSENT");
  });

  it("builds the collection resource URL", () => {
    expect(txgioDownloadUrl("48209")).toBe(
      "https://data.geographic.texas.gov/0fa04328-872e-481c-b453-126a74777593/resources/stratmap25-landparcels_48209_lp.zip",
    );
  });

  it("extracts only the shapefile sidecars we parse", () => {
    expect(TXGIO_ENTRY_FILTER("shp/stratmap25-landparcels_48209_hays_202503.shp")).toBe(true);
    expect(TXGIO_ENTRY_FILTER("shp/stratmap25-landparcels_48209_hays_202503.dbf")).toBe(true);
    expect(TXGIO_ENTRY_FILTER("shp/stratmap25-landparcels_48209_hays_202503.prj")).toBe(true);
    // The 251MB fgdb copy and the .sbn/.xml sidecars stay in the zip.
    expect(TXGIO_ENTRY_FILTER("fgdb/stratmap25.gdb/a00000001.gdbtable")).toBe(false);
    expect(TXGIO_ENTRY_FILTER("shp/stratmap25-landparcels_48209_hays_202503.shp.xml")).toBe(false);
    expect(TXGIO_ENTRY_FILTER("shp/stratmap25-landparcels_48209_hays_202503.sbn")).toBe(false);
  });
});

describe("cad-ingest CLI micro-fix: deriveVintage", () => {
  it("URL-decodes percent escapes instead of storing them (Travis regression)", () => {
    expect(
      deriveVintage(
        "https://traviscad.org/wp-content/largefiles/2026%20preliminary%20appraisal%20export%20supp%200_07072026.zip",
      ),
    ).toBe("2026-preliminary-appraisal-export-supp-0_07072026");
  });

  it("strips query/hash and extension, lowercases, dashes whitespace", () => {
    expect(deriveVintage("https://x.test/Drops/DATA-EXPORT-2026.zip?dl=1#frag")).toBe(
      "data-export-2026",
    );
    expect(deriveVintage("C:\\drops\\Hays Property 2026.TXT")).toBe(
      "hays-property-2026",
    );
  });

  it("keeps the raw basename on malformed percent escapes", () => {
    expect(deriveVintage("https://x.test/bad%zzname.zip")).toBe("bad%zzname");
  });
});
