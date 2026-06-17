import { eq } from "drizzle-orm";
import { db, reasoningAtoms, type ReasoningSourceLink } from "@workspace/db";

export interface ReasoningVerificationSnapshotRow {
  id: string;
  verificationState: string;
  snippet: string | null;
  reasoning: string | null;
  sources: ReasoningSourceLink[];
  assertedConfidence: string;
}

export interface ReasoningVerificationSnapshot {
  jurisdictionKey: string;
  capturedAt: string;
  rows: ReasoningVerificationSnapshotRow[];
}

export async function snapshotReasoningVerification(
  jurisdictionKey: string,
): Promise<ReasoningVerificationSnapshot> {
  const rows = await db
    .select()
    .from(reasoningAtoms)
    .where(eq(reasoningAtoms.jurisdictionKey, jurisdictionKey));

  return {
    jurisdictionKey,
    capturedAt: new Date().toISOString(),
    rows: rows.map((row) => ({
      id: row.id,
      verificationState: row.verificationState,
      snippet: row.snippet,
      reasoning: row.reasoning,
      sources: (row.sources as ReasoningSourceLink[]) ?? [],
      assertedConfidence: row.assertedConfidence,
    })),
  };
}

export async function rollbackReasoningVerification(
  snapshot: ReasoningVerificationSnapshot,
): Promise<number> {
  let restored = 0;
  const now = new Date();
  for (const row of snapshot.rows) {
    const [updated] = await db
      .update(reasoningAtoms)
      .set({
        verificationState: row.verificationState,
        snippet: row.snippet,
        reasoning: row.reasoning,
        sources: row.sources,
        assertedConfidence: row.assertedConfidence,
        updatedAt: now,
      })
      .where(eq(reasoningAtoms.id, row.id))
      .returning({ id: reasoningAtoms.id });
    if (updated) restored += 1;
  }
  return restored;
}

/** Restore verified high-water mark from snippet + verified source evidence. */
export async function restoreGroundedReasoningAtoms(
  jurisdictionKey: string,
): Promise<{ restored: number }> {
  const rows = await db
    .select()
    .from(reasoningAtoms)
    .where(eq(reasoningAtoms.jurisdictionKey, jurisdictionKey));

  let restored = 0;
  const now = new Date();
  for (const row of rows) {
    if (row.verificationState === "verified") continue;
    const sources = (row.sources as ReasoningSourceLink[]) ?? [];
    const hasVerifiedSource = sources.some((source) => source.verified);
    const priorGrounded = hasVerifiedSource;
    if (!priorGrounded) continue;

    await db
      .update(reasoningAtoms)
      .set({
        verificationState: "verified",
        updatedAt: now,
      })
      .where(eq(reasoningAtoms.id, row.id));
    restored += 1;
  }
  return { restored };
}
