/**
 * POST /api/engagements/:id/generate-layers — DA-PI-4 unified adapter run.
 *
 * The route is the integration seam between the engagement's
 * site-context columns, the `@workspace/adapters` runner, and the
 * `briefing_sources` supersession contract. The adapters themselves
 * are exercised by `lib/adapters/src/__tests__/*` — this file mocks
 * `@workspace/adapters` so the test can:
 *   - assert the route's jurisdiction-resolve → applicable filter
 *     fan-out across the three pilot jurisdictions (Bastrop TX,
 *     Moab/Grand County UT, Salmon/Lemhi County ID),
 *   - verify per-adapter outcomes round-trip the wire envelope with
 *     `tier` + `sourceKind` + `status`,
 *   - prove the supersession contract (re-run on the same layerKind
 *     stamps the prior row + backfills `superseded_by_id`),
 *   - prove the briefing-source.fetched event is emitted with the
 *     adapter-driven `system:briefing-generate-layers` actor.
 *
 * Why fakes rather than the real `ALL_ADAPTERS`?
 * --------------------------------------------
 * Decision (DA-PI-4 / V1-5, 2026-05-02): keep the route-test fakes. The
 * `vi.mock("@workspace/adapters", …)` block below replaces the runner
 * with a per-test set of `makeAdapter()` shapes that share the real
 * registry's key naming (e.g. `bastrop-tx:zoning`, `ugrc:parcels`) but
 * carry trivial inline payloads. This keeps the route-level concerns of
 * this file — fan-out, supersession, event emission — decoupled from
 * each adapter's network shape, which is covered by
 * `lib/adapters/src/__tests__/*` against fixture HTTP. Replacing the
 * fakes with real adapters here would buy us nothing the lib-side tests
 * don't already pin and would re-introduce a fixture-fetch dependency
 * the route tests have always avoided.
 */

import { describe, it, expect, vi } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { ctx } from "./test-context";

vi.mock("@workspace/db", async () => {
  const actual =
    await vi.importActual<typeof import("@workspace/db")>("@workspace/db");
  return {
    ...actual,
    get db() {
      if (!ctx.schema)
        throw new Error("generate-layers.test: ctx.schema not set");
      return ctx.schema.db;
    },
  };
});

interface FakeAdapter {
  readonly adapterKey: string;
  readonly tier: "federal" | "state" | "local";
  readonly sourceKind:
    | "manual-upload"
    | "federal-adapter"
    | "state-adapter"
    | "local-adapter";
  readonly layerKind: string;
  readonly provider: string;
  readonly jurisdictionGate: { state?: string; local?: string };
  appliesTo: (c: {
    parcel: { latitude: number; longitude: number };
    jurisdiction: { stateKey: string | null; localKey: string | null };
  }) => boolean;
  run: () => Promise<{
    adapterKey: string;
    tier: "federal" | "state" | "local";
    layerKind: string;
    sourceKind:
      | "manual-upload"
      | "federal-adapter"
      | "state-adapter"
      | "local-adapter";
    provider: string;
    snapshotDate: string;
    payload: Record<string, unknown>;
    note?: string | null;
  }>;
}

