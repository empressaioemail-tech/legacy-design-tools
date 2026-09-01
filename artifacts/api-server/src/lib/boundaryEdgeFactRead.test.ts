/**
 * Dual-grammar property-boundary-edge bind + interpret. No store.
 *
 * Snapshot / CAD / GIS / txgio_parcel values are out of this file on
 * purpose. Geometry comes from the atom body, never from a GIS parcel
 * outline. L17: refuse probes use lowercase `from cad_property` only.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  interpretBoundaryEdgeFactRows,
  loadBoundaryEdgeFactAtom,
  memoryBoundaryEdgeFactAtoms,
  resetBoundaryEdgeFactAtomQueryableForTests,
  setBoundaryEdgeFactAtomQueryableForTests,
  boundaryEdgeFactBindPrefixes,
  boundaryEdgeFactPrefixRanges,
} from "./boundaryEdgeFactRead";

const GOLD = "48021:34137";
const GOLD_PADDED = "48021:34137.00000000";
const GOLD_FRONT = "48021:34137:boundary:2";
const CC_HISTORIC = "48021:28286";
const MISS = "00000:does-not-exist";

const LOCAL_ENU: [[number, number], [number, number]] = [
  [0, 0],
  [30.18, 0],
];

function goldBody(edgeIndex: number, extra: Record<string, unknown>) {
  return {
    entityType: "property-boundary-edge",
    atomDid: `pbedge_4802134137_${edgeIndex}`,
    boundaryEdgeId: `48021:34137:boundary:${edgeIndex}`,
    parcelNodeId: GOLD,
    countyFips: "48021",
    propId: "34137",
    edgeIndex,
    interior: {
      ringCcw: true,
      centroidInside: true,
      inwardNormal: { x: 0, y: 1 },
      edgeEndpoints: LOCAL_ENU,
    },
    propertyLineTags: {
      bearing: "N 0°00' E",
      distanceFeet: 99.0,
      provenance: {
        kind: "gis-approximate",
        honesty: "GIS-approximate from ring endpoints; never survey-grade",
        source: "depth-warm-projectRing",
      },
    },
    sourceAdapter: "descriptor-fixture",
    extractedAt: "2026-07-29T21:07:59.334Z",
    ...extra,
  };
}

const GOLD_EDGES = [
  {
    entityId: "48021:34137:boundary:0",
    body: goldBody(0, {
      role: "rear",
      adjacencyKind: "alley",
      facingRoad: {
        roadNodeId: "48021:road:925036023",
        classification: "alley",
        provenance: "osm-overpass-v1",
      },
      setback: { feet: 5, provenance: "descriptor-fixture" },
    }),
  },
  {
    entityId: "48021:34137:boundary:1",
    body: goldBody(1, {
      role: "side",
      adjacencyKind: "neighbor-parcel",
      parcelNeighborPropId: "34169",
      facingRoad: null,
      setback: { feet: 0, provenance: "descriptor-fixture" },
    }),
  },
  {
    entityId: GOLD_FRONT,
    body: goldBody(2, {
      role: "front",
      adjacencyKind: "ROW",
      frontBasis: "situs-street-match",
      parcelNeighborPropId: "34121",
      facingRoad: {
        roadNodeId: "48021:road:15113284",
        classification: "residential",
        provenance: "osm-overpass-v1",
      },
      setback: { feet: 15, provenance: "descriptor-fixture" },
    }),
  },
  {
    entityId: "48021:34137:boundary:3",
    body: goldBody(3, {
      role: "side_corner",
      adjacencyKind: "ROW",
      facingRoad: {
        roadNodeId: "48021:road:129017865",
        classification: "residential",
        provenance: "osm-overpass-v1",
      },
      setback: { feet: 0, provenance: "descriptor-fixture" },
    }),
  },
];

afterEach(() => {
  resetBoundaryEdgeFactAtomQueryableForTests();
});

describe("boundaryEdgeFactBindPrefixes — dual grammar on parcel prefixes only", () => {
  it("returns integer then padded for an integer inbound id", () => {
    expect(boundaryEdgeFactBindPrefixes(GOLD)).toEqual([GOLD, GOLD_PADDED]);
  });

  it("inverts a padded inbound id to the same pair", () => {
    expect(boundaryEdgeFactBindPrefixes(GOLD_PADDED)).toEqual([
      GOLD,
      GOLD_PADDED,
    ]);
  });

  it("never collapses to one prefix and never appends :boundary: or :sd:", () => {
    const prefixes = boundaryEdgeFactBindPrefixes(GOLD);
    expect(prefixes).toHaveLength(2);
    expect(new Set(prefixes).size).toBe(2);
    expect(prefixes[0]).toBe(GOLD);
    expect(prefixes[1]).toBe(GOLD_PADDED);
    expect(prefixes.join("|")).not.toContain(":sd:");
    expect(prefixes.join("|")).not.toContain(":boundary:");
  });

  it("builds prefix-range bounds that close on the writer :boundary: suffix", () => {
    const ranges = boundaryEdgeFactPrefixRanges(
      boundaryEdgeFactBindPrefixes(GOLD),
    );
    expect(ranges.integerStart).toBe("48021:34137:boundary:");
    expect(ranges.integerEnd).toBe("48021:34137:boundary;");
    expect(ranges.paddedStart).toBe("48021:34137.00000000:boundary:");
    expect(ranges.paddedEnd).toBe("48021:34137.00000000:boundary;");
  });
});

describe("interpretBoundaryEdgeFactRows", () => {
  it("serves gold 48021:34137 as present from writer keys and atom-body geometry", () => {
    const read = interpretBoundaryEdgeFactRows(
      GOLD,
      GOLD_EDGES.map((e) => ({ entity_id: e.entityId, body: e.body })),
    );
    expect(read.state).toBe("present");
    if (read.state !== "present") return;
    expect(read.source).toBe("property-boundary-edge");
    expect(read.boundAs).toBe(GOLD_FRONT);
    expect(read.tried).toEqual([GOLD, GOLD_PADDED]);
    expect(read.entityId).toBe(GOLD_FRONT);
    expect(read.edgeIndex).toBe(2);
    expect(read.role).toBe("front");
    expect(read.adjacencyKind).toBe("ROW");
    expect(read.frontBasis).toBe("situs-street-match");
    expect(read.facingRoad?.roadNodeId).toBe("48021:road:15113284");
    expect(read.edges).toHaveLength(4);
    expect(read.interior?.edgeEndpoints).toEqual(LOCAL_ENU);
    expect(read.propertyLineTags?.provenance?.kind).toBe("gis-approximate");
    expect(read.sourceAdapter).toBe("descriptor-fixture");
    expect(JSON.stringify(read)).not.toContain("txgio_parcel");
    expect(JSON.stringify(read)).not.toContain("GIS-MUST-NOT-LEAK");
  });

  it("serves a confirmatory 48021:28286 fixture as present", () => {
    const read = interpretBoundaryEdgeFactRows(CC_HISTORIC, [
      {
        entity_id: "48021:28286:boundary:2",
        body: {
          entityType: "property-boundary-edge",
          parcelNodeId: CC_HISTORIC,
          edgeIndex: 2,
          role: "front",
          adjacencyKind: "ROW",
          interior: { edgeEndpoints: LOCAL_ENU },
        },
      },
    ]);
    expect(read.state).toBe("present");
    if (read.state !== "present") return;
    expect(read.entityId).toBe("48021:28286:boundary:2");
    expect(read.source).toBe("property-boundary-edge");
  });

  it("empty rows are atom-miss, not a copied GIS outline", () => {
    const read = interpretBoundaryEdgeFactRows(MISS, []);
    expect(read.state).toBe("refused");
    if (read.state !== "refused") return;
    expect(read.code).toBe("atom-miss");
    expect(read.source).toBe("property-boundary-edge");
    expect(read.tried).toEqual([MISS, `${MISS}.00000000`]);
    expect(read.reason).toMatch(/Atom miss, not a GIS parcel outline/);
    expect(read).not.toHaveProperty("interior");
    expect(read).not.toHaveProperty("edges");
  });

  it("padded-only fixture yields present via inbound integer", () => {
    const paddedKey = "48021:34137.00000000:boundary:2";
    const read = interpretBoundaryEdgeFactRows(GOLD, [
      {
        entity_id: paddedKey,
        body: goldBody(2, {
          parcelNodeId: GOLD_PADDED,
          role: "front",
          adjacencyKind: "ROW",
        }),
      },
    ]);
    expect(read.state).toBe("present");
    if (read.state !== "present") return;
    expect(read.boundAs).toBe(paddedKey);
    expect(read.tried).toEqual([GOLD, GOLD_PADDED]);
    expect(read.source).toBe("property-boundary-edge");
  });

  it("both grammars disagreeing on edgeIndex set is bind-conflict", () => {
    const read = interpretBoundaryEdgeFactRows(GOLD, [
      {
        entity_id: "48021:34137:boundary:0",
        body: goldBody(0, { role: "rear", adjacencyKind: "alley" }),
      },
      {
        entity_id: "48021:34137.00000000:boundary:2",
        body: goldBody(2, {
          parcelNodeId: GOLD_PADDED,
          role: "front",
          adjacencyKind: "ROW",
        }),
      },
    ]);
    expect(read.state).toBe("refused");
    if (read.state !== "refused") return;
    expect(read.code).toBe("bind-conflict");
  });

  it("missing body.edgeIndex is malformed, not an invented GIS ring", () => {
    const read = interpretBoundaryEdgeFactRows(GOLD, [
      {
        entity_id: GOLD_FRONT,
        body: { entityType: "property-boundary-edge", role: "front" },
      },
    ]);
    expect(read.state).toBe("refused");
    if (read.state !== "refused") return;
    expect(read.code).toBe("malformed-atom");
    expect(read.reason).toMatch(/edgeIndex/);
  });

  it("does not copy GIS / snapshot field names onto boundaryEdgeFact from a non-atom body", () => {
    const read = interpretBoundaryEdgeFactRows(
      GOLD,
      GOLD_EDGES.map((e) => ({ entity_id: e.entityId, body: e.body })),
    );
    expect(read.state).toBe("present");
    if (read.state !== "present") return;
    expect(read).not.toHaveProperty("txgio_parcel");
    expect(read).not.toHaveProperty("parcelRing");
    expect(read).not.toHaveProperty("FOOTPRINT");
    expect(read.source).toBe("property-boundary-edge");
  });

  it("classifies a dimensional gold setback as value on both the lead and every edge", () => {
    const read = interpretBoundaryEdgeFactRows(
      GOLD,
      GOLD_EDGES.map((e) => ({ entity_id: e.entityId, body: e.body })),
    );
    expect(read.state).toBe("present");
    if (read.state !== "present") return;
    expect(read.setback.state).toBe("value");
    if (read.setback.state !== "value") return;
    expect(read.setback.feet).toBe(15);
    expect(read.setback.provenance).toBe("descriptor-fixture");
    for (const edge of read.edges) {
      expect(edge.setback.state).toBe("value");
      expect(edge.setback).toHaveProperty("feet");
    }
  });

  it("serves refused with the retired derivation named when the lead setback is road-class-setback-table", () => {
    const read = interpretBoundaryEdgeFactRows(GOLD, [
      {
        entity_id: GOLD_FRONT,
        body: goldBody(2, {
          role: "front",
          adjacencyKind: "ROW",
          setback: {
            feet: 15,
            provenance: "road-class-setback-table",
            atomCitation: "bastrop_tx",
          },
        }),
      },
    ]);
    expect(read.state).toBe("present");
    if (read.state !== "present") return;
    expect(read.setback.state).toBe("refused");
    expect(read.setback.basis).toMatch(/retired road-class derivation/);
    expect(read.setback.basis).toMatch(/road class is not a setback/);
    expect(read.setback.basis).not.toContain("road-class-setback-table");
    expect(read.setback).not.toHaveProperty("feet");
    expect(read.edges[0]?.setback.state).toBe("refused");
    expect(read.edges[0]?.setback).not.toHaveProperty("feet");
  });

  it("serves unknown, never absent-verified, for storage-port-proof/phase-1a", () => {
    const read = interpretBoundaryEdgeFactRows(GOLD, [
      {
        entity_id: GOLD_FRONT,
        body: goldBody(2, {
          role: "front",
          adjacencyKind: "ROW",
          setback: {
            feet: 0,
            provenance: "storage-port-proof/phase-1a",
          },
        }),
      },
    ]);
    expect(read.state).toBe("present");
    if (read.state !== "present") return;
    expect(read.setback.state).toBe("unknown");
    expect(read.setback.basis).toMatch(/phase-1a storage-port proof/);
    expect(read.setback.basis).not.toContain("storage-port-proof/phase-1a");
    expect(read.setback.state).not.toBe("absent");
    expect(JSON.stringify(read.setback)).not.toContain("absent-verified");
    expect(read.edges[0]?.setback.state).toBe("unknown");
  });
});

describe("loadBoundaryEdgeFactAtom — store seam", () => {
  it("refuses as atoms-store-not-configured when the queryable is null", async () => {
    setBoundaryEdgeFactAtomQueryableForTests(null);
    const read = await loadBoundaryEdgeFactAtom(GOLD);
    expect(read.state).toBe("refused");
    if (read.state !== "refused") return;
    expect(read.code).toBe("atoms-store-not-configured");
    expect(read.reason).toContain("ATOMS_DATABASE_URL");
    expect(read.reason).toMatch(/place_layer_snapshots|txgio_parcel|GIS/);
  });

  it("yields gold present when fixture atoms exist", async () => {
    setBoundaryEdgeFactAtomQueryableForTests(
      memoryBoundaryEdgeFactAtoms(GOLD_EDGES),
    );
    const read = await loadBoundaryEdgeFactAtom(GOLD);
    expect(read.state).toBe("present");
    if (read.state !== "present") return;
    expect(read.entityId).toBe(GOLD_FRONT);
    expect(read.role).toBe("front");
    expect(read.edges).toHaveLength(4);
    expect(read.source).toBe("property-boundary-edge");
  });

  it("the memory fake refuses a place_layer_snapshots query", async () => {
    const fake = memoryBoundaryEdgeFactAtoms([]);
    await expect(
      fake.query("SELECT payload_json FROM place_layer_snapshots WHERE place_key = $1", [
        "node:48021:34137",
      ]),
    ).rejects.toThrow(/place_layer_snapshots/);
  });

  it("the memory fake refuses a cad_property query", async () => {
    const fake = memoryBoundaryEdgeFactAtoms([]);
    await expect(
      fake.query("SELECT * from cad_property WHERE parcel_id = $1", [GOLD]),
    ).rejects.toThrow(/cad_property/);
  });

  it("the memory fake refuses a txgio_parcel query", async () => {
    const fake = memoryBoundaryEdgeFactAtoms([]);
    await expect(
      fake.query("SELECT geom FROM txgio_parcel WHERE parcel_id = $1", [GOLD]),
    ).rejects.toThrow(/txgio_parcel/);
  });

  it("the memory fake refuses a GIS query", async () => {
    const fake = memoryBoundaryEdgeFactAtoms([]);
    await expect(
      fake.query("SELECT geom FROM parcel_outline_GIS WHERE parcel = $1", [GOLD]),
    ).rejects.toThrow(/GIS/);
  });

  it("the memory fake refuses a special-district :sd: picker query", async () => {
    const fake = memoryBoundaryEdgeFactAtoms([]);
    await expect(
      fake.query(
        "SELECT entity_id, body FROM atoms WHERE entity_type = $1 AND entity_id LIKE $2 ESCAPE '\\' AND entity_id LIKE '%:sd:%'",
        ["property-boundary-edge", "48021:34137:sd:%"],
      ),
    ).rejects.toThrow(/:sd:/);
  });

  it("the memory fake refuses a pipeline-style ANY(bare parcel) query", async () => {
    const fake = memoryBoundaryEdgeFactAtoms([]);
    await expect(
      fake.query(
        "SELECT entity_id, body FROM atoms WHERE entity_type = $1 AND entity_id = ANY($2::text[])",
        ["property-boundary-edge", [GOLD, GOLD_PADDED]],
      ),
    ).rejects.toThrow(/ANY/);
  });
});

describe("boundaryEdgeFactRead source does not name the retired store", () => {
  it("the SELECT binds by :boundary: prefix-range and does not read bake/CAD/GIS", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(join(here, "boundaryEdgeFactRead.ts"), "utf8");
    expect(src).not.toMatch(/FROM\s+cad_property/i);
    expect(src).not.toMatch(/FROM\s+place_layer_snapshots/i);
    expect(src).not.toMatch(/FROM\s+txgio_parcel/i);
    expect(src).not.toMatch(/ST_Intersects/i);
    expect(src).not.toMatch(/ST_DWithin/i);
    const select = src.match(
      /const SELECT_BOUNDARY_EDGE_FACT = `([\s\S]*?)`;/,
    )?.[1];
    expect(select).toBeTruthy();
    expect(select).toMatch(/FROM atoms/);
    expect(select).toMatch(/entity_type = \$1/);
    expect(select).toMatch(/entity_id >= \$2/);
    expect(select).toMatch(/entity_id < \$3/);
    expect(select).not.toMatch(/LIKE/);
    expect(select).not.toMatch(/:sd:/);
    expect(select).not.toMatch(/entity_id = ANY/);
  });

  it("classifies setback at parse; does not copy raw rec.setback onto the item", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(join(here, "boundaryEdgeFactRead.ts"), "utf8");
    expect(src).toMatch(/serveBoundaryEdgeSetback\(rec\.setback\)/);
    expect(src).not.toMatch(/setback:\s*rec\.setback/);
  });
});
