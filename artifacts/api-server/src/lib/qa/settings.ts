/**
 * Task #482 — QA Dashboard runtime settings (autopilot toggle).
 *
 * Backed by the tiny `qa_settings` kv table. Today the only key in
 * use is `autopilot.enabled` ("true" | "false"); kept generic so
 * subsequent dashboard toggles (e.g. notification preferences) can
 * land without a schema migration.
 */

import { db, qaSettings } from "@workspace/db";
import { eq } from "drizzle-orm";

export type QaSettingKey = "autopilot.enabled";

const DEFAULTS: Record<QaSettingKey, string> = {
  "autopilot.enabled": "true",
};

export async function getSetting(key: QaSettingKey): Promise<string> {
  const [row] = await db
    .select()
    .from(qaSettings)
    .where(eq(qaSettings.key, key))
    .limit(1);
  return row?.value ?? DEFAULTS[key];
}

export async function setSetting(
  key: QaSettingKey,
  value: string,
): Promise<void> {
  await db
    .insert(qaSettings)
    .values({ key, value, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: qaSettings.key,
      set: { value, updatedAt: new Date() },
    });
}

export async function isAutopilotEnabled(): Promise<boolean> {
  return (await getSetting("autopilot.enabled")) === "true";
}
