import { Router, type IRouter } from "express";
import healthRouter from "./health";
import engagementsRouter from "./engagements";
import matchRouter from "./match";
import snapshotsRouter from "./snapshots";
import sheetsRouter from "./sheets";
import chatRouter from "./chat";
import codesRouter from "./codes";
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
import findingsRouter from "./findings";
import reviewerRequestsRouter from "./reviewerRequests";
import rendersRouter from "./renders";

const router: IRouter = Router();

router.use(healthRouter);
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
// localSetbacksRouter exposes `/local/setbacks/:jurisdictionKey` —
// distinct path subtree from everything else so ordering is
// indifferent.
router.use(localSetbacksRouter);
router.use(engagementsRouter);
router.use(snapshotsRouter);
router.use(sheetsRouter);
router.use(chatRouter);
router.use(codesRouter);
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
// V1-1 / AIR-1 — findings surface. Mounts under
// /submissions/:submissionId/findings* and /findings/:findingId/*;
// no path overlap with reviewer-annotations or any other router so
// ordering is indifferent.
router.use(findingsRouter);
// Wave 2 Sprint D / V1-2 — reviewer-request surface. Mounts under
// /engagements/:id/reviewer-requests + /reviewer-requests/:id/dismiss.
// engagementsRouter's `/engagements/:id` handler is a leaf and does
// not match the longer `/engagements/:id/reviewer-requests` path,
// so mount ordering relative to engagementsRouter is indifferent.
router.use(reviewerRequestsRouter);
// V1-4 / DA-RP-1 — mnml.ai renders. Mounts under
// /engagements/:id/renders (kickoff + list) and top-level /renders/:id
// (status + cancel). The /engagements/:id/renders path is more
// specific than engagementsRouter's /engagements/:id parametric
// handler, so this register must come before engagementsRouter — but
// engagementsRouter is already registered above the bottom-of-file
// ordering-indifferent group (line 55), so we land here matching the
// briefing-router precedent (line 34 ordering note).
router.use(rendersRouter);

export default router;
