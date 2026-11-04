# Pluggy MCP

Use the [Pluggy API](https://docs.pluggy.ai/en/reference) from an LLM to read your accounts, transactions, card bills, investments, loans, and connection status. You can also correct transaction categories and manage supported bank connections (with writes enabled).

This fork focuses on personal and household finances. It supports Meu Pluggy and other Pluggy applications, subject to their plans, connectors, and consents. Payment initiation, boleto issuing, credit-risk analysis, and application administration are outside its scope. It is independent of Pluggy's official MCP.

The server calls Pluggy directly unless you supply `DATABASE_URL`. With PostgreSQL, it can keep a mirror for repeated queries and summaries. Financial records are stored **only in that database**; the server does not write them to local files. Your LLM client may keep its own conversation history.

## Install and connect

You need Node.js `^22.23.4` or `>=24.22.1`, a local stdio MCP client, and your Pluggy application's client ID and secret.

```bash
git clone https://github.com/MarceloFCandido/pluggy-mcp.git
cd pluggy-mcp
npm ci
```

Installation builds `dist/index.js`. This fork is not published to npm or the MCP registry.

For personal access, follow [Pluggy's Meu Pluggy guide](https://docs.pluggy.ai/en/docs/guides/meu-pluggy-personal-use): connect your banks in Meu Pluggy, authorize them through the **MeuPluggy** connector in the Dashboard's application demo, and keep the returned item IDs. An item identifies a bank connection.

Add this server to your MCP client, replacing the path and placeholder values. Many clients use `mcpServers`; check your client's configuration format.

```json
{
  "mcpServers": {
    "pluggy-mcp": {
      "command": "node",
      "args": ["/absolute/path/to/pluggy-mcp/dist/index.js"],
      "env": {
        "PLUGGY_CLIENT_ID": "your-client-id",
        "PLUGGY_CLIENT_SECRET": "your-client-secret",
        "PLUGGY_ITEM_IDS": "00000000-0000-4000-8000-000000000001"
      }
    }
  }
}
```

Keep credentials in the server environment or a local `.env`, outside the conversation. `.env` is read from the process working directory; putting variables in the client's configuration avoids path surprises.

Reconnect the client and try:

> Show my Pluggy connections and accounts, and check when the bank data last updated.

> Fetch this account's posted transactions for October. Follow every page and keep pending transactions separate.

API tools return one page at a time. The LLM uses their schemas to supply `path`, `query`, and `body` arguments. The [API reference](docs/API.md) lists the exposed operations. If you used the original prototype, replace `getAccounts` with `pluggy_accounts_list` (`query.itemId`) and `listConnectors` with `pluggy_connectors_list`; `fullPrompt` has been removed.

## Add PostgreSQL

Use this configuration when you want retained history and database queries:

```json
{
  "mcpServers": {
    "pluggy-mcp": {
      "command": "node",
      "args": ["/absolute/path/to/pluggy-mcp/dist/index.js"],
      "env": {
        "PLUGGY_CLIENT_ID": "your-client-id",
        "PLUGGY_CLIENT_SECRET": "your-client-secret",
        "PLUGGY_ITEM_IDS": "00000000-0000-4000-8000-000000000001",
        "DATABASE_URL": "postgresql://pluggy:password@localhost:5432/pluggy"
      }
    }
  }
}
```

Use a dedicated database or role. The server creates and updates its `pluggy_mcp` schema, tables, and indexes; it needs those permissions and leaves other application tables alone. API records go in the `data` JSONB column, alongside IDs, sync timestamps, and deletion markers. JSONB is a PostgreSQL column type, not another store or a local JSON file. It keeps upstream fields available without adding a SQL column for each one.

The SQL requires PostgreSQL 14+; integration tests run on PostgreSQL 18. Use a direct connection. Session poolers need compatible startup parameters and session advisory locks; transaction pooling is unsupported. TLS follows the driver's connection-string settings, without disabling certificate verification.

`PLUGGY_ITEM_IDS` is the list of connections to mirror. Use the same list in all clients and workers sharing an application/database. Removing an ID and restarting excludes its records from database reads and future syncs; retained rows are not erased. Webhooks cannot add IDs. To mirror a newly connected bank, add its ID and restart.

### What happens during a conversation?

After connecting, ask:

> Synchronize my configured Pluggy items into PostgreSQL, then summarize my posted BRL transactions for October by account and category. Show any sync errors and the data's age.

The LLM calls `pluggy_sync`, checks its `complete`, `items[].errors`, and `events`, then uses `pluggy_query_transactions` or `pluggy_summarize_transactions`. Later queries reuse PostgreSQL until you ask for another sync or a worker updates it. There is no import on MCP startup and no background process left behind when a conversation ends.

For financial tools that support database reads:

| `source`         | Behavior                                                |
| ---------------- | ------------------------------------------------------- |
| `auto` (default) | Read PostgreSQL when configured; otherwise call Pluggy. |
| `api`            | Call Pluggy without updating the mirror.                |
| `database`       | Require a supported, synchronized collection.           |

An unsynchronized collection returns an error, not a zero balance. Failed refreshes leave the last successful snapshot available with `freshness.last_error`; queued or exhausted events appear as `EVENT_PENDING` or `EVENT_FAILED`. Check `pluggy_sync_status` for details.

Connection health (`pluggy_items_retrieve`) always comes from the API. Cached account balances are as old as their sync; use `source: "api"` or `pluggy_account_balance_get` for a current upstream balance. A sync copies what Pluggy already collected and cannot refresh a Meu Pluggy bank connection.

Each collection is fetched through every page before a transaction commits it. A failed page leaves its previous snapshot intact. Posted and investment transaction history is retained when banks shorten their history windows. Pending entries that disappear from a full import stop appearing in active results; deletion events explicitly remove posted transactions. Polling alone cannot detect every upstream correction or deletion outside the available history window. A complete import means all available pages were read, not that the bank supplied its entire history.

Summaries return exact decimal strings and always separate accounts and currencies. Bank debits and card purchases use different amount signs; combining them can cancel unrelated expenses. Raw totals also include transfers and card bill payments, so they need an accounting policy before being called household spending. Select the relevant people, businesses, and accounts explicitly. If an account disappears from Pluggy, its retained transactions are excluded from active queries and its ID appears in `excludedAccountIds`; report that gap before treating the result as a household total.

Database date filters and month grouping use UTC, with inclusive date bounds; records are ordered by date and ID ascending. API ordering is left unchanged. `pluggy_query_transactions` returns `nextCursor`: reuse it with the same filters, and restart pagination if a sync changes the data. Use summaries for totals instead of adding pages manually.

### Sync without an LLM session

For terminal use, copy `.env.example` to `.env` and fill it in locally. A one-time import is:

```bash
npm run sync
```

Exit code `0` means the attempted collections succeeded and no events remain pending, `2` means an incomplete result, and `1` means setup or execution failed. You can schedule this command with your normal scheduler.

For periodic imports, run a worker under your process supervisor:

```bash
PLUGGY_SYNC_INTERVAL_SECONDS=86400 npm run worker
```

The worker uses the same credentials, `DATABASE_URL`, and `PLUGGY_ITEM_IDS` as the MCP clients. Its first scheduled import runs after the interval; run `npm run sync` for the initial import. Only worker mode runs timers and binds a webhook port. Separate stdio clients can share its database; an application lock prevents overlapping imports and writes.

### Webhooks

Webhooks are optional notifications from Pluggy to a running worker, not messages to the LLM. They need a server you can keep running and a public HTTPS endpoint. If that setup is unnecessary for you, use scheduled imports.

Set `PLUGGY_WEBHOOK_PORT` and a random `PLUGGY_WEBHOOK_SECRET` of at least 32 characters in the worker environment. The listener binds to loopback by default. Publish `/webhooks/pluggy` through your reverse proxy on HTTPS port 443 and configure the webhook in Pluggy's Dashboard or API, outside the conversation. Its `headers.Authorization` must be `Bearer <the same secret>`. Webhook administration tools are not exposed through this MCP.

Subscribe to `item/created`, `item/updated`, `item/deleted`, `transactions/created`, `transactions/updated`, and `transactions/deleted`. The worker authenticates each delivery and saves it to the PostgreSQL queue before replying `202`. It checks the queue every five seconds, applies deletions, and fetches changed data from Pluggy. The next LLM query sees the updated mirror without needing another `pluggy_sync` call.

Item events import the configured item's available products. Transaction updates fetch the supplied IDs in batches of 500; creation events use their timestamp filter when available, otherwise they re-read the account. A missing baseline triggers an item import. Event IDs are deduplicated, payload URLs are ignored, and unconfigured items are ignored. Failures retry up to ten attempts, starting after 30 seconds and doubling the delay. After fixing a persistent failure, call `pluggy_sync` with `retryEvents: true` to reset attempts and process due events before importing. Unprocessed events remain visible in freshness and status.

## Writes and access limits

Reads work by default. `PLUGGY_ALLOW_WRITES=true` enables supported connection changes, deletions, and categorization operations. Keep the MCP client's approval prompts enabled for each change; the environment flag only enables the capability. Bank login and reauthorization belong in the human connection flow, and credentials should never be requested in chat.

Writes that affect mirrored data first invalidate the financial collections under the same lock as sync. A running sync or unavailable database blocks those writes before they reach Pluggy. Sync again afterward, including after a timeout. If a remote write succeeds but subsequent database maintenance fails, the response preserves the success with a warning; repair the mirror without repeating the write. Operations that do not change mirrored data leave it valid. After deleting a connection, remove its ID from the environment so a restart does not try to import it again.

Authentication is handled internally. API keys are cached and refreshed after expiry or one HTTP 401. GET requests retry a bounded number of rate-limit or temporary-server errors. Writes are not retried after timeouts or server errors; check their outcome first.

Meu Pluggy personal access has its own limits: known item IDs are required, proxy connections update on Pluggy's schedule, and `GET /v2/items` and manual proxy refresh are unavailable. Application authorization and bank consent can expire separately. Categorization and other products can require an additional entitlement. Check the [personal-use guide](https://docs.pluggy.ai/en/docs/guides/meu-pluggy-personal-use) for current terms; missing data does not mean zero spending.

## Environment variables

| Variable                       | Default     | Purpose                                                                   |
| ------------------------------ | ----------- | ------------------------------------------------------------------------- |
| `PLUGGY_CLIENT_ID`             | Required    | Application client ID.                                                    |
| `PLUGGY_CLIENT_SECRET`         | Required    | Application client secret.                                                |
| `PLUGGY_ITEM_IDS`              | Empty       | Comma-separated item UUIDs; authoritative list for the mirror.            |
| `DATABASE_URL`                 | Unset       | Enable PostgreSQL storage.                                                |
| `PLUGGY_ALLOW_WRITES`          | `false`     | Enable supported POST/PATCH/PUT/DELETE operations.                        |
| `PLUGGY_SYNC_INTERVAL_SECONDS` | `0`         | Import interval in worker mode; requires PostgreSQL.                      |
| `PLUGGY_WEBHOOK_PORT`          | Unset       | Enable the worker's webhook receiver; requires PostgreSQL.                |
| `PLUGGY_WEBHOOK_HOST`          | `127.0.0.1` | Receiver bind address.                                                    |
| `PLUGGY_WEBHOOK_SECRET`        | Unset       | Receiver's shared bearer secret (at least 32 characters).                 |
| `PLUGGY_ENRICHMENT_API_KEY`    | Unset       | Separately provisioned categorization/recurring-payments product key.     |
| `PLUGGY_TIMEOUT_MS`            | `30000`     | Per-request HTTP timeout, separate from the MCP client's tool timeout.    |
| `PLUGGY_MAX_SYNC_PAGES`        | `1000`      | Page limit per collection; reaching it leaves the collection uncommitted. |

Allow a longer MCP client timeout for large imports. `node dist/index.js --help` lists the CLI commands; `npm start` starts stdio and waits for an MCP client, without opening a web page.

## Privacy and troubleshooting

The transport is local stdio. The optional HTTP endpoint only receives webhooks; it is not a remote MCP endpoint. Your client and LLM provider receive the records you request. Protect the database, its backups, environment files, and conversation logs. Application namespaces prevent accidental mixing of client IDs, but database permissions remain your responsibility.

API requests use fixed Pluggy origins and schemas checked into this repository. The server does not send financial queries to telemetry or documentation services. You can connect [Pluggy's official MCP](https://docs.pluggy.ai/en/docs/developer-tools/mcp) separately at `https://mcp.pluggy.ai/mcp` for documentation and developer diagnostics.

| Result                  | What to check                                                               |
| ----------------------- | --------------------------------------------------------------------------- |
| HTTP 401/403            | Credentials, application environment, product entitlement, and consent.     |
| `NOT_SYNCHRONIZED`      | Run `pluggy_sync`, or choose `source: "api"`.                               |
| `ITEM_NOT_CONFIGURED`   | Add the intended ID to `PLUGGY_ITEM_IDS` and restart all processes.         |
| `SYNC_IN_PROGRESS`      | Wait for the current import/write to finish.                                |
| `INVALID_CURSOR`        | Restart pagination after a mirror change; keep the same filters and source. |
| `SYNC_PAGE_LIMIT`       | Raise the limit and repeat the import.                                      |
| `WEBHOOK_LISTEN_FAILED` | Check the worker's bind address/port and any other listener.                |
| Pending/failed events   | Inspect `pluggy_sync_status`; fix the cause, then use `retryEvents: true`.  |
| A write timed out       | Inspect its upstream result before retrying.                                |

See [development and tests](docs/DEVELOPMENT.md), [review decisions](docs/REVIEW.md), and the separate [LLM operating guide](docs/LLMS.md).
