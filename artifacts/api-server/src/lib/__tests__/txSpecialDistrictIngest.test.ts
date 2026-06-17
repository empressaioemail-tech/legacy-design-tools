import { describe, expect, it, vi } from "vitest";

import {
  parseCsvLine,
  ingestTxSpecialDistrictsFromComptroller,
} from "../txSpecialDistrictIngest";

describe("parseCsvLine", () => {
  it("parses quoted CSV fields", () => {
    const cols = parseCsvLine(
      '1,103225518,"F4E89E5E-F161-4568-B4EE-627A0EC8BDAC","Stamford Hospital District","2018",32042451453',
    );
    expect(cols[3]).toBe("Stamford Hospital District");
    expect(cols[5]).toBe("32042451453");
  });
});

describe("ingestTxSpecialDistrictsFromComptroller", () => {
  it("normalizes Comptroller CSV rows to registry JSON", async () => {
    const csv = [
      "id,spd_publ_id,spd_ent_rpt_id,ent_dis_nm,rpt_yr,tp_id,city_nm,cnty_cd,wbst_url_tx,ostd_bond_cd,gros_rcpt_cd,cash_temp_nvst_cd,no_crit_cd,ent_ty_tx",
      '1,103225550,"A","Fort Bend County Municipal Utility District #2","2024",17462402706,"HOUSTON",79,"","Y","Y","Y","N","Municipal Utility District"',
    ].join("\n");

    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => csv,
    });

    const result = await ingestTxSpecialDistrictsFromComptroller({
      outputPath: "P:/legacy-design-tools/var/test-spd.json",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result.districtCount).toBe(1);
    expect(result.districtCount).toBeGreaterThan(0);
  });
});
