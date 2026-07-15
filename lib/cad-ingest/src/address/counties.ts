/**
 * County resolution for the address-point ingest.
 *
 * The StratMap Address Points service filters on the county DISPLAY
 * NAME (`county='Travis'`), not FIPS, and it covers all 254 Texas
 * counties. Rather than hardcode a 254-row FIPS<->name table here, the
 * CLI accepts either a `--county-name=<Name>` (passed straight to the
 * service) or a `--county=<fips|name>` resolved through this small
 * registry of the counties the self-hosted stores already care about
 * (the TxGIO parcel scope + the CAD-roll counties). A statewide crawl
 * loops counties by name.
 */

export interface AddressCounty {
  /** 5-digit county FIPS, e.g. `48453`. */
  fips: string;
  /** County display name as the service knows it, e.g. `Travis`. */
  name: string;
}

/**
 * Convenience registry — the counties with a self-hosted parcel/roll
 * store today. Not exhaustive; the CLI's `--county-name` path reaches
 * any of the 254 counties without an entry here.
 */
export const ADDRESS_COUNTIES: Record<string, AddressCounty> = {
  "48453": { fips: "48453", name: "Travis" },
  "48209": { fips: "48209", name: "Hays" },
  "48091": { fips: "48091", name: "Comal" },
  "48491": { fips: "48491", name: "Williamson" },
  "48021": { fips: "48021", name: "Bastrop" },
  "48055": { fips: "48055", name: "Caldwell" },
  "48029": { fips: "48029", name: "Bexar" },
};

export function resolveAddressCounty(input: string): AddressCounty | undefined {
  const key = input.trim();
  if (ADDRESS_COUNTIES[key]) return ADDRESS_COUNTIES[key];
  const lower = key.toLowerCase();
  return Object.values(ADDRESS_COUNTIES).find(
    (c) => c.name.toLowerCase() === lower,
  );
}
