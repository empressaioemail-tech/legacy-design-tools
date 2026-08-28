import { chromium } from "playwright";
import { afterEach, describe, expect, it } from "vitest";
import { createPlaywrightBrowser } from "./playwrightBrowser.js";

describe("extractResultRows header seam", () => {
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;

  afterEach(async () => {
    if (browser) {
      await browser.close();
      browser = undefined;
    }
  });

  it("reads the published grid header onto each result row", async () => {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.setContent(`
      <table>
        <thead>
          <tr>
            <th>Instrument Number</th>
            <th>Grantor</th>
            <th>Document Type</th>
            <th>Date</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td><a href="/doc/1">2024-12345</a></td>
            <td>SMITH JOHN A</td>
            <td>WARRANTY DEED</td>
            <td>01/02/2024</td>
          </tr>
        </tbody>
      </table>
    `);
    const rows = await createPlaywrightBrowser(page).extractResultRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.headers).toEqual([
      "Instrument Number",
      "Grantor",
      "Document Type",
      "Date",
    ]);
    expect(rows[0]?.cells[2]).toBe("WARRANTY DEED");
  });

  it("returns null headers when the grid has no header row", async () => {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.setContent(`
      <table>
        <tbody>
          <tr>
            <td>2024-12345</td>
            <td>SMITH JOHN A</td>
            <td>WARRANTY DEED</td>
          </tr>
        </tbody>
      </table>
    `);
    const rows = await createPlaywrightBrowser(page).extractResultRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.headers).toBeNull();
  });
});
