import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { createServer as createNetServer } from "node:net";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Storage } from "../../dist/storage.js";
import { Synchronizer } from "../../dist/sync.js";
import { PluggyClient } from "../../dist/client.js";
import { loadConfig } from "../../dist/config.js";
import { operationById } from "../../dist/catalog.js";
import { startWebhooks } from "../../dist/webhooks.js";
import { createServer } from "../../dist/server.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const connectionString = process.env.TEST_DATABASE_URL;
if (!connectionString)
  throw new Error(
    "Use npm run test:postgres for an isolated database, or explicitly supply a disposable TEST_DATABASE_URL.",
  );
const itemId = "00000000-0000-4000-8000-000000000001";
const accountId = "00000000-0000-4000-8000-000000000002";
const txId = "00000000-0000-4000-8000-000000000003";
const scope = { resource: "transactions", itemId, parentId: accountId };
const transaction = (extra = {}) => ({
  id: txId,
  accountId,
  amount: 0.1,
  currencyCode: "BRL",
  type: "DEBIT",
  status: "POSTED",
  date: "2026-11-01T00:00:00Z",
  createdAt: "2026-11-01T00:00:00Z",
  ...extra,
});

async function database(t, namespace = `test-${randomUUID()}`) {
  const storage = new Storage(connectionString, namespace);
  await storage.initialize();
  await storage.configureItems([itemId]);
  t.after(async () => {
    for (const table of ["records", "sync_scopes", "items", "events"])
      await storage.pool.query(
        `DELETE FROM pluggy_mcp.${table} WHERE application_id=$1`,
        [storage.namespace],
      );
    await storage.close();
  });
  return storage;
}

