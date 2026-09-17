/**
 * P-299 — `GET /api/local/setbacks/:jurisdictionKey` must treat a flagged
 * height as ABSENT, not as the corpus's 999 stated-absence sentinel.
 *
 * Deliberately NOT built on the shared route-test harness in
 * `./setup.ts`: that harness provisions a Postgres schema, and this endpoint is
 * DB-free (see the route's own docstring). Mounting the real router on a bare
 * express app exercises the real handler, the real `@workspace/adapters` lookup
 * and the real projection without needing a database — which is also why this
 * file can run in any environment.
 *
 * The falsifier this locks in: before P-299 the route served
 * `max_height_ft: 999` for the 21 Round Rock districts whose code states height
 * in stories, so the Site Context table (and anything sizing against the row)
 * read "999 ft" as a limit.
 */
import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import router, { heightIsAbsent } from "../routes/localSetbacks";

function app() {
  const a = express();
  a.use("/api", router);
  return a;
}

describe("P-299 — heightIsAbsent()", () => {
  it("is true for the flagged honest form, whatever the sentinel is", () => {
    expect(
      heightIsAbsent({
        max_height_ft: 999,
        provenance: { max_height_ft: { not_specified: true } },
      }),
    ).toBe(true);
  });

  it("is true for the bare canonical sentinel with NO flag (fails closed on the value too)", () => {
    expect(heightIsAbsent({ max_height_ft: 999 })).toBe(true);
    expect(
      heightIsAbsent({ max_height_ft: 999, provenance: { max_height_ft: {} } }),
    ).toBe(true);
  });

  it("is true whenever the flag is set, even on a non-sentinel number (the FLAG is the payload; rule G7 forbids that shape shipping)", () => {
    expect(
      heightIsAbsent({
        max_height_ft: 48,
        provenance: { max_height_ft: { not_specified: true } },
      }),
    ).toBe(true);
  });

  it("is false for a real, unflagged height", () => {
    expect(heightIsAbsent({ max_height_ft: 48 })).toBe(false);
    expect(heightIsAbsent({ max_height_ft: 35, provenance: { max_height_ft: {} } })).toBe(false);
  });
});

describe("P-299 — GET /api/local/setbacks/round-rock-tx (real table, real route)", () => {
  it("serves null for every district whose height is not stated in feet, and never 999", async () => {
    const res = await request(app()).get("/api/local/setbacks/round-rock-tx");
    if (res.status !== 200) throw new Error(`unexpected status ${res.status}`);

    const districts = res.body.districts as {
      district_name: string;
      max_height_ft: number | null;
    }[];
    expect(districts.length).toBeGreaterThan(0);

    const sentinel = districts.filter((d) => d.max_height_ft === 999);
    expect(sentinel.map((d) => d.district_name)).toEqual([]);

    // Round Rock states the commercial/industrial heights in STORIES, so those
    // rows must arrive as null...
    const sf2 = districts.find((d) => d.district_name.startsWith("SF-2"));
    expect(sf2).toBeDefined();
    expect(sf2!.max_height_ft).toBeNull();

    // ...while a district that DOES state feet keeps its number (MU-1 = 48 ft),
    // so this test cannot pass by nulling everything.
    const mu1 = districts.find((d) => d.district_name.startsWith("MU-1"));
    expect(mu1).toBeDefined();
    expect(mu1!.max_height_ft).toBe(48);
  });

  it("a null height is still a present key on the wire (the FE decodes a shape, not a sparse row)", async () => {
    const res = await request(app()).get("/api/local/setbacks/round-rock-tx");
    const row = (res.body.districts as Record<string, unknown>[])[0]!;
    expect(Object.keys(row)).toContain("max_height_ft");
    expect(row["max_height_ft"]).toBeNull();
  });
});
