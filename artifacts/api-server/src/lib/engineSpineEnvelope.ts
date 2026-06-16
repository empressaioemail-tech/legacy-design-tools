/**
 * Spine response envelope parsing — delegates to @workspace/engine-core.
 */

import type { EngineHonesty } from "@workspace/engine-core";
import { unwrapEngineEnvelope } from "@workspace/engine-core";

export type SpineRoutedResult<TPayload> = {
  payload: TPayload;
  honesty: EngineHonesty;
};

export function unwrapSpineResponse<TPayload>(
  raw: unknown,
  args?: {
    legacyProducer?: string;
    legacyConfidence?: number;
    fallbackSource?: string;
  },
): SpineRoutedResult<TPayload> {
  return unwrapEngineEnvelope<TPayload>(raw, {
    fallbackSourceAdapter: args?.fallbackSource ?? "engine-api",
    legacyProducer: args?.legacyProducer,
    legacyConfidence: args?.legacyConfidence,
  });
}
