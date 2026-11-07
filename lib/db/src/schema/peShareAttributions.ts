import { sql } from "drizzle-orm";
import { pgTable, text, timestamp, index, check } from "drizzle-orm/pg-core";
import { users } from "./users";
import { peShareGrants } from "./peShareGrants";

/**
 * P-100 item 3 — which sharer does this account belong to.
 *
 * WHAT A ROW MEANS. This account was created by someone who arrived through
 * that share grant. Nothing else. It is not a purchase, not a referral
 * payment, and not a claim that the share CAUSED the signup — it records the
 * path, which is the only thing observable.
 *
 * THE JOIN KEY IS THE GRANT ROW ID. `pe_share_grants` (P-86) already holds
 * `grantorUserId`, written server-side by the mint route. The recipient's
 * browser holds the grant id because it is in the URL it was handed; it does
 * not, and must not, get to say WHO the sharer is. The route resolves the
 * grantor from the grant row, and a request body that names a sharer is
 * REFUSED rather than ignored — ignoring it leaves the caller believing it
 * set one.
 *
 * `grantorUserId` IS DELIBERATELY NOT A COLUMN HERE. It is one join away, and
 * storing it would create two values that must agree and can drift.
 *
 * FIRST TOUCH WINS AND THE DATABASE ENFORCES IT. `recipientUserId` is the
 * primary key, so a second attribution for the same account is
 * unrepresentable — not by a race, not by a retry, not by a raw connection.
 * A read-then-write "is this account already attributed" check would have
 * lost that race.
 *
 * `surface` IS NULLABLE WITH NO DEFAULT, for the reason recorded on
 * `pe_activation_events`: an attribution whose surface was not sent is
 * UNMEASURED, and that is a different fact from one captured on a surface
 * named `api`.
 */
export const peShareAttributions = pgTable(
  "pe_share_attributions",
  {
    recipientUserId: text("recipient_user_id")
      .primaryKey()
      .references(() => users.id, { onDelete: "cascade" }),
    grantId: text("grant_id")
      .notNull()
      .references(() => peShareGrants.id, { onDelete: "cascade" }),
    /** `null` = the caller sent no surface. NEVER a default. */
    surface: text("surface"),
    attributedAt: timestamp("attributed_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    index("pe_share_attributions_grant_id_idx").on(t.grantId),
    index("pe_share_attributions_attributed_at_idx").on(t.attributedAt),
    check(
      "pe_share_attributions_surface_chk",
      sql`${t.surface} IS NULL OR ${t.surface} <> ''`,
    ),
  ],
);

export type PeShareAttribution = typeof peShareAttributions.$inferSelect;
