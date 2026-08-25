import { describe, expect, it, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  loadCityLimitsFact,
  resetCityLimitsIndexForTests,
  setCityLimitsIndexForTests,
} from "./cityLimitsFactRead";
import { buildCityBoundaryIndex } from "@workspace/cad-ingest/boundary";

const AUSTIN = buildCityBoundaryIndex([
  {
    geoId: "4805000",
    cityName: "Austin",
    gnis: "1389879",
    geometry: {
      type: "Polygon",
      coordinates: [
        [
          [-97.78, 30.24],
          [-97.72, 30.24],
          [-97.72, 30.28],
          [-97.78, 30.28],
          [-97.78, 30.24],
        ],
      ],
    },
  },
]);

const IN_CITY = { longitude: -97.75, latitude: 30.26 };
const RURAL = { longitude: -101.5, latitude: 32.5 };

afterEach(() => {
  resetCityLimitsIndexForTests();
});

describe("loadCityLimitsFact", () => {
  it("fixture incorporated names the city and leaves ETJ unresolved", async () => {
    setCityLimitsIndexForTests({ tablePopulated: true, entries: AUSTIN });
    const fact = await loadCityLimitsFact(IN_CITY);
    expect(fact.status).toBe("incorporated");
    expect(fact.cityName).toBe("Austin");
    expect(fact.geoId).toBe("4805000");
    expect(fact.etjStatus).toBe("unresolved");
    expect(fact.source).toBe("tx_city_boundary");
    expect(fact.basis).toContain("geo_id=4805000");
  });

  it("fixture unincorporated does not invent a city or ETJ ring", async () => {
    setCityLimitsIndexForTests({ tablePopulated: true, entries: AUSTIN });
    const fact = await loadCityLimitsFact(RURAL);
    expect(fact.status).toBe("unincorporated");
    expect(fact.cityName).toBeUndefined();
    expect(fact.etjStatus).toBe("unresolved");
  });

  it("empty index is unmeasured, not unincorporated", async () => {
    setCityLimitsIndexForTests({ tablePopulated: false, entries: [] });
    const fact = await loadCityLimitsFact(IN_CITY);
    expect(fact.status).toBe("unmeasured");
    expect(fact.basis).toContain("unmeasured");
    expect(fact.basis).not.toContain("unincorporated is the honest answer");
    expect(fact.etjStatus).toBe("unresolved");
  });

  it("populated table with no bbox hit is unincorporated", async () => {
    setCityLimitsIndexForTests({ tablePopulated: true, entries: [] });
    const fact = await loadCityLimitsFact(RURAL);
    expect(fact.status).toBe("unincorporated");
    expect(fact.etjStatus).toBe("unresolved");
  });

  it("missing query point is unmeasured", async () => {
    setCityLimitsIndexForTests({ tablePopulated: true, entries: AUSTIN });
    const fact = await loadCityLimitsFact(null);
    expect(fact.status).toBe("unmeasured");
    expect(fact.basis).toContain("query point");
  });

  it("does not treat a 2-mile offset as ETJ", async () => {
    setCityLimitsIndexForTests({ tablePopulated: true, entries: AUSTIN });
    const fact = await loadCityLimitsFact({
      longitude: -97.72 + 0.04,
      latitude: 30.26,
    });
    expect(fact.status).toBe("unincorporated");
    expect(fact.etjStatus).toBe("unresolved");
    expect(JSON.stringify(fact)).not.toMatch(/"status":"etj/i);

    const src = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "cityLimitsFactRead.ts"),
      "utf8",
    );
    expect(src).not.toMatch(/buffer(ed)?\s*(polygon|ring|miles)/i);
    expect(src).not.toMatch(/offset\s*2\s*miles/i);
  });
});