async function mcp(t, storage, fetcher) {
  const config = loadConfig({
    PLUGGY_CLIENT_ID: "mock",
    PLUGGY_CLIENT_SECRET: "secret",
    PLUGGY_ALLOW_WRITES: "true",
    PLUGGY_ITEM_IDS: itemId,
  });
  const api = new PluggyClient(config, fetcher);
  const server = createServer(
    config,
    api,
    storage,
    new Synchronizer(api, storage),
  );
  const client = new Client({ name: "review-regression", version: "1.0.0" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  t.after(async () => {
    await client.close();
    await server.close();
  });
  await server.connect(st);
  await client.connect(ct);
  return client;
}

test("a full snapshot retires vanished pending entries while retaining posted history", async (t) => {
  const storage = await database(t);
  const old = transaction({ id: randomUUID(), date: "2025-01-01", amount: 10 });
  const pending = transaction({
    id: randomUUID(),
    status: "PENDING",
    amount: 20,
  });
  await storage.snapshot(scope, [old, pending]);
  await storage.snapshot(scope, [transaction()]);
  const read = () =>
    storage.read(operationById.get("transactions-list-by-cursor"), {
      query: { accountId },
    });
  assert.deepEqual(
    new Set((await read()).data.results.map((r) => r.id)),
    new Set([old.id, txId]),
  );
  await storage.snapshot(scope, [pending], false);
  assert.equal((await read()).data.results.length, 3);
  await storage.snapshot(scope, []);
  assert.equal((await read()).data.results.length, 2);
});

test("removed accounts cannot contribute to summaries or serve stale cached transactions", async (t) => {
  const storage = await database(t);
  const removed = randomUUID();
  const accounts = { resource: "accounts", itemId, parentId: itemId };
  await storage.snapshot(accounts, [{ id: accountId }, { id: removed }]);
  await storage.snapshot(scope, [transaction({ amount: 10 })]);
  await storage.snapshot({ ...scope, parentId: removed }, [
    transaction({ id: randomUUID(), accountId: removed, amount: 90 }),
  ]);
  await storage.snapshot(accounts, [{ id: accountId }]);
  const summary = await storage.transactions({}, true);
  assert.equal(summary.groups.length, 1);
  assert.equal(summary.groups[0].amount, "10");
  assert.deepEqual(summary.excludedAccountIds, [removed]);
  await assert.rejects(
    storage.read(operationById.get("transactions-list-by-cursor"), {
      query: { accountId: removed },
    }),
    (error) =>
      error.code === "NOT_SYNCHRONIZED" &&
      error.details.lastError === "PARENT_NOT_RETURNED",
  );
});

test("summaries keep bank debits and credit-card charges in separate account groups", async (t) => {
  const storage = await database(t);
  const card = randomUUID();
  await storage.snapshot({ resource: "accounts", itemId, parentId: itemId }, [
    { id: accountId, type: "BANK" },
    { id: card, type: "CREDIT" },
  ]);
  await storage.snapshot(scope, [transaction({ amount: -100 })]);
  await storage.snapshot({ ...scope, parentId: card }, [
    transaction({ id: randomUUID(), accountId: card, amount: 60 }),
  ]);
  const summary = await storage.transactions({}, true);
  assert.equal(summary.groups.length, 2);
  assert.deepEqual(
    new Set(summary.groups.map((r) => r.amount)),
    new Set(["-100", "60"]),
  );
  assert.ok(summary.groups.every((r) => r.accountId));
});

test("webhook failures back off and remain visible on ordinary cached reads", async (t) => {
  const storage = await database(t);
  await storage.snapshot(scope, [transaction()]);
  await storage.enqueue({
    event: "transactions/updated",
    eventId: randomUUID(),
    itemId,
    accountId,
    transactionIds: [txId],
  });
  const sync = new Synchronizer(
    {
      listAll: async () => {
        throw new Error("offline");
      },
    },
    storage,
  );
  await sync.processEvents();
  await sync.processEvents();
  const { rows } = await storage.pool.query(
    "SELECT attempts FROM pluggy_mcp.events WHERE application_id=$1",
    [storage.namespace],
  );
  assert.equal(rows[0].attempts, 1);
  const freshness = await storage.scope("transactions", accountId);
  assert.equal(freshness.last_error, "EVENT_PENDING");
  await storage.pool.query(
    "UPDATE pluggy_mcp.events SET attempts=10 WHERE application_id=$1",
    [storage.namespace],
  );
  assert.equal(
    (await storage.scope("transactions", accountId)).last_error,
    "EVENT_FAILED",
  );
});

test("webhooks cannot register an unrelated item or import its data", async (t) => {
  const storage = await database(t);
  const unrelated = randomUUID();
  let fetched = false;
  const api = {
    request: async () => {
      fetched = true;
      throw new Error("must not fetch");
    },
  };
  await storage.enqueue({
    event: "item/created",
    eventId: randomUUID(),
    itemId: unrelated,
  });
  await new Synchronizer(api, storage).processEvents();
  assert.equal(fetched, false);
  assert.deepEqual(await storage.itemIds(), [itemId]);
});

test("internal auth cannot invalidate the database and connection health stays live", async (t) => {
  const storage = await database(t);
  await storage.snapshot(scope, [transaction()]);
  await storage.snapshot({ resource: "items", itemId, parentId: itemId }, [
    { id: itemId, status: "UPDATED" },
  ]);
  const client = await mcp(t, storage, async (url) =>
    Response.json(
      String(url).endsWith("/auth")
        ? { apiKey: "token" }
        : { id: itemId, status: "LOGIN_ERROR" },
    ),
  );
  const denied = await client.callTool({
    name: "pluggy_auth_create",
    arguments: { body: { clientId: itemId, clientSecret: "y" } },
  });
  assert.equal(denied.structuredContent.error.code, "UNKNOWN_TOOL");
  assert.equal((await storage.scope("transactions", accountId)).complete, true);
  const item = await client.callTool({
    name: "pluggy_items_retrieve",
    arguments: { path: { id: itemId } },
  });
  assert.equal(item.structuredContent.source, "api");
  assert.equal(item.structuredContent.data.status, "LOGIN_ERROR");
});

test("structured-query cursors reject an intervening import instead of duplicating rows", async (t) => {
  const storage = await database(t);
  await storage.snapshot({ resource: "accounts", itemId, parentId: itemId }, [
    { id: accountId },
  ]);
  await storage.snapshot(scope, [
    transaction(),
    transaction({ id: randomUUID(), date: "2026-11-02" }),
  ]);
  const page = await storage.transactions({ limit: 1 });
  assert.equal(typeof page.nextCursor, "string");
  assert.equal(
    (await storage.transactions({ limit: 1, cursor: page.nextCursor })).results
      .length,
    1,
  );
  await storage.snapshot(
    scope,
    [transaction({ id: randomUUID(), date: "2026-10-01" })],
    false,
  );
  await assert.rejects(
    storage.transactions({ limit: 1, cursor: page.nextCursor }),
    /cursor|pagination/i,
  );
});

test("PostgreSQL upserts are idempotent, exact, isolated per application, and report freshness", async (t) => {
  const storage = await database(t);
  await assert.rejects(
    storage.read(operationById.get("transactions-list-by-cursor"), {
      query: { accountId },
    }),
    /pluggy_sync/,
  );
  await storage.snapshot({ resource: "accounts", itemId, parentId: itemId }, [
    { id: accountId, itemId, type: "BANK" },
  ]);
  await storage.snapshot(scope, [
    transaction(),
    transaction({ id: randomUUID(), amount: 0.2 }),
  ]);
  await storage.snapshot(scope, [transaction()]);
  const summary = await storage.transactions({}, true);
  assert.equal(summary.groups[0].amount, "0.3");
  assert.equal(summary.groups[0].count, 2);
  assert.ok(summary.freshness[0].synced_at);
  const other = await database(t);
  await other.snapshot({ resource: "accounts", itemId, parentId: itemId }, []);
  assert.deepEqual((await other.transactions({})).results, []);
  await storage.deleteTransactions([txId]);
  assert.equal((await storage.transactions({}, true)).groups[0].amount, "0.2");
  await storage.invalidate();
  await assert.rejects(storage.transactions({}), /pluggy_sync/);
});

test("database filtering and pagination preserve scope, currency, and settlement status", async (t) => {
  const storage = await database(t);
  await storage.snapshot({ resource: "accounts", itemId, parentId: itemId }, [
    { id: accountId, itemId },
  ]);
  await storage.snapshot(scope, [
    transaction(),
    transaction({ id: randomUUID(), currencyCode: "USD", amount: 3 }),
    transaction({ id: randomUUID(), status: "PENDING", amount: 5 }),
  ]);
  const result = await storage.transactions({ status: "POSTED" }, true);
  assert.equal(result.groups.length, 2);
  assert.deepEqual(
    new Set(result.groups.map((group) => group.currencyCode)),
    new Set(["BRL", "USD"]),
  );
  const first = await storage.read(operationById.get("transactions-list"), {
    query: { accountId, pageSize: 1 },
  });
  assert.equal(first.data.results.length, 1);
  assert.equal(first.data.totalPages, 3);
  const filtered = await storage.read(
    operationById.get("transactions-list-by-cursor"),
    {
      query: {
        accountId,
        dateFrom: "2026-11-01",
        dateTo: "2026-11-01",
        ids: [txId],
      },
    },
  );
  assert.equal(filtered.data.results.length, 1);
  assert.equal(filtered.data.next, null);
  await assert.rejects(
    storage.transactions({ accountIds: [randomUUID()] }),
    /requested account is missing/,
  );
  const legacyIds = await storage.read(operationById.get("transactions-list"), {
    query: { accountId, ids: [txId], from: "2026-01-01", to: "2026-01-02" },
  });
  assert.equal(legacyIds.data.results.length, 1);
});

test("synchronization follows cursors and a failed subsequent page never commits a partial collection", async (t) => {
  const storage = await database(t);
  let fail = false;
  const config = loadConfig({
    PLUGGY_CLIENT_ID: "mock",
    PLUGGY_CLIENT_SECRET: "secret",
    PLUGGY_ITEM_IDS: itemId,
  });
  const fetcher = async (url) => {
    const u = new URL(url);
    if (u.pathname === "/auth") return Response.json({ apiKey: "token" });
    if (u.pathname.startsWith("/items/"))
      return Response.json({
        id: itemId,
        products: ["ACCOUNTS", "TRANSACTIONS"],
      });
    if (u.pathname === "/accounts")
      return Response.json({
        results: [{ id: accountId, itemId, type: "BANK" }],
      });
    if (u.pathname === "/consents") return Response.json({ results: [] });
    if (u.pathname === "/v2/transactions") {
      if (u.searchParams.has("after"))
        return fail
          ? Response.json({}, { status: 403 })
          : Response.json({
              results: [transaction({ id: randomUUID(), amount: 0.2 })],
              next: null,
            });
      return Response.json({
        results: [transaction({ amount: fail ? 999 : 0.1 })],
        next: "?after=second",
      });
    }
    throw new Error(`Unexpected request ${u.pathname}`);
  };
  const sync = new Synchronizer(new PluggyClient(config, fetcher), storage);
  assert.equal((await sync.sync()).complete, true);
  fail = true;
  assert.equal((await sync.sync()).complete, false);
  const cached = await storage.read(
    operationById.get("transactions-retrieve"),
    { path: { id: txId } },
  );
  assert.equal(cached.data.amount, 0.1);
  assert.equal(cached.freshness.last_error, "HTTP_403");
});

test("webhook queue is durable and deduplicated; deletions cannot leak across applications", async (t) => {
  const storage = await database(t);
  await storage.snapshot(scope, [transaction()]);
  const other = await database(t);
  await other.snapshot(scope, [transaction()]);
  const event = {
    event: "transactions/deleted",
    eventId: randomUUID(),
    transactionIds: [txId],
  };
  await storage.enqueue(event);
  await storage.enqueue(event);
  const config = loadConfig({
    PLUGGY_CLIENT_ID: "mock",
    PLUGGY_CLIENT_SECRET: "secret",
  });
  const sync = new Synchronizer(
    new PluggyClient(config, async () => {
      throw new Error("Deletion must not fetch");
    }),
    storage,
  );
  await sync.processEvents();
  assert.equal(
    (
      await storage.read(operationById.get("transactions-list-by-cursor"), {
        query: { accountId },
      })
    ).data.results.length,
    0,
  );
  assert.equal(
    (
      await other.read(operationById.get("transactions-list-by-cursor"), {
        query: { accountId },
      })
    ).data.results.length,
    1,
  );
  assert.equal((await storage.status()).events.pending, 0);
  const count = await storage.pool.query(
    "SELECT count(*)::int AS n FROM pluggy_mcp.events WHERE application_id=$1",
    [storage.namespace],
  );
  assert.equal(count.rows[0].n, 1);
});

test("HTTP webhook receiver requires the configured secret and commits before acknowledging", async (t) => {
  const storage = await database(t);
  const secret = "a-secret-value-at-least-32-characters-long";
  const server = await startWebhooks(
    { webhookPort: 0, webhookHost: "127.0.0.1", webhookSecret: secret },
    storage,
  );
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/webhooks/pluggy`;
  const payload = { event: "item/updated", eventId: randomUUID(), itemId };
  assert.equal(
    (await fetch(url, { method: "POST", body: JSON.stringify(payload) }))
      .status,
    401,
  );
  assert.equal(
    (
      await fetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${secret}` },
        body: JSON.stringify(payload),
      })
    ).status,
    202,
  );
  assert.equal((await storage.status()).events.pending, 1);
  assert.equal(
    (
      await fetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${secret}` },
        body: "{}",
      })
    ).status,
    400,
  );
});

test("webhook updates fetch only affected IDs and creation filters without replacing the baseline", async (t) => {
  const storage = await database(t);
  await storage.snapshot(scope, [transaction()]);
  const requests = [];
  const config = loadConfig({
    PLUGGY_CLIENT_ID: "mock",
    PLUGGY_CLIENT_SECRET: "secret",
  });
  const created = randomUUID();
  const api = new PluggyClient(config, async (url) => {
    const u = new URL(url);
    if (u.pathname === "/auth") return Response.json({ apiKey: "token" });
    requests.push(u);
    if (u.searchParams.has("ids"))
      return Response.json({
        results: [transaction({ amount: 8, status: "POSTED" })],
        next: null,
      });
    return Response.json({
      results: [transaction({ id: created, amount: 2 })],
      next: null,
    });
  });
  const sync = new Synchronizer(api, storage);
  await storage.enqueue({
    event: "transactions/updated",
    eventId: randomUUID(),
    itemId,
    accountId,
    transactionIds: [txId],
  });
  await storage.enqueue({
    event: "transactions/created",
    eventId: randomUUID(),
    itemId,
    accountId,
    transactionsCreatedAtFrom: "2026-11-01T00:00:00Z",
  });
  await sync.processEvents();
  const cached = await storage.read(
    operationById.get("transactions-list-by-cursor"),
    { query: { accountId } },
  );
  assert.equal(cached.data.results.length, 2);
  assert.equal(cached.data.results.find((row) => row.id === txId).amount, 8);
  assert.equal(requests[0].pathname, "/v2/transactions");
  assert.equal(requests[0].searchParams.get("ids"), txId);
  assert.equal(
    requests[1].searchParams.get("createdAtFrom"),
    "2026-11-01T00:00:00Z",
  );
  assert.ok(cached.freshness.last_event_at);
  assert.equal((await storage.status()).events.pending, 0);
});

test("database cursors are bound to filters, account scope, and collection revision", async (t) => {
  const storage = await database(t);
  const rows = Array.from({ length: 501 }, (_, n) =>
    transaction({ id: n === 0 ? txId : randomUUID(), amount: n }),
  );
  await storage.snapshot(scope, rows);
  const op = operationById.get("transactions-list-by-cursor");
  const first = await storage.read(op, { query: { accountId } });
  assert.equal(first.data.results.length, 500);
  const after = new URLSearchParams(first.data.next).get("after");
  assert.equal(
    (await storage.read(op, { query: { accountId, after } })).data.results
      .length,
    1,
  );
  await assert.rejects(
    storage.read(op, { query: { accountId, after, dateFrom: "2026-11-01" } }),
    /same filters/,
  );
  await storage.deleteTransactions([txId]);
  await assert.rejects(
    storage.read(op, { query: { accountId, after } }),
    /same filters/,
  );
});

test("MCP routes reads through PostgreSQL, allows explicit API reads, and invalidates before mutations", async (t) => {
  const storage = await database(t);
  await storage.snapshot({ resource: "accounts", itemId, parentId: itemId }, [
    { id: accountId, itemId, type: "BANK" },
  ]);
  await storage.snapshot(scope, [transaction()]);
  const config = loadConfig({
    PLUGGY_CLIENT_ID: "mock",
    PLUGGY_CLIENT_SECRET: "secret",
    PLUGGY_ALLOW_WRITES: "true",
  });
  const requests = [];
  const api = new PluggyClient(config, async (url) => {
    const u = new URL(url);
    requests.push(u.pathname);
    if (u.pathname === "/auth") return Response.json({ apiKey: "token" });
    if (u.pathname === "/accounts")
      return Response.json({ results: [{ id: accountId, balance: 999 }] });
    await assert.rejects(
      storage.scope("transactions", accountId),
      /pluggy_sync/,
    );
    return Response.json(transaction({ categoryId: "07010000" }));
  });
  const server = createServer(
    config,
    api,
    storage,
    new Synchronizer(api, storage),
  );
  const client = new Client({ name: "postgres-test", version: "1.0.0" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  t.after(async () => {
    await client.close();
    await server.close();
  });
  await server.connect(st);
  await client.connect(ct);
  const cached = await client.callTool({
    name: "pluggy_accounts_list",
    arguments: { query: { itemId } },
  });
  assert.equal(cached.structuredContent.source, "database");
  assert.equal(requests.length, 0);
  const live = await client.callTool({
    name: "pluggy_accounts_list",
    arguments: { query: { itemId }, source: "api" },
  });
  assert.equal(live.structuredContent.data.results[0].balance, 999);
  const changed = await client.callTool({
    name: "pluggy_transactions_update",
    arguments: { path: { id: txId }, body: { categoryId: "07010000" } },
  });
  assert.equal(changed.isError, undefined);
  assert.equal(changed.structuredContent.databaseInvalidated, true);
  const invalidated = await client.callTool({
    name: "pluggy_accounts_list",
    arguments: { query: { itemId } },
  });
  assert.equal(invalidated.isError, true);
  assert.equal(invalidated.structuredContent.error.code, "NOT_SYNCHRONIZED");
});

test("application locks reject concurrent synchronization and release on exceptions", async (t) => {
  const storage = await database(t);
  await storage.withSyncLock(async () => {
    await assert.rejects(
      storage.withSyncLock(async () => {}),
      /Another operation/,
    );
  });
  await assert.rejects(
    storage.withSyncLock(async () => {
      throw new Error("failure");
    }),
    /failure/,
  );
  await storage.withSyncLock(async () => {});
});

test("the standalone worker receives and processes durable events without an LLM session", async (t) => {
  const probe = createNetServer();
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  const env = {
    PLUGGY_CLIENT_ID: `worker-test-${randomUUID()}`,
    PLUGGY_CLIENT_SECRET: "mock-secret",
    DATABASE_URL: connectionString,
    PLUGGY_ITEM_IDS: itemId,
    PLUGGY_WEBHOOK_PORT: String(port),
    PLUGGY_WEBHOOK_SECRET: "worker-test-secret-with-more-than-32-characters",
  };
  const config = loadConfig(env);
  const storage = await database(t, config.namespace);
  await storage.snapshot(scope, [transaction()]);
  const cwd = await mkdtemp(join(tmpdir(), "pluggy-mcp-worker-"));
  const child = spawn(
    process.execPath,
    [fileURLToPath(new URL("../../dist/index.js", import.meta.url)), "worker"],
    { cwd, env, stdio: ["ignore", "pipe", "pipe"] },
  );
  const exited = once(child, "exit");
  let output = "";
  child.stdout.on("data", (chunk) => {
    output += chunk;
  });
  child.stderr.on("data", (chunk) => {
    output += chunk;
  });
  t.after(async () => {
    if (child.exitCode === null) child.kill("SIGTERM");
    await exited;
    await rm(cwd, { recursive: true, force: true });
  });
  const url = `http://127.0.0.1:${port}/webhooks/pluggy`;
  let ready = false;
  for (let i = 0; i < 100 && !ready; i++) {
    if (child.exitCode !== null) throw new Error(`Worker exited: ${output}`);
    try {
      ready = (await fetch(url)).status === 405;
    } catch {}
    if (!ready) await delay(20);
  }
  assert.equal(ready, true);
  const duplicate = spawn(
    process.execPath,
    [fileURLToPath(new URL("../../dist/index.js", import.meta.url)), "worker"],
    { cwd, env, stdio: ["ignore", "ignore", "pipe"] },
  );
  let duplicateError = "";
  duplicate.stderr.on("data", (chunk) => {
    duplicateError += chunk;
  });
  assert.equal((await once(duplicate, "exit"))[0], 1);
  assert.match(duplicateError, /WEBHOOK_LISTEN_FAILED/);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL("../../dist/index.js", import.meta.url))],
    cwd,
    env,
    stderr: "pipe",
  });
  const mcpClient = new Client({
    name: "shared-worker-client",
    version: "1.0.0",
  });
  try {
    await mcpClient.connect(transport);
    assert.equal(
      (await mcpClient.callTool({ name: "pluggy_capabilities" }))
        .structuredContent.mode,
      "postgresql",
    );
  } finally {
    await mcpClient.close();
  }
  const response = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.PLUGGY_WEBHOOK_SECRET}` },
    body: JSON.stringify({
      event: "transactions/deleted",
      eventId: randomUUID(),
      transactionIds: [txId],
    }),
  });
  assert.equal(response.status, 202);
  let pending = 1;
  for (let i = 0; i < 80 && pending; i++) {
    await delay(100);
    pending = (await storage.status()).events.pending;
  }
  assert.equal(pending, 0);
  assert.equal(
    (
      await storage.read(operationById.get("transactions-list-by-cursor"), {
        query: { accountId },
      })
    ).data.results.length,
    0,
  );
  child.kill("SIGTERM");
  assert.equal((await exited)[0], 0);
  assert.equal(output, "");
});

test("configuration replacement removes access without erasing retained financial history", async (t) => {
  const storage = await database(t);
  const otherItem = randomUUID();
  await storage.configureItems([itemId, otherItem]);
  await storage.snapshot({ ...scope, itemId: otherItem }, [transaction()]);
  await storage.configureItems([itemId]);
  assert.deepEqual(await storage.itemIds(), [itemId]);
  await assert.rejects(
    storage.read(operationById.get("transactions-list-by-cursor"), {
      query: { accountId },
    }),
    (error) => error.code === "NOT_SYNCHRONIZED",
  );
  await assert.rejects(
    new Synchronizer({}, storage).sync([otherItem]),
    (error) => error.code === "ITEM_NOT_CONFIGURED",
  );
  assert.equal(
    (
      await storage.pool.query(
        "SELECT count(*)::int AS n FROM pluggy_mcp.records WHERE application_id=$1",
        [storage.namespace],
      )
    ).rows[0].n,
    1,
  );
  await storage.withSyncLock(() => storage.configureItems([itemId]));
});

test("a failed parent refresh is visible when reading retained child transactions", async (t) => {
  const storage = await database(t);
  await storage.snapshot(scope, [transaction()]);
  const config = loadConfig({
    PLUGGY_CLIENT_ID: "mock",
    PLUGGY_CLIENT_SECRET: "secret",
  });
  const api = new PluggyClient(config, async (url) =>
    String(url).endsWith("/auth")
      ? Response.json({ apiKey: "token" })
      : Response.json({}, { status: 403 }),
  );
  assert.equal((await new Synchronizer(api, storage).sync()).complete, false);
  const cached = await storage.read(
    operationById.get("transactions-list-by-cursor"),
    { query: { accountId } },
  );
  assert.equal(cached.data.results[0].id, txId);
  assert.equal(cached.freshness.last_error, "HTTP_403");
});

test("sync invalidates withdrawn products and treats only the documented missing-identity response as empty", async (t) => {
  const storage = await database(t);
  const investment = randomUUID();
  const bill = randomUUID();
  let products = [
    "ACCOUNTS",
    "TRANSACTIONS",
    "INVESTMENTS",
    "INVESTMENTS_TRANSACTIONS",
    "IDENTITY",
  ];
  const config = loadConfig({
    PLUGGY_CLIENT_ID: "mock",
    PLUGGY_CLIENT_SECRET: "secret",
  });
  const api = new PluggyClient(config, async (url) => {
    const path = new URL(url).pathname;
    if (path === "/auth") return Response.json({ apiKey: "token" });
    if (path.startsWith("/items/"))
      return Response.json({ id: itemId, products });
    if (path === "/identity")
      return Response.json({ code: "IDENTITY_NOT_FOUND" }, { status: 404 });
    if (path === "/accounts")
      return Response.json({ results: [{ id: accountId, type: "CREDIT" }] });
    if (path === "/investments")
      return Response.json({ results: [{ id: investment }] });
    if (path === "/bills")
      return Response.json({
        results: [{ id: bill, accountId, totalAmount: 10 }],
      });
    if (path === "/v2/transactions")
      return Response.json({ results: [transaction()], next: null });
    return Response.json({ results: [] });
  });
  const sync = new Synchronizer(api, storage);
  assert.equal((await sync.sync()).complete, true);
  assert.equal(
    (
      await storage.read(operationById.get("bills-list"), {
        query: { accountId },
      })
    ).data.results[0].id,
    bill,
  );
  assert.equal(
    (
      await storage.read(operationById.get("identity-find-by-item"), {
        query: { itemId },
      })
    ).data,
    null,
  );
  assert.equal(
    (
      await storage.read(operationById.get("investments-list"), {
        query: { itemId },
      })
    ).data.results[0].id,
    investment,
  );
  products = ["ACCOUNTS"];
  assert.equal((await sync.sync()).complete, true);
  for (const [resource, parent] of [
    ["transactions", accountId],
    ["investments", itemId],
  ])
    await assert.rejects(
      storage.scope(resource, parent),
      (error) => error.details.lastError === "PRODUCT_UNAVAILABLE",
    );
});

test("write failures invalidate first, unrelated writes preserve the mirror, and maintenance warnings preserve success", async (t) => {
  const storage = await database(t);
  await storage.snapshot(scope, [transaction()]);
  let fail = true;
  const client = await mcp(t, storage, async (url) => {
    const path = new URL(url).pathname;
    if (path === "/auth") return Response.json({ apiKey: "token" });
    if (path.endsWith("/disable-auto-sync")) return Response.json({});
    await assert.rejects(
      storage.scope("transactions", accountId),
      (error) => error.code === "NOT_SYNCHRONIZED",
    );
    return Response.json({}, { status: fail ? 400 : 200 });
  });
  const unrelated = await client.callTool({
    name: "pluggy_items_disable_autosync",
    arguments: { path: { id: itemId } },
  });
  assert.equal(unrelated.isError, undefined);
  assert.equal((await storage.scope("transactions", accountId)).complete, true);
  const failed = await client.callTool({
    name: "pluggy_transactions_update",
    arguments: { path: { id: txId }, body: { categoryId: "07010000" } },
  });
  assert.equal(failed.structuredContent.error.code, "PLUGGY_API_ERROR");
  await assert.rejects(
    storage.scope("transactions", accountId),
    (error) => error.code === "NOT_SYNCHRONIZED",
  );
  fail = false;
  storage.deleteItem = async () => {
    throw new Error("database maintenance failed");
  };
  const succeeded = await client.callTool({
    name: "pluggy_items_delete",
    arguments: { path: { id: itemId } },
  });
  assert.equal(succeeded.isError, undefined);
  assert.match(succeeded.structuredContent.warning, /API_WRITE_SUCCEEDED/);
});
