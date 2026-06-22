/** ICC PoC shell ids — mirrored from OpenAPI `IccFindingShellId`. */
export const ICC_FINDING_SHELL_IDS = ["municipal-ipmc", "architect-ibc"] as const;
export type IccFindingShellId = (typeof ICC_FINDING_SHELL_IDS)[number];

/** Plan-review chrome for ICC PoC shells (titles only — editions live server-side). */
export const ICC_SHELL_CHROME: Record<
  IccFindingShellId,
  { pageTitle: string; pageSubtitle: string }
> = {
  "municipal-ipmc": {
    pageTitle: "Property Maintenance Review",
    pageSubtitle: "IPMC 2018 — municipal compliance checks",
  },
  "architect-ibc": {
    pageTitle: "Building Code Review",
    pageSubtitle: "IBC 2018 — architect compliance checks",
  },
};

export const ICC_SHELL_EDITION_LABEL: Record<IccFindingShellId, string> = {
  "municipal-ipmc": "IPMC 2018",
  "architect-ibc": "IBC 2018",
};