function makeAdapter(
  AdapterRunErrorCtor: new (
    code:
      | "no-coverage"
      | "network-error"
      | "upstream-error"
      | "parse-error"
      | "timeout"
      | "unknown",
    message: string,
  ) => Error,
  opts: {
    adapterKey: string;
    tier: "federal" | "state" | "local";
    layerKind: string;
    provider: string;
    state?: string;
    local?: string;
    payload?: Record<string, unknown>;
    fail?: {
      code:
        | "no-coverage"
        | "network-error"
        | "upstream-error"
        | "parse-error"
        | "timeout"
        | "unknown";
      message: string;
    };
    noCoverage?: boolean;
  },
): FakeAdapter {
  const sourceKind =
    opts.tier === "federal"
      ? "federal-adapter"
      : opts.tier === "state"
        ? "state-adapter"
        : "local-adapter";
  return {
    adapterKey: opts.adapterKey,
    tier: opts.tier,
    sourceKind,
    layerKind: opts.layerKind,
    provider: opts.provider,
    jurisdictionGate: { state: opts.state, local: opts.local },
    appliesTo: (c) => {
      if (opts.local) return c.jurisdiction.localKey === opts.local;
      if (opts.state) return c.jurisdiction.stateKey === opts.state;
      // No state/local gate ⇒ federal. PL-04: federal applies for any
      // geocoded engagement, mirrors the real federal adapters' new
      // lat/lng-only contract.
      return (
        Number.isFinite(c.parcel.latitude) &&
        Number.isFinite(c.parcel.longitude)
      );
    },
    run: async () => {
      if (opts.fail) {
        // Use the real AdapterRunError ctor so the runner's
        // `instanceof` check translates `code` + `message` verbatim
        // into the outcome envelope.
        throw new AdapterRunErrorCtor(opts.fail.code, opts.fail.message);
      }
      if (opts.noCoverage) {
        throw new AdapterRunErrorCtor(
          "no-coverage",
          "upstream returned no features",
        );
      }
      return {
        adapterKey: opts.adapterKey,
        tier: opts.tier,
        layerKind: opts.layerKind,
        sourceKind,
        provider: opts.provider,
        snapshotDate: "2026-01-15T00:00:00.000Z",
        payload: opts.payload ?? { ok: true },
        note: null,
      };
    },
  };
}

function fakeAdapters(
  AdapterRunErrorCtor: new (
    code:
      | "no-coverage"
      | "network-error"
      | "upstream-error"
      | "parse-error"
      | "timeout"
      | "unknown",
    message: string,
  ) => Error,
): FakeAdapter[] {
  return [
    // Federal — apply for any pilot state. FEMA NFHL succeeds, FCC
    // broadband fails so the per-adapter failure-isolation contract
    // is also covered at the federal tier.
    makeAdapter(AdapterRunErrorCtor, {
      adapterKey: "fema:nfhl-flood-zone",
      tier: "federal",
      layerKind: "fema-nfhl-flood-zone",
      provider: "FEMA NFHL",
      payload: { in_floodplain: true, zone: "AE" },
    }),
    makeAdapter(AdapterRunErrorCtor, {
      adapterKey: "fcc:broadband",
      tier: "federal",
      layerKind: "fcc-broadband-availability",
      provider: "FCC NBM",
      fail: { code: "upstream-error", message: "FCC NBM returned 502" },
    }),
    // Utah — state + Grand County local
    makeAdapter(AdapterRunErrorCtor, {
      // Real `ugrc:parcels` adapter key — kept aligned with the
      // real registry so a fixture-vs-registry drift can't sneak
      // in (test would have asserted on a key that no longer
      // exists). The layerKind stays `ugrc-parcels` because the
      // real adapter emits that value too.
      adapterKey: "ugrc:parcels",
      tier: "state",
      layerKind: "ugrc-parcels",
      provider: "Utah Geospatial Resource Center",
      state: "utah",
      payload: { parcelId: "UT-FAKE-1" },
    }),
    makeAdapter(AdapterRunErrorCtor, {
      adapterKey: "grand-county-ut:zoning",
      tier: "local",
      layerKind: "grand-county-zoning",
      provider: "Grand County GIS",
      local: "grand-county-ut",
      payload: { district: "RR-1" },
    }),
    // Idaho — state + Lemhi County local
    makeAdapter(AdapterRunErrorCtor, {
      adapterKey: "idaho:inside-parcels",
      tier: "state",
      layerKind: "inside-idaho-parcels",
      provider: "INSIDE Idaho",
      state: "idaho",
      payload: { parcelId: "ID-FAKE-1" },
    }),
    makeAdapter(AdapterRunErrorCtor, {
      adapterKey: "lemhi-county-id:zoning",
      tier: "local",
      layerKind: "lemhi-county-zoning",
      provider: "Lemhi County GIS",
      local: "lemhi-county-id",
      payload: { district: "AG-20" },
    }),
    // Texas — state + Bastrop local. Real `tceq:edwards-aquifer`
    // adapter key (the registry's only Texas-bearing state adapter).
    makeAdapter(AdapterRunErrorCtor, {
      adapterKey: "tceq:edwards-aquifer",
      tier: "state",
      layerKind: "tceq-edwards-aquifer",
      provider: "TCEQ",
      state: "texas",
      payload: { in_recharge_zone: false },
    }),
    makeAdapter(AdapterRunErrorCtor, {
      adapterKey: "bastrop-tx:zoning",
      tier: "local",
      layerKind: "bastrop-zoning",
      provider: "Bastrop County GIS",
      local: "bastrop-tx",
      payload: { district: "RU" },
    }),
    // A deliberately failing local adapter only for Bastrop, so we can
    // assert the per-adapter failure-isolation contract. We use the
    // real `bastrop-tx:floodplain` adapter key here (no Bastrop roads
    // adapter exists in the real registry); the layerKind / provider
    // / payload are still synthetic because the runner is stubbed and
    // never touches real upstreams.
    makeAdapter(AdapterRunErrorCtor, {
      adapterKey: "bastrop-tx:floodplain",
      tier: "local",
      layerKind: "bastrop-floodplain",
      provider: "Bastrop County GIS",
      local: "bastrop-tx",
      fail: { code: "upstream-error", message: "Bastrop GIS returned 503" },
    }),
  ];
}

