import { Router, type IRouter } from "express";
import healthRouter from "./health";
import engagementsRouter from "./engagements";
import snapshotsRouter from "./snapshots";
import chatRouter from "./chat";

const router: IRouter = Router();

router.use(healthRouter);
router.use(engagementsRouter);
router.use(snapshotsRouter);
router.use(chatRouter);

export default router;
