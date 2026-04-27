import { Router, type IRouter } from "express";
import healthRouter from "./health";
import snapshotsRouter from "./snapshots";
import chatRouter from "./chat";

const router: IRouter = Router();

router.use(healthRouter);
router.use(snapshotsRouter);
router.use(chatRouter);

export default router;
