import { chromium } from "playwright";
import { afterEach, describe, expect, it } from "vitest";
import {
  CHROME_CLIENT_HINTS_HEADERS,
  CHROME_USER_AGENT,
  createChromeBrowserContext,
} from "./playwrightBrowser.js";

describe("createChromeBrowserContext", () => {
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;

  afterEach(async () => {
    if (browser) {
      await browser.close();
      browser = undefined;
    }
  });

  it("sets Chrome user agent and sec-ch-ua headers on the browser context", async () => {
    browser = await chromium.launch({ headless: true });
    const context = await createChromeBrowserContext(browser);
    const page = await context.newPage();

    const navigatorUserAgent = await page.evaluate(() => navigator.userAgent);
    expect(navigatorUserAgent).toBe(CHROME_USER_AGENT);

    let capturedHeaders: Record<string, string> = {};
    await page.route("**/*", async (route) => {
      capturedHeaders = route.request().headers();
      await route.fulfill({
        status: 200,
        contentType: "text/html",
        body: "<html><body>ok</body></html>",
      });
    });

    await page.goto("https://example.test/travis-waf-probe");

    expect(capturedHeaders["user-agent"]).toBe(CHROME_USER_AGENT);
    expect(capturedHeaders["sec-ch-ua"]).toBe(
      CHROME_CLIENT_HINTS_HEADERS["sec-ch-ua"],
    );
    expect(capturedHeaders["sec-ch-ua-mobile"]).toBe(
      CHROME_CLIENT_HINTS_HEADERS["sec-ch-ua-mobile"],
    );
    expect(capturedHeaders["sec-ch-ua-platform"]).toBe(
      CHROME_CLIENT_HINTS_HEADERS["sec-ch-ua-platform"],
    );
  });
});
