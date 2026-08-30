/**
 * CTX W1 alias READ (alias WDLL item 5). Bake only. Does not write
 * `identity.alias` atoms or landing rows.
 *
 * If an open `landing_cad_txgio_alias` row exists for
 * `(county_fips, cad_prop_id)`, join from that TxGIO key. Situs plus
 * `ownersAgree` runs only when no open alias exists, and only on a FIPS
 * that would have been go for situs-extend (W0b: none of 48021 / 48055 /
 * 48453). New bind emit may be empty.
 */

import { tableExists, type QueryablePool } from "./nodeFacetTier1ParcelJoin";

export const CAD_TXGIO_ALIAS_METHOD = "cad-roll-address-join";
export const ALIAS_LANDING_TABLE = "landing_cad_txgio_alias";
export const ALIAS_JOIN_SOURCE = "cad-txgio-alias" as const;

/**
 * W0b leftover owner-agree: 48021 0.688 n=32 no-go; 48055 0.721 n=43
 * no-go; 48453 unmeasured. Empty until a go FIPS exists. Do not reverse
 * `addressJoinKey` for those three.
 */
export const SITUS_EXTEND_GO_FIPS: ReadonlySet<string> = new Set();

export interface CadTxgioAliasRead {
  countyFips: string;
  cadPropId: string;
  txgioId: string;
  situsKey: string;
}

export interface CadTxgioBindEmit {
  county_fips: string;
  cad_prop_id: string;
  txgio_id: string;
  situs_key: string;
  owners_agree: true;
  as_of: string;
  method: typeof CAD_TXGIO_ALIAS_METHOD;
}

export function resolveOpenAlias(
  aliases: ReadonlyMap<string, CadTxgioAliasRead>,
  cadPropId: string,
): CadTxgioAliasRead | null {
  if (!cadPropId) return null;
  return aliases.get(cadPropId) ?? null;
}

/**
 * Situs keys that still need a TxGIO fetch. An open alias skips the situs
 * fetch for that CAD prop_id.
 */
export function situsKeysNeedingFetch(
  work: ReadonlyArray<{ cadPropId: string; situsKey: string | null }>,
  aliases: ReadonlyMap<string, CadTxgioAliasRead>,
): string[] {
  const keys = new Set<string>();
  for (const w of work) {
    if (resolveOpenAlias(aliases, w.cadPropId)) continue;
    if (w.situsKey) keys.add(w.situsKey);
  }
  return [...keys];
}

export function emitBindFromSitusRecovery(input: {
  countyFips: string;
  cadPropId: string;
  txgioId: string | null | undefined;
  situsKey: string | null | undefined;
  asOf: string;
}): CadTxgioBindEmit | null {
  const txgioId = input.txgioId?.trim() ?? "";
  const situsKey = input.situsKey?.trim() ?? "";
  const cadPropId = input.cadPropId.trim();
  if (!txgioId || !situsKey || !cadPropId) return null;
  return {
    county_fips: input.countyFips,
    cad_prop_id: cadPropId,
    txgio_id: txgioId,
    situs_key: situsKey,
    owners_agree: true,
    as_of: input.asOf,
    method: CAD_TXGIO_ALIAS_METHOD,
  };
}

export async function loadOpenCadTxgioAliases(
  pool: QueryablePool,
  countyFips: string,
): Promise<{
  rows: Map<string, CadTxgioAliasRead>;
  tableState: "present" | "absent";
}> {
  if (!(await tableExists(pool, ALIAS_LANDING_TABLE))) {
    return { rows: new Map(), tableState: "absent" };
  }
  const r = await pool.query<{
    cad_prop_id: string;
    txgio_id: string;
    situs_key: string;
  }>(
    `SELECT cad_prop_id, txgio_id, situs_key
       FROM ${ALIAS_LANDING_TABLE}
      WHERE county_fips = $1
        AND valid_to IS NULL
        AND owners_agree IS TRUE
      ORDER BY cad_prop_id, txgio_id`,
    [countyFips],
  );
  const rows = new Map<string, CadTxgioAliasRead>();
  for (const row of r.rows) {
    const cadPropId = row.cad_prop_id?.trim();
    const txgioId = row.txgio_id?.trim();
    if (!cadPropId || !txgioId || rows.has(cadPropId)) continue;
    rows.set(cadPropId, {
      countyFips,
      cadPropId,
      txgioId,
      situsKey: row.situs_key?.trim() ?? "",
    });
  }
  return { rows, tableState: "present" };
}
