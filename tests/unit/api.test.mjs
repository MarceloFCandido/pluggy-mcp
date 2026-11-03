import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../../dist/config.js";
import {
  operations,
  operationById,
  validateArguments,
} from "../../dist/catalog.js";
import { PluggyClient, ApiError } from "../../dist/client.js";
import { createServer } from "../../dist/server.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

export const itemId = "00000000-0000-4000-8000-000000000001";
export const accountId = "00000000-0000-4000-8000-000000000002";
const config = (extra = {}) =>
  loadConfig({
    PLUGGY_CLIENT_ID: "test-client",
    PLUGGY_CLIENT_SECRET: "secret-never-echo",
    ...extra,
  });
const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });

test("every pinned API operation has a unique, valid, self-contained tool schema", () => {
  const spec = JSON.parse(
    readFileSync(new URL("../../spec/pluggy-openapi.json", import.meta.url)),
  );
  const expected = Object.values(spec.paths).flatMap((path) =>
    Object.entries(path)
      .filter(([method]) =>
        ["get", "post", "put", "patch", "delete"].includes(method),
      )
      .map(([, op]) => op.operationId),
  );
  for (const id of expected) assert.ok(operationById.has(id), id);
  assert.equal(operations.length, expected.length + 6);
  assert.equal(
    new Set(operations.map((op) => op.name)).size,
    operations.length,
  );
  for (const op of operations) {
    assert.match(op.name, /^[a-zA-Z0-9_-]{1,64}$/);
    assert.equal(
      JSON.stringify(op.inputSchema).includes('"$ref"'),
      false,
      op.id,
    );
  }
});

test("configuration rejects missing credentials, accidental write flags, and unsupported database options", () => {
  assert.throws(() => loadConfig({}), /PLUGGY_CLIENT_ID/);
  assert.throws(() => config({ PLUGGY_ALLOW_WRITES: "yes" }), /true or false/);
  assert.throws(
    () => config({ DATABASE_URL: "https://example.test" }),
    /PostgreSQL/,
  );
  assert.throws(() => config({ PLUGGY_ITEM_IDS: "not-a-uuid" }), /UUID/);
  assert.throws(
    () => config({ PLUGGY_SYNC_INTERVAL_SECONDS: "60" }),
    /DATABASE_URL/,
  );
  assert.throws(
    () =>
      config({
        DATABASE_URL: "postgresql://localhost/test",
        PLUGGY_WEBHOOK_PORT: "3000",
        PLUGGY_WEBHOOK_SECRET: "short",
      }),
    /32 characters/,
  );
});

test("endpoint validation handles referenced bodies, documented dates, and incompatible filters", () => {
  assert.throws(
    () => validateArguments(operationById.get("accounts-list"), {}),
    /schema/,
  );
  assert.throws(
    () => validateArguments(operationById.get("webhooks-create"), { body: {} }),
    /schema/,
  );
  validateArguments(operationById.get("transactions-list-by-cursor"), {
    query: { accountId, dateFrom: "2026-11-01" },
  });
  assert.throws(
    () =>
      validateArguments(operationById.get("transactions-list-by-cursor"), {
        query: {
          accountId,
          dateFrom: "2026-11-01",
          createdAtFrom: "2026-11-01T00:00:00Z",
        },
      }),
    /cannot be combined/,
  );
  assert.throws(
    () =>
      validateArguments(operationById.get("transactions-list-by-cursor"), {
        query: { accountId, dateFrom: "2026-02-30" },
      }),
    /schema/,
  );
});

test("concurrent reads share authentication and serialize query parameters without injecting filters", async () => {
  const calls = [];
  const client = new PluggyClient(config(), async (url, init) => {
    calls.push({ url, init });
    return json(
      String(url).endsWith("/auth")
        ? { apiKey: "short-lived-token" }
        : { results: [] },
    );
  });
  await Promise.all([
    client.request("accounts-list", { query: { itemId } }),
    client.request("accounts-list", { query: { itemId } }),
  ]);
  assert.equal(calls.filter((call) => call.url.endsWith("/auth")).length, 1);
  await client.request("transactions-list-by-cursor", {
    query: { accountId, ids: [itemId, accountId], after: "a+/=" },
  });
  const last = new URL(calls.at(-1).url);
  assert.equal(last.searchParams.get("ids"), `${itemId},${accountId}`);
  assert.equal(last.searchParams.get("after"), "a+/=");
  assert.equal(calls.at(-1).init.headers["X-API-KEY"], "short-lived-token");
});

