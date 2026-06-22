import { describe, expect, it } from "vitest";
import { parseApplicableIccEditions } from "../iccEditions";

describe("parseApplicableIccEditions", () => {
  it("parses IBC and IPMC titles with editions", () => {
    expect(
      parseApplicableIccEditions(["IBC 2021", "IPMC 2018", "NEC 2020"]),
    ).toEqual([
      { title: "IBC", edition: "2021" },
      { title: "IPMC", edition: "2018" },
    ]);
  });

  it("deduplicates repeated entries", () => {
    expect(parseApplicableIccEditions(["IBC 2021", "IBC 2021"])).toEqual([
      { title: "IBC", edition: "2021" },
    ]);
  });
});
