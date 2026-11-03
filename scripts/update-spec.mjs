import { readFile, writeFile, rename } from "node:fs/promises";

const destination = new URL("../spec/pluggy-openapi.json", import.meta.url);
const response = await fetch("https://api.pluggy.ai/oas3.json", {
  signal: AbortSignal.timeout(30_000),
  redirect: "error",
});
if (!response.ok)
  throw new Error(`OpenAPI download failed: HTTP ${response.status}`);
const document = await response.json();
if (
  !document.openapi?.startsWith("3.") ||
  !document.paths ||
  !document.components?.schemas
)
  throw new Error(
    "Unexpected OpenAPI document; existing snapshot was left unchanged.",
  );
const previous = JSON.parse(await readFile(destination, "utf8"));
const ids = (spec) =>
  Object.values(spec.paths).flatMap((path) =>
    Object.entries(path)
      .filter(([method]) =>
        ["get", "post", "put", "patch", "delete"].includes(method),
      )
      .map(([, op]) => op.operationId),
  );
const before = new Set(ids(previous));
const after = new Set(ids(document));
if (
  [...after].some((id) => typeof id !== "string") ||
  after.size !== ids(document).length
)
  throw new Error(
    "Missing or duplicate operation IDs; existing snapshot was left unchanged.",
  );
const temporary = new URL("../spec/pluggy-openapi.json.tmp", import.meta.url);
await writeFile(temporary, JSON.stringify(document, null, 2) + "\n");
await rename(temporary, destination);
console.log(
  JSON.stringify(
    {
      operations: after.size,
      added: [...after].filter((id) => !before.has(id)),
      removed: [...before].filter((id) => !after.has(id)),
    },
    null,
    2,
  ),
);
console.log(
  "Review the spec diff, then run npm test, npm run test:postgres, and npm run docs:api. No spec is downloaded at server startup.",
);
