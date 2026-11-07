/**
 * Property Explorer billing seam — service-token + install-id path (WDLL 26).
 *
 *   POST /api/brokerage/v1/property-explorer/billing/checkout
 */

import { Router, type IRouter, type Request, type Response } from "express";
import { z } from "zod";
import { brokerageCors } from "../middlewares/brokerageCors";
import { requireBrokerageAuthOrServiceToken } from "../middlewares/brokerageServiceAuth";
import { requireInstallId } from "../lib/brokerageInstallId";
import {
  BrokerageCheckoutConfigError,
  createSubscriptionCheckoutSession,
  isStripeConfigured,
  type SubscriptionCheckoutTier,
} from "../lib/brokerageStripe";
import { recordGtmEvent } from "../lib/recordGtmEvent";
import { syncPipedriveDeal } from "../lib/brokeragePipedrive";
import {
  BillingPublicBaseUrlUnsetError,
  defaultCheckoutCancelUrl,
  defaultCheckoutSuccessUrl,
} from "../lib/brokerageBillingUrls";

const CHECKOUT_BODY = z.object({
  successUrl: z.string().url().optional(),
  cancelUrl: z.string().url().optional(),
  tier: z.enum(["pro", "max"]).optional().default("pro"),
  parcelNodeId: z.string().max(128).optional(),
});

export const propertyExplorerBillingRouter: IRouter = Router();

propertyExplorerBillingRouter.use(brokerageCors);
propertyExplorerBillingRouter.use(requireBrokerageAuthOrServiceToken);

propertyExplorerBillingRouter.post("/checkout", async (req: Request, res: Response) => {
  const installId = requireInstallId(req, res);
  if (!installId) return;

  const parse = CHECKOUT_BODY.safeParse(req.body ?? {});
  if (!parse.success) {
    res.status(400).json({
      error: "invalid_request",
      message: "Invalid checkout body",
    });
    return;
  }

  const tier: SubscriptionCheckoutTier = parse.data.tier;
  let successUrl: string;
  let cancelUrl: string;
  try {
    successUrl = parse.data.successUrl ?? defaultCheckoutSuccessUrl();
    cancelUrl = parse.data.cancelUrl ?? defaultCheckoutCancelUrl();
  } catch (err) {
    if (err instanceof BillingPublicBaseUrlUnsetError) {
      // FAIL CLOSED, declared, and NAMED (D-25): no public origin is configured
      // for the return pages, so there is no checkout to create. Refusing here
      // is the point -- the alternative is a return URL on a dead host, which
      // fails after the customer has paid. Raised before the GTM event and the
      // Pipedrive sync so neither records an attempt that never happened.
      res.status(503).json({
        error: err.refusal,
        message: err.message,
      });
      return;
    }
    throw err;
  }

  recordGtmEvent({
    installId,
    eventType: "pe_upgrade_started",
    sourceSurface: "property-explorer",
    payload: {
      rail: isStripeConfigured() ? "stripe" : "stripe_simulated",
      tier,
      parcelNodeId: parse.data.parcelNodeId ?? null,
    },
  });

  void syncPipedriveDeal({
    installId,
    title: `Property Explorer ${tier === "max" ? "Max" : "Pro"} checkout — ${installId.slice(0, 8)}`,
  });

  try {
    const session = await createSubscriptionCheckoutSession({
      installId,
      tier,
      successUrl,
      cancelUrl,
    });
    res.json({
      ...session,
      stripeConfigured: isStripeConfigured(),
      honestNote: isStripeConfigured()
        ? undefined
        : "Stripe credentials not configured on cortex — simulated checkout only",
    });
  } catch (err) {
    if (err instanceof BrokerageCheckoutConfigError) {
      // FAIL CLOSED, declared: this tier's price is not configured. Refuse
      // rather than hand back a fake session under a real key.
      res.status(503).json({
        error: "checkout_unavailable",
        message: err.message,
        missing: err.missing,
        stripeConfigured: isStripeConfigured(),
      });
      return;
    }
    res.status(502).json({
      error: "checkout_failed",
      message: String((err as Error).message || err),
      stripeConfigured: isStripeConfigured(),
    });
  }
});

propertyExplorerBillingRouter.get("/status", (_req: Request, res: Response) => {
  res.json({
    stripeConfigured: isStripeConfigured(),
    liveCheckout: isStripeConfigured(),
  });
});
