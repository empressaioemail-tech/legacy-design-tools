import { Router, type IRouter } from "express";
import healthRouter from "./health";
import engagementsRouter from "./engagements";
import snapshotsRouter from "./snapshots";
import sheetsRouter from "./sheets";
import chatRouter from "./chat";

const router: IRouter = Router();

router.use(healthRouter);
router.use(engagementsRouter);
router.use(snapshotsRouter);
router.use(sheetsRouter);
router.use(chatRouter);

export default router;
