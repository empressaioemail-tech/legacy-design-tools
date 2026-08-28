import { sql } from "drizzle-orm";
import {
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  index,
  check,
} from "drizzle-orm/pg-core";
import { users } from "./users";
import type { PeTeamRole } from "./peTeamMembers";

/**
 * Outstanding team invitations. An invitation HOLDS A SEAT from send,
 * not from accept. Invitee may not have a users row yet — email only.
 */
export const peTeamInvitations = pgTable(
  "pe_team_invitations",
  {
    id: text("id").primaryKey(),
    accountOwnerUserId: text("account_owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    role: text("role").notNull().$type<PeTeamRole>(),
    sentAt: timestamp("sent_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    uniqueIndex("pe_team_invitations_account_email_uidx").on(
      t.accountOwnerUserId,
      t.email,
    ),
    index("pe_team_invitations_account_idx").on(t.accountOwnerUserId),
    check(
      "pe_team_invitations_role_chk",
      sql`${t.role} IN ('owner', 'member')`,
    ),
  ],
);

export type PeTeamInvitation = typeof peTeamInvitations.$inferSelect;
