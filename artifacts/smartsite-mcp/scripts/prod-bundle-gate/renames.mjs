// Lists identifiers the production bundle renamed (numeric suffix) that the served page references but never declares.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function undeclaredRenames(bundle, page) {
  const renamed = new Set();
  for (const m of bundle.matchAll(
    /(?:function|var|let|const|class)\s+([A-Za-z_$][\w$]*?\d+)\b/g,
  )) {
    renamed.add(m[1]);
  }
  const out = [];
  for (const id of renamed) {
    const esc = id.replace(/\$/g, "\\$");
    const uses = (page.match(new RegExp("\\b" + esc + "\\b", "g")) || []).length;
    if (!uses) continue;
    const declared = new RegExp(
      "(?:function|var|let|const|class)\\s+" + esc + "\\b",
    ).test(page);
    if (!declared) out.push({ id, uses });
  }
  return out;
}

const here = path.dirname(fileURLToPath(import.meta.url));

export function selfTestRenames() {
  const planted = undeclaredRenames("function fooBar2(){} var baz3=1;", "fooBar2(); var baz3=2; baz3;");
  if (planted.length !== 1 || planted[0].id !== "fooBar2") {
    throw new Error(`rename detector self-test failed: ${JSON.stringify(planted)}`);
  }
}

