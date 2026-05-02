/**
 * Task #446 — End-to-end coverage for the Task #429 reviewer-side
 * "Request refresh" affordances on the BIM model tab and the
 * briefing panel.
 *
 * The unit / component tests in
 * `lib/portal-ui/src/components/__tests__/RequestRefreshDialog.test.tsx`
 * already exercise the pending-state disable wiring in isolation,
 * but nothing currently walks a real reviewer browser session
 * through the full open-dialog → submit → "Refresh requested"
 * flip on the live UI against the live API. This spec fills that
 * gap for the two engagement-scoped affordances:
 *
 *   1. `refresh-bim-model` — surfaced inside the SubmissionDetailModal's
 *      BIM Model tab (via `BimModelSummaryCard`) when the model is
 *      `stale` and the reviewer audience is mounted.
 *
 *   2. `regenerate-briefing` — surfaced at the top of the briefing
 *      panel on `EngagementDetail` (the `BriefingRegenerationAffordance`
 *      wrapper component).
 *
 * The third Task #429 affordance (`refresh-briefing-source` on
 * `BriefingSourceRow`) is intentionally out of scope here — it gates
 * on a stale freshness verdict from per-layer adapter evaluators
 * which is environment-coupled in dev DB; that path is already
 * covered API-first by `reviewer-stale-request.spec.ts`.
 *
 * Seeding strategy mirrors `bim-model-tab.spec.ts`:
 *
 *   - Insert a clean engagement directly via `@workspace/db`.
 *   - Insert an empty parcel briefing shell (the bim-model push
 *     route requires one to mint `activeBriefingId`).
 *   - Create a real submission via the public POST so the
 *     SubmissionDetailModal has a row to open.
 *   - Push a bim-model via the real route so the tab is in its
 *     non-empty branch.
 *   - Bump `parcel_briefings.updated_at` to a moment after the
 *     bim-model's `materialized_at` so `computeRefreshStatus`
 *     classifies the model as `stale` — the `BimModelSummaryCard`
 *     gate `audience === "internal" && refreshStatus === "stale"`
 *     is the precondition for the affordance to mount at all.
 *
 * The browser session is promoted to `audience === "internal"` via
 * the dev-only `pr_session` cookie shape that
 * `artifacts/api-server/src/middlewares/session.ts` honors when
 * `NODE_ENV !== "production"`. Production fail-closes that cookie
 * so this is purely a dev / e2e seam, not a production attack
 * surface.
 *
 * `afterAll` deletes the engagement; FK cascades remove the
 * bim-model, submissions, parcel briefing, and any reviewer-request
 * rows the test created so the dev DB is left as we found it.
 */

import { test, expect } from "@playwright/test";
import { eq, and } from "drizzle-orm";
import {
  db,
  engagements,
  parcelBriefings,
  bimModels,
  reviewerRequests,
} from "@workspace/db";

const RUN_TAG = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const TEST_PROJECT_NAME = `e2e Reviewer Refresh Affordances ${RUN_TAG}`;
const TEST_NOTE = `e2e-reviewer-refresh ${RUN_TAG}`;

let engagementId = "";
let submissionId = "";
let bimModelId = "";

