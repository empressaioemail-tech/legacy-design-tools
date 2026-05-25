import {
  pgTable,
  uuid,
  text,
  timestamp,
  jsonb,
  index,
} from "drizzle-orm/pg-core";

/** Workspace-scoped Canva OAuth tokens (refresh token never sent to browser). */
export const canvaConnections = pgTable(
  "canva_connections",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: text("tenant_id").notNull().default("default"),
    /** Session requestor id when connected; dev uses `default-user`. */
    ownerUserId: text("owner_user_id").notNull(),
    accessToken: text("access_token").notNull(),
    refreshToken: text("refresh_token").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    displayName: text("display_name").notNull(),
    avatarUrl: text("avatar_url"),
    connectedAt: timestamp("connected_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => ({
    tenantOwnerIdx: index("canva_connections_tenant_owner_idx").on(
      t.tenantId,
      t.ownerUserId,
    ),
  }),
);

/** Short-lived PKCE + state for OAuth start → callback. */
export const canvaOauthStates = pgTable(
  "canva_oauth_states",
  {
    state: text("state").primaryKey(),
    codeVerifier: text("code_verifier").notNull(),
    ownerUserId: text("owner_user_id").notNull(),
    tenantId: text("tenant_id").notNull().default("default"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => ({
    createdIdx: index("canva_oauth_states_created_idx").on(t.createdAt),
  }),
);

export const CANVA_PUSH_JOB_STEPS = [
  "preparing",
  "uploading",
  "creating",
  "ready",
  "failed",
] as const;
export type CanvaPushJobStepValue = (typeof CANVA_PUSH_JOB_STEPS)[number];

export interface CanvaPushRequestJson {
  templateId: string;
  assetIds: string[];
  slotMapping: Record<string, string>;
  textFields: Record<string, string>;
  uploadAssetsOnly?: boolean;
}

export const canvaPushJobs = pgTable(
  "canva_push_jobs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    engagementId: uuid("engagement_id").notNull(),
    step: text("step").notNull().default("preparing"),
    progressLabel: text("progress_label").notNull(),
    request: jsonb("request").notNull().$type<CanvaPushRequestJson>(),
    designUrl: text("design_url"),
    designThumbnailUrl: text("design_thumbnail_url"),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    canvaAutofillJobId: text("canva_autofill_job_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => ({
    engagementCreatedIdx: index("canva_push_jobs_engagement_created_idx").on(
      t.engagementId,
      t.createdAt,
    ),
  }),
);

export const CANVA_DESIGN_PUSH_STATUSES = [
  "uploading",
  "ready",
  "failed",
  "edited_in_canva",
] as const;

export const canvaDesignPushes = pgTable(
  "canva_design_pushes",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    engagementId: uuid("engagement_id").notNull(),
    pushJobId: uuid("push_job_id"),
    templateId: text("template_id").notNull(),
    templateName: text("template_name").notNull(),
    status: text("status").notNull().default("uploading"),
    thumbnailUrl: text("thumbnail_url"),
    designUrl: text("design_url"),
    sourceAssetIds: jsonb("source_asset_ids")
      .notNull()
      .default([])
      .$type<string[]>(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => ({
    engagementCreatedIdx: index("canva_design_pushes_engagement_created_idx").on(
      t.engagementId,
      t.createdAt,
    ),
  }),
);

export type CanvaConnection = typeof canvaConnections.$inferSelect;
export type CanvaPushJob = typeof canvaPushJobs.$inferSelect;
export type CanvaDesignPush = typeof canvaDesignPushes.$inferSelect;
