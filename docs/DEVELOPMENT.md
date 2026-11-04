# Development

The project has two execution paths: the same API catalog can call Pluggy directly or serve supported financial reads from an optional PostgreSQL mirror. Keep the API contract in the catalog, financial mirror behavior in storage/sync, and MCP transport wiring in the server.

| File              | Responsibility                                                                              |
| ----------------- | ------------------------------------------------------------------------------------------- |
| `src/catalog.ts`  | OpenAPI references, self-contained input schemas, tool names, validation                    |
| `src/client.ts`   | Fixed upstream origins, auth cache, HTTP errors, bounded GET retries, pagination            |
| `src/storage.ts`  | Parameterized PostgreSQL queries, transactional snapshots, freshness, application isolation |
| `src/sync.ts`     | Import financial products and process queued data events                                    |
| `src/webhooks.ts` | Authenticate, validate, durably queue, and acknowledge webhook deliveries                   |
| `src/server.ts`   | MCP tools/resources, source routing, operator write permission                              |
| `src/index.ts`    | Environment configuration, stdio, optional scheduling/receiver, lifecycle                   |

Without `DATABASE_URL`, financial responses pass from Pluggy to the MCP client without being persisted by this server. With it, sync writes those responses into `pluggy_mcp.records.data`, a JSONB column **inside PostgreSQL**. JSONB keeps upstream fields without a separate SQL column for each one. There is no local financial JSON cache, filesystem mirror, or third store. PostgreSQL numeric arithmetic produces exact decimal sums.

`PLUGGY_ITEM_IDS` controls which items can enter the mirror. Startup reconciles that list with `pluggy_mcp.items`; removed IDs are disabled, and events cannot register new ones. Keep the same configuration in clients and workers sharing a mirror. Retained data stays in PostgreSQL until its operator removes it.

Only `worker` runs polling, the HTTP receiver, and automatic queue processing. Stdio serves LLM tool calls; `pluggy_sync` drains due events and imports on demand. The [README](../README.md) explains both flows for users.

## Checks

```bash
npm ci
npm test
npm run test:postgres
npm run format:check
```

The unit suite uses mock HTTP and real MCP protocol transports. `test:postgres` creates a disposable local cluster with a private Unix socket, runs integration tests, stops it, and removes it. It requires the PostgreSQL **server** binaries (`initdb`, `postgres`, `pg_ctl`), not just libpq client commands. If needed, set `PG_BINDIR` to the server's bin directory. This runner supports macOS/Linux and should run as an ordinary user.

For CI or a dedicated disposable database:

```bash
TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/pluggy_test npm run test:integration
```

Integration tests create the `pluggy_mcp` schema and use random application namespaces. Use a test database; the runtime never reads `TEST_DATABASE_URL`.

## Update API coverage

```bash
npm run spec:update
npm test
npm run test:postgres
npm run docs:api
```

Review the downloaded spec diff. The runtime uses the checked-in snapshot; it never downloads executable tool definitions at startup. The unmodified main snapshot contains 94 operations. `householdPaths` in `src/catalog.ts` selects the financial/connection endpoints; payment initiation and administration are excluded. Three status and two enrichment operations are maintained in `spec/additional-operations.json`, each with its primary source. If upstream adds these to its main spec, remove duplicate supplemental definitions and update the coverage test.

OpenAPI input references are inlined because MCP clients need standalone schemas. The main spec currently has acyclic component references. Unsupported or cyclic future structures should fail the update checks instead of silently dropping parameters. The documented date-only query parameters are normalized from the upstream spec's `date-time` format to `date`.

## Invariants to preserve

- Keep the project and executable named `pluggy-mcp`.
- Authentication stays internal. Never expose API-key generation as a tool or return secrets in errors.
- Never follow upstream or webhook-provided arbitrary URLs with credentials. Follow cursor values on the original operation and filter scope.
- A failed list page must leave the previous collection snapshot intact.
- An unsynchronized mirror must return an error, never an empty balance or transaction result.
- Explicit transaction deletion events are application-scoped. Preserve absent posted history; retire absent pending entries only after a full import. Absence from a shorter history window does not prove deletion.
- Local maintenance failure after a successful API write must not turn the remote success into a retryable failure.
- Reads use a repeatable-read transaction so rows and freshness describe the same snapshot. Transaction cursors are bound to its scope revisions and filters.
- Summaries always separate accounts and currencies; bank and card signs differ.
- SQL identifiers come from fixed code maps; all user values are bound parameters.
- Return source, freshness, and partial-sync errors. A mirror's current timestamp is different from its bank's last refresh.
- Keep human setup in README and operating guidance in `docs/LLMS.md`; avoid duplicating configuration facts across guides.

This server uses the MCP SDK's lower-level `Server` so native OpenAPI JSON Schemas can be registered without translating them through a second schema language. AJV performs input validation. There is no Pluggy SDK dependency: the pinned specification covers operations that may be absent from SDK releases, and one HTTP client serves all operations consistently.
