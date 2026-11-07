/**
 * ONE DOOR county scope (`_design/2026-10-15_burnet_publish_without_bake.md`
 * §1e and item 4): which counties a surface serves is the READER's answer, not
 * a hand-maintained list. The per-county switch (`off` | `shadow` | `on`)
 * lives only in the reader; a county it reports as `shadow` or `on` is
 * onboarded to the one door (Burnet 48053 first, then Bell and Milam) and
 * needs no edit in this repo to be admitted.
 *
 * Hand lists are the anti-pattern `placeCoverageSource.ts` names: correct
 * today and silently wrong the moment a county is onboarded. The bake-era
 * lists stay only for the six counties the bake still serves.
 */

import { oneDoorModeOf, readOneDoorRecord } from "./oneDoorReaderClient";

/**
 * True when the reader has this parcel's county under the one-door switch
 * (`shadow` or `on`). A reader that cannot be reached answers with the last
 * mode this process saw for the county, else `off` (fail closed).
 */
export async function oneDoorServesParcel(parcelNodeId: string): Promise<boolean> {
  const read = await readOneDoorRecord(parcelNodeId, { entitlements: [] });
  return oneDoorModeOf(read) !== "off";
}
