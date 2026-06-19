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
  resolveEntitlementSnapshot,
} from "../lib/brokerageWallet";

export const brokerageEntitlementRouter: IRouter = Router();

brokerageEntitlementRouter.use(brokerageCors);
brokerageEntitlementRouter.use(brokerageAuth);

brokerageEntitlementRouter.get("/", async (req: Request, res: Response) => {
  const ent = await resolveEntitlementSnapshot(req);
  if (!ent) {
    requireInstallId(req, res);
    return;
  }

  res.json({
    ...clientEntitlementFromSnapshot(ent),
    freeBriefsUsed: ent.freeBriefsUsed,
    balanceCents: ent.balanceCents,
    paidActive: ent.paidActive,
  });
});
