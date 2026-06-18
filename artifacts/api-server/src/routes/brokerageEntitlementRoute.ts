/**
 * Install entitlement snapshot — free brief cap + Pro subscription state.
 * Extension_public may call (no dev-client gate).
 */

import { Router, type IRouter, type Request, type Response } from "express";
import { brokerageCors } from "../middlewares/brokerageCors";
import { brokerageAuth } from "../middlewares/brokerageAuth";
import { requireInstallId } from "../lib/brokerageInstallId";
import {
  clientEntitlementFromSnapshot,
  getEntitlementSnapshot,
} from "../lib/brokerageWallet";

export const brokerageEntitlementRouter: IRouter = Router();

brokerageEntitlementRouter.use(brokerageCors);
brokerageEntitlementRouter.use(brokerageAuth);

brokerageEntitlementRouter.get("/", async (req: Request, res: Response) => {
  const installId = requireInstallId(req, res);
  if (!installId) return;

  const ent = await getEntitlementSnapshot(installId);
  res.json({
    ...clientEntitlementFromSnapshot(ent),
    freeBriefsUsed: ent.freeBriefsUsed,
    balanceCents: ent.balanceCents,
    paidActive: ent.paidActive,
  });
});
