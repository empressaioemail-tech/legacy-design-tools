/**
 * Exit 1 when customer prose contains internal text.
 * Usage: node check-prose.mjs <text-file> [parcelNodeId]
 */
import { readFileSync } from "node:fs";
import { customerProseViolations } from "./prose-violations.mjs";

const file = process.argv[2];
const parcelNodeId = process.argv[3] || "";
if (!file) {
  console.error("usage: node check-prose.mjs <text-file> [parcelNodeId]");
  process.exit(2);
}
const text = readFileSync(file, "utf8");
const violations = customerProseViolations(text, parcelNodeId);
const kinds = [...new Set(violations.map((v) => v.kind))];
console.log(JSON.stringify({ file, parcelNodeId, count: violations.length, kinds }, null, 2));
process.exit(violations.length ? 1 : 0);
