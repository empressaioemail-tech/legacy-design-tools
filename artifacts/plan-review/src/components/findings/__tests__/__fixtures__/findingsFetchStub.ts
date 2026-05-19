/**
 * In-memory fetch stub for the findings API surface — replaces the
 * deleted `lib/findingsMock.ts` for tests. Routes every fetch call
 * the generated Orval client makes against
 * `GET /api/submissions/:id/findings`,
 * `GET /api/submissions/:id/findings/runs`,
 * `GET /api/submissions/:id/findings/status`,
 * `POST /api/submissions/:id/findings/generate`,
 * `POST /api/findings/:id/accept`,
 * `POST /api/findings/:id/reject`,
 * `POST /api/findings/:id/override`,
 * and `POST /api/submissions/:id/findings` (manual-add)
 * to a tiny in-memory store that mirrors the BE's row-level mutations
 * so the FindingsTab component tests can exercise the real client
 * end-to-end without crossing the network.
 *
 * Tests install the stub in `beforeEach`, seed findings / runs as
 * needed, and call `restore()` in `afterEach`. Optional per-test
 * `extraHandlers` argument forwards through unmatched URLs (e.g. the
 * `/api/tenants/.../canned-findings` GET in the canned-picker spec)
 * so a test can layer its own fetch handlers on top of the findings
 * surface without re-implementing the whole spy.
 */
import { vi, type MockInstance } from "vitest";

export type FindingCitation =
  | { kind: "code-section"; atomId: string }
  | { kind: "briefing-source"; id: string; label: string };

export interface FindingActor {
  kind: "user" | "agent" | "system";
  id: string;
  displayName?: string | null;
}

export type FindingSeverity = "blocker" | "concern" | "advisory";
export type FindingCategory =
  | "setback"
  | "height"
  | "coverage"
  | "egress"
  | "use"
  | "overlay-conflict"
  | "divergence-related"
  | "other";
export type FindingStatus =
  | "ai-produced"
  | "accepted"
  | "rejected"
  | "overridden"
  | "promoted-to-architect";

export interface StubFinding {
  id: string;
  submissionId: string;
  severity: FindingSeverity;
  category: FindingCategory;
  status: FindingStatus;
  text: string;
  citations: FindingCitation[];
  confidence: number;
  lowConfidence: boolean;
  reviewerStatusBy: FindingActor | null;
  reviewerStatusChangedAt: string | null;
  reviewerComment: string | null;
  elementRef: string | null;
  sourceRef: { id: string; label: string } | null;
  aiGeneratedAt: string;
  revisionOf: string | null;
  aiGenerated: boolean;
  acceptedByReviewerId: string | null;
  acceptedAt: string | null;
  acceptedBy: FindingActor | null;
}

export interface StubRun {
  generationId: string;
  state: "pending" | "completed" | "failed";
  startedAt: string;
  completedAt: string | null;
  error: string | null;
  invalidCitationCount: number | null;
  invalidCitations: string[] | null;
  discardedFindingCount: number | null;
}

export interface InstallFindingsFetchStubOptions {
  /**
   * Forwarded handler chain. Each entry receives the parsed url + the
   * fetch init args and returns a Response on match, or null/undefined
   * to pass through. The findings endpoints take precedence; anything
   * the chain doesn't claim falls through to a default `404`.
   */
  extraHandlers?: ReadonlyArray<
    (
      url: string,
      init: RequestInit | undefined,
    ) => Response | Promise<Response> | null | undefined
  >;
  /**
   * Deterministic three-finding fixture the stub returns on
   * `POST /api/submissions/:id/findings/generate`. Defaults to the
   * historical mock fixture (1 blocker / 1 concern / 1 advisory) so
   * existing component tests don't need to re-seed for the generate-
   * flow path.
   */
  generationFixture?: (submissionId: string, now: string) => StubFinding[];
}

export interface FindingsFetchStub {
  seedFindings(submissionId: string, findings: StubFinding[]): void;
  seedRuns(submissionId: string, runs: StubRun[]): void;
  peekFindings(submissionId: string): StubFinding[];
  peekRuns(submissionId: string): StubRun[];
  restore(): void;
  /**
   * Test-only convenience: build a `StubFinding` with overrides applied
   * over a fully-populated baseline so individual tests can opt in to
   * just the fields they care about.
   */
  finding(overrides: Partial<StubFinding>): StubFinding;
  /** The underlying spy, in case a test wants to assert on call history. */
  spy: MockInstance<typeof fetch>;
}