test.beforeAll(async ({ request }) => {
  const [eng] = await db
    .insert(engagements)
    .values({
      name: TEST_PROJECT_NAME,
      nameLower: TEST_PROJECT_NAME.toLowerCase(),
      jurisdiction: "Moab, UT",
      jurisdictionCity: "Moab",
      jurisdictionState: "UT",
      jurisdictionFips: "49019",
      address: "1 Reviewer Refresh Way, Moab, UT 84532",
      status: "active",
    })
    .returning();
  if (!eng) throw new Error("seed: engagement insert returned no row");
  engagementId = eng.id;

  // Empty briefing shell — required for the bim-model push to bind
  // an activeBriefingId. The narrative columns are optional.
  await db
    .insert(parcelBriefings)
    .values({ engagementId })
    .onConflictDoNothing();

  // Submission gives us the row that opens the SubmissionDetailModal,
  // which is where the BIM Model tab (and its summary card +
  // affordance) lives in plan-review.
  const submissionResp = await request.post(
    `/api/engagements/${engagementId}/submissions`,
    {
      data: { note: TEST_NOTE },
      headers: { "content-type": "application/json" },
    },
  );
  if (submissionResp.status() !== 201) {
    throw new Error(
      `seed: POST /api/engagements/${engagementId}/submissions returned ` +
        `${submissionResp.status()}: ${await submissionResp.text()}`,
    );
  }
  const submissionBody = (await submissionResp.json()) as {
    submissionId?: string;
  };
  if (!submissionBody.submissionId) {
    throw new Error("seed: submissions response did not include submissionId");
  }
  submissionId = submissionBody.submissionId;

  // Push to bim-model so the tab is in its non-empty branch and a
  // bim-model row exists. The push route is internal-audience-gated,
  // hence the dev-only `x-audience` header (see middlewares/session.ts).
  const pushResp = await request.post(
    `/api/engagements/${engagementId}/bim-model`,
    {
      data: { revitDocumentPath: `e2e:${RUN_TAG}.rvt` },
      headers: {
        "content-type": "application/json",
        "x-audience": "internal",
      },
    },
  );
  if (pushResp.status() !== 200) {
    throw new Error(
      `seed: POST /api/engagements/${engagementId}/bim-model returned ` +
        `${pushResp.status()}: ${await pushResp.text()}`,
    );
  }

  // Look up the bim-model row's id so we can target the per-target
  // `request-refresh-affordance-${targetEntityId}` testid directly,
  // and bump the briefing's updated_at to a moment AFTER the row's
  // materialized_at so `computeRefreshStatus` returns "stale". The
  // `BimModelSummaryCard` only mounts the affordance when the model
  // is stale, so this nudge is the load-bearing gate flip.
  const [bm] = await db
    .select({ id: bimModels.id, materializedAt: bimModels.materializedAt })
    .from(bimModels)
    .where(eq(bimModels.engagementId, engagementId));
  if (!bm) throw new Error("seed: bim-model row not found post-push");
  bimModelId = bm.id;
  const staleAt = new Date(
    (bm.materializedAt?.getTime() ?? Date.now()) + 60_000,
  );
  await db
    .update(parcelBriefings)
    .set({ updatedAt: staleAt })
    .where(eq(parcelBriefings.engagementId, engagementId));
});

test.afterAll(async () => {
  if (engagementId) {
    // FK cascades clean up the parcel briefing, bim-model, submission,
    // and any reviewer-requests + atom_events rows the test created.
    await db.delete(engagements).where(eq(engagements.id, engagementId));
  }
});

/**
 * Plant the dev-only `pr_session` cookie that promotes the browser
 * to `audience === "internal"`. Mirrors the cookie wiring in
 * `bim-model-tab.spec.ts` so this spec opts into the same
 * session-middleware seam without coupling to production auth.
 */
async function promoteToInternalAudience(context: import("@playwright/test").BrowserContext) {
  const proxyOrigin = new URL(
    process.env["E2E_BASE_URL"] ?? "http://localhost:80",
  );
  await context.addCookies([
    {
      name: "pr_session",
      value: encodeURIComponent(
        JSON.stringify({
          audience: "internal",
          requestor: { kind: "user", id: `e2e-reviewer-${RUN_TAG}` },
        }),
      ),
      domain: proxyOrigin.hostname,
      path: "/",
      httpOnly: false,
      secure: false,
    },
  ]);
}

