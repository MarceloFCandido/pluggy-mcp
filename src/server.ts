import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import {
  ajv,
  operations,
  operationByName,
  validateArguments,
} from "./catalog.js";
import { PluggyClient } from "./client.js";
import { cachedOperations, Storage } from "./storage.js";
import { Synchronizer } from "./sync.js";
import { AppError, type Config, type JsonObject } from "./types.js";

const uuid = { type: "string", format: "uuid" };
const ids = {
  type: "array",
  items: uuid,
  minItems: 1,
  uniqueItems: true,
  maxItems: 1000,
};
const object = (properties: JsonObject, required: string[] = []) => ({
  type: "object" as const,
  properties,
  required,
  additionalProperties: false,
});
const filterProperties = {
  itemIds: ids,
  accountIds: ids,
  dateFrom: { type: "string", format: "date" },
  dateTo: { type: "string", format: "date" },
  type: { type: "string", enum: ["CREDIT", "DEBIT"] },
  status: { type: "string", enum: ["POSTED", "PENDING"] },
  currencyCode: { type: "string", pattern: "^[A-Z]{3}$" },
  categoryId: { type: "string" },
};

const localTools: Tool[] = [
  {
    name: "pluggy_capabilities",
    description:
      "Inspect the server mode, enabled writes, registered item IDs, API coverage, supported database reads, and account limitations. Never returns credentials or the PostgreSQL connection string.",
    inputSchema: object({}),
    annotations: { readOnlyHint: true },
  },
  {
    name: "pluggy_sync",
    description:
      "Synchronize configured items (or a selected subset) from Pluggy to PostgreSQL. Follows every page. Does not refresh a bank connection. Inspect complete, per-product errors, and pending events. May take several minutes.",
    inputSchema: object({
      itemIds: ids,
      retryEvents: {
        type: "boolean",
        description:
          "Reset failed webhook attempts so the background worker can retry them.",
      },
    }),
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
    },
  },
  {
    name: "pluggy_sync_status",
    description:
      "Inspect synchronized collections, last successful sync timestamps, errors, and pending or failed webhook events in PostgreSQL.",
    inputSchema: object({}),
    annotations: { readOnlyHint: true },
  },
  {
    name: "pluggy_query_transactions",
    description:
      "Query synchronized PostgreSQL transactions using bounded, structured filters. Returns original Pluggy records with freshness metadata. No arbitrary SQL. Does not fetch live transactions or infer household spending.",
    inputSchema: object({
      ...filterProperties,
      limit: { type: "integer", minimum: 1, maximum: 500, default: 100 },
      cursor: {
        type: "string",
        description:
          "Use nextCursor from the previous page with the same filters. Restart after a sync changes the data.",
      },
    }),
    annotations: { readOnlyHint: true },
  },
  {
    name: "pluggy_summarize_transactions",
    description:
      "Aggregate synchronized transactions with exact decimal sums. Always separates accounts and currencies: bank debits and credit-card charges use different signs. Transfers and card bill payments remain included unless filtered out; these are raw totals, not household spending.",
    inputSchema: object({
      ...filterProperties,
      groupBy: {
        type: "array",
        uniqueItems: true,
        items: {
          type: "string",
          enum: [
            "currencyCode",
            "accountId",
            "type",
            "status",
            "category",
            "categoryId",
            "month",
          ],
        },
      },
    }),
    annotations: { readOnlyHint: true },
  },
];
const localValidators = new Map(
  localTools.map((tool) => [tool.name, ajv.compile(tool.inputSchema)]),
);
const mirrorWrites = new Set([
  "items-update",
  "items-delete",
  "items-send-mfa",
  "transactions-Update",
  "client-category-rules-create",
  "client-category-rules-delete",
]);

function result(value: JsonObject, isError = false): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
    structuredContent: value,
    ...(isError ? { isError: true } : {}),
  };
}

