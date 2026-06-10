import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db, userAuthCredentials, users } from "@workspace/db";
import { ensureUserProfile } from "./userProfiles";
import { newUserId } from "./sessionToken";

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LEN = 64;

function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const derived = scryptSync(password, salt, KEY_LEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
  });
  return `scrypt:${salt.toString("hex")}:${derived.toString("hex")}`;
}

function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split(":");
  if (parts.length !== 3 || parts[0] !== "scrypt") return false;
  const salt = Buffer.from(parts[1]!, "hex");
  const expected = Buffer.from(parts[2]!, "hex");
  const derived = scryptSync(password, salt, expected.length, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
  });
  return (
    expected.length === derived.length && timingSafeEqual(expected, derived)
  );
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export async function signupWithEmailPassword(input: {
  email: string;
  password: string;
  displayName?: string;
}): Promise<
  | { ok: true; userId: string; email: string }
  | { ok: false; error: "invalid_input" | "email_taken" }
> {
  const email = normalizeEmail(input.email);
  const password = input.password?.trim() ?? "";
  if (!email.includes("@") || password.length < 8) {
    return { ok: false, error: "invalid_input" };
  }
  const existing = await db
    .select({ userId: userAuthCredentials.userId })
    .from(userAuthCredentials)
    .where(eq(userAuthCredentials.email, email))
    .limit(1);
  if (existing[0]) return { ok: false, error: "email_taken" };

  const userId = newUserId();
  const displayName =
    input.displayName?.trim() || email.split("@")[0] || userId;
  await ensureUserProfile(userId, displayName);
  await db.insert(users).values({ id: userId, displayName }).onConflictDoNothing();
  await db.insert(userAuthCredentials).values({
    userId,
    email,
    passwordHash: hashPassword(password),
  });
  return { ok: true, userId, email };
}

export async function loginWithEmailPassword(input: {
  email: string;
  password: string;
}): Promise<
  | { ok: true; userId: string; email: string }
  | { ok: false; error: "invalid_credentials" }
> {
  const email = normalizeEmail(input.email);
  const password = input.password ?? "";
  const [row] = await db
    .select()
    .from(userAuthCredentials)
    .where(eq(userAuthCredentials.email, email))
    .limit(1);
  if (!row || !verifyPassword(password, row.passwordHash)) {
    return { ok: false, error: "invalid_credentials" };
  }
  await ensureUserProfile(row.userId);
  return { ok: true, userId: row.userId, email: row.email };
}

export async function findUserIdByEmail(
  email: string,
): Promise<string | null> {
  const normalized = normalizeEmail(email);
  const [row] = await db
    .select({ userId: userAuthCredentials.userId })
    .from(userAuthCredentials)
    .where(eq(userAuthCredentials.email, normalized))
    .limit(1);
  return row?.userId ?? null;
}
