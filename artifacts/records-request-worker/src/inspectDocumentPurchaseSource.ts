/**
 * Browser-side document-surface inspect as a string. Same rule as
 * extractResultRows: a compiled function serializes tsx `__name` into
 * Chromium. Do not use page.content() — that is the ambient HTML scan.
 */
export const INSPECT_DOCUMENT_PURCHASE_SOURCE = `(() => {
  const chromeSel =
    "nav, header, footer, [role=navigation], [role=banner], [role=contentinfo]";
  const isChrome = (el) => !!el.closest(chromeSel);

  const main =
    document.querySelector("main, [role=main], .document-viewer, #document") ||
    document.body;

  const controls = [];
  for (const el of main.querySelectorAll(
    "button, a, [role=button], input[type=submit]",
  )) {
    if (isChrome(el)) continue;
    const t = (
      el.innerText ||
      el.value ||
      el.getAttribute("aria-label") ||
      ""
    ).trim();
    if (t) controls.push(t);
  }

  let visibleMainText = "";
  if (main !== document.body) {
    visibleMainText = (main.innerText || "").trim();
  } else {
    const parts = [];
    for (const child of document.body.children) {
      if (isChrome(child)) continue;
      const t = (child.innerText || "").trim();
      if (t) parts.push(t);
    }
    visibleMainText = parts.join("\\n");
  }

  return {
    visibleMainText,
    visibleMainControls: controls,
    rowPriceText: null,
  };
})()`;
