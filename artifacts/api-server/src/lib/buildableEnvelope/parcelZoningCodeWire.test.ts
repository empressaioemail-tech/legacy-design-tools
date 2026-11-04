import { describe, expect, it } from "vitest";
import { parcelZoningCodeWire } from "./parcelZoningCodeWire";

describe("parcelZoningCodeWire", () => {
  it("serves the ring's own stamp when it has one", () => {
    expect(parcelZoningCodeWire("GC", "GC")).toEqual({
      zoningCode: "GC",
      zoningCodeSource: "parcel-stamp",
    });
  });

  it("keeps the stamp even when the ledger names another district", () => {
    expect(parcelZoningCodeWire("C-1", "GC")).toEqual({
      zoningCode: "C-1",
      zoningCodeSource: "parcel-stamp",
    });
  });

  it("serves the ledger district, named as such, when the stamp is empty", () => {
    expect(parcelZoningCodeWire(null, "GC")).toEqual({
      zoningCode: "GC",
      zoningCodeSource: "ledger",
    });
    expect(parcelZoningCodeWire("  ", "GC")).toEqual({
      zoningCode: "GC",
      zoningCodeSource: "ledger",
    });
  });

  it("stays null when both are empty; nothing is invented", () => {
    expect(parcelZoningCodeWire(null, null)).toEqual({
      zoningCode: null,
      zoningCodeSource: null,
    });
    expect(parcelZoningCodeWire(undefined, "")).toEqual({
      zoningCode: null,
      zoningCodeSource: null,
    });
  });
});
