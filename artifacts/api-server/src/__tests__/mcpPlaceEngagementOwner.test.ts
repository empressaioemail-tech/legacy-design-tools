/**
 * Regression: MCP/place engagement inserts MUST supply owner_user_id.
 *
 * Migration 0038 made engagements.owner_user_id NOT NULL with no DB-level
 * default (0039 only reassigns). The place/terrain refresh routes create a
 * service engagement with no authenticated user, so an omitted owner_user_id
 * threw Postgres 23502 and 503'd the route. The fix supplies a documented
 * service sentinel; this test locks the insert to always carry it (no DB —
 * the insert builder is captured via a mock).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { SERVICE_PLACE_OWNER_USER_ID } from "../lib/anonymousOwnerCookie";

// Capture the values passed to db.insert(...).values(...).
const insertValuesSpy = vi.hoisted(() => vi.fn());

vi.mock("@workspace/db", () => {
  const engagements = { id: "id", nameLower: "name_lower" } as const;
  const db = {
    // No existing row -> forces the insert branch.
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve([]),
        }),
      }),
    }),
    insert: () => ({
      values: (v: Record<string, unknown>) => {
        insertValuesSpy(v);
        return {
          returning: () => Promise.resolve([{ id: "eng-created-1" }]),
        };
      },
    }),
  };
  return { db, engagements };
});

vi.mock("../lib/placeResolve", () => ({
  // Coord placeKey path — no geocode needed.
  parseCoordPlaceKey: (key: string) => {
    const m = /^coord:(-?\d+(?:\.\d+)?):(-?\d+(?:\.\d+)?)$/.exec(key);
    return m ? { lat: Number(m[1]), lng: Number(m[2]) } : null;
  },
  resolvePlace: vi.fn(),
}));

vi.mock("../lib/engagementCoverage", () => ({
  computeEngagementCoverage: vi.fn(async () => ({})),
  coverageFieldsFromResolved: () => ({}),
}));

const { ensureMcpPlaceEngagement } = await import("../lib/mcpPlaceEngagement");

describe("ensureMcpPlaceEngagement insert", () => {
  beforeEach(() => {
    insertValuesSpy.mockClear();
  });

  it("supplies the service-sentinel owner_user_id on create (fixes 23502)", async () => {
    const result = await ensureMcpPlaceEngagement({
      placeKey: "coord:30.11000:-97.32000",
    });

    expect(result.ok).toBe(true);
    expect(insertValuesSpy).toHaveBeenCalledTimes(1);
    const values = insertValuesSpy.mock.calls[0][0] as Record<string, unknown>;
    expect(values.ownerUserId).toBe(SERVICE_PLACE_OWNER_USER_ID);
    expect(values.ownerUserId).toBe("service:mcp-place");
  });
});
