/**
 * Why a setback dimension was not served, in the city's own words.
 *
 * Bastrop setback refusals (re-walk 2026-11-09, 1102 Pecan St, 48021:33977). Every MU lot's per-parcel GIS record
 * (Parcels_One_Click layer 23) states the side setback as "None - Reference Building Code/Fire Code". That is the
 * repealed Bastrop Building Block (B3) code's wording, not a number. The factory refuses the cell and quotes that text
 * in its reason. The envelope used to say only "parcel_record_cell .../setbackSideFt is not a readable number",
 * dropping both the city's words and what the current code says.
 *
 * This puts the cell's own refusal into a staff sentence. For a Bastrop district whose current rule is transcribed
 * here, it also gives the 2026 Bastrop Development Code rule. It names a rule; it never serves a number.
 */

/** The 2026 Bastrop Development Code (Ord. 2026-06) side rule for districts whose GIS record names no side number. */
export const BASTROP_2026_SIDE_RULE: Readonly<Record<string, string>> = Object.freeze({
  MU:
    "The 2026 Bastrop Development Code (Ord. 2026-06, Sec. 14.02.003.F.3) says 5 ft minimum, 0 ft on a shared party " +
    "wall in a unified development, and 10 ft where the lot abuts an RR or SF district.",
});

const BASTROP_COUNTY_FIPS = "48021";

/** The setback text the city's record states, quoted in the factory's refusal ("... states the side setback as \"X\" ..."). */
export function cityStatedText(reason: string | null | undefined): string | null {
  const m = /states the \w+(?: \w+)? setback as "([^"]+)"/.exec(String(reason ?? ""));
  return m ? m[1] : null;
}

function districtToken(district: string | null | undefined): string {
  const raw = String(district ?? "").trim().toUpperCase();
  const m = /^(MU|GC|IND|PDD|OS|RR|PI|SF-\d)(?:$|[-_\s])/.exec(raw);
  return m ? m[1] : raw;
}

/**
 * The sentence for one unserved dimension ("side", "rear", "front"). `refusal` is the cell's own reason when the
 * record refused it, else null. `entityId` is the parcel's place key ("48021:33977").
 */
export function setbackRefusalWords({
  dimension,
  entityId,
  district,
  refusal,
}: {
  dimension: "side" | "rear" | "front";
  entityId: string;
  district: string | null | undefined;
  refusal: string | null | undefined;
}): string {
  const stated = cityStatedText(refusal);
  const token = districtToken(district);
  const inBastrop = String(entityId).startsWith(`${BASTROP_COUNTY_FIPS}:`);
  if (inBastrop && stated) {
    const lot = token ? `this ${token} lot` : "this lot";
    const first =
      `Bastrop's parcel GIS record gives no ${dimension} setback for ${lot} ` +
      `("${stated}", from the repealed Bastrop Building Block (B3) code).`;
    const rule = dimension === "side" ? BASTROP_2026_SIDE_RULE[token] : undefined;
    return rule ? `${first} ${rule}` : first;
  }
  if (refusal && String(refusal).trim()) {
    const r = String(refusal).trim();
    return `The parcel record gives no ${dimension} setback for this lot: ${r[0].toUpperCase()}${r.slice(1)}${/[.!?]$/.test(r) ? "" : "."}`;
  }
  return `The parcel record gives no readable ${dimension} setback for this lot, so none is drawn rather than inventing one.`;
}
