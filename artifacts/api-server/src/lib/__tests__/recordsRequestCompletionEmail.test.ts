import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  buildRecordsRequestEmail,
  notifyRecordsRequestCompletion,
} from "../recordsRequestCompletionEmail";

const mockLoad = vi.fn();
const mockUpdate = vi.fn(() => ({
  set: vi.fn(() => ({ where: vi.fn().mockResolvedValue(undefined) })),
}));

vi.mock("../recordsRequestJobWorker", () => ({
  loadRecordsRequestJobById: (...args: unknown[]) => mockLoad(...args),
}));

vi.mock("@workspace/db", () => ({
  db: {
    update: () => mockUpdate(),
  },
  recordsRequestJobs: { id: "id" },
}));

describe("recordsRequestCompletionEmail", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("builds subject and body without title-plant language", () => {
    const mail = buildRecordsRequestEmail({
      job: {
        id: "j1",
        parcelKey: "apn:48021:34161",
        userEmail: "user@example.com",
      } as never,
      kind: "complete",
    });
    expect(mail.subject).toContain("34161");
    expect(mail.text).toContain("not a title opinion");
    expect(mail.text.toLowerCase()).not.toContain("clear title");
    expect(mail.text.toLowerCase()).not.toContain("chain of title");
  });

  it("records failed send on the job scope", async () => {
    mockLoad.mockResolvedValue({
      id: "job-1",
      status: "complete",
      userEmail: "user@example.com",
      parcelKey: "apn:48021:34161",
      scopeSearched: {},
    });
    const event = await notifyRecordsRequestCompletion({
      jobId: "job-1",
      send: async () => ({ ok: false, error: "Resend HTTP 401" }),
    });
    expect(event.status).toBe("failed");
    expect(event.error).toContain("401");
    expect(mockUpdate).toHaveBeenCalled();
  });

  it("records sent provider id", async () => {
    mockLoad.mockResolvedValue({
      id: "job-2",
      status: "awaiting-purchase-approval",
      userEmail: "user@example.com",
      parcelKey: "apn:48021:99999",
      scopeSearched: null,
    });
    const event = await notifyRecordsRequestCompletion({
      jobId: "job-2",
      send: async () => ({ ok: true, id: "resend_abc" }),
    });
    expect(event.status).toBe("sent");
    expect(event.providerId).toBe("resend_abc");
  });

  it("skips when user email absent", async () => {
    mockLoad.mockResolvedValue({
      id: "job-3",
      status: "failed",
      userEmail: null,
      parcelKey: "apn:48021:1",
      scopeSearched: {},
    });
    const event = await notifyRecordsRequestCompletion({ jobId: "job-3" });
    expect(event.status).toBe("skipped");
  });
});
