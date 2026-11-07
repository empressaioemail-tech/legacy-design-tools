import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.DATABASE_URL ??=
    "postgres://unused:unused@localhost:5432/unused";
});
import {
  asTeamRole,
  consumedSeatCount,
  seatsPurchasedForWire,
  toWireMember,
} from "./peTeamRoster";

const here = dirname(fileURLToPath(import.meta.url));

describe("toWireMember — a third role is dropped, not defaulted", () => {
  it("emits owner and member", () => {
    expect(
      toWireMember({
        email: "Owner@Roster.Test",
        role: "owner",
        status: "joined",
        at: "2026-08-28T00:00:00.000Z",
      }),
    ).toEqual({
      email: "owner@roster.test",
      role: "owner",
      status: "joined",
      at: "2026-08-28T00:00:00.000Z",
    });
  });

  it("DROPS administrator rather than emitting it", () => {
    expect(
      toWireMember({
        email: "admin@roster.test",
        role: "administrator",
        status: "joined",
        at: null,
      }),
    ).toBeNull();
    expect(asTeamRole("administrator")).toBeNull();
  });
});

describe("seatsPurchasedForWire — never 0 to mean unknown", () => {
  it("omits the field when there is no team subscription", () => {
    expect(
      seatsPurchasedForWire({ subscriptionTier: null, seatsPurchased: null }),
    ).toBeUndefined();
    expect(
      seatsPurchasedForWire({ subscriptionTier: "solo", seatsPurchased: 1 }),
    ).toBeUndefined();
    expect(
      seatsPurchasedForWire({ subscriptionTier: "studio", seatsPurchased: 3 }),
    ).toBeUndefined();
  });

  it("omits the field when team seats were not stored", () => {
    expect(
      seatsPurchasedForWire({ subscriptionTier: "team", seatsPurchased: null }),
    ).toBeUndefined();
  });

  it("emits a stored number, including a stored zero", () => {
    expect(
      seatsPurchasedForWire({ subscriptionTier: "team", seatsPurchased: 10 }),
    ).toBe(10);
    expect(
      seatsPurchasedForWire({ subscriptionTier: "team", seatsPurchased: 0 }),
    ).toBe(0);
  });
});

describe("consumedSeatCount — an invitation holds a seat", () => {
  it("counts joined plus outstanding invitations", () => {
    expect(consumedSeatCount({ joinedCount: 3, invitedCount: 1 })).toBe(4);
  });
});

describe("no design-comp specimen addresses in the server half", () => {
  it("fails if specimen domains appear in shipped team sources", () => {
    const files = [
      join(here, "peTeamRoster.ts"),
      join(here, "..", "routes", "propertyExplorer.ts"),
    ];
    const specimen = /@bastrop-arch\.com|@structural\.co|@firm\.com/i;
    for (const file of files) {
      const src = readFileSync(file, "utf8");
      expect(src, file).not.toMatch(specimen);
    }
  });
});
