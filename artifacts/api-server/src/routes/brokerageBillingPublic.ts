/**
 * Public Stripe checkout return pages — no API key required.
 */

import { Router, type IRouter, type Request, type Response } from "express";
import { brokerageCors } from "../middlewares/brokerageCors";
import { renderBillingLandingHtml } from "../lib/brokerageBillingLandingHtml";

export const brokerageBillingPublicRouter: IRouter = Router();

brokerageBillingPublicRouter.use(brokerageCors);

brokerageBillingPublicRouter.get(
  "/checkout-complete",
  (_req: Request, res: Response) => {
    res.type("html").send(renderBillingLandingHtml("complete"));
  },
);

brokerageBillingPublicRouter.get(
  "/checkout-cancel",
  (_req: Request, res: Response) => {
    res.type("html").send(renderBillingLandingHtml("cancel"));
  },
);