function makeUlid(): string {
  return (
    Date.now().toString(36).toUpperCase() +
    Math.random().toString(36).slice(2, 10).toUpperCase()
  );
}

function defaultGenerationFixture(
  submissionId: string,
  now: string,
): StubFinding[] {
  // Mirrors the historical 3-finding fixture so the cross-tab jump
  // e2e + the FindingsTab component test keep their fixed assertions.
  const mk = (overrides: Partial<StubFinding>): StubFinding => ({
    id: `finding:${submissionId}:${makeUlid()}`,
    submissionId,
    severity: "blocker",
    category: "setback",
    status: "ai-produced",
    text: "Fixture finding text [[CODE:demo-section]].",
    citations: [{ kind: "code-section", atomId: "demo-section" }],
    confidence: 0.9,
    lowConfidence: false,
    reviewerStatusBy: null,
    reviewerStatusChangedAt: null,
    reviewerComment: null,
    elementRef: null,
    sourceRef: null,
    aiGeneratedAt: now,
    revisionOf: null,
    aiGenerated: true,
    acceptedByReviewerId: null,
    acceptedAt: null,
    acceptedBy: null,
    ...overrides,
  });
  return [
    mk({
      severity: "blocker",
      category: "setback",
      text:
        "North side-yard setback violation. See [[CODE:bastrop-udc-4-3-2-b]].",
      citations: [
        { kind: "code-section", atomId: "bastrop-udc-4-3-2-b" },
        {
          kind: "briefing-source",
          id: "src-bastrop-udc-2024",
          label: "Bastrop UDC §4.3.2",
        },
      ],
      elementRef: "wall:north-side-l2",
      sourceRef: {
        id: "src-bastrop-udc-2024",
        label: "Bastrop UDC §4.3.2",
      },
    }),
    mk({
      severity: "concern",
      category: "egress",
      text:
        "Bedroom 2 egress window appears below minimum opening. [[CODE:irc-r310-2-1]]",
      citations: [{ kind: "code-section", atomId: "irc-r310-2-1" }],
      confidence: 0.55,
      lowConfidence: true,
      elementRef: "window:bedroom-2-egress",
    }),
    mk({
      severity: "advisory",
      category: "other",
      text:
        "Plant schedule count mismatch (6 vs 8). [[CODE:bastrop-udc-6-7-1]]",
      citations: [{ kind: "code-section", atomId: "bastrop-udc-6-7-1" }],
      confidence: 0.78,
    }),
  ];
}

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

