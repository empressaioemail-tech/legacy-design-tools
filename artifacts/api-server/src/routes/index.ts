import { Router, type IRouter } from "express";
import healthRouter from "./health";
import engagementsRouter from "./engagements";
import matchRouter from "./match";
import snapshotsRouter from "./snapshots";
import sheetsRouter from "./sheets";
import chatRouter from "./chat";
import codesRouter from "./codes";
import substrateRouter from "./substrate";
import devAtomsRouter from "./devAtoms";
import atomsRouter from "./atoms";
import usersRouter from "./users";
import reviewersRouter from "./reviewers";
import settingsRouter from "./settings";
import storageRouter from "./storage";
import sessionRouter from "./session";
import meRouter from "./me";
import parcelBriefingsRouter from "./parcelBriefings";
import briefingSourcesRouter from "./briefingSources";
import bimModelsRouter from "./bimModels";
import generateLayersRouter from "./generateLayers";
import localSetbacksRouter from "./localSetbacks";
import adapterCacheRouter from "./adapterCache";
import reviewerAnnotationsRouter from "./reviewerAnnotations";
import submissionCommentsRouter from "./submissionComments";
import findingsRouter from "./findings";
import findingOutcomesRouter from "./findingOutcomes";
import findingsRunsRouter from "./findingsRuns";
import findingsEvidenceLedgerRouter from "./findingsEvidenceLedger";
import findingsCalibrationOverlayRouter from "./findingsCalibrationOverlay";
import submissionEventsRouter from "./submissionEvents";
import communicationsRouter from "./communications";
import reviewerRequestsRouter from "./reviewerRequests";
import packagesRouter from "./packages";
import canvaRouter from "./canva";
import collateralRouter from "./collateral";
import reviewerQueueRouter from "./submissions";
import decisionsRouter from "./decisions";
import rendersRouter from "./renders";
import renderToolsRouter from "./render-tools";
import notificationsRouter from "./notifications";
import cannedFindingsRouter from "./cannedFindings";
import qaRouter from "./qa";
import responseTasksRouter from "./responseTasks";
import sheetContentRouter from "./sheetContent";
import deliverableLettersRouter from "./deliverableLetters";
import detailCalloutSpecsRouter from "./detailCalloutSpecs";
import productSpecReferencesRouter from "./productSpecReferences";
import deliverableLetterRendersRouter from "./deliverableLetterRenders";
import siteTopographyRouter from "./siteTopography";
import siteDrainageRouter from "./siteDrainage";
import encumbrancesRouter from "./encumbrances";
import workspaceSettingsRouter from "./workspaceSettings";
import coverageRequestsRouter from "./coverageRequests";
import intakeRouter from "./intake";
import brokerageBriefRouter from "./brokerageBrief";
import authRouter from "./auth";
import planReviewBffRouter from "./planReviewBff";
import { internalQaRunStateRouter } from "./operatorRunState";

const router: IRouter = Router();