test.describe("reviewer refresh affordances — Task #429", () => {
  test("BIM model tab affordance opens dialog, files request, flips to 'Refresh requested'", async ({
    page,
  }) => {
    await promoteToInternalAudience(page.context());

    // Relative path so the configured `…/plan-review/` baseURL is
    // honored — an absolute `/engagements/...` would land on the
    // proxy root and miss the artifact's base path prefix.
    await page.goto(`engagements/${engagementId}?tab=submissions`);

    const row = page.getByTestId(`submission-row-${submissionId}`);
    await expect(row).toBeVisible();
    await row.click();

    const modal = page.getByTestId("submission-detail-modal");
    await expect(modal).toBeVisible();

    // Switch into the BIM Model tab — it's not the default landing
    // pane (Sprint A made Note the default).
    await modal.getByTestId("submission-detail-modal-tab-bim-model").click();
    await expect(modal.getByTestId("bim-model-tab")).toBeVisible();
    await expect(modal.getByTestId("bim-model-summary-card")).toBeVisible();

    // The summary card should classify the model as stale (we bumped
    // the briefing's updated_at past materialized_at in beforeAll),
    // which is the precondition for the affordance to mount.
    await expect(
      modal.getByTestId("bim-model-summary-refresh-status"),
    ).toHaveAttribute("data-status", "stale");

    const affordance = modal.getByTestId(
      `request-refresh-affordance-${bimModelId}`,
    );
    await expect(affordance).toBeVisible();
    await expect(affordance).toHaveAttribute(
      "data-request-kind",
      "refresh-bim-model",
    );
    // Pre-submit the affordance is enabled and labels the bare action.
    await expect(affordance).toBeEnabled();
    await expect(affordance).toHaveText("Request refresh");

    await affordance.click();

    const dialog = page.getByTestId("request-refresh-dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveAttribute(
      "data-request-kind",
      "refresh-bim-model",
    );

    await dialog
      .getByTestId("request-refresh-reason")
      .fill("Model is misaligned with the latest briefing — please refresh.");
    await dialog.getByTestId("request-refresh-confirm").click();

    // Dialog closes on success, and the affordance flips into its
    // bound "pending" state — disabled with the "Refresh requested"
    // label and `data-pending="true"`.
    await expect(dialog).toBeHidden();
    await expect(affordance).toBeDisabled();
    await expect(affordance).toHaveAttribute("data-pending", "true");
    await expect(affordance).toHaveText("Refresh requested");

    // Server-side proof: a pending reviewer-request row exists for
    // this `(engagement, refresh-bim-model, bimModelId)` triple.
    const pending = await db
      .select({ id: reviewerRequests.id, reason: reviewerRequests.reason })
      .from(reviewerRequests)
      .where(
        and(
          eq(reviewerRequests.engagementId, engagementId),
          eq(reviewerRequests.requestKind, "refresh-bim-model"),
          eq(reviewerRequests.targetEntityId, bimModelId),
          eq(reviewerRequests.status, "pending"),
        ),
      );
    expect(pending).toHaveLength(1);
    expect(pending[0]!.reason).toContain("misaligned");
  });

  test("briefing panel affordance opens dialog, files request, flips to 'Refresh requested'", async ({
    page,
  }) => {
    await promoteToInternalAudience(page.context());

    await page.goto(`engagements/${engagementId}`);

    // The briefing-regen affordance row mounts when the page-level
    // session resolves to `audience === "internal"`. The button's
    // testid is keyed on the engagement id (the briefing target is
    // engagement-scoped — see `BriefingRegenerationAffordance`).
    const regenRow = page.getByTestId("briefing-regen-affordance-row");
    await expect(regenRow).toBeVisible();
    const affordance = page.getByTestId(
      `request-refresh-affordance-${engagementId}`,
    );
    await expect(affordance).toBeVisible();
    await expect(affordance).toHaveAttribute(
      "data-request-kind",
      "regenerate-briefing",
    );
    await expect(affordance).toBeEnabled();
    await expect(affordance).toHaveText("Request refresh");

    await affordance.click();

    const dialog = page.getByTestId("request-refresh-dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveAttribute(
      "data-request-kind",
      "regenerate-briefing",
    );

    await dialog
      .getByTestId("request-refresh-reason")
      .fill("Inputs changed since this briefing was last generated.");
    await dialog.getByTestId("request-refresh-confirm").click();

    await expect(dialog).toBeHidden();
    await expect(affordance).toBeDisabled();
    await expect(affordance).toHaveAttribute("data-pending", "true");
    await expect(affordance).toHaveText("Refresh requested");

    // Server-side proof: the pending reviewer-request row exists for
    // the `(engagement, regenerate-briefing, engagementId)` triple
    // (parcel-briefing target ids equal the engagement id by
    // convention — see RequestRefreshAffordance docstring).
    const pending = await db
      .select({ id: reviewerRequests.id, reason: reviewerRequests.reason })
      .from(reviewerRequests)
      .where(
        and(
          eq(reviewerRequests.engagementId, engagementId),
          eq(reviewerRequests.requestKind, "regenerate-briefing"),
          eq(reviewerRequests.targetEntityId, engagementId),
          eq(reviewerRequests.status, "pending"),
        ),
      );
    expect(pending).toHaveLength(1);
    expect(pending[0]!.reason).toContain("Inputs changed");
  });
});