export function createServer(
  config: Config,
  client: PluggyClient,
  storage?: Storage,
  sync?: Synchronizer,
): Server {
  const apiTools: Tool[] = operations
    .filter((op) => op.id !== "auth-create")
    .map((op) => ({
      name: op.name,
      description: `${op.method} ${op.path} (${op.tag}). ${op.summary}. ${op.description.slice(0, 1500)}${op.deprecated ? " Deprecated; prefer the cursor-based replacement." : ""}${op.method !== "GET" && !config.allowWrites ? " Disabled until PLUGGY_ALLOW_WRITES=true is configured by the operator." : ""}`,
      inputSchema: op.inputSchema as Tool["inputSchema"],
      annotations: {
        readOnlyHint: op.method === "GET",
        destructiveHint: op.method !== "GET",
        idempotentHint: op.method === "GET",
        openWorldHint: true,
      },
    }));
  const tools = [
    ...apiTools,
    ...localTools.filter(
      (tool) => storage || tool.name === "pluggy_capabilities",
    ),
  ];
  const server = new Server(
    { name: "pluggy-mcp", version: "1.0.0" },
    {
      capabilities: { tools: {}, resources: {} },
      instructions:
        "Use pluggy_capabilities first. API operations are named after the pinned OpenAPI operation IDs, with path/query/body argument groups. Financial GET tools default to synchronized PostgreSQL when configured; source can explicitly select api. An unsynchronized database produces an error, never an empty financial result. Inspect freshness and partial-sync errors. Use exact account and item IDs, preserve currencies, and distinguish POSTED/PENDING. Get human approval for writes through the MCP client's approval controls; PLUGGY_ALLOW_WRITES is an operator-level permission, not approval of a particular action. Never request credentials in chat. Documentation tools are available separately at https://mcp.pluggy.ai/mcp.",
    },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: [
      {
        uri: "pluggy://operations",
        name: "Pluggy API coverage",
        mimeType: "application/json",
        description:
          "Complete API catalog, tool names, origins, and database support. API-key generation is internal.",
      },
    ],
  }));
  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    if (request.params.uri !== "pluggy://operations")
      throw new AppError("UNKNOWN_RESOURCE", "Unknown resource.");
    return {
      contents: [
        {
          uri: request.params.uri,
          mimeType: "application/json",
          text: JSON.stringify(
            operations.map((op) => ({
              operationId: op.id,
              tool: op.id === "auth-create" ? null : op.name,
              method: op.method,
              path: op.path,
              service: op.service,
              tag: op.tag,
              database: !!cachedOperations[op.id],
              internal: op.id === "auth-create",
            })),
            null,
            2,
          ),
        },
      ],
    };
  });
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const input = request.params.arguments ?? {};
    try {
      const op = operationByName.get(request.params.name);
      if (op) {
        const args = validateArguments(op, input);
        const source = args.source ?? "auto";
        if (
          op.method === "GET" &&
          source !== "api" &&
          (source === "database" || (storage && cachedOperations[op.id]))
        ) {
          if (!storage)
            throw new AppError(
              "DATABASE_NOT_CONFIGURED",
              "Set DATABASE_URL to enable PostgreSQL.",
            );
          return result(await storage.read(op, args));
        }
        if (
          storage &&
          config.allowWrites &&
          op.method !== "GET" &&
          mirrorWrites.has(op.id)
        )
          return result(
            await storage.withSyncLock(async () => {
              // Persist invalidation before attempting a remote mutation, including uncertain outcomes.
              // Synchronization cannot make an old snapshot readable while this write is in progress.
              await storage.invalidate();
              const data = await client.request(op, args);
              try {
                if (op.id === "items-delete")
                  await storage.deleteItem(String(args.path!.id));
              } catch {
                return {
                  source: "api",
                  data,
                  warning:
                    "API_WRITE_SUCCEEDED_DATABASE_MAINTENANCE_FAILED. Do not repeat the write. Synchronize before reading cached data.",
                };
              }
              return {
                source: "api",
                fetchedAt: new Date().toISOString(),
                data,
                databaseInvalidated: true,
              };
            }),
          );
        return result({
          source: "api",
          fetchedAt: new Date().toISOString(),
          data: await client.request(op, args),
        });
      }
      const validate = localValidators.get(request.params.name);
      if (!validate || !tools.some((tool) => tool.name === request.params.name))
        throw new AppError("UNKNOWN_TOOL", "Unknown or unavailable tool.");
      if (!validate(input))
        throw new AppError(
          "INVALID_ARGUMENTS",
          "Arguments do not match the tool schema.",
          validate.errors?.map((e) => ({
            path: e.instancePath,
            message: e.message,
          })),
        );
      if (
        input.dateFrom &&
        input.dateTo &&
        String(input.dateFrom) > String(input.dateTo)
      )
        throw new AppError(
          "INVALID_ARGUMENTS",
          "dateFrom must be on or before dateTo.",
        );
      for (const key of ["itemIds", "accountIds"])
        if (Array.isArray(input[key]))
          input[key] = (input[key] as string[]).map((id) => id.toLowerCase());
      switch (request.params.name) {
        case "pluggy_capabilities":
          return result({
            mode: storage ? "postgresql" : "api",
            writesEnabled: config.allowWrites,
            enrichmentConfigured: !!config.enrichmentApiKey,
            operations: operations.length,
            apiTools: apiTools.length,
            itemIds: storage ? await storage.itemIds() : config.itemIds,
            databaseOperations: Object.keys(cachedOperations),
            limits: [
              "Endpoint availability depends on your Pluggy plan, connector, and consent.",
              "Meu Pluggy cannot list all items or manually refresh proxy items.",
              "API-key generation is internal.",
              "Connection health and real-time balances always use the API. Payment initiation and application administration are not exposed.",
            ],
          });
        case "pluggy_sync": {
          const synced = await sync!.sync(
            input.itemIds as string[] | undefined,
            input.retryEvents === true,
          );
          return result(synced);
        }
        case "pluggy_sync_status":
          return result(await storage!.status());
        case "pluggy_query_transactions":
        case "pluggy_summarize_transactions":
          return result(
            await storage!.transactions(
              input,
              request.params.name === "pluggy_summarize_transactions",
            ),
          );
        default:
          throw new AppError("UNKNOWN_TOOL", "Unknown tool.");
      }
    } catch (error) {
      if (error instanceof AppError)
        return result(
          {
            error: {
              code: error.code,
              message: error.message,
              details: error.details,
            },
          },
          true,
        );
      console.error(
        "Pluggy MCP operation failed; inspect server configuration and database availability.",
      );
      return result(
        {
          error: {
            code: "OPERATION_FAILED",
            message:
              "Operation failed. Check API/database availability and server configuration; no credentials are included in this error.",
          },
        },
        true,
      );
    }
  });
  return server;
}
