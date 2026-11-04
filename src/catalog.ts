import { readFileSync } from "node:fs";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { UUID } from "./config.js";
import {
  AppError,
  type Arguments,
  type JsonObject,
  type Operation,
} from "./types.js";

const spec: JsonObject = JSON.parse(
  readFileSync(new URL("../spec/pluggy-openapi.json", import.meta.url), "utf8"),
);

function resolve(value: JsonObject): JsonObject {
  if (!value.$ref) return value;
  if (!value.$ref.startsWith("#/"))
    throw new Error("Only local OpenAPI references are supported.");
  const target = value.$ref
    .slice(2)
    .split("/")
    .reduce(
      (node: any, key: string) =>
        node[key.replace(/~1/g, "/").replace(/~0/g, "~")],
      spec,
    );
  if (!target) throw new Error(`Unresolved OpenAPI reference: ${value.$ref}`);
  const { $ref, ...siblings } = value;
  return { ...resolve(target), ...siblings };
}

// Inline the pinned spec's acyclic references so every client receives a self-contained schema.
function schema(value: any): any {
  if (Array.isArray(value)) return value.map(schema);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(resolve(value))
      .filter(
        ([key]) => !["example", "examples", "discriminator"].includes(key),
      )
      .map(([key, child]) => [key, schema(child)]),
  );
}

function inputSchema(
  op: JsonObject,
  inherited: JsonObject[],
): { inputSchema: JsonObject; parameters: JsonObject[] } {
  const properties: JsonObject = {};
  const required: string[] = [];
  const parameters = [...inherited, ...(op.parameters ?? [])].map(resolve);
  if (parameters.some((p) => !["path", "query"].includes(p.in)))
    throw new Error(`Unsupported parameter location: ${op.operationId}`);
  for (const location of ["path", "query"]) {
    const selected = parameters.filter((p) => p.in === location);
    if (!selected.length) continue;
    const group: JsonObject = {
      type: "object",
      properties: {},
      additionalProperties: false,
    };
    const groupRequired = selected.filter((p) => p.required).map((p) => p.name);
    for (const parameter of selected) {
      const definition = schema(parameter.schema ?? {});
      // The spec labels these as date-time, but explicitly documents YYYY-MM-DD values.
      if (
        ["from", "to", "dateFrom", "dateTo"].includes(parameter.name) &&
        definition.format === "date-time"
      )
        definition.format = "date";
      group.properties[parameter.name] = {
        ...definition,
        description: parameter.description,
      };
    }
    if (groupRequired.length) {
      group.required = groupRequired;
      required.push(location);
    }
    properties[location] = group;
  }
  if (op.requestBody) {
    const body = resolve(op.requestBody);
    const definition = body.content?.["application/json"]?.schema;
    if (!definition)
      throw new Error(`Missing JSON request schema: ${op.operationId}`);
    properties.body = schema(definition);
    if (body.required) required.push("body");
  }
  if (op.method === "GET")
    properties.source = {
      type: "string",
      enum: ["auto", "api", "database"],
      default: "auto",
      description:
        "auto uses synchronized PostgreSQL data for supported financial reads when DATABASE_URL is set; api explicitly reads Pluggy; database requires a supported, successfully synchronized collection.",
    };
  return {
    inputSchema: {
      type: "object",
      properties,
      additionalProperties: false,
      ...(required.length ? { required } : {}),
    },
    parameters,
  };
}

// Keep the household-finance surface explicit; new upstream products need a deliberate review.
const householdPaths = new Set([
  "/auth",
  "/connectors",
  "/connectors/{id}",
  "/items",
  "/items/{id}",
  "/items/{id}/resources",
  "/items/{id}/mfa",
  "/items/{id}/disable-auto-sync",
  "/items/{id}/scr",
  "/v2/items",
  "/consents",
  "/consents/{id}",
  "/accounts",
  "/accounts/{id}",
  "/accounts/{id}/balance",
  "/transactions",
  "/v2/transactions",
  "/transactions/{id}",
  "/investments",
  "/investments/{id}",
  "/investments/{id}/transactions",
  "/identity",
  "/identity/{id}",
  "/categories",
  "/categories/{id}",
  "/categories/rules",
  "/categories/rules/{id}",
  "/loans",
  "/loans/{id}",
  "/merchants",
  "/bills",
  "/bills/{id}",
]);

