/**
 * GET /api/local/setbacks/:jurisdictionKey — thin HTTP shim over the
 * adapter-owned `lib/adapters/src/local/setbacks/<key>.json` tables.
 *
 * Why a shim and not "import the JSON in the FE":
 *   - The design-tools artifact does not depend on `@workspace/adapters`
 *     and we'd rather not pull the adapter lib (with its server-only
 *     imports — `arcgisPointQuery`, `node:fs`-adjacent things) into a
 *     Vite client bundle.
 *   - The setback tables are also small enough that a per-page fetch
 *     is cheap (each table is a handful of district rows), so we avoid
 *     any client-bundled JSON.
 *
 * Contract:
 *   - 200 + { jurisdictionKey, jurisdictionDisplayName, note?, districts[] }
 *     when `jurisdictionKey` matches one of `SETBACK_JURISDICTION_KEYS`.
 *   - 404 { error: "setback_table_not_found" } otherwise. The Site
 *     Context tab treats a 404 as "no codified table for this row's
 *     jurisdiction" and renders the bare adapter payload.
 */

import { Router, type IRouter, type Request, type Response } from "express";
import { getSetbackTable } from "@workspace/adapters";
import { logger } from "../lib/logger";

const router: IRouter = Router();

/**
 * The corpus's canonical stated-absence sentinel for max_height_ft
 * (hauska-setback-corpus rule G7 / `NOT_SPECIFIED_MAX_HEIGHT_FT`). It is a
 * placeholder, not a height: the meaning lives in the row's
 * `provenance.max_height_ft.not_specified` flag, and the number carries none.
 */
const NOT_SPECIFIED_MAX_HEIGHT_FT = 999;

/**
 * True when this row's height is ABSENT rather than a number — either the
 * honest form (`provenance.max_height_ft.not_specified === true`) or the bare
 * sentinel with no flag (P-299: the corpus gate blocks that shape, but this
 * route reads the JSON file directly, so it fails closed on the value too —
 * 999 ft is not a height any of these codes states).
 */
export function heightIsAbsent(d: {
  max_height_ft: number;
  provenance?: Record<string, unknown>;
}): boolean {
  const slot = d.provenance?.["max_height_ft"];
  const flagged =
    !!slot &&
    typeof slot === "object" &&
    (slot as { not_specified?: boolean }).not_specified === true;
  return flagged || d.max_height_ft === NOT_SPECIFIED_MAX_HEIGHT_FT;
}

router.get(
  "/local/setbacks/:jurisdictionKey",
  (req: Request, res: Response) => {
    const reqLog = (req as unknown as { log?: typeof logger }).log ?? logger;
    const key = req.params["jurisdictionKey"];
    if (!key || typeof key !== "string") {
      res.status(400).json({ error: "invalid_jurisdiction_key" });
      return;
    }
    const table = getSetbackTable(key);
    if (!table) {
      reqLog.info(
        { jurisdictionKey: key },
        "local-setbacks: no table for jurisdiction key — responding 404",
      );
      res.status(404).json({ error: "setback_table_not_found" });
      return;
    }
    // The adapter's `SetbackTable` shape happens to match the wire
    // shape `LocalSetbackTable` exactly — re-project explicitly so a
    // future adapter-side schema extension cannot silently leak new
    // fields onto the wire.
    //
    // P-299: a height the code does not state reaches the wire as null, never
    // as the corpus's 999 sentinel. The raw field is the placeholder; serving it
    // verbatim is what put "max height 999 ft" in front of a reader.
    res.json({
      jurisdictionKey: table.jurisdictionKey,
      jurisdictionDisplayName: table.jurisdictionDisplayName,
      note: table.note ?? null,
      districts: table.districts.map((d) => ({
        district_name: d.district_name,
        front_ft: d.front_ft,
        rear_ft: d.rear_ft,
        side_ft: d.side_ft,
        side_corner_ft: d.side_corner_ft,
        max_height_ft: heightIsAbsent(d) ? null : d.max_height_ft,
        max_lot_coverage_pct: d.max_lot_coverage_pct,
        max_impervious_pct: d.max_impervious_pct,
        citation_url: d.citation_url,
      })),
    });
  },
);

export default router;
