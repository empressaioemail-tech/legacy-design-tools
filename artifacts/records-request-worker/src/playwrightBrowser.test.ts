import { describe, expect, it, vi } from "vitest";
import type { Browser } from "playwright";
import {
  createChromeBrowserContext,
  createPlaywrightBrowser,
  RECORDS_REQUEST_WORKER_USER_AGENT,
} from "./playwrightBrowser.js";
import { PORTAL_ACCESS_BLOCKED_CODE } from "./portalAccessBlocked.js";
import type { Page } from "playwright";

describe("createChromeBrowserContext", () => {
  it("passes honest worker user agent without browser-mimicking headers", async () => {
    const fakeContext = { newPage: vi.fn() };
    const browser = {
      newContext: vi.fn().mockResolvedValue(fakeContext),
    } as unknown as Browser;

    const context = await createChromeBrowserContext(browser);

    expect(context).toBe(fakeContext);
    expect(browser.newContext).toHaveBeenCalledWith({
      userAgent: RECORDS_REQUEST_WORKER_USER_AGENT,
      locale: "en-US",
      viewport: { width: 1920, height: 1080 },
    });
    expect(RECORDS_REQUEST_WORKER_USER_AGENT).toContain("RecordsRequestWorker/1.0");
    expect(RECORDS_REQUEST_WORKER_USER_AGENT).not.toMatch(/Chrome\//);
  });
});

describe("createPlaywrightBrowser portal access blocked", () => {
  it("returns portal-access-blocked on HTTP 403 without retry", async () => {
    const page = {
      goto: vi.fn().mockResolvedValue({
        status: () => 403,
        ok: () => false,
      }),
      url: () => "https://example.com/blocked",
      content: vi.fn().mockResolvedValue("<html><body>Forbidden</body></html>"),
    } as unknown as Page;

    const browser = createPlaywrightBrowser(page, {
      throttle: { beforeAction: vi.fn().mockResolvedValue(undefined) },
    });
    const result = await browser.goto("https://example.com/blocked");

    expect(result.ok).toBe(false);
    expect(result.status).toBe(403);
    expect(result.errorCode).toBe(PORTAL_ACCESS_BLOCKED_CODE);
    expect(page.goto).toHaveBeenCalledTimes(1);
  });

  it("returns portal-access-blocked when page content indicates WAF challenge", async () => {
    const page = {
      goto: vi.fn().mockResolvedValue({
        status: () => 200,
        ok: () => true,
      }),
      url: () => "https://example.com/challenge",
      content: vi
        .fn()
        .mockResolvedValue(
          "<html><body><div id=\"cf-challenge\">Checking your browser</div></body></html>",
        ),
    } as unknown as Page;

    const browser = createPlaywrightBrowser(page, {
      throttle: { beforeAction: vi.fn().mockResolvedValue(undefined) },
    });
    const result = await browser.goto("https://example.com/challenge");

    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe(PORTAL_ACCESS_BLOCKED_CODE);
  });
});
