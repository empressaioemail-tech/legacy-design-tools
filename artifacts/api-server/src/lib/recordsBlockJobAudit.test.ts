import { describe, expect, it } from "vitest";
import { selectBlockMissJobs } from "./recordsBlockJobAudit";

describe("selectBlockMissJobs", () => {
  it("names only jobs whose legal text the retired pattern missed", () => {
    const hits = selectBlockMissJobs([
      {
        id: "job-block",
        parcelKey: "apn:48021:1",
        status: "complete",
        legalDescription: "PECAN GROVE BLOCK 3 LOT 5",
        storedBlock: null,
      },
      {
        id: "job-blk",
        parcelKey: "apn:48021:2",
        status: "complete",
        legalDescription: "LOT 12 BLK 3 PECAN GROVE",
        storedBlock: "3",
      },
    ]);
    expect(hits.map((h) => h.id)).toEqual(["job-block"]);
  });
});
