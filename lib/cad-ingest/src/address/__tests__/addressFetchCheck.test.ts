/**
 * Pure (no network, no DB) tests for the "check" half of fetch-then-swap
 * (P-499 stage-check-swap, applied to `txgio_address` — 2026-10-12):
 * `bufferAddressRecords`'s objectid dedupe, and
 * `checkAddressFetchComplete`'s three refusal conditions.
 *
 * These exercise the exact scenario the fix closes: on OLD `cli.ts`, a
 * crawl that reads fewer features than the service reported (a dropped
 * connection, a server that silently truncated paging, or a
 * deliberately bounded `--limit` sample) went straight into
 * `deleteCountyAddresses` + `upsertAddresses` with no check at all — the
 * live county was deleted and partially rebuilt regardless. These tests
 * fail against that old shape (neither function existed on it) and pass
 * against the new one, proving the refusal fires on the right numbers
 * before `swapCountyAddresses` is ever reached by `cli.ts`.
 */
import { describe, expect, it } from "vitest";
import {
  ADDRESS_FETCH_INCOMPLETE,
  bufferAddressRecords,
  checkAddressFetchComplete,
  type AddressFetchCheckInput,
} from "../ingest";
import type { TxgioAddressRecord } from "../parse";

const BASE: Omit<TxgioAddressRecord, "objectId"> = {
  countyFips: "48055",
  fullAddr: "100 MAIN ST",
  unit: "",
  addNumber: "100",
  stName: "Main",
  postComm: "Luling",
  postCode: "78648",
  state: "TX",
  countyName: "Caldwell",
  source: "CAPCOG",
  dateAcq: "2025-04-07",
  longitude: -97.65,
  latitude: 29.68,
  tileKey: "g0.02:-97.66000,29.68000",
};

function rec(objectId: number, overrides: Partial<TxgioAddressRecord> = {}): TxgioAddressRecord {
  return { ...BASE, objectId, ...overrides };
}

async function* gen(records: TxgioAddressRecord[]): AsyncGenerator<TxgioAddressRecord> {
  for (const r of records) yield r;
}

describe("bufferAddressRecords", () => {
  it("buffers every distinct (county_fips, object_id) record", async () => {
    const result = await bufferAddressRecords(gen([rec(1), rec(2), rec(3)]));
    expect(result.records).toHaveLength(3);
    expect(result.duplicateObjectIds).toBe(0);
  });

  it("drops a same-objectid repeat within one load and counts it, keeping the first-seen", async () => {
    const first = rec(10, { longitude: -97.1 });
    const repeat = rec(10, { longitude: -97.9 }); // same objectid, never happens for real, but must be counted if it does
    const result = await bufferAddressRecords(gen([first, repeat]));
    expect(result.records).toHaveLength(1);
    expect(result.duplicateObjectIds).toBe(1);
    expect(result.records[0].longitude).toBe(-97.1);
  });

  it("an empty crawl buffers to zero records with zero duplicates", async () => {
    const result = await bufferAddressRecords(gen([]));
    expect(result.records).toHaveLength(0);
    expect(result.duplicateObjectIds).toBe(0);
  });

  it("accepts a plain (sync) iterable, not only an async generator", async () => {
    const result = await bufferAddressRecords([rec(1), rec(2)]);
    expect(result.records).toHaveLength(2);
  });
});

const COMPLETE: AddressFetchCheckInput = {
  countyFips: "48055",
  countyName: "Caldwell",
  serviceCount: 3,
  rowsRead: 3,
  rowsParsed: 3,
  rowsSkipped: 0,
  bufferedAfterDedupe: 3,
};

