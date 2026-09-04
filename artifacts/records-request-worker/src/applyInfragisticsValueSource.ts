/**
 * Browser-side Infragistics editor write as a string. page.evaluate of a
 * compiled function serializes tsx `__name` into Chromium. Playwright
 * fill() sets the input DOM value; Infragistics watermarks ignore that
 * unless `$find(id).set_value` also runs. Readback is the second signal.
 */
export function applyInfragisticsValueSource(
  selector: string,
  value: string,
): string {
  return `(() => {
    const sel = ${JSON.stringify(selector)};
    const val = ${JSON.stringify(value)};
    const el = document.querySelector(sel);
    if (!el) return { ok: false, read: null, reason: "missing" };
    const id = el.id;
    const find = window.$find;
    if (id && typeof find === "function") {
      const ed = find(id);
      if (ed && typeof ed.set_value === "function") {
        ed.set_value(val);
      }
    }
    const read = String(el.value ?? "").trim();
    return { ok: read === String(val).trim(), read };
  })()`;
}
