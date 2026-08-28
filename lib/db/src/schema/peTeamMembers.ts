import { sql } from "drizzle-orm";
import {
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  index,
  primaryKey,
  check,
} from "drizzle-orm/pg-core";
import { users } from "./users";

export type PeTeamRole = "owner" | "member";

/**
 * Joined members of a Property Explorer billing account.
 * The billing owner is `account_owner_user_id` (pe_user_entitlements).
 * Identity is the existing users / pe_user_identities row — this is
 * membership, not a second user store.
 */
export const peTeamMembers = pgTable(
  "pe_team_members",
  {
    accountOwnerUserId: text("account_owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    memberUserId: text("member_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    role: text("role").notNull().$type<PeTeamRole>(),
    joinedAt: timestamp("joined_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    primaryKey({
      name: "pe_team_members_pkey",
      columns: [t.accountOwnerUserId, t.memberUserId],
    }),
    uniqueIndex("pe_team_members_account_member_uidx").on(
      t.accountOwnerUserId,
      t.memberUserId,
    ),
    uniqueIndex("pe_team_members_account_email_uidx").on(
      t.accountOwnerUserId,
      t.email,
    ),
    uniqueIndex("pe_team_members_member_uidx").on(t.memberUserId),
    index("pe_team_members_account_idx").on(t.accountOwnerUserId),
    check(
      "pe_team_members_role_chk",
      sql`${t.role} IN ('owner', 'member')`,
    ),
  ],
);

export type PeTeamMember = typeof peTeamMembers.$inferSelect;