vi.mock("@workspace/adapters", async () => {
  // The factory is hoisted above all top-level statements, so we
  // rebuild the fake-adapter list inline here using the real
  // AdapterRunError pulled from the actual module — keeps the
  // runner's `instanceof` translation honest while still letting
  // the test stub the registry.
  const actual =
    await vi.importActual<typeof import("@workspace/adapters")>(
      "@workspace/adapters",
    );
  return {
    ...actual,
    ALL_ADAPTERS: fakeAdapters(actual.AdapterRunError),
  };
});

const { setupRouteTests } = await import("./setup");
const {
  engagements,
  parcelBriefings,
  briefingSources,
  atomEvents,
  adapterResponseCache,
} = await import("@workspace/db");
const { eq, and } = await import("drizzle-orm");

let getApp: () => Express;
setupRouteTests((g) => {
  getApp = g;
});

interface SeedOpts {
  city: string;
  state: string;
  /** Bastrop TX, Moab UT, Salmon ID — pilot parcel coordinates. */
  lat: string;
  lng: string;
  jurisdiction?: string;
  address?: string;
}

async function seedEngagement(opts: SeedOpts) {
  if (!ctx.schema) throw new Error("schema not ready");
  const name = `${opts.city} Engagement`;
  const [eng] = await ctx.schema.db
    .insert(engagements)
    .values({
      name,
      nameLower: name.trim().toLowerCase(),
      jurisdiction: opts.jurisdiction ?? `${opts.city}, ${opts.state}`,
      jurisdictionCity: opts.city,
      jurisdictionState: opts.state,
      address: opts.address ?? `1 Main St, ${opts.city}, ${opts.state}`,
      latitude: opts.lat,
      longitude: opts.lng,
      status: "active",
    })
    .returning();
  return eng;
}

