/**
 * Per-engine feature flags for reversible cortex → spine engine-api cutover (C1).
 *
 * Each flag defaults off (`0`). Set to `1` or `true` to route that engine
 * through spine engine-api instead of the local lib/*-engine workspace package.
 */

function flagOn(name: string): boolean {
  const raw = process.env[name];
  if (!raw) return false;
  const v = raw.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

export const ENGINE_SPINE_FLAGS = {
  briefing: "ENGINE_SPINE_BRIEFING",
  findings: "ENGINE_SPINE_FINDINGS",
  findingsOrchestrated: "ENGINE_SPINE_FINDINGS_ORCHESTRATED",
  hydrology: "ENGINE_SPINE_HYDROLOGY",
  topography: "ENGINE_SPINE_TOPOGRAPHY",
} as const;

export function useSpineBriefing(): boolean {
  return flagOn(ENGINE_SPINE_FLAGS.briefing);
}

export function useSpineFindings(): boolean {
  return flagOn(ENGINE_SPINE_FLAGS.findings);
}

export function useSpineFindingsOrchestrated(): boolean {
  return flagOn(ENGINE_SPINE_FLAGS.findingsOrchestrated);
}

export function useSpineHydrology(): boolean {
  return flagOn(ENGINE_SPINE_FLAGS.hydrology);
}

export function useSpineTopography(): boolean {
  return flagOn(ENGINE_SPINE_FLAGS.topography);
}

/** Snapshot for health / operator QA endpoints. */
export function engineSpineFlagSnapshot(): Record<string, boolean> {
  return {
    [ENGINE_SPINE_FLAGS.briefing]: useSpineBriefing(),
    [ENGINE_SPINE_FLAGS.findings]: useSpineFindings(),
    [ENGINE_SPINE_FLAGS.findingsOrchestrated]: useSpineFindingsOrchestrated(),
    [ENGINE_SPINE_FLAGS.hydrology]: useSpineHydrology(),
    [ENGINE_SPINE_FLAGS.topography]: useSpineTopography(),
  };
}
