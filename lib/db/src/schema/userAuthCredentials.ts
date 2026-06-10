import { pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { users } from "./users";

export const userAuthCredentials = pgTable("user_auth_credentials", {
  userId: text("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  email: text("email").notNull(),
  passwordHash: text("password_hash").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export type UserAuthCredential = typeof userAuthCredentials.$inferSelect;
export type NewUserAuthCredential = typeof userAuthCredentials.$inferInsert;