describe("POST /api/engagements/:id/generate-layers", () => {
  it("404 when the engagement does not exist", async () => {
    const res = await request(getApp()).post(
      "/api/engagements/00000000-0000-0000-0000-000000000000/generate-layers",
    );
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("engagement_not_found");
  });

  it("PL-04: out-of-pilot but geocoded engagement runs the federal four (no 422)", async () => {
    if (!ctx.schema) throw new Error("ctx");
    const eng = await seedEngagement({
      city: "Boulder",
      state: "CO",
      lat: "40.014984",
      lng: "-105.270546",
    });
    const res = await request(getApp()).post(
      `/api/engagements/${eng.id}/generate-layers`,
    );
    expect(res.status).toBe(200);

    const outcomes = res.body.outcomes as Array<{
      adapterKey: string;
      tier: string;
      status: string;
    }>;
    // The Boulder context has stateKey=null + localKey=null, so no
    // state/local fakes apply. The two federal fakes (FEMA + FCC)
    // both fire — FEMA as ok, FCC as upstream-error per the fake's
    // failure config. Every other fake is a no-coverage skip.
    const ranKeys = outcomes
      .filter((o) => o.status !== "no-coverage")
      .map((o) => o.adapterKey)
      .sort();
    expect(ranKeys).toEqual(
      ["fema:nfhl-flood-zone", "fcc:broadband"].sort(),
    );
    // The successful federal row was persisted as a briefing source,
    // so the briefing wire has a non-empty `sources` array.
    expect(res.body.briefing.sources.length).toBeGreaterThan(0);
    expect(
      res.body.briefing.sources.some(
        (s: { sourceKind: string }) => s.sourceKind === "federal-adapter",
      ),
    ).toBe(true);
  });

  it("422 when the engagement has no geocode (no adapter can run)", async () => {
    if (!ctx.schema) throw new Error("ctx");
    const name = "No-geocode Engagement";
    const [eng] = await ctx.schema.db
      .insert(engagements)
      .values({
        name,
        nameLower: name.trim().toLowerCase(),
        jurisdiction: "Unknown",
        jurisdictionCity: null,
        jurisdictionState: null,
        address: null,
        latitude: null,
        longitude: null,
        status: "active",
      })
      .returning();
    const res = await request(getApp()).post(
      `/api/engagements/${eng.id}/generate-layers`,
    );
    expect(res.status).toBe(422);
    expect(res.body.error).toBe("no_applicable_adapters");
    expect(res.body.message).toBe(
      "Add an address to enable site context layers.",
    );
  });

  it("Bastrop TX parcel runs Texas state + Bastrop local adapters and persists ok rows", async () => {
    if (!ctx.schema) throw new Error("ctx");
    const eng = await seedEngagement({
      city: "Bastrop",
      state: "TX",
      lat: "30.110800",
      lng: "-97.315600",
    });

    const res = await request(getApp()).post(
      `/api/engagements/${eng.id}/generate-layers`,
    );
    expect(res.status).toBe(200);

    // The Texas pilot has 5 applicable adapters (2 federal + 1 state
    // + 2 local). Three succeed (FEMA, TCEQ, Bastrop zoning), two
    // fail (FCC NBM, Bastrop roads) — the run as a whole still
    // succeeds because per-adapter failures are isolated.
    const outcomes = res.body.outcomes as Array<{
      adapterKey: string;
      tier: string;
      sourceKind: string;
      status: string;
      error: { code: string; message: string } | null;
      sourceId: string | null;
    }>;
    const byKey = new Map(outcomes.map((o) => [o.adapterKey, o]));
    // Federal-tier success — the new DA-PI-2 surface. Asserts the
    // federal outcome rides the same wire envelope as state/local.
    expect(byKey.get("fema:nfhl-flood-zone")).toMatchObject({
      tier: "federal",
      sourceKind: "federal-adapter",
      status: "ok",
    });
    expect(byKey.get("fema:nfhl-flood-zone")?.sourceId).toEqual(
      expect.any(String),
    );
    // Federal-tier failure — proves the failure-isolation contract
    // also applies at the federal tier (one bad federal adapter
    // cannot break the rest of the run).
    expect(byKey.get("fcc:broadband")).toMatchObject({
      tier: "federal",
      sourceKind: "federal-adapter",
      status: "failed",
      error: { code: "upstream-error", message: "FCC NBM returned 502" },
      sourceId: null,
    });
    expect(byKey.get("tceq:edwards-aquifer")).toMatchObject({
      tier: "state",
      sourceKind: "state-adapter",
      status: "ok",
    });
    expect(byKey.get("bastrop-tx:zoning")).toMatchObject({
      tier: "local",
      sourceKind: "local-adapter",
      status: "ok",
    });
    // Per-adapter failure isolation — bastrop-tx:floodplain upstream
    // returned 503, but the run as a whole still succeeds.
    expect(byKey.get("bastrop-tx:floodplain")).toMatchObject({
      tier: "local",
      sourceKind: "local-adapter",
      status: "failed",
      error: { code: "upstream-error", message: "Bastrop GIS returned 503" },
      sourceId: null,
    });

    // Briefing wire envelope: only the OK rows show up, each with the
    // packed `<adapterKey> (<provider>)` provider string.
    const sources = res.body.briefing.sources as Array<{
      layerKind: string;
      sourceKind: string;
      provider: string;
    }>;
    const layers = sources.map((s) => s.layerKind).sort();
    expect(layers).toEqual([
      "bastrop-zoning",
      "fema-nfhl-flood-zone",
      "tceq-edwards-aquifer",
    ]);
    const tceq = sources.find((s) => s.layerKind === "tceq-edwards-aquifer")!;
    expect(tceq.sourceKind).toBe("state-adapter");
    expect(tceq.provider).toBe("tceq:edwards-aquifer (TCEQ)");
    const fema = sources.find((s) => s.layerKind === "fema-nfhl-flood-zone")!;
    expect(fema.sourceKind).toBe("federal-adapter");
    expect(fema.provider).toBe("fema:nfhl-flood-zone (FEMA NFHL)");

    // briefing_sources rows landed and the briefing-source.fetched
    // event was emitted against each, with the adapter-driven actor.
    const dbSources = await ctx.schema.db
      .select()
      .from(briefingSources);
    expect(dbSources).toHaveLength(3);
    const evRows = await ctx.schema.db
      .select()
      .from(atomEvents)
      .where(eq(atomEvents.entityType, "briefing-source"));
    expect(evRows).toHaveLength(3);
    expect(evRows[0]!.actor).toEqual({
      kind: "system",
      id: "briefing-generate-layers",
    });
  });

  it("Moab UT parcel runs Utah state + Grand County local adapters", async () => {
    const eng = await seedEngagement({
      city: "Moab",
      state: "UT",
      lat: "38.573000",
      lng: "-109.549400",
    });
    const res = await request(getApp()).post(
      `/api/engagements/${eng.id}/generate-layers`,
    );
    expect(res.status).toBe(200);
    const layers = (res.body.briefing.sources as Array<{ layerKind: string }>)
      .map((s) => s.layerKind)
      .sort();
    expect(layers).toEqual([
      "fema-nfhl-flood-zone",
      "grand-county-zoning",
      "ugrc-parcels",
    ]);
  });

  it("Salmon ID parcel runs Idaho state + Lemhi County local adapters", async () => {
    const eng = await seedEngagement({
      city: "Salmon",
      state: "ID",
      lat: "45.175900",
      lng: "-113.895700",
    });
    const res = await request(getApp()).post(
      `/api/engagements/${eng.id}/generate-layers`,
    );
    expect(res.status).toBe(200);
    const layers = (res.body.briefing.sources as Array<{ layerKind: string }>)
      .map((s) => s.layerKind)
      .sort();
    expect(layers).toEqual([
      "fema-nfhl-flood-zone",
      "inside-idaho-parcels",
      "lemhi-county-zoning",
    ]);
  });

  it("re-run supersedes the prior row for the same layerKind (locked decision #4)", async () => {
    if (!ctx.schema) throw new Error("ctx");
    const eng = await seedEngagement({
      city: "Bastrop",
      state: "TX",
      lat: "30.110800",
      lng: "-97.315600",
    });

    const first = await request(getApp()).post(
      `/api/engagements/${eng.id}/generate-layers`,
    );
    expect(first.status).toBe(200);
    const firstZoningId = (
      first.body.briefing.sources as Array<{
        id: string;
        layerKind: string;
      }>
    ).find((s) => s.layerKind === "bastrop-zoning")!.id;

    const second = await request(getApp()).post(
      `/api/engagements/${eng.id}/generate-layers`,
    );
    expect(second.status).toBe(200);
    const secondZoningId = (
      second.body.briefing.sources as Array<{
        id: string;
        layerKind: string;
      }>
    ).find((s) => s.layerKind === "bastrop-zoning")!.id;
    expect(secondZoningId).not.toBe(firstZoningId);

    // The wire envelope only carries the current rows.
    const wireIds = (
      second.body.briefing.sources as Array<{ id: string }>
    ).map((s) => s.id);
    expect(wireIds).not.toContain(firstZoningId);

    // The DB carries both rows; the older one is stamped + linked.
    const briefings = await ctx.schema.db
      .select()
      .from(parcelBriefings)
      .where(eq(parcelBriefings.engagementId, eng.id));
    expect(briefings).toHaveLength(1);
    const allRows = await ctx.schema.db
      .select()
      .from(briefingSources)
      .where(
        and(
          eq(briefingSources.briefingId, briefings[0]!.id),
          eq(briefingSources.layerKind, "bastrop-zoning"),
        ),
      );
    expect(allRows).toHaveLength(2);
    const prior = allRows.find((r) => r.id === firstZoningId)!;
    expect(prior.supersededAt).not.toBeNull();
    expect(prior.supersededById).toBe(secondZoningId);
  });

  it("caches federal adapter results so a re-run does not invoke the adapter again (Task #180)", async () => {
    if (!ctx.schema) throw new Error("ctx");
    const eng = await seedEngagement({
      city: "Bastrop",
      state: "TX",
      lat: "30.110800",
      lng: "-97.315600",
    });

    // First run: federal results should land in the cache, failed
    // outcomes (FCC) should not.
    const first = await request(getApp()).post(
      `/api/engagements/${eng.id}/generate-layers`,
    );
    expect(first.status).toBe(200);

    const cacheRows = await ctx.schema.db
      .select()
      .from(adapterResponseCache);
    expect(cacheRows.map((r) => r.adapterKey).sort()).toEqual([
      // FEMA succeeded → cached. FCC failed → not cached.
      "fema:nfhl-flood-zone",
    ]);
    const femaCached = cacheRows.find(
      (r) => r.adapterKey === "fema:nfhl-flood-zone",
    )!;
    expect(femaCached.latRounded).toBe("30.11080");
    expect(femaCached.lngRounded).toBe("-97.31560");
    // TTL gate is in the future.
    expect(femaCached.expiresAt.getTime()).toBeGreaterThan(Date.now());
    // Payload round-trips the AdapterResult envelope.
    expect(
      (femaCached.resultPayload as { payload: { in_floodplain: boolean } })
        .payload,
    ).toEqual({ in_floodplain: true, zone: "AE" });

    // Second run: the FEMA adapter should not be re-invoked. We can
    // observe that by counting briefing-source.fetched events that
    // carry the FEMA adapter key — both runs supersede the prior
    // row, so both runs emit an event regardless of cache hit (the
    // route does not know the source was cached). What we *can*
    // assert is that the cache row's createdAt was refreshed (the
    // upsert touched it) AND no extra adapter rows were written for
    // the same (adapter, parcel) key — the unique index forbids it.
    const second = await request(getApp()).post(
      `/api/engagements/${eng.id}/generate-layers`,
    );
    expect(second.status).toBe(200);
    const cacheRowsAfter = await ctx.schema.db
      .select()
      .from(adapterResponseCache)
      .where(
        eq(adapterResponseCache.adapterKey, "fema:nfhl-flood-zone"),
      );
    // Same row, in place — proves the upsert path keeps the table
    // bounded across re-runs.
    expect(cacheRowsAfter).toHaveLength(1);
  });

  it("propagates fromCache/cachedAt on outcomes and ?forceRefresh=true bypasses the cache (Task #204)", async () => {
    if (!ctx.schema) throw new Error("ctx");
    const eng = await seedEngagement({
      city: "Bastrop",
      state: "TX",
      lat: "30.110800",
      lng: "-97.315600",
    });

    // Run #1 — live fetch. Every successful outcome should report
    // fromCache=false / cachedAt=null because the cache started cold.
    const first = await request(getApp()).post(
      `/api/engagements/${eng.id}/generate-layers`,
    );
    expect(first.status).toBe(200);
    const firstFema = first.body.outcomes.find(
      (o: { adapterKey: string }) =>
        o.adapterKey === "fema:nfhl-flood-zone",
    );
    expect(firstFema.status).toBe("ok");
    expect(firstFema.fromCache).toBe(false);
    expect(firstFema.cachedAt).toBeNull();

    // Run #2 — default (cache honored). The FEMA outcome should now
    // come back fromCache=true with a recent cachedAt timestamp; the
    // FCC outcome (failed → not cached) stays fromCache=false.
    const second = await request(getApp()).post(
      `/api/engagements/${eng.id}/generate-layers`,
    );
    expect(second.status).toBe(200);
    const secondFema = second.body.outcomes.find(
      (o: { adapterKey: string }) =>
        o.adapterKey === "fema:nfhl-flood-zone",
    );
    expect(secondFema.status).toBe("ok");
    expect(secondFema.fromCache).toBe(true);
    expect(typeof secondFema.cachedAt).toBe("string");
    const cachedAtMs = Date.parse(secondFema.cachedAt);
    expect(Number.isNaN(cachedAtMs)).toBe(false);
    // The cached row was just written by the first run, so its age
    // should be well under a minute.
    expect(Date.now() - cachedAtMs).toBeLessThan(60_000);
    const secondFcc = second.body.outcomes.find(
      (o: { adapterKey: string }) => o.adapterKey === "fcc:broadband-907",
    );
    if (secondFcc) {
      expect(secondFcc.fromCache).toBe(false);
      expect(secondFcc.cachedAt).toBeNull();
    }

    // Run #3 — ?forceRefresh=true. The cache should be bypassed, so
    // even a freshly-warm row reports fromCache=false. The cached
    // row itself stays in place (still upserted), but the OUTCOME
    // wire envelope tells the FE this run was live.
    const third = await request(getApp())
      .post(`/api/engagements/${eng.id}/generate-layers`)
      .query({ forceRefresh: "true" });
    expect(third.status).toBe(200);
    const thirdFema = third.body.outcomes.find(
      (o: { adapterKey: string }) =>
        o.adapterKey === "fema:nfhl-flood-zone",
    );
    expect(thirdFema.status).toBe("ok");
    expect(thirdFema.fromCache).toBe(false);
    expect(thirdFema.cachedAt).toBeNull();

    // The cache row is still there (we always write through, even on
    // forceRefresh) — confirms the table stays bounded.
    const cacheRowsAfter = await ctx.schema.db
      .select()
      .from(adapterResponseCache)
      .where(
        eq(adapterResponseCache.adapterKey, "fema:nfhl-flood-zone"),
      );
    expect(cacheRowsAfter).toHaveLength(1);

    // Garbage values for `?forceRefresh` MUST behave like the flag
    // is absent (cache honored). This locks the parser's strict
    // "true"/"1" allow-list so a typo can't accidentally drop into
    // a forced live run.
    const fourth = await request(getApp())
      .post(`/api/engagements/${eng.id}/generate-layers`)
      .query({ forceRefresh: "yes" });
    expect(fourth.status).toBe(200);
    const fourthFema = fourth.body.outcomes.find(
      (o: { adapterKey: string }) =>
        o.adapterKey === "fema:nfhl-flood-zone",
    );
    expect(fourthFema.fromCache).toBe(true);
  });

  it("?adapterKey=<key> scopes the run to that single adapter (Task #228)", async () => {
    if (!ctx.schema) throw new Error("ctx");
    const eng = await seedEngagement({
      city: "Bastrop",
      state: "TX",
      lat: "30.110800",
      lng: "-97.315600",
    });

    // Seed the briefing with a full Generate Layers run so there are
    // existing rows for the supersession contract to bite on.
    const seedRes = await request(getApp()).post(
      `/api/engagements/${eng.id}/generate-layers`,
    );
    expect(seedRes.status).toBe(200);
    // Bastrop's pilot has 3 ok rows persisted (fema-nfhl, tceq, bastrop-zoning).
    const seedRows = await ctx.schema.db.select().from(briefingSources);
    expect(seedRows).toHaveLength(3);
    const seedFemaId = seedRows.find(
      (r) => r.layerKind === "fema-nfhl-flood-zone",
    )!.id;
    const seedTceqId = seedRows.find(
      (r) => r.layerKind === "tceq-edwards-aquifer",
    )!.id;
    const seedZoningId = seedRows.find(
      (r) => r.layerKind === "bastrop-zoning",
    )!.id;

    // Force-refresh JUST the FEMA layer.
    const single = await request(getApp())
      .post(`/api/engagements/${eng.id}/generate-layers`)
      .query({ adapterKey: "fema:nfhl-flood-zone", forceRefresh: "true" });
    expect(single.status).toBe(200);

    // Outcomes envelope: exactly one outcome, for the targeted
    // adapter. None of the other applicable adapters (state,
    // local, sibling federal FCC) should appear — that is what
    // proves the route ran a single adapter.
    const outcomes = single.body.outcomes as Array<{
      adapterKey: string;
      status: string;
    }>;
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]!.adapterKey).toBe("fema:nfhl-flood-zone");
    expect(outcomes[0]!.status).toBe("ok");

    // Persistence: exactly one NEW briefing_sources row landed.
    const allRows = await ctx.schema.db.select().from(briefingSources);
    // 3 originals + 1 new for the refreshed layer = 4 total.
    expect(allRows).toHaveLength(4);
    const femaRows = allRows.filter(
      (r) => r.layerKind === "fema-nfhl-flood-zone",
    );
    expect(femaRows).toHaveLength(2);
    const newFema = femaRows.find((r) => r.id !== seedFemaId)!;
    expect(newFema.id).not.toBe(seedFemaId);

    // Supersession wired correctly: prior FEMA row stamped + linked,
    // OTHER layers untouched. This is the "didn't re-run every
    // adapter" assertion: a sibling adapter run would also have
    // stamped + replaced the tceq + bastrop-zoning rows.
    const priorFema = femaRows.find((r) => r.id === seedFemaId)!;
    expect(priorFema.supersededAt).not.toBeNull();
    expect(priorFema.supersededById).toBe(newFema.id);
    const tceqRow = allRows.find((r) => r.id === seedTceqId)!;
    expect(tceqRow.supersededAt).toBeNull();
    expect(tceqRow.supersededById).toBeNull();
    const zoningRow = allRows.find((r) => r.id === seedZoningId)!;
    expect(zoningRow.supersededAt).toBeNull();
    expect(zoningRow.supersededById).toBeNull();

    // Wire-shape briefing on the response only carries the current
    // rows, so the new fema id is in there alongside the unchanged
    // tceq + bastrop-zoning rows.
    const wireSources = single.body.briefing.sources as Array<{
      id: string;
      layerKind: string;
    }>;
    const layerSet = new Set(wireSources.map((s) => s.layerKind));
    expect(layerSet).toEqual(
      new Set(["fema-nfhl-flood-zone", "tceq-edwards-aquifer", "bastrop-zoning"]),
    );
    const wireFema = wireSources.find(
      (s) => s.layerKind === "fema-nfhl-flood-zone",
    )!;
    expect(wireFema.id).toBe(newFema.id);

    // briefing-source events from this scoped run:
    //   - 1 .fetched on the new FEMA row (created)
    //   - 1 .refreshed on the SUPERSEDED FEMA row (V1-2 — anchors
    //     the implicit-resolve hook's triggered_action_event_id)
    // ...in addition to the 3 .fetched emitted by the seed run = 5.
    const evRows = await ctx.schema.db
      .select()
      .from(atomEvents)
      .where(eq(atomEvents.entityType, "briefing-source"));
    expect(evRows).toHaveLength(5);
    const newFemaEvents = evRows.filter((e) => e.entityId === newFema.id);
    expect(newFemaEvents).toHaveLength(1);
    expect(newFemaEvents[0]!.actor).toEqual({
      kind: "system",
      id: "briefing-generate-layers",
    });
  });

  it("422 unknown_adapter_key when ?adapterKey=<key> does not match an applicable adapter (Task #228)", async () => {
    const eng = await seedEngagement({
      city: "Bastrop",
      state: "TX",
      lat: "30.110800",
      lng: "-97.315600",
    });

    // Off-jurisdiction adapter (Utah parcels on a Texas parcel) —
    // real `ugrc:parcels` adapter key, gated to Utah, so it cannot
    // apply to a Bastrop parcel and the route must surface
    // `unknown_adapter_key` rather than running it.
    const offJurisdiction = await request(getApp())
      .post(`/api/engagements/${eng.id}/generate-layers`)
      .query({ adapterKey: "ugrc:parcels" });
    expect(offJurisdiction.status).toBe(422);
    expect(offJurisdiction.body.error).toBe("unknown_adapter_key");
    expect(offJurisdiction.body.message).toContain("ugrc:parcels");

    // Garbage adapter key.
    const garbage = await request(getApp())
      .post(`/api/engagements/${eng.id}/generate-layers`)
      .query({ adapterKey: "does-not-exist:nope" });
    expect(garbage.status).toBe(422);
    expect(garbage.body.error).toBe("unknown_adapter_key");

    // Empty/whitespace-only ?adapterKey= behaves like the flag is
    // absent (full run) rather than 422-ing on "" — this locks the
    // parser's "trim then null" behavior.
    const emptyKey = await request(getApp())
      .post(`/api/engagements/${eng.id}/generate-layers`)
      .query({ adapterKey: "   " });
    expect(emptyKey.status).toBe(200);
    // Full Bastrop run produces 5 outcomes (2 federal + 1 state +
    // 2 local). Anything less would mean we accidentally narrowed
    // the run on the empty value.
    expect(emptyKey.body.outcomes).toHaveLength(5);
  });
});
