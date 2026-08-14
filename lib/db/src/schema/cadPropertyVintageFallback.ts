import {
  check,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

/**
 * Named prior-vintage fallback entries (L21 follow-up 3 / P-25).
 *
 * These rows implement the L9 vintage spec's sanctioned fallback clause:
 * fallback is explicit per county/key, evidence-classed, and visible to
 * consumers. The blessed vintage resolver remains the only read seam.
 */
export const cadPropertyVintageFallback = pgTable(
  "cad_property_vintage_fallback",
  {
    countyFips: text("county_fips").notNull(),
    requestedPropId: text("requested_prop_id").notNull(),
    declaredTaxYear: integer("declared_tax_year").notNull(),
    fallbackPropId: text("fallback_prop_id").notNull(),
    fallbackTaxYear: integer("fallback_tax_year").notNull(),
    method: text("method").notNull(),
    evidenceClass: text("evidence_class").notNull(),
    sourceFile: text("source_file").notNull(),
    sourceVintage: text("source_vintage").notNull(),
    ingestedAt: timestamp("ingested_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => ({
    pk: primaryKey({
      name: "cad_property_vintage_fallback_pk",
      columns: [t.countyFips, t.requestedPropId, t.declaredTaxYear],
    }),
    distinctYears: check(
      "cad_property_vintage_fallback_distinct_years",
      sql`${t.declaredTaxYear} <> ${t.fallbackTaxYear}`,
    ),
    lookupIdx: index("cad_property_vintage_fallback_lookup_idx").on(
      t.countyFips,
      t.fallbackTaxYear,
      t.fallbackPropId,
    ),
  }),
);

export type CadPropertyVintageFallbackRow =
  typeof cadPropertyVintageFallback.$inferSelect;
export type CadPropertyVintageFallbackInsert =
  typeof cadPropertyVintageFallback.$inferInsert;
