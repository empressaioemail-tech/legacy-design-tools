import { db, workspaceSettings } from "@workspace/db";
import { eq } from "drizzle-orm";
import {
  mergeWorkspacePreferences,
  type WorkspacePreferences,
} from "./workspacePreferences";

const DEFAULT_ID = "default";

export async function loadWorkspacePreferences(): Promise<WorkspacePreferences> {
  const [row] = await db
    .select({ preferences: workspaceSettings.preferences })
    .from(workspaceSettings)
    .where(eq(workspaceSettings.id, DEFAULT_ID))
    .limit(1);
  return mergeWorkspacePreferences(row?.preferences ?? {});
}
