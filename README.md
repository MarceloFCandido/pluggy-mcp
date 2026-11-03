# Pluggy MCP

A Model Context Protocol server that lets an LLM client use the [Pluggy API](https://docs.pluggy.ai/en/reference) with your credentials. Read accounts, transactions, card bills, investments, loans, and identity data; manage supported connections, categorization, webhooks, and payment operations.

It works with Meu Pluggy personal access and other Pluggy applications. Available products depend on your plan, connector, and consents. The project remains an independent fork; it is not Pluggy's official MCP.

**Two modes, one server:**

| Configuration                    | How it works                                                                                                                         |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| API credentials                  | Tools call Pluggy directly. No database required.                                                                                    |
| API credentials + `DATABASE_URL` | Financial reads use a PostgreSQL mirror after synchronization. Live-only operations and all upstream writes continue through Pluggy. |

The catalog covers 100 documented operations: 94 from the pinned main OpenAPI spec, plus three public status and three separately authenticated enrichment endpoints. API-key creation is handled internally; the other 99 operations have tools. See the [complete API coverage](docs/API.md).

## Start here

You need a supported Node.js release (`^22.23.4` or `>=24.22.1`), an MCP client that can launch a local stdio server, and a Pluggy application's client ID and secret.

```bash
git clone https://github.com/MarceloFCandido/pluggy-mcp.git
cd pluggy-mcp
npm ci
```

Installation compiles the server. The executable is `dist/index.js`. This fork is not published to npm or the MCP registry.

If you used the fork's original two-tool prototype, update saved calls: `getAccounts` is now `pluggy_accounts_list` with a `query.itemId` argument, and `listConnectors` is now `pluggy_connectors_list`. The unused `fullPrompt` argument has been removed.

### Get access to your data

For personal use, follow [Pluggy's Meu Pluggy guide](https://docs.pluggy.ai/en/docs/guides/meu-pluggy-personal-use):

1. Connect your banks in Meu Pluggy.
2. In the Pluggy Dashboard's application demo, select the **MeuPluggy** connector and authorize your existing connections.
3. Keep the application's client ID/secret and the item ID for each bank connection.

Keep the credentials in the MCP client's server environment or a local `.env`; do not paste them into an LLM conversation. The example IDs in this README are placeholders.

### Connect your LLM client

Add a local stdio server using the equivalent of this configuration. Replace the absolute path and environment values. The surrounding configuration key varies by client; many clients use `mcpServers`.

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

Restart or reconnect the client, then try:

> Use pluggy-mcp to show its capabilities, list the accounts on my registered item, and show when Pluggy last updated the connection.

> Fetch my posted transactions for this account during October. Follow every page and keep pending transactions separate.

With multiple people or businesses, select the relevant items/accounts before asking for a combined report. This server has no built-in assumptions about household membership or account ownership.

For terminal use, copy `.env.example` to `.env` and fill it in locally. `npm start` launches the stdio protocol server; it waits for an MCP client rather than opening a web page. `node dist/index.js --help` shows the CLI commands.

## Add PostgreSQL when you want a mirror

Supply `DATABASE_URL` in the same server environment:

```json
{
  "DATABASE_URL": "postgresql://pluggy:password@localhost:5432/pluggy",
  "PLUGGY_ITEM_IDS": "00000000-0000-4000-8000-000000000001"
}
```

Use a dedicated database or database role. On startup, the server creates its own `pluggy_mcp` schema, tables, and indexes; it needs permission to create that schema and read/write its tables. It never edits your other application tables. PostgreSQL 14+ is supported by the SQL used here; the integration suite runs against PostgreSQL 18. SSL options follow the PostgreSQL driver's connection-string settings; certificate verification is not disabled by the application.

Use a direct connection or session-mode pooler. Synchronization uses session advisory locks; transaction-mode poolers are not supported.

After reconnecting, ask:

> Synchronize my registered Pluggy items into PostgreSQL. Tell me which products succeeded and which need attention.

> Using the synchronized database, group my posted BRL transactions for October by account, direction, and category. Include the last successful synchronization time.

You can also run a one-time import from the repository with credentials in `.env`:

```bash
npm run sync
```

Exit code `0` means every attempted collection succeeded, `2` means some collections failed, and `1` means setup or execution failed. This command can be scheduled independently of an LLM session.

### What sync does

- Imports known items and their available accounts, transactions, credit-card bills, investments and investment transactions, identities, loans, and consents.
- Follows every page, then commits each collection transactionally. Repeated imports upsert existing records. A failed later page leaves the previous successful collection intact.
- Keeps original API fields in JSONB. Records and sync state are logically separated by a hash of the application client ID; credentials are not stored in the mirror.
- Keeps historical transactions when an institution shortens its available history. Explicit deletion webhooks mark deleted transactions. Polling alone cannot guarantee detection of historical deletions.
- Reports last successful full-sync time, last event time, and errors separately. A failed refresh can leave an older valid snapshot available, with its error exposed.

An import is limited to what the institution and Pluggy make available. A complete sync means all pages of the available collections were imported; it does not guarantee the bank supplied your entire historical record.

This follows Pluggy's recommendation to [copy transactions into your own system and consume created, updated, and deleted events](https://docs.pluggy.ai/en/reference/transaction/transactions-list-by-cursor). Sync copies data already collected by Pluggy; it does not refresh a bank connection.

### Choosing the data source

Supported financial GET tools accept `source`:

| Value            | Behavior                                                                             |
| ---------------- | ------------------------------------------------------------------------------------ |
| `auto` (default) | Use PostgreSQL for supported mirrored reads when configured; otherwise call the API. |
| `api`            | Explicitly call Pluggy. Does not update the mirror.                                  |
| `database`       | Require a supported synchronized collection. Return an error if unavailable.         |

An empty or invalidated mirror produces `NOT_SYNCHRONIZED`, never a fabricated zero balance. Use `pluggy_sync`, or explicitly select `source: "api"`. Real-time balances, connection resources, SCR, categories, merchant lookup, developer administration, payments, enrichment, and public status remain live API calls. All endpoint mappings are in [API coverage](docs/API.md).

Database transaction queries and summaries use bounded structured filters, not arbitrary SQL. Sums use PostgreSQL decimal arithmetic and return strings; currencies stay separate. Date filters and month grouping use UTC. Raw sums include internal transfers and credit-card bill payments unless filtered out, so they are not automatically household spending.

### Keep the mirror current

For polling, set `PLUGGY_SYNC_INTERVAL_SECONDS` to the desired interval, such as `86400` for a day. It runs while the MCP process is alive; reconnecting a client does not keep a background daemon running. Alternatively schedule `npm run sync` with your normal scheduler. The first import is on demand or at the first scheduled interval.

For an always-on receiver or polling process independent of an LLM client, run `npm run worker` under your normal process supervisor. It requires PostgreSQL and a configured webhook port or sync interval. Your LLM clients can run their own stdio instances against the same mirror; application locks coordinate imports, events, and writes.

For event updates, enable the receiver with `PLUGGY_WEBHOOK_PORT` and a random `PLUGGY_WEBHOOK_SECRET` of at least 32 characters. It binds to loopback by default. Publish `/webhooks/pluggy` through your HTTPS reverse proxy and configure Pluggy's webhook `headers.Authorization` as `Bearer <the same secret>` **outside the LLM conversation**. The server does not register webhooks or expose a port publicly for you.

Subscribe to `item/created`, `item/updated`, `item/deleted`, `transactions/created`, `transactions/updated`, and `transactions/deleted`, or `all`. Pluggy requires a [public HTTPS endpoint on port 443](https://docs.pluggy.ai/en/reference/webhooks). The receiver validates and commits each event to a durable PostgreSQL queue before acknowledging it. A worker processes queued events every five seconds while the server is running.

Transaction updates fetch the supplied IDs in batches; creation events use the provided creation-time filter on the fixed API origin. An event without a baseline snapshot triggers an initial item import. Deletions are applied explicitly. Event IDs are deduplicated; failed processing is retried up to five times. Inspect `pluggy_sync_status`; after correcting the cause, `pluggy_sync` with `retryEvents: true` resets failed attempts.

For synchronization tools, allow a longer MCP client timeout when importing large histories. `PLUGGY_TIMEOUT_MS` limits each HTTP request; it is separate from the client tool-call timeout. A page limit prevents endless imports; hitting it leaves that collection uncommitted.

## Writes and API permissions

Reads work by default. Set `PLUGGY_ALLOW_WRITES=true` to enable upstream POST, PATCH, PUT, and DELETE operations, including connection creation, category corrections, webhook registration, and payments. Keep your MCP client's approval prompts enabled for changes. The server flag grants capability; the client controls approval of each action. The server cannot make an unavailable product or expired consent work, and bank authorization remains part of the payment flow.

In PostgreSQL mode, an upstream write first invalidates mirrored financial collections and takes the same application lock as synchronization. If the database is unavailable or a sync is running, the write does not start. Synchronize before reading those collections again, including after a write with an uncertain outcome. The API result is preserved if subsequent local maintenance fails; check the warning and repair the mirror rather than repeating the write.

API keys are cached internally and refreshed after expiry or a single unauthorized response. GET requests retry a small number of rate-limit or temporary-server errors. Writes are not retried for timeouts or server errors; inspect their outcome before retrying. A 401 may cause one reauthentication attempt.

## Configuration reference

All values are server environment variables. `.env` is read from the process working directory; explicit MCP environment configuration avoids working-directory surprises.

| Variable                       | Default     | Purpose                                                                             |
| ------------------------------ | ----------- | ----------------------------------------------------------------------------------- |
| `PLUGGY_CLIENT_ID`             | Required    | Application client ID.                                                              |
| `PLUGGY_CLIENT_SECRET`         | Required    | Application client secret.                                                          |
| `PLUGGY_ITEM_IDS`              | Empty       | Comma-separated known item UUIDs; needed for sync unless registered through a tool. |
| `DATABASE_URL`                 | Unset       | Enable the PostgreSQL mirror.                                                       |
| `PLUGGY_ALLOW_WRITES`          | `false`     | Permit upstream POST/PATCH/PUT/DELETE.                                              |
| `PLUGGY_SYNC_INTERVAL_SECONDS` | `0`         | Optional polling interval, up to 2147483 seconds; requires PostgreSQL.              |
| `PLUGGY_WEBHOOK_PORT`          | Unset       | Enable the optional webhook listener; requires PostgreSQL and a secret.             |
| `PLUGGY_WEBHOOK_HOST`          | `127.0.0.1` | Webhook bind address.                                                               |
| `PLUGGY_WEBHOOK_SECRET`        | Unset       | Shared secret, at least 32 characters, for the receiver's Bearer header.            |
| `PLUGGY_ENRICHMENT_API_KEY`    | Unset       | Separately provisioned enrichment API key.                                          |
| `PLUGGY_TIMEOUT_MS`            | `30000`     | Timeout for each upstream request, 100–300000 ms.                                   |
| `PLUGGY_MAX_SYNC_PAGES`        | `1000`      | Maximum pages per collection import.                                                |

`pluggy_register_items` persists IDs in PostgreSQL when enabled; otherwise registrations last for the current server process. Registration does not connect a bank or grant consent.

## Meu Pluggy limitations

Personal access is free for personal, noncommercial use, currently up to five connections. Keep item IDs: `GET /v2/items` is unavailable for these accounts. Proxy items mirror daily upstream updates and cannot be refreshed manually. Application authorization lasts one year and requires signing in again; bank consent has its own lifecycle. See the [personal-use guide](https://docs.pluggy.ai/en/docs/guides/meu-pluggy-personal-use).

Automatic categorization and other products can require a separate entitlement. Missing categories or products must not be interpreted as zero spending. Account permissions are decided by Pluggy, not by this server.

## Privacy and deployment

The MCP transport is local stdio. The optional HTTP listener receives webhooks only; it is not a remote MCP endpoint. Your MCP client and LLM provider receive the financial data you request. Keep local environment files, database credentials, and backups private. The PostgreSQL mirror contains personal financial data in the form returned by Pluggy. Application namespaces prevent accidental mixing; database access permissions remain the operator's responsibility.

No telemetry or documentation service receives your financial queries from this server. API traffic goes to fixed Pluggy origins; the optional database uses your supplied connection string. Tool schemas are loaded from the repository, with no startup spec download.

## Pluggy's official MCP

You can connect [Pluggy's official server](https://docs.pluggy.ai/en/docs/developer-tools/mcp) at `https://mcp.pluggy.ai/mcp` alongside this one for documentation and signed-in developer diagnostics. This fork supplies product API access and the optional mirror. Keeping the official service separate preserves its authentication and avoids proxying personal financial queries into documentation tools.

## Troubleshooting

| Result                           | Next step                                                                           |
| -------------------------------- | ----------------------------------------------------------------------------------- |
| `INVALID_CONFIG`                 | Check required environment variables and supported value formats.                   |
| HTTP 401/403                     | Check credentials, application environment, product entitlement, and consent.       |
| `LIST_ITEMS_FEATURE_NOT_ENABLED` | Supply known item IDs; Meu Pluggy personal accounts cannot enable item listing.     |
| `NOT_SYNCHRONIZED`               | Import the item with `pluggy_sync`, or explicitly choose `source: "api"`.           |
| Partial synchronization          | Inspect per-product errors and last successful snapshots with `pluggy_sync_status`. |
| `SYNC_PAGE_LIMIT`                | Raise the configured page limit and repeat the import.                              |
| `SYNC_IN_PROGRESS`               | Wait for the existing process to finish, then retry.                                |
| A webhook event remains failed   | Correct the underlying issue, then use `retryEvents: true` with `pluggy_sync`.      |
| A write timed out                | Check its remote status before retrying; the outcome may be uncertain.              |

For contributors, see [development and tests](docs/DEVELOPMENT.md). For assistants, see the [LLM operating guide](docs/LLMS.md).
