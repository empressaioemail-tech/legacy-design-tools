/**
 * Lifecycle stage rules, moved intact from the retired GoHighLevel leg
 * (`peGhlLifecycle.ts` nextStage, `peLifecycleTypes.ts` highestStage and
 * stageForPlan) to the contact record's own home (P-492).
 *
 * Stages only move forward from the app. A person can skip stages (a plan
 * with no share); the highest reached is kept. A downgrade or cancel changes
 * plan and billing, never the stage.
 */

export const STAGES = [
  "Explorer",
  "Sharer",
  "Unlock",
  "Solo",
  "Studio",
  "Team",
] as const;

export type LifecycleStage = (typeof STAGES)[number];

type StagePlan = "free" | "unlock" | "solo" | "studio" | "team";

export function stageIndex(stage: LifecycleStage): number {
  return STAGES.indexOf(stage);
}

/**
 * Stages move forward only. A skip (Explorer → Solo with no share) is the
 * highest reached, not a walk through the ones in between.
 */
export function highestStage(
  current: LifecycleStage | null,
  next: LifecycleStage,
): LifecycleStage {
  if (!current) return next;
  return stageIndex(next) > stageIndex(current) ? next : current;
}

export function stageForPlan(plan: StagePlan): LifecycleStage | null {
  switch (plan) {
    case "unlock":
      return "Unlock";
    case "solo":
      return "Solo";
    case "studio":
      return "Studio";
    case "team":
      return "Team";
    case "free":
      return null;
  }
}

export type StageInput = {
  event: string;
  currentStage?: LifecycleStage | null;
  plan?: StagePlan;
};

/**
 * The stage after an event. Events that carry no stage meaning keep the
 * current one (Explorer for a contact the record has never seen).
 */
export function nextStage(input: StageInput): LifecycleStage {
  const current = input.currentStage ?? null;
  switch (input.event) {
    case "e1_account_created":
      return highestStage(current, "Explorer");
    case "e3_share_sent":
    case "became_sharer":
      return highestStage(current, "Sharer");
    case "e4_unlock_bought":
      return highestStage(current, "Unlock");
    case "e5_plan_started": {
      const planStage = input.plan ? stageForPlan(input.plan) : null;
      return planStage
        ? highestStage(current, planStage)
        : (current ?? "Explorer");
    }
    default:
      return current ?? "Explorer";
  }
}
