/**
 * Slim each parcel on a multi-parcel node read (UX review 2026-10-05, F13: three
 * parcels came to 84 KB, against the host's ~150,000-character result cap).
 *
 * A comparison answer needs each parcel's facts and the card needs its draw
 * block; neither needs the duplicates removed here:
 * - boundaryEdgeFact (the same edges ride on draw.edges, which the card draws);
 * - footprint polygons (the footprint's presence and role stay);
 * - the setback table's long internal note (the values and citation stay);
 * - the identical plan-gate sentence on every gated value (its code stays);
 * - the city-limits and ETJ explanation paragraphs (status, city and settledBy stay).
 * A single-parcel read is never slimmed.
 */

const GATED_REASON_PREFIX = "County tax-assessed valuation";

function stripGatedReasons(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripGatedReasons);
  if (!value || typeof value !== "object") return value;
  const rec = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(rec)) {
    if (
      k === "reason" &&
      rec.state === "refused" &&
      rec.code === "studio-gated" &&
      typeof v === "string" &&
      v.startsWith(GATED_REASON_PREFIX)
    ) {
      continue;
    }
    out[k] = stripGatedReasons(v);
  }
  return out;
}

export function slimBatchParcel(parcel: Record<string, unknown>): Record<string, unknown> {
  const out = stripGatedReasons(parcel) as Record<string, unknown>;
  delete out.boundaryEdgeFact;
  const fp = out.buildingFootprintFact as Record<string, unknown> | undefined;
  if (fp && typeof fp === "object") {
    delete fp.footprintGeometry;
    if (Array.isArray(fp.footprints)) {
      fp.footprints = fp.footprints.map((f) => {
        if (!f || typeof f !== "object") return f;
        const { footprintGeometry: _g, ...rest } = f as Record<string, unknown>;
        return rest;
      });
    }
  }
  const sr = out.setbackRulesFact as Record<string, unknown> | undefined;
  if (sr && typeof sr === "object") delete sr.note;
  // The city-limits and ETJ facts repeat the same legal paragraph per parcel;
  // keep the status, city and how it was settled.
  const cl = out.cityLimitsFact as Record<string, unknown> | undefined;
  if (cl && typeof cl === "object") {
    delete cl.basis;
    delete cl.queryPoint;
    const etj = cl.etjFact as Record<string, unknown> | undefined;
    if (etj && typeof etj === "object") {
      delete etj.basis;
      delete etj.queryPoint;
      const inc = etj.incorporation as Record<string, unknown> | undefined;
      if (inc && typeof inc === "object") delete inc.cityLimitsBasis;
    }
  }
  return out;
}

/** Applies slimBatchParcel to every parcel in a batch response's JSON text; anything unparseable passes through. */
export function slimBatchResponseText(text: string): string {
  try {
    const data = JSON.parse(text) as Record<string, unknown>;
    if (!Array.isArray(data.parcels)) return text;
    data.parcels = data.parcels.map((p) =>
      p && typeof p === "object" ? slimBatchParcel(p as Record<string, unknown>) : p,
    );
    if (data.gatedValueNote === undefined && text.includes(GATED_REASON_PREFIX)) {
      data.gatedValueNote =
        "Values marked studio-gated are county tax-assessed valuations, shown on Studio and Team plans only.";
    }
    return JSON.stringify(data);
  } catch {
    return text;
  }
}
