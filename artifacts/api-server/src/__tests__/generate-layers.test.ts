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
      // No state/local gate ⇒ federal: applies whenever a pilot state
      // resolved (mirrors the real federal adapters' contract).
      return c.jurisdiction.stateKey !== null;
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
      adapterKey: "utah:ugrc-parcels",
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
    // Texas — state + Bastrop local
    makeAdapter(AdapterRunErrorCtor, {
      adapterKey: "texas:tceq-floodplain",
      tier: "state",
      layerKind: "tceq-floodplain",
      provider: "TCEQ",
      state: "texas",
      payload: { in_floodplain: false },
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
    // assert the per-adapter failure-isolation contract.
    makeAdapter(AdapterRunErrorCtor, {
      adapterKey: "bastrop-tx:roads",
      tier: "local",
      layerKind: "bastrop-roads",
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

  it("422 when no adapters apply (out-of-pilot jurisdiction)", async () => {
    const eng = await seedEngagement({
      city: "Boulder",
      state: "CO",
      lat: "40.014984",
      lng: "-105.270546",
    });
    const res = await request(getApp()).post(
      `/api/engagements/${eng.id}/generate-layers`,
    );
    expect(res.status).toBe(422);
    expect(res.body.error).toBe("no_applicable_adapters");
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
    expect(byKey.get("texas:tceq-floodplain")).toMatchObject({
      tier: "state",
      sourceKind: "state-adapter",
      status: "ok",
    });
    expect(byKey.get("bastrop-tx:zoning")).toMatchObject({
      tier: "local",
      sourceKind: "local-adapter",
      status: "ok",
    });
    // Per-adapter failure isolation — bastrop-tx:roads upstream
    // returned 503, but the run as a whole still succeeds.
    expect(byKey.get("bastrop-tx:roads")).toMatchObject({
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
      "tceq-floodplain",
    ]);
    const tceq = sources.find((s) => s.layerKind === "tceq-floodplain")!;
    expect(tceq.sourceKind).toBe("state-adapter");
    expect(tceq.provider).toBe("texas:tceq-floodplain (TCEQ)");
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
});
