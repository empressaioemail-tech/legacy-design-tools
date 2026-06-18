/**
 * Stripe billing routes — Pro checkout, portal, webhook (consumer subscription).
 *
 *   POST /api/brokerage/v1/billing/checkout
 *   POST /api/brokerage/v1/billing/portal
 *   POST /api/brokerage/v1/billing/checkout/complete-simulated (keyless only)
 *   POST /api/brokerage/v1/billing/stripe/webhook (raw body; mounted in app.ts)
 */

import { Router, type IRouter, type Request, type Response } from "express";
import { z } from "zod";
import { brokerageCors } from "../middlewares/brokerageCors";
import { brokerageAuth } from "../middlewares/brokerageAuth";
import { requireInstallId } from "../lib/brokerageInstallId";
import {
  completeSimulatedCheckout,
  createBillingPortalSession,
  createSubscriptionCheckoutSession,
  handleStripeWebhook,
  isStripeConfigured,
  type SubscriptionCheckoutTier,
} from "../lib/brokerageStripe";
import { recordGtmEvent } from "../lib/recordGtmEvent";
import { syncPipedriveDeal } from "../lib/brokeragePipedrive";

const CHECKOUT_BODY = z.object({
  successUrl: z.string().url(),
  cancelUrl: z.string().url(),
  tier: z.enum(["pro", "max"]).optional().default("pro"),
});

const PORTAL_BODY = z.object({
  returnUrl: z.string().url(),
});

const SIMULATED_COMPLETE_BODY = z.object({
  sessionId: z.string().min(1).optional(),
  tier: z.enum(["pro", "max"]).optional().default("pro"),
});

export const brokerageBillingRouter: IRouter = Router();

brokerageBillingRouter.use(brokerageCors);
brokerageBillingRouter.use(brokerageAuth);

brokerageBillingRouter.post("/checkout", async (req: Request, res: Response) => {
  const installId = requireInstallId(req, res);
  if (!installId) return;

  const parse = CHECKOUT_BODY.safeParse(req.body ?? {});
  if (!parse.success) {
    res.status(400).json({
      error: "invalid_request",
      message: "successUrl and cancelUrl (absolute URLs) are required",
    });
    return;
  }

  const tier: SubscriptionCheckoutTier = parse.data.tier;

  recordGtmEvent({
    installId,
    eventType: "upgrade_started",
    sourceSurface: "api",
    payload: { rail: "stripe", tier },
  });

  void syncPipedriveDeal({
    installId,
    title: `Hauska ${tier === "max" ? "Max" : "Pro"} upgrade — ${installId.slice(0, 8)}`,
  });

  try {
    const session = await createSubscriptionCheckoutSession({
      installId,
      tier,
      successUrl: parse.data.successUrl,
      cancelUrl: parse.data.cancelUrl,
    });
    res.json(session);
  } catch (err) {
    res.status(502).json({
      error: "checkout_failed",
      message: String((err as Error).message || err),
    });
  }
});

brokerageBillingRouter.post("/portal", async (req: Request, res: Response) => {
  const installId = requireInstallId(req, res);
  if (!installId) return;

  const parse = PORTAL_BODY.safeParse(req.body ?? {});
  if (!parse.success) {
    res.status(400).json({
      error: "invalid_request",
      message: "returnUrl (absolute URL) is required",
    });
    return;
  }

  try {
    const portal = await createBillingPortalSession({
      installId,
      returnUrl: parse.data.returnUrl,
    });
    res.json(portal);
  } catch (err) {
    const message = String((err as Error).message || err);
    if (message.includes("No such customer")) {
      res.status(404).json({
        error: "no_billing_customer",
        message: "No Stripe customer for this install — complete checkout first",
      });
      return;
    }
    res.status(502).json({
      error: "portal_failed",
      message,
    });
  }
});

/** Keyless smoke/demo — activates Pro when Stripe secrets are absent. */
brokerageBillingRouter.post(
  "/checkout/complete-simulated",
  async (req: Request, res: Response) => {
    if (isStripeConfigured()) {
      res.status(404).json({ error: "not_available" });
      return;
    }

    const installId = requireInstallId(req, res);
    if (!installId) return;

    const parse = SIMULATED_COMPLETE_BODY.safeParse(req.body ?? {});
    if (!parse.success) {
      res.status(400).json({ error: "invalid_request" });
      return;
    }

    await completeSimulatedCheckout({
      installId,
      sessionId: parse.data.sessionId,
      tier: parse.data.tier,
    });

    recordGtmEvent({
      installId,
      eventType: "subscription_active",
      sourceSurface: "api",
      payload: { rail: "stripe_simulated", tier: parse.data.tier },
    });

    res.json({
      ok: true,
      proActive: parse.data.tier === "pro",
      maxActive: parse.data.tier === "max",
      subscriptionTier: parse.data.tier,
    });
  },
);

export async function stripeWebhookHandler(
  req: Request,
  res: Response,
): Promise<void> {
  const raw =
    req.body instanceof Buffer
      ? req.body
      : Buffer.from(
          typeof req.body === "string" ? req.body : JSON.stringify(req.body ?? {}),
        );

  const result = await handleStripeWebhook(
    raw,
    req.headers["stripe-signature"] as string | undefined,
  );

  if (!result.handled) {
    res.status(400).json({ error: "webhook_not_handled", reason: result.reason });
    return;
  }

  if (result.installId) {
    recordGtmEvent({
      installId: result.installId,
      eventType: result.eventType,
      sourceSurface: "stripe_webhook",
      payload: { rail: "stripe" },
    });
  }

  res.json({ received: true, eventType: result.eventType });
}
