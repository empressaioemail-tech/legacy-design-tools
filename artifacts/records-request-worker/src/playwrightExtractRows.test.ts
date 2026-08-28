/// <reference lib="dom" />
/**
 * @vitest-environment happy-dom
 *
 * Runs the page.evaluate callback in-process. CI Test does not install
 * Playwright Chromium, so a live launch is not a gate here.
 */
import { beforeEach, describe, expect, it } from "vitest";
import type { Page } from "playwright";
import { createPlaywrightBrowser } from "./playwrightBrowser.js";

function pageWithInProcessEvaluate(): Page {
  return {
    evaluate: async <T>(fn: () => T): Promise<T> => fn(),
  } as unknown as Page;
}

describe("extractResultRows header seam", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("reads the published grid header onto each result row", async () => {
    document.body.innerHTML = `
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
    `;
    const rows = await createPlaywrightBrowser(
      pageWithInProcessEvaluate(),
    ).extractResultRows();
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
    document.body.innerHTML = `
      <table>
        <tbody>
          <tr>
            <td>2024-12345</td>
            <td>SMITH JOHN A</td>
            <td>WARRANTY DEED</td>
          </tr>
        </tbody>
      </table>
    `;
    const rows = await createPlaywrightBrowser(
      pageWithInProcessEvaluate(),
    ).extractResultRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.headers).toBeNull();
  });
});
