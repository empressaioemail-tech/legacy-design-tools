/**
 * CAD roll routing tests — bulk_primary refuses silent StratMap.
 */

import { describe, expect, it } from "vitest";
import { resolveCadRollRoute, registrySliceRow } from "../routing";
import { formatSourceVintage, parseSourceVintage } from "../tier";

describe("resolveCadRollRoute", () => {
  it("flags Tarrant 48439 bulk_primary with cad-export preference", () => {
    const route = resolveCadRollRoute("48439");
    expect(route.bulkPrimary).toBe(true);
    expect(route.preferredTier).toBe("cad-export");
    expect(route.adapterKind).toBe("county-run");
    expect(route.allowSilentStratmap).toBe(false);
  });

  it("flags Dallas 48113 bulk_primary with dcad-bulk-only adapter", () => {
    const route = resolveCadRollRoute("48113");
    expect(route.bulkPrimary).toBe(true);
    expect(route.preferredTier).toBe("cad-export");
    expect(route.adapterKind).toBe("dcad-bulk-only");
    expect(route.allowSilentStratmap).toBe(false);
  });

  it("allows silent stratmap for non-bulk_primary counties", () => {
    const route = resolveCadRollRoute("48491");
    expect(route.bulkPrimary).toBe(false);
    expect(route.preferredTier).toBeNull();
    expect(route.allowSilentStratmap).toBe(true);
  });

  it("registry slice carries format metadata", () => {
    expect(registrySliceRow("48439")?.format).toBe("bulk_export");
    expect(registrySliceRow("48113")?.format).toBe("arcgis_rest");
  });
});

describe("formatSourceVintage / parseSourceVintage", () => {
  it("round-trips tier adapter drop", () => {
    const vintage = formatSourceVintage({
      tier: "cad-export",
      adapter: "county-run",
      drop: "PropertyData(Delimited)_R.ZIP",
    });
    expect(vintage).toBe(
      "tier:cad-export;adapter:county-run;drop:PropertyData(Delimited)_R.ZIP",
    );
    expect(parseSourceVintage(vintage)).toEqual({
      tier: "cad-export",
      adapter: "county-run",
      drop: "PropertyData(Delimited)_R.ZIP",
    });
  });

  it("parses stratmap-roll fallback vintage", () => {
    const vintage = formatSourceVintage({
      tier: "stratmap-roll",
      adapter: "stratmap",
      drop: "stratmap25-landparcels_48113_lp",
    });
    expect(parseSourceVintage(vintage).tier).toBe("stratmap-roll");
  });
});
