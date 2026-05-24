export type PresentationFlowStepId =
  | "assemble"
  | "preview"
  | "generate"
  | "review";

export interface PresentationFlowStep {
  id: PresentationFlowStepId;
  label: string;
  summary: string;
  testId: string;
}

export const PRESENTATION_FLOW_STEPS: ReadonlyArray<PresentationFlowStep> = [
  {
    id: "assemble",
    label: "Choose pages",
    summary:
      "Pick page types from the client template — moodboards, plans, FF&E, and more.",
    testId: "presentation-flow-assemble",
  },
  {
    id: "preview",
    label: "Preview deck",
    summary:
      "Scroll the deck, moodboards, or plan spreads before exporting.",
    testId: "presentation-flow-preview",
  },
  {
    id: "generate",
    label: "Export",
    summary:
      "Produce a branded PDF (and later a Canva edit link) for the client.",
    testId: "presentation-flow-generate",
  },
  {
    id: "review",
    label: "Versions & share",
    summary:
      "Compare drafts, download PDFs, and share when the presentation is ready.",
    testId: "presentation-flow-review",
  },
];

export { PRESENTATION_PAGE_SOURCE_TAB as SECTION_SOURCE_TAB } from "./presentationTemplate";

export function canEnterPresentationStep(
  step: PresentationFlowStepId,
  ctx: {
    selectedCount: number;
    versionCount: number;
    generating: boolean;
  },
): boolean {
  switch (step) {
    case "assemble":
      return true;
    case "preview":
      return ctx.selectedCount > 0;
    case "generate":
      return ctx.selectedCount > 0 && !ctx.generating;
    case "review":
      return ctx.versionCount > 0;
    default:
      return false;
  }
}

export function isPresentationStepComplete(
  step: PresentationFlowStepId,
  ctx: {
    selectedCount: number;
    versionCount: number;
    hasDraft: boolean;
  },
): boolean {
  switch (step) {
    case "assemble":
      return ctx.selectedCount > 0;
    case "preview":
      return ctx.selectedCount > 0;
    case "generate":
      return ctx.versionCount > 0;
    case "review":
      return ctx.hasDraft;
    default:
      return false;
  }
}
