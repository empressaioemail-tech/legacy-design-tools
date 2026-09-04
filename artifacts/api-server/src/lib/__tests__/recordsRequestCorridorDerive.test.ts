/**
 * P-85 WDLL item 9 — corridor derivation fixtures + refuse fixture.
 */

import { describe, expect, it } from "vitest";
import { PARCEL_714_SPRING_33512 } from "../buildableEnvelope/fixtures/parcelRings";
import {
  assertCorridorDerivationWritable,
  deriveCorridorFromClause,
  parseCorridorEdgeHint,
  parseCorridorWidthFt,
  RECORDS_REQUEST_CORRIDOR_DERIVE_VERSION,
  RecordsRequestCorridorRefuseError,
} from "../recordsRequestCorridorDerive";

const PARCEL_REF = "apn:48021:33512";
const CLAUSE_DID = "did:hauska:clause:fixture:1";

describe("parseCorridorWidthFt", () => {
  it("parses explicit foot widths", () => {
    expect(parseCorridorWidthFt("twenty-foot utility easement")).toBe(20);
    expect(parseCorridorWidthFt("a 20-foot utility easement")).toBe(20);
    expect(parseCorridorWidthFt("ten-foot drainage easement")).toBe(10);
  });
});

describe("deriveCorridorFromClause — P-85 item 9 fixtures", () => {
  it("rear-line utility easement — places corridor strip with derivesFrom", () => {
    const body =
      "Grantee shall have a twenty-foot utility easement along the rear line of the lot for ingress and egress of utilities.";

    expect(parseCorridorEdgeHint(body)).toEqual({ kind: "labeled", label: "rear" });

    const result = deriveCorridorFromClause({
      clauseDid: CLAUSE_DID,
      bodyText: body,
      parcelGeometryRef: PARCEL_REF,
      parcelRing: PARCEL_714_SPRING_33512,
    });

    expect(result.kind).toBe("derived");
    if (result.kind !== "derived") return;

    const c = result.constrains;
    expect(c.placement).toBe("placed");
    expect(c.derivesFrom).toEqual({
      clauseDid: CLAUSE_DID,
      parcelGeometryRef: PARCEL_REF,
    });
    expect(c.methodId).toBe(`${RECORDS_REQUEST_CORRIDOR_DERIVE_VERSION}:rear-line-strip`);
    expect(c.widthFt).toBe(20);
    expect(c.edgeHint).toBe("rear");
    expect(c.geometryGeojson?.type).toBe("Polygon");
    expect(c.geometryGeojson?.coordinates[0]?.length).toBeGreaterThanOrEqual(4);
    expect(c.confidence).toBeGreaterThan(0);
    expect(c.confidence).toBeLessThan(1);

    assertCorridorDerivationWritable(c);
  });

  it("plat-drawn drainage corridor — east boundary with plat note", () => {
    const body =
      "A ten-foot drainage easement is reserved along the east boundary as shown on the plat for storm water conveyance.";

    expect(parseCorridorEdgeHint(body)).toEqual({
      kind: "compass",
      direction: "east",
      platNoted: true,
    });

    const result = deriveCorridorFromClause({
      clauseDid: CLAUSE_DID,
      bodyText: body,
      parcelGeometryRef: PARCEL_REF,
      parcelRing: PARCEL_714_SPRING_33512,
    });

    expect(result.kind).toBe("derived");
    if (result.kind !== "derived") return;

    const c = result.constrains;
    expect(c.placement).toBe("placed");
    expect(c.methodId).toBe(`${RECORDS_REQUEST_CORRIDOR_DERIVE_VERSION}:plat-noted-strip`);
    expect(c.widthFt).toBe(10);
    expect(c.edgeHint).toBe("east");
    expect(c.geometryGeojson?.type).toBe("Polygon");
    expect(c.derivesFrom.clauseDid).toBe(CLAUSE_DID);
    assertCorridorDerivationWritable(c);
  });

  it("unplaceable clause — says so and draws nothing", () => {
    const body =
      "Grantee may install utilities in such location as the parties may mutually agree from time to time.";

    const result = deriveCorridorFromClause({
      clauseDid: CLAUSE_DID,
      bodyText: body,
      parcelGeometryRef: PARCEL_REF,
      parcelRing: PARCEL_714_SPRING_33512,
    });

    expect(result.kind).toBe("derived");
    if (result.kind !== "derived") return;

    const c = result.constrains;
    expect(c.placement).toBe("unplaceable");
    expect(c.unplaceableReason).toMatch(/fixed boundary anchor/i);
    expect(c.geometryGeojson).toBeUndefined();
    expect(c.derivesFrom.clauseDid).toBe(CLAUSE_DID);
    expect(c.confidence).toBe(0);
    assertCorridorDerivationWritable(c);
  });

  it("refuse fixture — corridor geometry without derivesFrom", () => {
    expect(() =>
      assertCorridorDerivationWritable({
        type: "corridor",
        placement: "placed",
        derivesFrom: { clauseDid: "", parcelGeometryRef: "" },
        geometryGeojson: {
          type: "Polygon",
          coordinates: [
            [
              [-97.31, 30.11],
              [-97.31, 30.12],
              [-97.32, 30.12],
              [-97.32, 30.11],
              [-97.31, 30.11],
            ],
          ],
        },
      }),
    ).toThrow(RecordsRequestCorridorRefuseError);

    try {
      assertCorridorDerivationWritable({
        type: "corridor",
        placement: "placed",
        geometryGeojson: {
          type: "Polygon",
          coordinates: [
            [
              [-97.31, 30.11],
              [-97.31, 30.12],
              [-97.32, 30.12],
              [-97.32, 30.11],
              [-97.31, 30.11],
            ],
          ],
        },
      });
      expect.fail("expected refuse");
    } catch (err) {
      expect(err).toBeInstanceOf(RecordsRequestCorridorRefuseError);
      expect((err as RecordsRequestCorridorRefuseError).code).toBe(
        "corridor_missing_derives_from",
      );
    }
  });

  it("non-corridor clause returns not_corridor_clause", () => {
    const result = deriveCorridorFromClause({
      clauseDid: CLAUSE_DID,
      bodyText: "No structures shall exceed thirty-five feet in height.",
      parcelGeometryRef: PARCEL_REF,
      parcelRing: PARCEL_714_SPRING_33512,
    });
    expect(result.kind).toBe("not_corridor_clause");
  });
});
