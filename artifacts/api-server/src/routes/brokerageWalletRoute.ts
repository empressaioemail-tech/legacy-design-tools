/**
 * Brokerage wallet — balance, $5 top-up, auto-refill settings.
 */

import { Router, type IRouter, type Request, type Response } from "express";
import { z } from "zod";
import { brokerageCors } from "../middlewares/brokerageCors";
import { brokerageAuth } from "../middlewares/brokerageAuth";
import { requireInstallId } from "../lib/brokerageInstallId";
import {
  BROKERAGE_TOP_UP_INCREMENT_CENTS,
  getWalletSnapshot,
  setWalletAutoRefill,
  topUpWallet,
} from "../lib/brokerageWallet";

const TOP_UP_BODY = z.object({
  amountCents: z
    .number()
    .int()
    .positive()
    .optional()
    .default(BROKERAGE_TOP_UP_INCREMENT_CENTS),
});

const SETTINGS_BODY = z.object({
  autoRefillEnabled: z.boolean(),
});

export const brokerageWalletRouter: IRouter = Router();

brokerageWalletRouter.use(brokerageCors);
brokerageWalletRouter.use(brokerageAuth);

brokerageWalletRouter.get("/", async (req: Request, res: Response) => {
  const installId = requireInstallId(req, res);
  if (!installId) return;

  const wallet = await getWalletSnapshot(installId);
  res.json({
    ...wallet,
    topUpIncrementCents: BROKERAGE_TOP_UP_INCREMENT_CENTS,
  });
});

brokerageWalletRouter.post("/top-up", async (req: Request, res: Response) => {
  const installId = requireInstallId(req, res);
  if (!installId) return;

  const parse = TOP_UP_BODY.safeParse(req.body ?? {});
  if (!parse.success) {
    res.status(400).json({ error: "invalid_request" });
    return;
  }

  const amountCents = parse.data.amountCents;
  if (amountCents % BROKERAGE_TOP_UP_INCREMENT_CENTS !== 0) {
    res.status(400).json({
      error: "invalid_amount",
      message: `Top-up must be a multiple of $${BROKERAGE_TOP_UP_INCREMENT_CENTS / 100}`,
    });
    return;
  }

  try {
    const wallet = await topUpWallet(installId, amountCents, "top_up");
    res.json({ ok: true, wallet, topUpIncrementCents: BROKERAGE_TOP_UP_INCREMENT_CENTS });
  } catch (err) {
    res.status(400).json({
      error: "top_up_failed",
      message: String((err as Error).message || err),
    });
  }
});

brokerageWalletRouter.post(
  "/settings",
  async (req: Request, res: Response) => {
    const installId = requireInstallId(req, res);
    if (!installId) return;

    const parse = SETTINGS_BODY.safeParse(req.body);
    if (!parse.success) {
      res.status(400).json({ error: "invalid_request" });
      return;
    }

    const wallet = await setWalletAutoRefill(
      installId,
      parse.data.autoRefillEnabled,
    );
    res.json({ ok: true, wallet });
  },
);