export const operations: Operation[] = Object.entries(spec.paths)
  .filter(([path]) => householdPaths.has(path))
  .flatMap(([path, entry]: [string, any]) =>
    Object.entries(entry)
      .filter(([method]) =>
        ["get", "post", "patch", "put", "delete"].includes(method),
      )
      .map(([method, raw]: [string, any]) => {
        const op = { ...raw, method: method.toUpperCase() };
        return {
          id: op.operationId,
          name: `pluggy_${op.operationId.replace(/[^a-zA-Z0-9_]/g, "_").toLowerCase()}`,
          method: op.method,
          path,
          service: "api" as const,
          tag: op.tags?.[0] ?? "General",
          summary: op.summary ?? op.operationId,
          description: op.description ?? "",
          deprecated: !!op.deprecated,
          ...inputSchema(op, entry.parameters ?? []),
        };
      }),
  );

// These separately hosted products are documented in the reference but absent from the main OAS.
const extras: JsonObject[] = JSON.parse(
  readFileSync(
    new URL("../spec/additional-operations.json", import.meta.url),
    "utf8",
  ),
);
for (const extra of extras) {
  const { parameters, ...input } = inputSchema(extra, []);
  operations.push({
    id: extra.operationId,
    name: `pluggy_${extra.operationId.replace(/-/g, "_")}`,
    method: extra.method,
    path: extra.path,
    service: extra.service,
    tag: extra.tags[0],
    summary: extra.summary,
    description: extra.description,
    deprecated: false,
    parameters,
    ...input,
  });
}

if (new Set(operations.map((op) => op.name)).size !== operations.length)
  throw new Error("Duplicate tool names in the API catalog.");

export const operationById = new Map(operations.map((op) => [op.id, op]));
export const operationByName = new Map(
  operations.filter((op) => op.id !== "auth-create").map((op) => [op.name, op]),
);
export const ajv = new Ajv2020({
  strict: false,
  allErrors: true,
  validateFormats: true,
});
(addFormats as unknown as (instance: Ajv2020) => void)(ajv);
ajv.addFormat("double", { type: "number", validate: Number.isFinite });
ajv.addFormat("integer", { type: "number", validate: Number.isInteger });
const validators = new Map(
  operations.map((op) => [op.id, ajv.compile(op.inputSchema)]),
);

export function validateArguments(
  operation: Operation,
  input: unknown,
): Arguments {
  const validate = validators.get(operation.id)!;
  if (!validate(input))
    throw new AppError(
      "INVALID_ARGUMENTS",
      "Arguments do not match the endpoint schema.",
      validate.errors?.map((e) => ({
        path: e.instancePath,
        message: e.message,
        keyword: e.keyword,
      })),
    );
  const args = input as Arguments;
  for (const group of [args.path, args.query]) {
    if (!group) continue;
    for (const key of ["id", "itemId", "accountId", "investmentId", "billId"]) {
      if (typeof group[key] === "string" && UUID.test(group[key]))
        group[key] = group[key].toLowerCase();
    }
    if (Array.isArray(group.ids))
      group.ids = group.ids.map((id: string) =>
        UUID.test(id) ? id.toLowerCase() : id,
      );
  }
  if (
    operation.id === "transactions-list-by-cursor" &&
    args.query?.dateFrom &&
    args.query?.createdAtFrom
  ) {
    throw new AppError(
      "INVALID_ARGUMENTS",
      "dateFrom and createdAtFrom cannot be combined.",
    );
  }
  if (args.query?.ids?.length > 500)
    throw new AppError(
      "INVALID_ARGUMENTS",
      "At most 500 IDs can be requested at once.",
    );
  const from = args.query?.dateFrom ?? args.query?.from;
  const to = args.query?.dateTo ?? args.query?.to;
  if (from && to && from > to)
    throw new AppError(
      "INVALID_ARGUMENTS",
      "The start date must be on or before the end date.",
    );
  return args;
}
