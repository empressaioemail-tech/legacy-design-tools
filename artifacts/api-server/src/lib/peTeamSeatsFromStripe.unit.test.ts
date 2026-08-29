import { describe, expect, it } from "vitest";
import {
  PE_TEAM_INCLUDED_SEATS,
  parseMetadataSeats,
  resolveTeamSeatsPurchased,
} from "./peTeamSeatsFromStripe";

const TEAM = "price_team";
const TEAM_YR = "price_team_yr";
const EXTRA = "price_seat";

describe("resolveTeamSeatsPurchased", () => {
  it("writes 10 + extras when the billed Team base is present", () => {
    expect(
      resolveTeamSeatsPurchased({
        grantTier: "team",
        metadataSeats: 12,
        items: [
          { priceId: TEAM, quantity: 1 },
          { priceId: EXTRA, quantity: 2 },
        ],
        teamPriceIds: [TEAM, TEAM_YR],
        extraSeatPriceId: EXTRA,
      }),
    ).toBe(12);
  });

  it("VIOLATION: Team tier with no billed items does not invent 10", () => {
    expect(
      resolveTeamSeatsPurchased({
        grantTier: "team",
        metadataSeats: 10,
        items: [],
        teamPriceIds: [TEAM],
        extraSeatPriceId: EXTRA,
      }),
    ).toBeNull();
    expect(PE_TEAM_INCLUDED_SEATS).toBe(10);
  });

  it("VIOLATION: metadata 10 and billed 12 disagree — write nothing", () => {
    expect(
      resolveTeamSeatsPurchased({
        grantTier: "team",
        metadataSeats: 10,
        items: [
          { priceId: TEAM, quantity: 1 },
          { priceId: EXTRA, quantity: 2 },
        ],
        teamPriceIds: [TEAM],
        extraSeatPriceId: EXTRA,
      }),
    ).toBeNull();
  });

  it("solo and studio omit even if Team items are on the payload", () => {
    const items = [{ priceId: TEAM, quantity: 1 }];
    expect(
      resolveTeamSeatsPurchased({
        grantTier: "solo",
        metadataSeats: null,
        items,
        teamPriceIds: [TEAM],
        extraSeatPriceId: EXTRA,
      }),
    ).toBeNull();
    expect(
      resolveTeamSeatsPurchased({
        grantTier: "studio",
        metadataSeats: 10,
        items,
        teamPriceIds: [TEAM],
        extraSeatPriceId: EXTRA,
      }),
    ).toBeNull();
  });

  it("unreadable extra quantity refuses the whole write", () => {
    expect(
      resolveTeamSeatsPurchased({
        grantTier: "team",
        metadataSeats: null,
        items: [
          { priceId: TEAM, quantity: 1 },
          { priceId: EXTRA, quantity: null },
        ],
        teamPriceIds: [TEAM],
        extraSeatPriceId: EXTRA,
      }),
    ).toBeNull();
  });
});

describe("parseMetadataSeats", () => {
  it("accepts a digit string and an integer, refuses junk", () => {
    expect(parseMetadataSeats("12")).toBe(12);
    expect(parseMetadataSeats(0)).toBe(0);
    expect(parseMetadataSeats("10.5")).toBeNull();
    expect(parseMetadataSeats("ten")).toBeNull();
    expect(parseMetadataSeats(-1)).toBeNull();
  });
});