test("HTTP errors are failures, and credentials and personal error text are redacted", async () => {
  const client = new PluggyClient(config(), async (url) =>
    json(
      String(url).endsWith("/auth")
        ? { apiKey: "token" }
        : {
            codeDescription: "NOT_ALLOWED",
            message: "sensitive-personal-data",
          },
      String(url).endsWith("/auth") ? 200 : 403,
    ),
  );
  await assert.rejects(
    client.request("accounts-list", { query: { itemId } }),
    (error) => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.status, 403);
      assert.equal(
        JSON.stringify(error).includes("sensitive-personal-data"),
        false,
      );
      return true;
    },
  );
});

test("a 401 refreshes the API key once; writes are gated and never retried on 503", async () => {
  let auth = 0;
  let requests = 0;
  const client = new PluggyClient(
    config({ PLUGGY_ALLOW_WRITES: "true" }),
    async (url) => {
      if (String(url).endsWith("/auth"))
        return json({ apiKey: `token-${++auth}` });
      requests++;
      return requests === 1 ? json({}, 401) : json({ results: [] });
    },
  );
  await client.request("accounts-list", { query: { itemId } });
  assert.equal(auth, 2);
  assert.equal(requests, 2);
  let mutations = 0;
  const mutation = new PluggyClient(
    config({ PLUGGY_ALLOW_WRITES: "true" }),
    async (url) =>
      String(url).endsWith("/auth")
        ? json({ apiKey: "token" })
        : (mutations++, json({}, 503)),
  );
  await assert.rejects(
    mutation.request("items-delete", { path: { id: itemId } }),
  );
  assert.equal(mutations, 1);
  const disabled = new PluggyClient(config(), async () => {
    throw new Error("Must not fetch");
  });
  await assert.rejects(
    disabled.request("items-delete", { path: { id: itemId } }),
    /PLUGGY_ALLOW_WRITES/,
  );
  await assert.rejects(
    disabled.request("auth-create", {}),
    /managed internally/,
  );
});

test("cursor pagination preserves account scope, decodes after, and rejects foreign URLs and loops", async () => {
  const queries = [];
  const client = new PluggyClient(config(), async (url) => {
    if (String(url).endsWith("/auth")) return json({ apiKey: "token" });
    const query = new URL(url).searchParams;
    queries.push(query);
    return json(
      query.has("after")
        ? { results: [{ id: "second" }], next: null }
        : {
            results: [{ id: "first" }],
            next: "?accountId=attacker&after=a%2B%2F%3D",
          },
    );
  });
  assert.deepEqual(
    await client.listAll("transactions-list-by-cursor", {
      query: { accountId },
    }),
    [{ id: "first" }, { id: "second" }],
  );
  assert.equal(queries[1].get("accountId"), accountId);
  assert.equal(queries[1].get("after"), "a+/=");
  const foreign = new PluggyClient(config(), async (url) =>
    json(
      String(url).endsWith("/auth")
        ? { apiKey: "token" }
        : { results: [], next: "https://evil.test/?after=x" },
    ),
  );
  await assert.rejects(
    foreign.listAll("transactions-list-by-cursor", { query: { accountId } }),
    /cursor/,
  );
  const loop = new PluggyClient(config(), async (url) =>
    json(
      String(url).endsWith("/auth")
        ? { apiKey: "token" }
        : { results: [], next: "?after=loop" },
    ),
  );
  await assert.rejects(
    loop.listAll("transactions-list-by-cursor", { query: { accountId } }),
    /repeated/,
  );
  const missing = new PluggyClient(config(), async (url) =>
    json(String(url).endsWith("/auth") ? { apiKey: "token" } : { results: [] }),
  );
  await assert.rejects(
    missing.listAll("transactions-list-by-cursor", { query: { accountId } }),
    /Missing or invalid/,
  );
});

