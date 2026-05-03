export interface QaSuite {
  readonly id: string;
  readonly app: "api-server" | "design-tools" | "plan-review";
  readonly kind: "vitest" | "playwright";
  readonly label: string;
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly description: string;
}

export const QA_SUITES: ReadonlyArray<QaSuite> = [
  {
    id: "api-server-vitest",
    app: "api-server",
    kind: "vitest",
    label: "API Server — vitest",
    command: "pnpm",
    args: ["--filter", "@workspace/api-server", "run", "test"],
    description: "Backend route + unit tests (vitest).",
  },
  {
    id: "design-tools-vitest",
    app: "design-tools",
    kind: "vitest",
    label: "Design Tools — vitest",
    command: "pnpm",
    args: ["--filter", "@workspace/design-tools", "run", "test"],
    description: "Design Tools component tests (vitest + happy-dom).",
  },
  {
    id: "design-tools-e2e",
    app: "design-tools",
    kind: "playwright",
    label: "Design Tools — playwright",
    command: "pnpm",
    args: ["--filter", "@workspace/design-tools", "run", "test:e2e"],
    description: "Design Tools end-to-end tests (Playwright + Chromium).",
  },
  {
    id: "plan-review-vitest",
    app: "plan-review",
    kind: "vitest",
    label: "Plan Review — vitest",
    command: "pnpm",
    args: ["--filter", "@workspace/plan-review", "run", "test"],
    description: "Plan Review component tests (vitest + happy-dom).",
  },
  {
    id: "plan-review-e2e",
    app: "plan-review",
    kind: "playwright",
    label: "Plan Review — playwright",
    command: "pnpm",
    args: ["--filter", "@workspace/plan-review", "run", "test:e2e"],
    description: "Plan Review end-to-end tests (Playwright + Chromium).",
  },
];

export function getSuiteById(id: string): QaSuite | undefined {
  return QA_SUITES.find((s) => s.id === id);
}