function methodOf(init: RequestInit | undefined): string {
  return (init?.method ?? "GET").toUpperCase();
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function notFoundResponse(url: string, method: string): Response {
  return new Response(
    JSON.stringify({
      error: "unstubbed_endpoint",
      message: `findingsFetchStub: ${method} ${url} was not stubbed.`,
    }),
    { status: 404, headers: { "content-type": "application/json" } },
  );
}

export function installFindingsFetchStub(
  options: InstallFindingsFetchStubOptions = {},
): FindingsFetchStub {
  const findings = new Map<string, StubFinding[]>();
  const runs = new Map<string, StubRun[]>();
  const generationFixture = options.generationFixture ?? defaultGenerationFixture;
  const extraHandlers = options.extraHandlers ?? [];

  const seedFindings = (submissionId: string, list: StubFinding[]): void => {
    findings.set(submissionId, list.map((f) => ({ ...f })));
  };
  const seedRuns = (submissionId: string, list: StubRun[]): void => {
    runs.set(submissionId, list.map((r) => ({ ...r })));
  };
  const peekFindings = (submissionId: string): StubFinding[] =>
    findings.get(submissionId) ?? [];
  const peekRuns = (submissionId: string): StubRun[] => runs.get(submissionId) ?? [];

  function buildFinding(overrides: Partial<StubFinding>): StubFinding {
    return {
      id: `finding:${overrides.submissionId ?? "sub-x"}:${makeUlid()}`,
      submissionId: overrides.submissionId ?? "sub-x",
      severity: "blocker",
      category: "setback",
      status: "ai-produced",
      text: "Fixture finding text [[CODE:demo-section]].",
      citations: [{ kind: "code-section", atomId: "demo-section" }],
      confidence: 0.9,
      lowConfidence: false,
      reviewerStatusBy: null,
      reviewerStatusChangedAt: null,
      reviewerComment: null,
      elementRef: null,
      sourceRef: null,
      aiGeneratedAt: "2026-04-30T12:00:00.000Z",
      revisionOf: null,
      aiGenerated: true,
      acceptedByReviewerId: null,
      acceptedAt: null,
      acceptedBy: null,
      ...overrides,
    };
  }

  function findFindingByAtomId(
    atomId: string,
  ): { submissionId: string; finding: StubFinding } | null {
    for (const [submissionId, list] of findings.entries()) {
      const finding = list.find((f) => f.id === atomId);
      if (finding) return { submissionId, finding };
    }
    return null;
  }

  function nowIso(): string {
    return new Date().toISOString();
  }

  async function handle(
    input: RequestInfo | URL,
    init: RequestInit | undefined,
  ): Promise<Response> {
    const url = urlOf(input);
    const method = methodOf(init);

    // ── Per-submission collection routes ────────────────────────────
    const listMatch = url.match(/\/api\/submissions\/([^/?#]+)\/findings(?:\?|#|$)/);
    if (listMatch) {
      const submissionId = decodeURIComponent(listMatch[1]);
      if (method === "GET") {
        return jsonResponse({ findings: peekFindings(submissionId) });
      }
      if (method === "POST") {
        // Manual-add.
        const body = JSON.parse(String(init?.body ?? "{}"));
        const title = String(body.title ?? "").trim();
        if (!title) {
          return jsonResponse(
            { error: "invalid_create_finding_body" },
            400,
          );
        }
        const description = (body.description ?? "").trim?.() ?? "";
        const text = description
          ? `${title}\n\n${description}`
          : title;
        const citations: FindingCitation[] = [];
        if (body.codeCitation) {
          citations.push({
            kind: "code-section",
            atomId: String(body.codeCitation),
          });
        }
        if (body.sourceCitation) {
          citations.push({
            kind: "briefing-source",
            id: String(body.sourceCitation.id),
            label: String(body.sourceCitation.label),
          });
        }
        const now = nowIso();
        const created: StubFinding = {
          id: `finding:${submissionId}:${makeUlid()}`,
          submissionId,
          severity: body.severity,
          category: body.category,
          status: "ai-produced",
          text,
          citations,
          confidence: 1,
          lowConfidence: false,
          reviewerStatusBy: {
            kind: "user",
            id: "reviewer-current",
            displayName: "Reviewer",
          },
          reviewerStatusChangedAt: now,
          reviewerComment: null,
          elementRef: body.elementRef ?? null,
          sourceRef: body.sourceCitation ?? null,
          aiGeneratedAt: now,
          revisionOf: null,
          aiGenerated: false,
          acceptedByReviewerId: null,
          acceptedAt: null,
          acceptedBy: null,
        };
        const prior = findings.get(submissionId) ?? [];
        findings.set(submissionId, [created, ...prior]);
        return jsonResponse({ finding: created }, 201);
      }
    }

    const runsMatch = url.match(
      /\/api\/submissions\/([^/?#]+)\/findings\/runs(?:\?|#|$)/,
    );
    if (runsMatch && method === "GET") {
      const submissionId = decodeURIComponent(runsMatch[1]);
      return jsonResponse({ runs: peekRuns(submissionId) });
    }

    const statusMatch = url.match(
      /\/api\/submissions\/([^/?#]+)\/findings\/status(?:\?|#|$)/,
    );
    if (statusMatch && method === "GET") {
      const submissionId = decodeURIComponent(statusMatch[1]);
      const latest = peekRuns(submissionId)[0] ?? null;
      if (!latest) {
        return jsonResponse({
          generationId: null,
          state: "idle",
          startedAt: null,
          completedAt: null,
          error: null,
          invalidCitationCount: null,
          invalidCitations: null,
          discardedFindingCount: null,
        });
      }
      return jsonResponse(latest);
    }

    const generateMatch = url.match(
      /\/api\/submissions\/([^/?#]+)\/findings\/generate(?:\?|#|$)/,
    );
    if (generateMatch && method === "POST") {
      const submissionId = decodeURIComponent(generateMatch[1]);
      const now = nowIso();
      const generationId = `frun_${makeUlid().toLowerCase().slice(0, 16)}`;
      const fixture = generationFixture(submissionId, now);
      findings.set(submissionId, fixture);
      const completedRun: StubRun = {
        generationId,
        state: "completed",
        startedAt: now,
        completedAt: now,
        error: null,
        invalidCitationCount: 0,
        invalidCitations: [],
        discardedFindingCount: 0,
      };
      const prior = runs.get(submissionId) ?? [];
      runs.set(submissionId, [completedRun, ...prior]);
      return jsonResponse({ generationId, state: "pending" }, 202);
    }

    // ── Per-finding mutation routes ─────────────────────────────────
    const acceptMatch = url.match(/\/api\/findings\/([^/?#]+)\/accept(?:\?|#|$)/);
    if (acceptMatch && method === "POST") {
      const atomId = decodeURIComponent(acceptMatch[1]);
      const hit = findFindingByAtomId(atomId);
      if (!hit) return jsonResponse({ error: "finding_not_found" }, 404);
      const now = nowIso();
      const actor: FindingActor = {
        kind: "user",
        id: "reviewer-current",
        displayName: "Reviewer",
      };
      const updated: StubFinding = {
        ...hit.finding,
        status: "accepted",
        reviewerStatusBy: actor,
        reviewerStatusChangedAt: now,
        acceptedAt: hit.finding.acceptedAt ?? now,
        acceptedBy: hit.finding.acceptedBy ?? actor,
        acceptedByReviewerId: hit.finding.acceptedByReviewerId ?? actor.id,
      };
      const list = findings.get(hit.submissionId)!;
      findings.set(
        hit.submissionId,
        list.map((f) => (f.id === atomId ? updated : f)),
      );
      return jsonResponse({ finding: updated });
    }

    const rejectMatch = url.match(/\/api\/findings\/([^/?#]+)\/reject(?:\?|#|$)/);
    if (rejectMatch && method === "POST") {
      const atomId = decodeURIComponent(rejectMatch[1]);
      const hit = findFindingByAtomId(atomId);
      if (!hit) return jsonResponse({ error: "finding_not_found" }, 404);
      const now = nowIso();
      const actor: FindingActor = {
        kind: "user",
        id: "reviewer-current",
        displayName: "Reviewer",
      };
      const updated: StubFinding = {
        ...hit.finding,
        status: "rejected",
        reviewerStatusBy: actor,
        reviewerStatusChangedAt: now,
      };
      const list = findings.get(hit.submissionId)!;
      findings.set(
        hit.submissionId,
        list.map((f) => (f.id === atomId ? updated : f)),
      );
      return jsonResponse({ finding: updated });
    }

    const overrideMatch = url.match(/\/api\/findings\/([^/?#]+)\/override(?:\?|#|$)/);
    if (overrideMatch && method === "POST") {
      const atomId = decodeURIComponent(overrideMatch[1]);
      const hit = findFindingByAtomId(atomId);
      if (!hit) return jsonResponse({ error: "finding_not_found" }, 404);
      if (hit.finding.status === "overridden") {
        return jsonResponse(
          {
            error: "finding_already_overridden",
            message:
              "This finding has already been overridden. The original cannot be overridden again.",
          },
          409,
        );
      }
      const body = JSON.parse(String(init?.body ?? "{}"));
      const now = nowIso();
      const actor: FindingActor = {
        kind: "user",
        id: "reviewer-current",
        displayName: "Reviewer",
      };
      const supersededOriginal: StubFinding = {
        ...hit.finding,
        status: "overridden",
        reviewerStatusBy: actor,
        reviewerStatusChangedAt: now,
        reviewerComment: body.reviewerComment ?? null,
      };
      const revision: StubFinding = {
        ...hit.finding,
        id: `finding:${hit.submissionId}:${makeUlid()}`,
        severity: body.severity,
        category: body.category,
        text: body.text,
        status: "overridden",
        reviewerStatusBy: actor,
        reviewerStatusChangedAt: now,
        reviewerComment: body.reviewerComment ?? null,
        citations: [],
        revisionOf: hit.finding.id,
      };
      const list = findings.get(hit.submissionId)!;
      const next: StubFinding[] = [];
      for (const f of list) {
        if (f.id === atomId) {
          next.push(supersededOriginal);
          next.push(revision);
        } else {
          next.push(f);
        }
      }
      findings.set(hit.submissionId, next);
      return jsonResponse({ finding: revision });
    }

    for (const handler of extraHandlers) {
      const result = await handler(url, init);
      if (result) return result;
    }
    return notFoundResponse(url, method);
  }

  const spy = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (input, init) => handle(input, init));

  return {
    seedFindings,
    seedRuns,
    peekFindings,
    peekRuns,
    finding: buildFinding,
    restore: () => spy.mockRestore(),
    spy: spy as unknown as MockInstance<typeof fetch>,
  };
}
