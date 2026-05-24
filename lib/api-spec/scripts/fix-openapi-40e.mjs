import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..", "..", "..");
const outPath = path.resolve(__dirname, "..", "openapi.yaml");

const head = execSync("git show HEAD:lib/api-spec/openapi.yaml", {
  cwd: repoRoot,
  encoding: "utf8",
});

let yaml = head;

// Backticks + `<uuid>` in property descriptions break orval's OpenAPI loader (XML parse).
yaml = yaml.replaceAll("`/objects/uploads/<uuid>`", "/objects/uploads/{uuid}");
yaml = yaml.replaceAll("/objects/uploads/<uuid>", "/objects/uploads/{uuid}");
yaml = yaml.replace(
  "description: `/objects/uploads/{uuid}` path for kickoff.",
  "description: Path under /objects/uploads/{uuid} for kickoff.",
);

// Invalid discriminator: two `still` variants share `kind: still`.
yaml = yaml.replace(
  /      discriminator:\r?\n        propertyName: kind\r?\n        mapping:\r?\n          still: "#\/components\/schemas\/KickoffRenderStillBody"\r?\n          elevation-set: "#\/components\/schemas\/KickoffRenderElevationSetBody"\r?\n          video: "#\/components\/schemas\/KickoffRenderVideoBody"\r?\n/,
  `      description: |
        Union by \`kind\`. Two \`still\` shapes share the same discriminator
        value — GLB capture (\`glbUrl\` + camera) vs upload (\`sourceUploadUrl\`);
        clients disambiguate on presence of those fields (doc 40e A.5).
`,
);

fs.writeFileSync(outPath, yaml, "utf8");
console.log("wrote", outPath, "bytes", yaml.length);
