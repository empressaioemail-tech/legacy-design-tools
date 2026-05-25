import {
  pgTable,
  uuid,
  text,
  timestamp,
  jsonb,
  integer,
  index,
} from "drizzle-orm/pg-core";

export const COLLATERAL_EXPORT_JOB_STEPS = [
  "preparing",
  "resolving_assets",
  "rendering",
  "ready",
  "failed",
] as const;
export type CollateralExportJobStepValue =
  (typeof COLLATERAL_EXPORT_JOB_STEPS)[number];

export interface CollateralExportRequestJson {
  templatePackId: string;
  assetIds: string[];
  slotMapping: Record<string, string>;
  textFields: Record<string, string>;
  /** Ordered plan sheet asset ids for per-page spreads (max 12). */
  sheetAssetIds?: string[];
}

export const collateralExportJobs = pgTable(
  "collateral_export_jobs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    engagementId: uuid("engagement_id").notNull(),
    tenantId: text("tenant_id").notNull().default("default"),
    step: text("step").notNull().default("preparing"),
    progressLabel: text("progress_label").notNull(),
    request: jsonb("request").notNull().$type<CollateralExportRequestJson>(),
    downloadUrl: text("download_url"),
    thumbnailUrl: text("thumbnail_url"),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    placidPdfId: text("placid_pdf_id"),
    creditsEstimated: integer("credits_estimated"),
    creditsActual: integer("credits_actual"),
    provider: text("provider").notNull().default("placid"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => ({
    engagementCreatedIdx: index(
      "collateral_export_jobs_engagement_created_idx",
    ).on(t.engagementId, t.createdAt),
  }),
);

export const COLLATERAL_EXPORT_STATUSES = [
  "rendering",
  "ready",
  "failed",
] as const;

export const collateralExports = pgTable(
  "collateral_exports",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    engagementId: uuid("engagement_id").notNull(),
    exportJobId: uuid("export_job_id"),
    templatePackId: text("template_pack_id").notNull(),
    templateName: text("template_name").notNull(),
    status: text("status").notNull().default("rendering"),
    downloadUrl: text("download_url"),
    thumbnailUrl: text("thumbnail_url"),
    sourceAssetIds: jsonb("source_asset_ids")
      .notNull()
      .default([])
      .$type<string[]>(),
    creditsCharged: integer("credits_charged"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => ({
    engagementCreatedIdx: index("collateral_exports_engagement_created_idx").on(
      t.engagementId,
      t.createdAt,
    ),
  }),
);

/** Billing hook stub — one row per successful export. */
export const collateralMeteringEvents = pgTable(
  "collateral_metering_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: text("tenant_id").notNull().default("default"),
    engagementId: uuid("engagement_id").notNull(),
    exportJobId: uuid("export_job_id").notNull(),
    units: integer("units").notNull(),
    provider: text("provider").notNull().default("placid"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => ({
    engagementIdx: index("collateral_metering_events_engagement_idx").on(
      t.engagementId,
      t.createdAt,
    ),
  }),
);

export type CollateralExportJob = typeof collateralExportJobs.$inferSelect;
export type CollateralExport = typeof collateralExports.$inferSelect;
