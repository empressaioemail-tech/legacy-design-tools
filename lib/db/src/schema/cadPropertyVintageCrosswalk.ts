import {
  pgTable,
  text,
  integer,
  timestamp,
  primaryKey,
  unique,
  index,
} from "drizzle-orm/pg-core";

/**
 * Deterministic cross-vintage CAD prop_id crosswalk (L21 / P-25).
 *
 * Readers stay inside the declared-vintage seam: exact declared-year
 * key first; on miss, at most one mapped `to_prop_id` for the declared
 * year. Unique constraints refuse one-to-many / many-to-one writes.
 */
export const cadPropertyVintageCrosswalk = pgTable(
  "cad_property_vintage_crosswalk",
  {
    countyFips: text("county_fips").notNull(),
    fromTaxYear: integer("from_tax_year").notNull(),
    fromPropId: text("from_prop_id").notNull(),
    toTaxYear: integer("to_tax_year").notNull(),
    toPropId: text("to_prop_id").notNull(),
    /** Machine method id, e.g. `gis-link-whitespace-collapse`. */
    method: text("method").notNull(),
    /** Named evidence class, e.g. `owner-situs-agree` / `source-key-normalize`. */
    evidenceClass: text("evidence_class").notNull(),
    sourceFile: text("source_file").notNull(),
    sourceVintage: text("source_vintage").notNull(),
    ingestedAt: timestamp("ingested_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => ({
    pk: primaryKey({
      name: "cad_property_vintage_crosswalk_pk",
      columns: [t.countyFips, t.fromTaxYear, t.fromPropId, t.toTaxYear],
    }),
    uniqueTarget: unique("cad_property_vintage_crosswalk_unique_target").on(
      t.countyFips,
      t.toTaxYear,
      t.toPropId,
      t.fromTaxYear,
    ),
    toIdx: index("cad_property_vintage_crosswalk_to_idx").on(
      t.countyFips,
      t.toTaxYear,
      t.toPropId,
    ),
  }),
);

export type CadPropertyVintageCrosswalkRow =
  typeof cadPropertyVintageCrosswalk.$inferSelect;
export type CadPropertyVintageCrosswalkInsert =
  typeof cadPropertyVintageCrosswalk.$inferInsert;
