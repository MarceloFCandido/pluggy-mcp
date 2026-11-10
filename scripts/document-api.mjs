import { writeFile } from "node:fs/promises";
import { operations } from "../dist/catalog.js";
import { cachedOperations } from "../dist/storage.js";

const lines = [
  "# API coverage",
  "",
  "Generated from the household-finance selection in the pinned OpenAPI catalog and the separately documented status/enrichment operations. Run `npm run docs:api` after updating the catalog.",
  "",
  "Tool arguments use `path`, `query`, and `body` groups. Financial read tools also accept `source`: `auto`, `api`, or `database`. Inspect the tool schema for the complete parameters. API-key generation stays internal. Payment initiation, boleto issuing, credit-risk analysis, connect-token generation, connector credential validation, and webhook administration are excluded. Connection health always uses the API; cached account balances reflect their synchronization time.",
  "",
  "| API | Operation ID | MCP tool | PostgreSQL reads |",
  "| --- | --- | --- | --- |",
];
for (const op of operations)
  lines.push(
    `| ${op.method} \`${op.path}\` | \`${op.id}\` | ${op.id === "auth-create" ? "Internal authentication" : `\`${op.name}\``} | ${cachedOperations[op.id] ? "Yes" : "Live API"} |`,
  );
await writeFile(
  new URL("../docs/API.md", import.meta.url),
  lines.join("\n") + "\n",
);
console.log(`Documented ${operations.length} operations.`);
