/**
 * Arrow-two Phase 3 — per-(atomId, jurisdictionTenant) calibration overlay.
 * Covers reasoning atoms and immutable corpus atoms; corpus is never mutated.
 */

import {
  pgTable,
  text,
  jsonb,
  timestamp,
  numeric,
  integer,
  boolean,
  index,
  primaryKey,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const CALIBRATION_PARTITION_KINDS = [
  "public",
  "tenant-private",
  "tenant-shared",
] as const;
export type CalibrationPartitionKind =
  (typeof CALIBRATION_PARTITION_KINDS)[number];

export const CALIBRATION_GRAINS = ["atom", "class"] as const;
export type CalibrationGrain = (typeof CALIBRATION_GRAINS)[number];

/** Public-pool partition key — anonymous/public-tier signal only. */
export const PUBLIC_CALIBRATION_TENANT = "__public__" as const;

export const atomCalibrationOverlay = pgTable(
  "atom_calibration_overlay",
  {
    atomId: text("atom_id").notNull(),
    jurisdictionTenant: text("jurisdiction_tenant").notNull(),
    partitionKind: text("partition_kind")
      .notNull()
      .default("public"),
    accessPolicy: text("access_policy").notNull().default("public-free"),
    sharedWithTenants: jsonb("shared_with_tenants").$type<string[]>(),
    assertedConfidence: numeric("asserted_confidence").notNull(),
    calibratedConfidence: numeric("calibrated_confidence"),
    codeRef: text("code_ref"),
    edition: text("edition"),
    sourceSetVersion: integer("source_set_version").notNull().default(1),
    calibrationStale: boolean("calibration_stale").notNull().default(false),
    calibrationGrain: text("calibration_grain").notNull().default("atom"),
    atomClass: text("atom_class"),
    signalCount: integer("signal_count").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.atomId, t.jurisdictionTenant] }),
    index("atom_calibration_overlay_tenant_idx").on(t.jurisdictionTenant),
    index("atom_calibration_overlay_class_idx").on(
      t.jurisdictionTenant,
      t.atomClass,
    ),
    check(
      "atom_calibration_overlay_partition_kind_check",
      sql`${t.partitionKind} IN ('public', 'tenant-private', 'tenant-shared')`,
    ),
    check(
      "atom_calibration_overlay_grain_check",
      sql`${t.calibrationGrain} IN ('atom', 'class')`,
    ),
  ],
);

export type AtomCalibrationOverlay = typeof atomCalibrationOverlay.$inferSelect;
export type NewAtomCalibrationOverlay =
  typeof atomCalibrationOverlay.$inferInsert;
