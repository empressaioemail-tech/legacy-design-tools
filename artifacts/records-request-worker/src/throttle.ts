/**
 * Minimum delay between portal navigations and search actions.
 */

export interface PortalActionThrottle {
  beforeAction(): Promise<void>;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function parseThrottleMsFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = env.RECORDS_REQUEST_THROTTLE_MS?.trim();
  if (!raw) return 2000;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 2000;
}

export function createPortalActionThrottle(options?: {
  minDelayMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}): PortalActionThrottle {
  const minDelayMs = options?.minDelayMs ?? parseThrottleMsFromEnv();
  const now = options?.now ?? (() => Date.now());
  const sleep = options?.sleep ?? defaultSleep;
  let lastActionAt: number | null = null;

  return {
    async beforeAction(): Promise<void> {
      const current = now();
      if (lastActionAt !== null) {
        const elapsed = current - lastActionAt;
        if (elapsed < minDelayMs) {
          await sleep(minDelayMs - elapsed);
        }
      }
      lastActionAt = now();
    },
  };
}