router.use(healthRouter);
router.use(authRouter);
router.use("/plan-review", planReviewBffRouter);
// Hauska Property Brief Chrome extension — API-key auth + extension CORS.
router.use(brokerageBriefRouter);
// /engagements/match must register BEFORE /engagements/:id otherwise Express
// matches the literal path against the parametric route first.
router.use(matchRouter);
// parcelBriefingsRouter mounts under /engagements/:id/briefing — register
// before engagementsRouter so its more-specific paths match first (mirrors
// the matchRouter ordering note above).
router.use(parcelBriefingsRouter);
// generateLayersRouter mounts under /engagements/:id/generate-layers — a
// distinct path from parcelBriefingsRouter (which owns the /briefing
// subtree) so ordering relative to engagementsRouter is indifferent;
// kept adjacent to its sibling so the briefing-related routes stay
// grouped.
router.use(generateLayersRouter);
// Phase 2D.x PR3 — site-topography refresh + read endpoints mount
// under /engagements/:id/site-topography*. Register BEFORE
// engagementsRouter so the more-specific paths match first (same
// pattern as parcelBriefingsRouter above).
router.use(siteTopographyRouter);
router.use(siteDrainageRouter);
router.use(encumbrancesRouter);
// briefingSourcesRouter exposes top-level `/briefing-sources/:id/glb`
// for the DA-MV-1 viewer; ordering relative to engagementsRouter is
// indifferent (no path overlap) but kept adjacent to its sibling so
// the briefing-related routes stay grouped.
router.use(briefingSourcesRouter);
// bimModelsRouter exposes `/engagements/:id/bim-model` (which would
// otherwise be shadowed by engagementsRouter's `/engagements/:id`
// parametric handler) plus the top-level `/bim-models/:id/*` group
// the C# Revit add-in calls.
router.use(bimModelsRouter);
router.use(coverageRequestsRouter);
router.use(packagesRouter);
router.use(canvaRouter);
router.use(collateralRouter);
// localSetbacksRouter exposes `/local/setbacks/:jurisdictionKey` —
// distinct path subtree from everything else so ordering is
// indifferent.
router.use(localSetbacksRouter);
router.use(engagementsRouter);
router.use(snapshotsRouter);
router.use(sheetsRouter);
router.use(workspaceSettingsRouter);
router.use(intakeRouter);
router.use(chatRouter);
router.use(codesRouter);
// QA-17 — live Hauska substrate catalog at `/substrate/jurisdictions`.
// Distinct path subtree from `/codes/*` (the cortex-prod-local corpus)
// so ordering relative to codesRouter is indifferent.
router.use(substrateRouter);
router.use(devAtomsRouter);
router.use(atomsRouter);
router.use(usersRouter);
router.use(reviewersRouter);
router.use(settingsRouter);
router.use(storageRouter);
router.use(sessionRouter);
// `/me/*` self-edit surface (currently just the architect PDF header).
// Distinct path subtree from `/users/*` (admin CRUD) so ordering is
// indifferent.
router.use(meRouter);
// adapterCacheRouter mounts under `/admin/adapter-cache` — distinct
// path subtree from everything else so ordering is indifferent.
router.use(adapterCacheRouter);
// Wave 2 Sprint C / Spec 307 — reviewer-annotation surface.
// Mounts under /submissions/:submissionId/reviewer-annotations; no
// path overlap with any existing router so ordering is indifferent.
router.use(reviewerAnnotationsRouter);
// Task #431 — reviewer↔architect inline comment thread surface.
// Mounts under /submissions/:submissionId/comments; no path overlap
// with the reviewer-annotations router (its parametric segment is
// always `reviewer-annotations`) so ordering is indifferent.
router.use(submissionCommentsRouter);
// Arrow two Phase 2 — outcome observations. Static `/findings/outcome-observations`
// must register before the parametric findings router.
router.use(findingOutcomesRouter);
// V1-1 / AIR-1 — findings surface. Mounts under
// /submissions/:submissionId/findings* and /findings/:findingId/*;
// no path overlap with reviewer-annotations or any other router so
// ordering is indifferent.
router.use(findingsRouter);
// Task #493 — Compliance Engine console (cross-submission). Mounts
// `/findings/runs` and `/findings/runs/summary`; distinct from the
// per-submission `/submissions/:id/findings/runs` so ordering is
// indifferent.
router.use(findingsRunsRouter);
// Arrow two Phase 1 — tier 1a adjudication-to-atom evidence ledger.
// Internal read-model only; mounts `/findings/adjudication-evidence*`.
router.use(findingsEvidenceLedgerRouter);
// Arrow two Phase 3 — calibration overlay (internal Cortex surface; rail-quiet).
router.use(findingsCalibrationOverlayRouter);
// PLR-9 — per-submission SSE live event channel + presence. Mounts
// `/submissions/:submissionId/events`; distinct path subtree from
// every other router so ordering is indifferent.
router.use(submissionEventsRouter);
// PLR-5 — communications surface (AI comment-letter compose + send).
// Mounts under /submissions/:submissionId/communications; no path
// overlap with the findings or comments routers so ordering is
// indifferent.
router.use(communicationsRouter);
// Wave 2 Sprint D / V1-2 — reviewer-request surface. Mounts under
// /engagements/:id/reviewer-requests + /reviewer-requests/:id/dismiss.
// engagementsRouter's `/engagements/:id` handler is a leaf and does
// not match the longer `/engagements/:id/reviewer-requests` path,
// so mount ordering relative to engagementsRouter is indifferent.
router.use(reviewerRequestsRouter);
// Cross-engagement reviewer Inbox feed at /reviewer/queue.
router.use(reviewerQueueRouter);
// PLR-6 / Task #460 — reviewer Decide surface. Mounts under
// /submissions/:submissionId/decisions; distinct from the reviewer-
// annotations / submission-comments routers (their parametric
// segment is always literal `reviewer-annotations` / `comments`)
// so ordering is indifferent.
router.use(decisionsRouter);
// V1-4 / DA-RP-1 — mnml.ai renders. Mounts under
// /engagements/:id/renders (kickoff + list) and top-level /renders/:id
// (status + cancel). The /engagements/:id/renders path is more
// specific than engagementsRouter's /engagements/:id parametric
// handler, so this register must come before engagementsRouter — but
// engagementsRouter is already registered above the bottom-of-file
// ordering-indifferent group (line 55), so we land here matching the
// briefing-router precedent (line 34 ordering note).
router.use(rendersRouter);
// doc 40e A.2 — five mnml power-tool routes under
// /render-outputs/:parentId/{enhance,upscale,erase,inpaint,style-transfer}.
// Distinct from rendersRouter's /render-outputs/:id/file leaf.
router.use(renderToolsRouter);
// Architect inbox/notification surface. Mounts under
// `/me/notifications*`; a distinct path subtree from `meRouter`
// (`/me/architect-pdf-header`, `/me/profile`) so ordering relative
// to it is indifferent.
router.use(notificationsRouter);
// PLR-10 — tenant-scoped canned-finding library. Mounts under
// `/tenants/:tenantId/canned-findings*`; distinct path subtree from
// every other router so ordering is indifferent.
router.use(cannedFindingsRouter);
router.use(qaRouter);
// Command-center Run Monitor — the console's second run-state probe at
// `/internal/qa/run-state`. Distinct path subtree from qaRouter's `/qa/*`, so
// ordering is indifferent. Carries its own Bearer service-token gate (the
// top-level `/api` router has no auth in front of it), so it is never
// anonymous — see routes/operatorRunState.ts.
router.use(internalQaRunStateRouter);
// Cortex L1 (Lane C.4 / C.4.1) — response-task surface. Mounts
// `/engagements/:engagementId/response-tasks` (create + list) and
// `/response-tasks/:responseTaskId/*` (state + link-finding).
// engagementsRouter's `/engagements/:id` handler is a leaf and does
// not match the longer `/engagements/:id/response-tasks` path, so
// mount ordering relative to engagementsRouter is indifferent.
router.use(responseTasksRouter);
// Cortex L2 (Lane C.4 / C.4.2) — sheet-content-extraction +
// attached-document surface. Mounts `/sheets/:id/content-extraction`,
// `/engagements/:id/attached-documents`, and `/attached-documents/:id`.
// None overlap an existing leaf route (the parametric segments differ
// in depth), so mount ordering is indifferent.
router.use(sheetContentRouter);
// Cortex L3 (Lane C.4 / C.4.3) — deliverable-letter surface. Mounts
// `/engagements/:id/deliverable-letters` and `/deliverable-letters/:id*`.
// No overlap with an existing leaf route, so ordering is indifferent.
router.use(deliverableLettersRouter);
// Cortex L4 (Lane C.4 / C.4.4) — detail-callout-spec surface. Mounts
// `/engagements/:id/detail-callout-specs` and
// `/detail-callout-specs/:id*`. No overlap with an existing leaf route,
// so ordering is indifferent.
router.use(detailCalloutSpecsRouter);
// Cortex L5 (Lane C.4 / C.4.5) — product-spec-reference surface.
// Mounts `/engagements/:id/product-spec-references` and
// `/product-spec-references/:id*`. No overlap with an existing leaf
// route, so ordering is indifferent.
router.use(productSpecReferencesRouter);
// Cortex L6 (Lane C.4 / C.4.6) — deliverable-letter-render surface.
// Mounts `/deliverable-letters/:id/renders` and
// `/deliverable-letter-renders/:id/file`. The `/renders` path is
// distinct from L3's `/deliverable-letters/:id/{sections,send,...}`
// leaves, so ordering relative to deliverableLettersRouter is
// indifferent.
router.use(deliverableLetterRendersRouter);

export default router;
