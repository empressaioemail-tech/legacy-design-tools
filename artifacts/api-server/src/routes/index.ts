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
import parcelBriefingsRouter from "./parcelBriefings";
import briefingSourcesRouter from "./briefingSources";

const router: IRouter = Router();

router.use(healthRouter);
// /engagements/match must register BEFORE /engagements/:id otherwise Express
// matches the literal path against the parametric route first.
router.use(matchRouter);
// parcelBriefingsRouter mounts under /engagements/:id/briefing — register
// before engagementsRouter so its more-specific paths match first (mirrors
// the matchRouter ordering note above).
router.use(parcelBriefingsRouter);
// briefingSourcesRouter exposes top-level `/briefing-sources/:id/glb`
// for the DA-MV-1 viewer; ordering relative to engagementsRouter is
// indifferent (no path overlap) but kept adjacent to its sibling so
// the briefing-related routes stay grouped.
router.use(briefingSourcesRouter);
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

export default router;
