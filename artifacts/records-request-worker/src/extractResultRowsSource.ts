/**
 * Browser-side extract as a string. page.evaluate of a compiled function
 * serializes tsx/esbuild `__name` into Chromium and throws
 * `ReferenceError: __name is not defined`. A string expression is the
 * evaluate payload that cannot carry that helper.
 *
 * Playwright evaluates a string as an expression, so this is an IIFE.
 *
 * Aumentum/Telerik RadGrid splits header and data into sibling tables.
 * closest("table") on a data row finds the data table, which has no th.
 * Headers are read from the RadGrid ancestor, not from that table alone.
 */
export const EXTRACT_RESULT_ROWS_SOURCE = `(() => {
  const headerTexts = (nodes) =>
    [...nodes].map((n) => n.textContent?.trim() ?? "");

  const uniqueHeaderTexts = (nodes) => {
    const texts = headerTexts(nodes).filter((t) => t.length > 0);
    const seen = new Set();
    const out = [];
    for (const t of texts) {
      if (seen.has(t)) continue;
      seen.add(t);
      out.push(t);
    }
    return out;
  };

  const isChromeRow = (rowEl, cells) => {
    const text = cells.join(" ").toLowerCase();
    if (text.includes("drag a column here")) return true;
    if (rowEl.classList?.contains("rgFilterRow")) return true;
    if (rowEl.classList?.contains("rgGroupHeader")) return true;
    if (rowEl.classList?.contains("rgPager")) return true;
    if (rowEl.closest("thead")) return true;
    return false;
  };

  const headersIn = (root) => {
    if (!root) return null;
    const thead = root.querySelectorAll("thead th, thead [role=columnheader]");
    if (thead.length > 0) return uniqueHeaderTexts(thead);
    const rg = root.querySelectorAll("th.rgHeader, .rgHeader");
    if (rg.length > 0) return uniqueHeaderTexts(rg);
    const cols = root.querySelectorAll('[role="columnheader"], th');
    if (cols.length > 0) return uniqueHeaderTexts(cols);
    return null;
  };

  const headersForRow = (rowEl) => {
    const table = rowEl.closest("table");
    const fromTable = headersIn(table);
    if (fromTable && fromTable.length > 0) return fromTable;

    const grid = rowEl.closest(
      ".RadGrid, [class*='RadGrid'], [role='grid'], [role='table'], .search-results, .results-table, .dx-datagrid",
    );
    const fromGrid = headersIn(grid);
    if (fromGrid && fromGrid.length > 0) return fromGrid;

    const parent = table?.parentElement ?? rowEl.parentElement;
    const fromParent = headersIn(parent);
    if (fromParent && fromParent.length > 0) return fromParent;

    return null;
  };

  const rows = [];
  const selectors = [
    "table tbody tr.rgRow",
    "table tbody tr.rgAltRow",
    "table tbody tr",
    ".search-results tr",
    '[role="row"]',
    ".results-table tr",
  ];
  const seen = new Set();
  for (const sel of selectors) {
    for (const tr of document.querySelectorAll(sel)) {
      if (seen.has(tr)) continue;
      seen.add(tr);
      if (tr.querySelectorAll("th").length > 0 && tr.querySelectorAll("td").length === 0) {
        continue;
      }
      const cells = [...tr.querySelectorAll("td, [role=cell]")].map(
        (c) => c.textContent?.trim() ?? "",
      );
      if (cells.length < 2) continue;
      if (isChromeRow(tr, cells)) continue;
      const anchor = tr.querySelector("a[href]");
      const link = anchor instanceof HTMLAnchorElement ? anchor.href : null;
      rows.push({ cells, link, headers: headersForRow(tr) });
    }
  }
  return rows;
})()`;
