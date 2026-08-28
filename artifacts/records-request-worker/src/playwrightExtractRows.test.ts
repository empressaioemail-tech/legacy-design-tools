/// <reference lib="dom" />
/**
 * @vitest-environment happy-dom
 *
 * Runs the same string Playwright evaluates in Chromium. A function
 * callback is refused: tsx serializes `__name` into page.evaluate and
 * production Chromium throws ReferenceError.
 */
import { beforeEach, describe, expect, it } from "vitest";
import type { Page } from "playwright";
import { EXTRACT_RESULT_ROWS_SOURCE } from "./extractResultRowsSource.js";
import { createPlaywrightBrowser } from "./playwrightBrowser.js";

function pageWithStringEvaluate(): Page {
  return {
    evaluate: async (payload: unknown): Promise<unknown> => {
      if (typeof payload !== "string") {
        throw new Error(
          "extractResultRows must pass a string to page.evaluate; a function serializes tsx __name into Chromium",
        );
      }
      if (payload.includes("__name")) {
        throw new Error(
          "evaluate source contains __name; Chromium will throw ReferenceError",
        );
      }
      return new Function(`return (${payload})`)();
    },
  } as unknown as Page;
}

describe("extractResultRows header seam", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("evaluate payload is a string without __name", () => {
    expect(typeof EXTRACT_RESULT_ROWS_SOURCE).toBe("string");
    expect(EXTRACT_RESULT_ROWS_SOURCE.includes("__name")).toBe(false);
    expect(EXTRACT_RESULT_ROWS_SOURCE.startsWith("(() =>")).toBe(true);
  });

  it("passes a string evaluate payload, not a function", async () => {
    const page = {
      evaluate: async (payload: unknown) => {
        if (typeof payload !== "string") {
          throw new Error("function payload");
        }
        return [];
      },
    } as unknown as Page;
    const browser = createPlaywrightBrowser(page);
    await expect(browser.extractResultRows()).resolves.toEqual([]);
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
      pageWithStringEvaluate(),
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

  it("reads Telerik split-table headers from the RadGrid ancestor", async () => {
    document.body.innerHTML = `
      <div class="RadGrid">
        <div class="rgGroupPanel">
          <table><tbody><tr><td>Drag a column here to group by.</td><td></td></tr></tbody></table>
        </div>
        <div class="rgHeaderWrapper">
          <table class="rgMasterTable">
            <thead>
              <tr>
                <th class="rgHeader">Instrument #</th>
                <th class="rgHeader">Date Filed</th>
                <th class="rgHeader">Document Type</th>
                <th class="rgHeader">Name</th>
              </tr>
            </thead>
          </table>
        </div>
        <div class="rgDataDiv">
          <table class="rgMasterTable">
            <tbody>
              <tr class="rgRow">
                <td><a href="/doc/1">202008880</a></td>
                <td>06/05/2020</td>
                <td>DEED</td>
                <td>PALMS PROPERTIES LLC</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    `;
    const rows = await createPlaywrightBrowser(
      pageWithStringEvaluate(),
    ).extractResultRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.headers).toEqual([
      "Instrument #",
      "Date Filed",
      "Document Type",
      "Name",
    ]);
    expect(rows[0]?.cells[2]).toBe("DEED");
    expect(rows[0]?.headers).not.toBeNull();
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
      pageWithStringEvaluate(),
    ).extractResultRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.headers).toBeNull();
  });
});
