/**
 * ICC PoC — thin finding-generation shells over `@workspace/finding-engine`.
 *
 * Municipal (IPMC) and architect (IBC) contexts differ only in which ICC
 * titles they pass and their chrome; retrieval always targets the
 * `icc-model-code` tenant via the gate with `platform-internal` access.
 */

import {
  parseApplicableIccEditions,
  type ApplicableIccEdition,
} from "@workspace/finding-engine";

/** Substrate jurisdiction tenant for cc-agent-E's icc-model-code fixtures. */
export const ICC_MODEL_CODE_JURISDICTION = "icc-model-code";

export const ICC_FINDING_SHELL_IDS = ["municipal-ipmc", "architect-ibc"] as const;
export type IccFindingShellId = (typeof ICC_FINDING_SHELL_IDS)[number];

export interface IccFindingShellConfig {
  id: IccFindingShellId;
  /** Product/surface key recorded on gate usage (content_usage / pay_per_query). */
  surfaceKey: string;
  pageTitle: string;
  pageSubtitle: string;
  applicableCodeBooks: readonly [string];
}

export const ICC_FINDING_SHELLS: Record<IccFindingShellId, IccFindingShellConfig> =
  {
    "municipal-ipmc": {
      id: "municipal-ipmc",
      surfaceKey: "plan-review-ipmc",
      pageTitle: "Property Maintenance Review",
      pageSubtitle: "IPMC 2018 — municipal compliance checks",
      applicableCodeBooks: ["IPMC 2018"],
    },
    "architect-ibc": {
      id: "architect-ibc",
      surfaceKey: "plan-review-ibc",
      pageTitle: "Building Code Review",
      pageSubtitle: "IBC 2018 — architect compliance checks",
      applicableCodeBooks: ["IBC 2018"],
    },
  };

export function isIccFindingShellId(
  value: string | undefined | null,
): value is IccFindingShellId {
  return (
    value != null &&
    (ICC_FINDING_SHELL_IDS as readonly string[]).includes(value)
  );
}

export function resolveIccFindingShell(
  shellId: IccFindingShellId,
): IccFindingShellConfig & { applicableIccEditions: ApplicableIccEdition[] } {
  const shell = ICC_FINDING_SHELLS[shellId];
  return {
    ...shell,
    applicableIccEditions: parseApplicableIccEditions(shell.applicableCodeBooks),
  };
}
