/**
 * /api/tenants/:tenantId/canned-findings — PLR-10 route integration tests.
 *
 * Coverage:
 *   - GET requires reviewer audience (`internal`); applicant + ai 403.
 *   - GET filters by discipline; invalid discipline 400; archived rows
 *     hidden by default and surfaced via `?includeArchived=true`.
 *   - POST/PATCH/DELETE require the `settings:manage` permission claim;
 *     the gate is the first thing the handler hits, so wrong audience
 *     plus permission still passes (mirrors `settings.test.ts`).
 *   - POST happy path returns 201 with the wire shape.
 *   - PATCH 404 on unknown id; 200 returns the merged row.
 *   - DELETE soft-deletes (archivedAt populated) and is idempotent: a
 *     second delete returns the same row with the SAME `archivedAt`
 *     timestamp the first call stamped — the route must not re-stamp
 *     on the no-op path.
 *
 * Lifecycle mirrors `findings-route.test.ts`: per-file vi.mock proxies
 * `db` to the per-test schema, `setupRouteTests` owns schema lifecycle.
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
        throw new Error("cannedFindings.test: ctx.schema not set");
      return ctx.schema.db;
    },
  };
});

const { setupRouteTests } = await import("./setup");
const { cannedFindings } = await import("@workspace/db");

let getApp: () => Express;
setupRouteTests((g) => {
  getApp = g;
});

const TENANT = "default";
const REVIEWER_AUDIENCE = { "x-audience": "internal" } as const;
const ADMIN_HEADERS = {
  "x-audience": "internal",
  "x-permissions": "settings:manage",
} as const;

interface SeedOpts {
  tenantId?: string;
  discipline?: "building" | "fire" | "zoning" | "civil";
  title?: string;
  severity?: "blocker" | "concern" | "advisory";
  category?: string;
  archivedAt?: Date | null;
}

async function seedCanned(opts: SeedOpts = {}): Promise<{ id: string }> {
  if (!ctx.schema) throw new Error("ctx.schema not set");
  const [row] = await ctx.schema.db
    .insert(cannedFindings)
    .values({
      tenantId: opts.tenantId ?? TENANT,
      discipline: opts.discipline ?? "building",
      title: opts.title ?? "Setback violation",
      defaultBody: "North wall encroaches the front setback.",
      severity: opts.severity ?? "blocker",
      category: opts.category ?? "setback",
      color: "#ff0000",
      codeAtomCitations: [
        { kind: "code-section", atomId: "code:zoning-19.3.2" },
      ] as unknown as Record<string, unknown>[],
      archivedAt: opts.archivedAt ?? null,
    })
    .returning({ id: cannedFindings.id });
  return { id: row.id };
}

describe("GET /api/tenants/:tenantId/canned-findings", () => {
  it("rejects non-reviewer audiences with findings_require_internal_audience", async () => {
    if (!ctx.schema) throw new Error("schema not ready");
    const res = await request(getApp())
      .get(`/api/tenants/${TENANT}/canned-findings`)
      .set("x-audience", "user");
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("findings_require_internal_audience");
  });

  it("returns rows ordered by discipline then title; hides archived by default", async () => {
    await seedCanned({ discipline: "zoning", title: "Z entry" });
    await seedCanned({ discipline: "building", title: "B beta" });
    await seedCanned({ discipline: "building", title: "B alpha" });
    await seedCanned({
      discipline: "fire",
      title: "Archived entry",
      archivedAt: new Date(),
    });

    const res = await request(getApp())
      .get(`/api/tenants/${TENANT}/canned-findings`)
      .set(REVIEWER_AUDIENCE);
    expect(res.status).toBe(200);
    const titles = res.body.cannedFindings.map(
      (r: { title: string }) => r.title,
    );
    expect(titles).toEqual(["B alpha", "B beta", "Z entry"]);
  });

  it("filters by discipline when ?discipline= is supplied", async () => {
    await seedCanned({ discipline: "zoning", title: "Z one" });
    await seedCanned({ discipline: "building", title: "B one" });

    const res = await request(getApp())
      .get(`/api/tenants/${TENANT}/canned-findings?discipline=zoning`)
      .set(REVIEWER_AUDIENCE);
    expect(res.status).toBe(200);
    expect(res.body.cannedFindings).toHaveLength(1);
    expect(res.body.cannedFindings[0].discipline).toBe("zoning");
  });

  it("400s on an unknown discipline value", async () => {
    const res = await request(getApp())
      .get(`/api/tenants/${TENANT}/canned-findings?discipline=plumbing`)
      .set(REVIEWER_AUDIENCE);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_discipline");
  });

  it("includes archived rows when ?includeArchived=true", async () => {
    await seedCanned({ title: "Live" });
    await seedCanned({ title: "Dead", archivedAt: new Date() });
    const res = await request(getApp())
      .get(`/api/tenants/${TENANT}/canned-findings?includeArchived=true`)
      .set(REVIEWER_AUDIENCE);
    expect(res.status).toBe(200);
    expect(res.body.cannedFindings).toHaveLength(2);
  });
});

describe("POST /api/tenants/:tenantId/canned-findings", () => {
  it("rejects callers without the settings:manage permission claim", async () => {
    if (!ctx.schema) throw new Error("schema not ready");
    const res = await request(getApp())
      .post(`/api/tenants/${TENANT}/canned-findings`)
      .set(REVIEWER_AUDIENCE)
      .send({
        discipline: "building",
        title: "X",
        defaultBody: "y",
        severity: "concern",
        category: "setback",
      });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("Requires settings:manage permission");
  });

  it("rejects sessions with unrelated permissions but not settings:manage", async () => {
    const res = await request(getApp())
      .post(`/api/tenants/${TENANT}/canned-findings`)
      .set("x-audience", "internal")
      .set("x-permissions", "users:manage,reviewers:manage")
      .send({
        discipline: "building",
        title: "X",
        defaultBody: "y",
        severity: "concern",
        category: "setback",
      });
    expect(res.status).toBe(403);
  });

  it("400s on an invalid create body", async () => {
    const res = await request(getApp())
      .post(`/api/tenants/${TENANT}/canned-findings`)
      .set(ADMIN_HEADERS)
      .send({ title: "" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_create_canned_finding_body");
  });

  it("creates the row and returns the wire shape on 201", async () => {
    const res = await request(getApp())
      .post(`/api/tenants/${TENANT}/canned-findings`)
      .set(ADMIN_HEADERS)
      .send({
        discipline: "zoning",
        title: "  Front setback violation  ",
        defaultBody: "North wall encroaches.",
        severity: "blocker",
        category: "setback",
        color: "#aa0000",
        codeAtomCitations: [
          { kind: "code-section", atomId: "code:zoning-19.3.2" },
        ],
      });
    expect(res.status).toBe(201);
    expect(res.body.cannedFinding).toMatchObject({
      tenantId: TENANT,
      discipline: "zoning",
      // Title is trimmed by the route.
      title: "Front setback violation",
      severity: "blocker",
      category: "setback",
      color: "#aa0000",
      archivedAt: null,
      codeAtomCitations: [
        { kind: "code-section", atomId: "code:zoning-19.3.2" },
      ],
    });
    expect(typeof res.body.cannedFinding.id).toBe("string");
  });
});

describe("PATCH /api/tenants/:tenantId/canned-findings/:id", () => {
  it("requires settings:manage", async () => {
    const { id } = await seedCanned();
    const res = await request(getApp())
      .patch(`/api/tenants/${TENANT}/canned-findings/${id}`)
      .set(REVIEWER_AUDIENCE)
      .send({ title: "New" });
    expect(res.status).toBe(403);
  });

  it("404s on an unknown canned-finding id", async () => {
    const res = await request(getApp())
      .patch(
        `/api/tenants/${TENANT}/canned-findings/00000000-0000-0000-0000-000000000000`,
      )
      .set(ADMIN_HEADERS)
      .send({ title: "New" });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("canned_finding_not_found");
  });

  it("merges the patch and returns the updated row", async () => {
    const { id } = await seedCanned({ title: "Original" });
    const res = await request(getApp())
      .patch(`/api/tenants/${TENANT}/canned-findings/${id}`)
      .set(ADMIN_HEADERS)
      .send({ title: "Renamed", severity: "advisory" });
    expect(res.status).toBe(200);
    expect(res.body.cannedFinding.id).toBe(id);
    expect(res.body.cannedFinding.title).toBe("Renamed");
    expect(res.body.cannedFinding.severity).toBe("advisory");
    // Untouched fields stay put.
    expect(res.body.cannedFinding.discipline).toBe("building");
  });
});

describe("DELETE /api/tenants/:tenantId/canned-findings/:id", () => {
  it("requires settings:manage", async () => {
    const { id } = await seedCanned();
    const res = await request(getApp())
      .delete(`/api/tenants/${TENANT}/canned-findings/${id}`)
      .set(REVIEWER_AUDIENCE);
    expect(res.status).toBe(403);
  });

  it("404s on an unknown id", async () => {
    const res = await request(getApp())
      .delete(
        `/api/tenants/${TENANT}/canned-findings/00000000-0000-0000-0000-000000000000`,
      )
      .set(ADMIN_HEADERS);
    expect(res.status).toBe(404);
  });

  it("soft-deletes and is idempotent: a second delete returns the same archivedAt", async () => {
    const { id } = await seedCanned();
    const first = await request(getApp())
      .delete(`/api/tenants/${TENANT}/canned-findings/${id}`)
      .set(ADMIN_HEADERS);
    expect(first.status).toBe(200);
    expect(first.body.cannedFinding.id).toBe(id);
    expect(first.body.cannedFinding.archivedAt).not.toBeNull();
    const firstArchivedAt = first.body.cannedFinding.archivedAt as string;

    // Second call must not re-stamp archivedAt — the route's
    // "already archived" branch returns the existing row unchanged.
    const second = await request(getApp())
      .delete(`/api/tenants/${TENANT}/canned-findings/${id}`)
      .set(ADMIN_HEADERS);
    expect(second.status).toBe(200);
    expect(second.body.cannedFinding.id).toBe(id);
    expect(second.body.cannedFinding.archivedAt).toBe(firstArchivedAt);
  });
});
