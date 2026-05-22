import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type {
  DeliverableLetterAtom,
  DeliverableLetterRenderAtom,
  LetterSection,
  LetterSectionKind,
} from "@workspace/api-client-react";

/**
 * CommentLetterPage integration test (CDX-9). `@workspace/api-client-
 * react` is mocked so the L3/L6-backed page renders without a backend;
 * `useMutation` / `useQueryClient` stay real via a QueryClientProvider.
 */
const hookState = vi.hoisted(() => ({
  letter: null as DeliverableLetterAtom | null,
  isLoading: false,
  isError: false,
  renders: [] as DeliverableLetterRenderAtom[],
  renderMutate: vi.fn(),
}));

vi.mock("@workspace/api-client-react", () => ({
  useGetDeliverableLetter: () => ({
    data: hookState.letter
      ? { deliverableLetter: hookState.letter }
      : undefined,
    isLoading: hookState.isLoading,
    isError: hookState.isError,
  }),
  useUpsertDeliverableLetterSection: () => ({
    mutate: vi.fn(),
    isPending: false,
  }),
  useListDeliverableLetterRenders: () => ({
    data: { renders: hookState.renders },
  }),
  useRenderDeliverableLetter: () => ({
    mutate: hookState.renderMutate,
    isPending: false,
  }),
  ApiError: class ApiError extends Error {},
  getGetDeliverableLetterQueryKey: (id: string) => [
    `/api/deliverable-letters/${id}`,
  ],
  getListDeliverableLetterRendersQueryKey: (id: string) => [
    `/api/deliverable-letters/${id}/renders`,
  ],
}));

const { default: CommentLetterPage } = await import("./CommentLetterPage");

function makeSection(
  kind: LetterSectionKind,
  overrides: Partial<LetterSection> = {},
): LetterSection {
  return {
    kind,
    heading: `${kind} heading`,
    content: `${kind} content`,
    provenance: {
      responseTaskIds: [],
      sheetContentExtractionIds: [],
      findingIds: [],
      adjudicationStateIds: [],
    },
    ...overrides,
  };
}

function makeLetter(
  overrides: Partial<DeliverableLetterAtom> = {},
): DeliverableLetterAtom {
  return {
    entityType: "deliverable-letter",
    entityId: "letter-1",
    jurisdictionTenant: "grand-county",
    fetchedAt: "2026-05-22T00:00:00.000Z",
    sourceAdapter: "cortex-l-surface",
    sourceUrl: "",
    contentHash: "hash-1",
    engagementId: "e1",
    title: "Comment Letter — Musgrave Residence",
    status: "draft",
    recipientActorId: null,
    sections: [
      makeSection("cover"),
      makeSection("intro"),
      makeSection("per-comment-response", {
        heading: "Comment 1 — Setback (Blocker)",
        provenance: {
          responseTaskIds: [],
          sheetContentExtractionIds: [],
          findingIds: ["finding:sub-1:01"],
          adjudicationStateIds: [],
        },
      }),
      makeSection("signature"),
    ],
    createdAt: "2026-05-22T00:00:00.000Z",
    sentAt: null,
    actorId: null,
    principalActorId: null,
    ...overrides,
  };
}

function renderPage(letterId = "letter-1") {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <CommentLetterPage letterId={letterId} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  hookState.letter = null;
  hookState.isLoading = false;
  hookState.isError = false;
  hookState.renders = [];
  hookState.renderMutate = vi.fn();
});

describe("CommentLetterPage", () => {
  it("shows a loading placeholder while the letter is in flight", () => {
    hookState.isLoading = true;
    renderPage();
    expect(screen.getByTestId("letter-placeholder").textContent).toContain(
      "Loading",
    );
  });

  it("shows an error placeholder when the letter cannot be loaded", () => {
    hookState.isError = true;
    renderPage();
    expect(screen.getByTestId("letter-placeholder").textContent).toContain(
      "could not be loaded",
    );
  });

  it("renders the letter title and every section", () => {
    hookState.letter = makeLetter();
    renderPage();
    expect(screen.getByTestId("letter-title").textContent).toBe(
      "Comment Letter — Musgrave Residence",
    );
    expect(screen.getAllByTestId(/^letter-section-\d+$/)).toHaveLength(4);
  });

  it("marks a letter with cover, intro, and signature complete", () => {
    hookState.letter = makeLetter();
    renderPage();
    expect(screen.getByTestId("letter-completeness").textContent).toContain(
      "Complete",
    );
    expect(
      screen.getByTestId<HTMLButtonElement>("letter-render-docx").disabled,
    ).toBe(false);
  });

  it("disables rendering when a required section is missing", () => {
    hookState.letter = makeLetter({
      sections: [makeSection("cover"), makeSection("intro")],
    });
    renderPage();
    expect(screen.getByTestId("letter-completeness").textContent).toContain(
      "Incomplete",
    );
    expect(
      screen.getByTestId<HTMLButtonElement>("letter-render-docx").disabled,
    ).toBe(true);
    expect(
      screen.getByTestId<HTMLButtonElement>("letter-render-pdf").disabled,
    ).toBe(true);
  });

  it("surfaces per-section finding provenance", () => {
    hookState.letter = makeLetter();
    renderPage();
    expect(
      screen.getByTestId("letter-section-2-provenance").textContent,
    ).toContain("finding:sub-1:01");
  });

  it("triggers an L6 render for the chosen format", () => {
    hookState.letter = makeLetter();
    renderPage();
    fireEvent.click(screen.getByTestId("letter-render-pdf"));
    expect(hookState.renderMutate).toHaveBeenCalledWith({
      letterId: "letter-1",
      data: { format: "pdf" },
    });
  });

  it("lists existing renders with a download link", () => {
    hookState.letter = makeLetter();
    hookState.renders = [
      {
        entityType: "deliverable-letter-render",
        entityId: "render-1",
        jurisdictionTenant: "grand-county",
        fetchedAt: "2026-05-22T01:00:00.000Z",
        sourceAdapter: "cortex-l-surface",
        sourceUrl: "",
        contentHash: "rhash-1",
        sourceLetterRef: "did:hauska:deliverable-letter:letter-1",
        sourceLetterVersion: "hash-1",
        format: "pdf",
        blobRef: "blob-1",
        renderedAt: "2026-05-22T01:00:00.000Z",
        renderedByActorId: null,
      },
    ];
    renderPage();
    const link = screen.getByTestId<HTMLAnchorElement>(
      "letter-render-render-1-download",
    );
    expect(link.getAttribute("href")).toBe(
      "/api/deliverable-letter-renders/render-1/file",
    );
  });

  it("renders sections read-only once the letter is sent", () => {
    hookState.letter = makeLetter({ status: "sent" });
    renderPage();
    expect(screen.getByTestId("letter-status").textContent).toBe("sent");
    expect(screen.queryByTestId("letter-section-0-save")).toBeNull();
  });
});
