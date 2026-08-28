import { describe, expect, it, vi } from "vitest";
import type { Browser } from "playwright";
import {
  CHROME_CLIENT_HINTS_HEADERS,
  CHROME_USER_AGENT,
  createChromeBrowserContext,
} from "./playwrightBrowser.js";

describe("createChromeBrowserContext", () => {
  it("passes Chrome user agent and sec-ch-ua headers to browser.newContext", async () => {
    const fakeContext = { newPage: vi.fn() };
    const browser = {
      newContext: vi.fn().mockResolvedValue(fakeContext),
    } as unknown as Browser;

    const context = await createChromeBrowserContext(browser);

    expect(context).toBe(fakeContext);
    expect(browser.newContext).toHaveBeenCalledWith({
      userAgent: CHROME_USER_AGENT,
      extraHTTPHeaders: { ...CHROME_CLIENT_HINTS_HEADERS },
      locale: "en-US",
      viewport: { width: 1920, height: 1080 },
    });
    expect(CHROME_USER_AGENT).toMatch(/Chrome\/147\./);
    expect(CHROME_CLIENT_HINTS_HEADERS["sec-ch-ua"]).toContain('"147"');
  });
});
