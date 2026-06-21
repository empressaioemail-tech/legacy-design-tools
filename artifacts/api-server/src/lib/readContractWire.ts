/**
 * F4 — read-contract wire helpers for cortex-api responses.
 */

import type { ReadContract } from "@hauska/atom-contract/read-contract";
import { READ_CONTRACT_SCHEMA } from "@hauska/atom-contract/read-contract";
import type { EngineHonesty } from "@workspace/engine-core";
import {
  legacyHonestyToReadContract,
  readContractForWire,
  readContractToEngineHonesty,
} from "@workspace/engine-core";

export type { ReadContract };

export function wireReadContract(raw: unknown): ReadContract | null {
  const parsed = READ_CONTRACT_SCHEMA.safeParse(raw);
  if (!parsed.success) return null;
  return readContractForWire(parsed.data as ReadContract);
}

export function readContractFromEngineHonesty(
  honesty: EngineHonesty | null | undefined,
  args?: { n?: number; assembledAt?: string },
): ReadContract | null {
  if (!honesty) return null;
  return readContractForWire(legacyHonestyToReadContract(honesty, args));
}

/** Transitional: derive EngineHonesty slice from read-contract for legacy UI. */
export function engineHonestyFromReadContract(
  contract: ReadContract | null | undefined,
): EngineHonesty | null {
  if (!contract) return null;
  return readContractToEngineHonesty(contract);
}