test("status requests are public and enrichment never reuses the main API token", async () => {
  const requests = [];
  const client = new PluggyClient(
    config({
      PLUGGY_ALLOW_WRITES: "true",
      PLUGGY_ENRICHMENT_API_KEY: "enrichment-token",
    }),
    async (url, init) => {
      requests.push({ url, init });
      return json({});
    },
  );
  await client.request("status-summary");
  await client.request("enrichment-recurring-payments", { body: { itemId } });
  assert.equal(requests[0].url, "https://status.pluggy.ai/api/summary");
  assert.equal(requests[0].init.headers["X-API-KEY"], undefined);
  assert.equal(requests[1].init.headers["X-API-KEY"], "enrichment-token");
  assert.equal(requests.length, 2);
});

test("concurrent unauthorized responses do not invalidate an already refreshed token", async () => {
  let auth = 0;
  const api = new PluggyClient(config(), async (url, init) => {
    if (String(url).endsWith("/auth"))
      return json({ apiKey: `token-${++auth}` });
    if (init.headers["X-API-KEY"] === "token-1") {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return json({}, 401);
    }
    return json({ results: [] });
  });
  await Promise.all(
    Array.from({ length: 5 }, () =>
      api.request("accounts-list", { query: { itemId } }),
    ),
  );
  assert.equal(auth, 2);
});

test("sync page limits fail explicitly and transport errors never expose credentials", async () => {
  const api = new PluggyClient(
    config({ PLUGGY_MAX_SYNC_PAGES: "1" }),
    async (url) =>
      json(
        String(url).endsWith("/auth")
          ? { apiKey: "token" }
          : { results: [], next: "?after=more" },
      ),
  );
  await assert.rejects(
    api.listAll("transactions-list-by-cursor", { query: { accountId } }),
    (error) => error.code === "SYNC_PAGE_LIMIT",
  );
  const broken = new PluggyClient(config(), async () => {
    throw new Error("secret-never-echo");
  });
  await assert.rejects(
    broken.request("accounts-list", { query: { itemId } }),
    (error) =>
      error.code === "REQUEST_FAILED" &&
      !error.message.includes("secret-never-echo"),
  );
});

test("MCP protocol: discover tools/resources, validate inputs, and flag HTTP errors", async () => {
  const api = new PluggyClient(config(), async (url) =>
    String(url).endsWith("/auth")
      ? json({ apiKey: "token" })
      : json({ code: "DENIED" }, 403),
  );
  const server = createServer(config(), api);
  const client = new Client({ name: "test", version: "1.0.0" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const { tools } = await client.listTools();
    assert.equal(
      tools.some((tool) => tool.name === "pluggy_auth_create"),
      false,
    );
    assert.equal(
      tools.some((tool) => tool.name === "pluggy_sync"),
      false,
    );
    assert.ok(tools.some((tool) => tool.name === "pluggy_accounts_list"));
    const capabilities = await client.callTool({ name: "pluggy_capabilities" });
    assert.equal(capabilities.structuredContent.mode, "api");
    const failed = await client.callTool({
      name: "pluggy_accounts_list",
      arguments: { query: { itemId } },
    });
    assert.equal(failed.isError, true);
    assert.equal(failed.structuredContent.error.code, "PLUGGY_API_ERROR");
    const missing = await client.callTool({
      name: "pluggy_accounts_list",
      arguments: {},
    });
    assert.equal(missing.isError, true);
    const resource = await client.readResource({ uri: "pluggy://operations" });
    assert.equal(
      JSON.parse(resource.contents[0].text).length,
      operations.length,
    );
  } finally {
    await client.close();
    await server.close();
  }
});

test("the built CLI works over stdio from another working directory and exits cleanly", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pluggy-mcp-stdio-"));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL("../../dist/index.js", import.meta.url))],
    cwd,
    env: {
      PLUGGY_CLIENT_ID: "stdio-test",
      PLUGGY_CLIENT_SECRET: "stdio-secret",
    },
    stderr: "pipe",
  });
  const client = new Client({ name: "stdio-test", version: "1.0.0" });
  let stderr = "";
  transport.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  try {
    await client.connect(transport);
    const capabilities = await client.callTool({ name: "pluggy_capabilities" });
    assert.equal(capabilities.structuredContent.mode, "api");
    assert.equal(JSON.stringify(capabilities).includes("stdio-secret"), false);
    assert.ok((await client.listTools()).tools.length >= 100);
  } finally {
    await client.close();
    await rm(cwd, { recursive: true, force: true });
  }
  assert.equal(stderr, "");
});