describe("checkAddressFetchComplete", () => {
  it("passes (null) when read == service, parsed+skipped == read, and at least one record survived dedupe", () => {
    expect(checkAddressFetchComplete(COMPLETE)).toBeNull();
  });

  it("passes when some features were skipped, as long as parsed+skipped accounts for everything read", () => {
    expect(
      checkAddressFetchComplete({
        ...COMPLETE,
        rowsParsed: 2,
        rowsSkipped: 1,
        bufferedAfterDedupe: 2,
      }),
    ).toBeNull();
  });

  it("THE CORE DEFECT, reproduced: refuses when features read is LESS than the service's own count (a dropped/short crawl)", () => {
    const refusal = checkAddressFetchComplete({
      ...COMPLETE,
      rowsRead: 2,
      rowsParsed: 2,
      bufferedAfterDedupe: 2,
    });
    expect(refusal).not.toBeNull();
    expect(refusal?.code).toBe(ADDRESS_FETCH_INCOMPLETE);
    expect(refusal?.reason).toBe("count-mismatch");
    // the numbers travel with the refusal, not just a bare message
    expect(refusal?.rowsRead).toBe(2);
    expect(refusal?.serviceCount).toBe(3);
  });

  it("refuses when features read EXCEEDS the service's own count too (count must match exactly, not just >=)", () => {
    const refusal = checkAddressFetchComplete({ ...COMPLETE, rowsRead: 4, rowsParsed: 4, bufferedAfterDedupe: 4 });
    expect(refusal?.reason).toBe("count-mismatch");
  });

  it("A --limit-bounded sample on a REAL write is a short crawl by definition, and is refused the same way", () => {
    // --limit=1000 against a 26,125-point county (Caldwell's real count,
    // 2026-10 measurement) is exactly this shape: rowsRead stops at the
    // limit, far under serviceCount.
    const refusal = checkAddressFetchComplete({
      countyFips: "48055",
      countyName: "Caldwell",
      serviceCount: 26_125,
      rowsRead: 1000,
      rowsParsed: 1000,
      rowsSkipped: 0,
      bufferedAfterDedupe: 1000,
    });
    expect(refusal?.code).toBe(ADDRESS_FETCH_INCOMPLETE);
    expect(refusal?.reason).toBe("count-mismatch");
  });

  it("refuses when parsed + skipped does not equal read (the counters themselves disagree)", () => {
    const refusal = checkAddressFetchComplete({
      ...COMPLETE,
      rowsParsed: 2,
      rowsSkipped: 0, // 2 + 0 = 2, but rowsRead is 3
    });
    expect(refusal).not.toBeNull();
    expect(refusal?.reason).toBe("parsed-skipped-mismatch");
  });

  it("refuses when the buffer is empty after dedupe, even though read == service and parsed+skipped == read", () => {
    const refusal = checkAddressFetchComplete({
      countyFips: "48055",
      countyName: "Caldwell",
      serviceCount: 0,
      rowsRead: 0,
      rowsParsed: 0,
      rowsSkipped: 0,
      bufferedAfterDedupe: 0,
    });
    expect(refusal).not.toBeNull();
    expect(refusal?.reason).toBe("zero-after-dedupe");
  });

  it("the zero-after-dedupe check only fires once the completeness checks already passed (checked in order)", () => {
    // rowsRead (0) != serviceCount (5): this must report count-mismatch,
    // not zero-after-dedupe, even though bufferedAfterDedupe is also 0.
    const refusal = checkAddressFetchComplete({
      countyFips: "48055",
      countyName: "Caldwell",
      serviceCount: 5,
      rowsRead: 0,
      rowsParsed: 0,
      rowsSkipped: 0,
      bufferedAfterDedupe: 0,
    });
    expect(refusal?.reason).toBe("count-mismatch");
  });

  it("zero-after-dedupe can fire even when every read feature parsed, if they all collided on objectid", () => {
    // Degenerate but real: everything read, everything parsed, nothing
    // skipped -- yet the buffer is empty because every record collapsed
    // onto one already-seen objectid (bufferAddressRecords's dedupe).
    const refusal = checkAddressFetchComplete({
      countyFips: "48055",
      countyName: "Caldwell",
      serviceCount: 3,
      rowsRead: 3,
      rowsParsed: 3,
      rowsSkipped: 0,
      bufferedAfterDedupe: 0,
    });
    expect(refusal?.reason).toBe("zero-after-dedupe");
  });

  it("every refusal names the county so an operator reading logs for six counties can tell them apart", () => {
    const refusal = checkAddressFetchComplete({ ...COMPLETE, rowsRead: 1, rowsParsed: 1, bufferedAfterDedupe: 1 });
    expect(refusal?.message).toContain("Caldwell");
    expect(refusal?.message).toContain("48055");
  });
});
