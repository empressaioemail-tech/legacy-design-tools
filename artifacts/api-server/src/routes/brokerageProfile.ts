/**
 * Tenant-private investor buy-box profile (Wave 2 teacher).
 *
 *   GET  /api/brokerage/v1/profile
 *   PATCH /api/brokerage/v1/profile
 *   POST /api/brokerage/v1/profile/verdict-action
 */

import { Router, type IRouter, type Request, type Response } from "express";
import { z } from "zod";
import { installIdFromRequest } from "../lib/brokerageInstallId";
import {
  patchBuyBoxProfile,
  readBuyBoxProfile,
  recordVerdictAction,
  resolveProfileOwnerId,
} from "../lib/brokerageBuyBoxTeacher";

export const brokerageProfileRouter: IRouter = Router();

const BUY_BOX_PATCH = z
  .object({
    capRateFloor: z.number().min(0).max(1).optional(),
    rehabPerSf: z.number().min(0).optional(),
    rentSpreadTolerance: z.number().min(0).max(1).optional(),
  })
  .strict();

const PROFILE_PATCH = z
  .object({
    buyBox: BUY_BOX_PATCH.optional(),
  })
  .strict();

const VERDICT_ACTION_BODY = z
  .object({
    action: z.enum(["keep", "pass"]),
    parcel_id: z.string().min(1).optional(),
    workspace_id: z.string().min(1).optional(),
    address: z.string().min(1).optional(),
  })
  .strict();

brokerageProfileRouter.get("/", async (req: Request, res: Response) => {
  const ownerUserId = await resolveProfileOwnerId(req);
  if (!ownerUserId) {
    res.status(401).json({
      error: "profile_owner_required",
      message:
        "Sign in or send X-Hauska-Install-Id to access your private buy-box profile.",
    });
    return;
  }

  const profile = await readBuyBoxProfile(ownerUserId);
  res.json(profile);
});

brokerageProfileRouter.patch("/", async (req: Request, res: Response) => {
  const parsed = PROFILE_PATCH.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_request", details: parsed.error.flatten() });
    return;
  }

  const ownerUserId = await resolveProfileOwnerId(req);
  if (!ownerUserId) {
    res.status(401).json({ error: "profile_owner_required" });
    return;
  }

  if (parsed.data.buyBox) {
    await patchBuyBoxProfile(ownerUserId, parsed.data.buyBox);
  }

  const profile = await readBuyBoxProfile(ownerUserId);
  res.json(profile);
});

brokerageProfileRouter.post(
  "/verdict-action",
  async (req: Request, res: Response) => {
    const parsed = VERDICT_ACTION_BODY.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_request", details: parsed.error.flatten() });
      return;
    }

    const ownerUserId = await resolveProfileOwnerId(req);
    if (!ownerUserId) {
      res.status(401).json({ error: "profile_owner_required" });
      return;
    }

    const installId = installIdFromRequest(req);
    const stats = await recordVerdictAction({
      ownerUserId,
      installId,
      action: parsed.data.action,
      parcelId: parsed.data.parcel_id,
      workspaceId: parsed.data.workspace_id,
      address: parsed.data.address,
    });

    res.json({
      ok: true,
      kept: stats.kept,
      passed: stats.passed,
    });
  },
);
