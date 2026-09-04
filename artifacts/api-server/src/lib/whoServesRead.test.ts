/**
 * P-75 who-serves serve-time read.
 *
 * Both directions: a polygon hit returns holders + residual; a miss
 * returns holders [] + residual. Empty-object success is refused by
 * violation: assertWhoServesSection({}) throws.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import express from "express";
import request from "supertest";
import { TX_UTILITY_TERRITORY_STAGING_TABLE } from "@workspace/db/schema";
import type { GeoJsonGeometry } from "@workspace/cad-ingest/txgio-geo";
import { createWhoServesRouter } from "../routes/whoServes";
import {
  WHO_SERVES_MIGRATION,
  WHO_SERVES_RESIDUAL,
  WHO_SERVES_TABLE,
  assembleWhoServesFromHits,
  assertWhoServesSection,
  holderFromCandidate,
  serveWhoServesAtPoint,
  unmeasuredWhoServesSection,
  type WhoServesCandidate,
  type WhoServesMeasured,
  type WhoServesSection,
} from "./whoServesRead";

function asMeasured(section: WhoServesSection): WhoServesMeasured {
  if (section.status !== "measured") {
    throw new Error(`expected measured who-serves section, got ${section.status}`);
  }
  return section;
}

const here = dirname(fileURLToPath(import.meta.url));

const UNIT_SQUARE: GeoJsonGeometry = {
  type: "Polygon",
  coordinates: [
    [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
      [-1, -1],
    ],
  ],
};

const FETCHED = "2026-08-14T16:24:00.000Z";

function candidate(
  overrides: Partial<WhoServesCandidate> &
    Pick<WhoServesCandidate, "sourceKey" | "serviceKind" | "territoryId">,
): WhoServesCandidate {
  return {
    territoryName: overrides.territoryName ?? "Fixture Territory",
    geometry: overrides.geometry ?? UNIT_SQUARE,
    fetchedAt: overrides.fetchedAt ?? FETCHED,
    ...overrides,
  };
}

describe("0076 pin", () => {
  it("schema module and reader name the 0076 table, not a guess", () => {
    const migration = readFileSync(
      join(
        here,
        "../../../../lib/db/drizzle",
        WHO_SERVES_MIGRATION,
      ),
      "utf8",
    );
    expect(migration).toContain(
      `CREATE TABLE IF NOT EXISTS "${TX_UTILITY_TERRITORY_STAGING_TABLE}"`,
    );
    expect(WHO_SERVES_TABLE).toBe("tx_utility_territory_staging");
    expect(WHO_SERVES_TABLE).toBe(TX_UTILITY_TERRITORY_STAGING_TABLE);
  });
});

describe("assembleWhoServesFromHits", () => {
  it("empty hit set returns holders [] plus residual, never {}", () => {
    const section = assembleWhoServesFromHits(10, 10, [
      candidate({
        sourceKey: "puct-water-ccn",
        serviceKind: "water",
        territoryId: "ccn-1",
      }),
    ]);
    expect(section).not.toEqual({});
    const measured = asMeasured(section);
    expect(measured.holders).toEqual([]);
    expect(measured.residual).toBe(WHO_SERVES_RESIDUAL);
    expect(assertWhoServesSection(measured).holders).toEqual([]);
  });

  it("zero candidates still returns residual, never {}", () => {
    const measured = asMeasured(assembleWhoServesFromHits(30.11, -97.32, []));
    expect(measured.holders).toEqual([]);
    expect(measured.residual).toBe(WHO_SERVES_RESIDUAL);
    expect(measured.asOf).toBeNull();
  });

  it("a hit still carries the residual sentence", () => {
    const section = assembleWhoServesFromHits(0, 0, [
      candidate({
        sourceKey: "puct-water-ccn",
        serviceKind: "water",
        territoryId: "ccn-1",
        territoryName: "Aqua Water Supply",
      }),
      candidate({
        sourceKey: "puct-sewer-ccn",
        serviceKind: "sewer",
        territoryId: "ccn-s1",
        territoryName: "Aqua Sewer",
      }),
    ]);
    const measured = asMeasured(section);
    expect(measured.holders).toEqual([
      {
        source_key: "puct-water-ccn",
        service_kind: "water",
        territory_id: "ccn-1",
        territory_name: "Aqua Water Supply",
      },
      {
        source_key: "puct-sewer-ccn",
        service_kind: "sewer",
        territory_id: "ccn-s1",
        territory_name: "Aqua Sewer",
      },
    ]);
    expect(measured.residual).toBe(WHO_SERVES_RESIDUAL);
    expect(measured.asOf).toBe(FETCHED);
  });

  it("TCEQ additive rows stay water-district, not water CCN", () => {
    const section = assembleWhoServesFromHits(0, 0, [
      candidate({
        sourceKey: "tceq-water-districts",
        serviceKind: "water-district",
        territoryId: "5857545",
        territoryName: "Montgomery County MUD 140",
      }),
    ]);
    expect(section.holders).toEqual([
      {
        source_key: "tceq-water-districts",
        service_kind: "water-district",
        territory_id: "5857545",
        territory_name: "Montgomery County MUD 140",
      },
    ]);
    expect(section.holders[0]?.service_kind).not.toBe("water");
  });
});

describe("assertWhoServesSection — violate empty-object success", () => {
  it("throws on {}", () => {
    expect(() => assertWhoServesSection({})).toThrow(
      /empty-object success is refused/,
    );
  });

  it("throws on a residual-less holders object", () => {
    expect(() =>
      assertWhoServesSection({
        holders: [],
      }),
    ).toThrow(/empty-object success is refused/);
  });

  it("throws when TCEQ is restated as water", () => {
    expect(() =>
      assertWhoServesSection({
        holders: [
          {
            source_key: "tceq-water-districts",
            service_kind: "water",
            territory_id: "5857545",
            territory_name: "Montgomery County MUD 140",
          },
        ],
        residual: WHO_SERVES_RESIDUAL,
      }),
    ).toThrow(/TCEQ additive row restated as water CCN/);
  });

  it("empty staging table is unmeasured, not a searched miss", () => {
    const section = unmeasuredWhoServesSection();
    expect(section.status).toBe("unmeasured");
    expect(section.holders).toEqual([]);
    expect(section).not.toHaveProperty("residual");
    expect(assertWhoServesSection(section).status).toBe("unmeasured");
  });

  it("throws when unmeasured carries residual as if a search ran", () => {
    expect(() =>
      assertWhoServesSection({
        status: "unmeasured",
        basis: "empty",
        holders: [],
        residual: WHO_SERVES_RESIDUAL,
      }),
    ).toThrow(/must not carry SERVICE-LETTER-REQUIRED/);
  });

  it("holderFromCandidate refuses a TCEQ-as-water remap", () => {
    expect(() =>
      holderFromCandidate(
        candidate({
          sourceKey: "tceq-water-districts",
          serviceKind: "water",
          territoryId: "5857545",
        }),
      ),
    ).toThrow(/TCEQ additive row restated as water CCN/);
  });
});

describe("HTTP attach", () => {
  it("miss returns holders [] + residual, not {}", async () => {
    const app = express();
    app.use(
      "/who-serves",
      createWhoServesRouter(async () => [
        candidate({
          sourceKey: "puct-water-ccn",
          serviceKind: "water",
          territoryId: "ccn-1",
        }),
      ]),
    );
    const res = await request(app).get("/who-serves").query({ lat: 10, lng: 10 });
    expect(res.status).toBe(200);
    expect(res.body).not.toEqual({});
    expect(res.body.status).toBe("measured");
    expect(res.body.holders).toEqual([]);
    expect(res.body.residual).toBe(WHO_SERVES_RESIDUAL);
  });

  it("hit returns holders + residual", async () => {
    const app = express();
    app.use(
      "/who-serves",
      createWhoServesRouter(async () => [
        candidate({
          sourceKey: "hifld-electric-retail",
          serviceKind: "electric",
          territoryId: "e-1",
          territoryName: "Bluebonnet Electric",
        }),
      ]),
    );
    const res = await request(app).get("/who-serves").query({ lat: 0, lng: 0 });
    expect(res.status).toBe(200);
    expect(res.body.holders).toEqual([
      {
        source_key: "hifld-electric-retail",
        service_kind: "electric",
        territory_id: "e-1",
        territory_name: "Bluebonnet Electric",
      },
    ]);
    expect(res.body.status).toBe("measured");
    expect(res.body.residual).toBe(WHO_SERVES_RESIDUAL);
  });

  it("HTTP empty store is unmeasured, not holders[]+residual", async () => {
    const app = express();
    app.use(
      "/who-serves",
      createWhoServesRouter(async () => {
        throw new Error("loader must not run when staging count is 0");
      }, async () => 0),
    );
    const res = await request(app).get("/who-serves").query({ lat: 30.11, lng: -97.32 });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("unmeasured");
    expect(res.body.residual).toBeUndefined();
    expect(res.body.holders).toEqual([]);
  });

  it("serveWhoServesAtPoint refuses a loader that returns a blank success", async () => {
    await expect(
      serveWhoServesAtPoint(0, 0, async () => {
        throw new Error("loader must not collapse to {}");
      }),
    ).rejects.toThrow(/loader must not collapse/);

    expect(() => assertWhoServesSection({})).toThrow(
      /empty-object success is refused/,
    );
  });

  it("missing lat/lng is 400, not a blank section", async () => {
    const app = express();
    app.use(
      "/who-serves",
      createWhoServesRouter(async () => []),
    );
    const res = await request(app).get("/who-serves");
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("who_serves_point_required");
    expect(res.body.holders).toBeUndefined();
  });
});
