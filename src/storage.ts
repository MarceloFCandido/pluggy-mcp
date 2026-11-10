import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import pg from "pg";
import {
  AppError,
  type Arguments,
  type JsonObject,
  type Operation,
} from "./types.js";

export type Resource =
  | "items"
  | "accounts"
  | "transactions"
  | "investments"
  | "investment_transactions"
  | "identity"
  | "loans"
  | "bills"
  | "consents";
export interface Scope {
  resource: Resource;
  parentId: string;
  itemId: string;
}

function encodeCursor(offset: number, fingerprint: string): string {
  return Buffer.from(JSON.stringify({ offset, fingerprint })).toString(
    "base64url",
  );
}

function decodeCursor(value: string, fingerprint: string): number {
  try {
    const cursor = JSON.parse(Buffer.from(value, "base64url").toString());
    if (
      cursor.fingerprint !== fingerprint ||
      !Number.isSafeInteger(cursor.offset) ||
      cursor.offset < 0
    )
      throw new Error();
    return cursor.offset;
  } catch {
    throw new AppError(
      "INVALID_CURSOR",
      "Use the cursor with the same filters and source; restart pagination after the mirror changes.",
    );
  }
}

export const cachedOperations: Record<
  string,
  {
    resource: Resource;
    parent?: string;
    pathParent?: boolean;
    single?: boolean;
  }
> = {
  "accounts-list": { resource: "accounts", parent: "itemId" },
  "accounts-retrieve": { resource: "accounts", single: true },
  "transactions-list": { resource: "transactions", parent: "accountId" },
  "transactions-list-by-cursor": {
    resource: "transactions",
    parent: "accountId",
  },
  "transactions-retrieve": { resource: "transactions", single: true },
  "investments-list": { resource: "investments", parent: "itemId" },
  "investments-retrieve": { resource: "investments", single: true },
  "investment-transactions-list": {
    resource: "investment_transactions",
    parent: "id",
    pathParent: true,
  },
  "identity-find-by-item": { resource: "identity", parent: "itemId" },
  "identity-retrieve": { resource: "identity", single: true },
  "loans-list": { resource: "loans", parent: "itemId" },
  "loans-retrieve": { resource: "loans", single: true },
  "bills-list": { resource: "bills", parent: "accountId" },
  "bills-retrieve": { resource: "bills", single: true },
  "consents-list": { resource: "consents", parent: "itemId" },
  "consent-retrieve": { resource: "consents", single: true },
};

export class Storage {
  readonly pool: pg.Pool;
  constructor(
    connectionString: string,
    readonly namespace: string,
  ) {
    this.pool = new pg.Pool({
      connectionString,
      max: 4,
      connectionTimeoutMillis: 10_000,
      idleTimeoutMillis: 30_000,
      application_name: "pluggy-mcp",
      statement_timeout: 30_000,
    });
    // Idle connection failures must not crash the MCP or disclose a connection string.
    this.pool.on("error", () =>
      console.error(
        "PostgreSQL idle connection failed; subsequent operations will reconnect.",
      ),
    );
  }

  async initialize(): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended('pluggy-mcp:migrations', 0))",
      );
      await client.query(
        readFileSync(
          new URL("../migrations/001_initial.sql", import.meta.url),
          "utf8",
        ),
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async configureItems(ids: string[]): Promise<void> {
    // Most stdio clients share the worker's configuration; starting one must not interrupt an import.
    if (
      JSON.stringify(await this.itemIds()) === JSON.stringify([...ids].sort())
    )
      return;
    await this.withSyncLock(async () => {
      const client = await this.pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(
          "UPDATE pluggy_mcp.items SET enabled=false WHERE application_id=$1 AND NOT(id=ANY($2::text[]))",
          [this.namespace, ids],
        );
        await client.query(
          `INSERT INTO pluggy_mcp.items(application_id,id)
          SELECT $1, unnest($2::text[]) ON CONFLICT(application_id,id) DO UPDATE SET enabled=true`,
          [this.namespace, ids],
        );
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    });
  }

  async itemIds(db: pg.Pool | pg.PoolClient = this.pool): Promise<string[]> {
    const result = await db.query(
      "SELECT id FROM pluggy_mcp.items WHERE application_id=$1 AND enabled ORDER BY id",
      [this.namespace],
    );
    return result.rows.map((row) => row.id);
  }

  async withSyncLock<T>(work: () => Promise<T>): Promise<T> {
    const connection = await this.pool.connect();
    const key = `pluggy-mcp:sync:${this.namespace}`;
    let acquired = false;
    try {
      acquired = (
        await connection.query(
          "SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS acquired",
          [key],
        )
      ).rows[0].acquired;
      if (!acquired)
        throw new AppError(
          "SYNC_IN_PROGRESS",
          "Another operation is synchronizing or changing this application's mirror. Retry after it finishes.",
        );
      return await work();
    } finally {
      let destroy = false;
      try {
        if (acquired)
          await connection.query(
            "SELECT pg_advisory_unlock(hashtextextended($1,0))",
            [key],
          );
      } catch {
        // Closing the session also releases its locks. Preserve a successful upstream write's result.
        destroy = true;
        console.error(
          "PostgreSQL lock cleanup failed; closing that connection.",
        );
      } finally {
        connection.release(destroy);
      }
    }
  }

  async snapshot(
    scope: Scope,
    records: JsonObject[],
    full = true,
  ): Promise<void> {
    if (records.some((row) => typeof row.id !== "string" || !row.id))
      throw new AppError(
        "INVALID_RESPONSE",
        `A ${scope.resource} record has no stable ID; snapshot was not committed.`,
      );
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      for (let start = 0; start < records.length; start += 500) {
        // A batch can contain overlapping pages. Last observed record wins deterministically.
        const batch = [
          ...new Map(
            records.slice(start, start + 500).map((row) => [row.id, row]),
          ).values(),
        ];
        await client.query(
          `INSERT INTO pluggy_mcp.records(application_id,resource,id,item_id,parent_id,data)
          SELECT $1,$2,value->>'id',$3,$4,value FROM jsonb_array_elements($5::jsonb)
          ON CONFLICT(application_id,resource,id) DO UPDATE SET data=EXCLUDED.data,item_id=EXCLUDED.item_id,
            parent_id=EXCLUDED.parent_id,synced_at=now(),deleted_at=NULL`,
          [
            this.namespace,
            scope.resource,
            scope.itemId,
            scope.parentId,
            JSON.stringify(batch),
          ],
        );
      }
      // A missing posted transaction may have left the bank's history window. Preserve it.
      // Pending entries describe current obligations; retire them when a full import no longer returns them.
      if (full && scope.resource === "transactions")
        await client.query(
          `UPDATE pluggy_mcp.records SET deleted_at=now() WHERE application_id=$1
          AND resource='transactions' AND parent_id=$2 AND deleted_at IS NULL
          AND data->>'status'='PENDING' AND NOT(id=ANY($3::text[]))`,
          [this.namespace, scope.parentId, records.map((row) => row.id)],
        );
      if (
        full &&
        !["transactions", "investment_transactions"].includes(scope.resource)
      ) {
        await client.query(
          `UPDATE pluggy_mcp.records SET deleted_at=now() WHERE application_id=$1 AND resource=$2
          AND parent_id=$3 AND deleted_at IS NULL AND NOT (id = ANY($4::text[]))`,
          [
            this.namespace,
            scope.resource,
            scope.parentId,
            records.map((row) => row.id),
          ],
        );
      }
      if (full && ["accounts", "investments"].includes(scope.resource))
        await client.query(
          `UPDATE pluggy_mcp.sync_scopes SET complete=false,last_error='PARENT_NOT_RETURNED',revision=revision+1
          WHERE application_id=$1 AND item_id=$2 AND resource=ANY($3::text[]) AND NOT(parent_id=ANY($4::text[]))`,
          [
            this.namespace,
            scope.itemId,
            scope.resource === "accounts"
              ? ["transactions", "bills"]
              : ["investment_transactions"],
            records.map((row) => row.id),
          ],
        );
      if (full)
        await client.query(
          `INSERT INTO pluggy_mcp.sync_scopes(application_id,resource,parent_id,item_id,complete,synced_at,revision)
        VALUES($1,$2,$3,$4,true,now(),1) ON CONFLICT(application_id,resource,parent_id)
        DO UPDATE SET complete=true,synced_at=now(),last_error=NULL,revision=pluggy_mcp.sync_scopes.revision+1`,
          [this.namespace, scope.resource, scope.parentId, scope.itemId],
        );
      else
        await client.query(
          "UPDATE pluggy_mcp.sync_scopes SET last_event_at=now(),revision=revision+1 WHERE application_id=$1 AND resource=$2 AND parent_id=$3",
          [this.namespace, scope.resource, scope.parentId],
        );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async failed(scope: Scope, code: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO pluggy_mcp.sync_scopes(application_id,resource,parent_id,item_id,last_error)
      VALUES($1,$2,$3,$4,$5) ON CONFLICT(application_id,resource,parent_id) DO UPDATE SET last_error=$5`,
      [this.namespace, scope.resource, scope.parentId, scope.itemId, code],
    );
    // A failed parent refresh also makes its children's apparent freshness uncertain.
    if (["items", "accounts", "investments"].includes(scope.resource))
      await this.pool.query(
        `UPDATE pluggy_mcp.sync_scopes SET last_error=$3
        WHERE application_id=$1 AND item_id=$2 AND ($4::boolean OR resource=ANY($5::text[]))`,
        [
          this.namespace,
          scope.itemId,
          code,
          scope.resource === "items",
          scope.resource === "accounts"
            ? ["transactions", "bills"]
            : ["investment_transactions"],
        ],
      );
  }

  async unavailable(itemId: string, resources: Resource[]): Promise<void> {
    if (!resources.length) return;
    await this.pool.query(
      `UPDATE pluggy_mcp.sync_scopes SET complete=false,last_error='PRODUCT_UNAVAILABLE',revision=revision+1
      WHERE application_id=$1 AND item_id=$2 AND resource=ANY($3::text[])`,
      [this.namespace, itemId, resources],
    );
  }

  async scope(
    resource: Resource,
    parentId: string,
    db: pg.Pool | pg.PoolClient = this.pool,
  ): Promise<JsonObject> {
    const { rows } = await db.query(
      `SELECT s.*, queue.pending AS pending_events, queue.failed AS failed_events,
        coalesce(s.last_error, CASE WHEN queue.failed>0 THEN 'EVENT_FAILED' WHEN queue.pending>0 THEN 'EVENT_PENDING' END) AS last_error
      FROM pluggy_mcp.sync_scopes s JOIN pluggy_mcp.items i ON i.application_id=s.application_id AND i.id=s.item_id AND i.enabled
      CROSS JOIN LATERAL (SELECT count(*)::int AS pending, count(*) FILTER(WHERE e.attempts>=10)::int AS failed
        FROM pluggy_mcp.events e WHERE e.application_id=s.application_id AND e.processed_at IS NULL
        AND (e.payload->>'itemId'=s.item_id OR (e.payload->'transactionIds') ?| ARRAY(
          SELECT r.id FROM pluggy_mcp.records r WHERE r.application_id=s.application_id AND r.item_id=s.item_id AND r.resource='transactions'
        ))) queue
      WHERE s.application_id=$1 AND s.resource=$2 AND s.parent_id=$3`,
      [this.namespace, resource, parentId],
    );
    if (!rows[0]?.complete)
      throw new AppError(
        "NOT_SYNCHRONIZED",
        "Run pluggy_sync before reading this collection from PostgreSQL, or explicitly choose source=api.",
        { resource, parentId, lastError: rows[0]?.last_error },
      );
    const { application_id, ...freshness } = rows[0];
    if (resource === "transactions" || resource === "investment_transactions")
      freshness.historyPolicy =
        "Retains previously imported history. A complete import is not proof of complete bank history; missing posted records require explicit deletion events.";
    return freshness;
  }

  async invalidate(): Promise<void> {
    await this.pool.query(
      "UPDATE pluggy_mcp.sync_scopes SET complete=false,last_error='API_WRITE_REQUIRES_SYNC' WHERE application_id=$1",
      [this.namespace],
    );
  }

  async deleteItem(itemId: string): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "UPDATE pluggy_mcp.items SET enabled=false WHERE application_id=$1 AND id=$2",
        [this.namespace, itemId],
      );
      await client.query(
        "UPDATE pluggy_mcp.records SET deleted_at=now() WHERE application_id=$1 AND item_id=$2",
        [this.namespace, itemId],
      );
      await client.query(
        "UPDATE pluggy_mcp.sync_scopes SET complete=false,last_error='ITEM_DELETED' WHERE application_id=$1 AND item_id=$2",
        [this.namespace, itemId],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async deleteTransactions(ids: string[]): Promise<void> {
    await this.pool.query(
      `WITH deleted AS (
      UPDATE pluggy_mcp.records r SET deleted_at=now() WHERE application_id=$1 AND resource='transactions' AND id=ANY($2::text[])
      AND EXISTS(SELECT 1 FROM pluggy_mcp.items i WHERE i.application_id=r.application_id AND i.id=r.item_id AND i.enabled) RETURNING parent_id
    ) UPDATE pluggy_mcp.sync_scopes SET last_event_at=now(),revision=revision+1
      WHERE application_id=$1 AND resource='transactions' AND parent_id IN (SELECT parent_id FROM deleted)`,
      [this.namespace, ids],
    );
  }

  async read(op: Operation, args: Arguments): Promise<JsonObject> {
    return this.readSnapshot((db) => this.readCollection(op, args, db));
  }

  private async readSnapshot(
    work: (db: pg.PoolClient) => Promise<JsonObject>,
  ): Promise<JsonObject> {
    const db = await this.pool.connect();
    try {
      await db.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const result = await work(db);
      await db.query("COMMIT");
      return result;
    } catch (error) {
      await db.query("ROLLBACK");
      throw error;
    } finally {
      db.release();
    }
  }

  private async readCollection(
    op: Operation,
    args: Arguments,
    db: pg.PoolClient,
  ): Promise<JsonObject> {
    const mapping = cachedOperations[op.id];
    if (!mapping)
      throw new AppError(
        "DATABASE_UNSUPPORTED",
        "This operation requires Pluggy's live API. Choose source=api.",
      );
    const params: unknown[] = [this.namespace, mapping.resource];
    const where = ["application_id=$1", "resource=$2", "deleted_at IS NULL"];
    let freshness: JsonObject;
    if (mapping.single) {
      const result = await db.query(
        "SELECT parent_id FROM pluggy_mcp.records WHERE application_id=$1 AND resource=$2 AND id=$3 AND deleted_at IS NULL",
        [...params, args.path?.id],
      );
      if (!result.rows[0])
        throw new AppError(
          "NOT_FOUND_IN_DATABASE",
          "No synchronized record with this ID. Synchronize its item or choose source=api.",
        );
      freshness = await this.scope(
        mapping.resource,
        result.rows[0].parent_id,
        db,
      );
      params.push(args.path?.id);
      where.push("id=$3");
    } else {
      const parentId = String(
        (mapping.pathParent ? args.path : args.query)?.[mapping.parent!] ?? "",
      );
      freshness = await this.scope(mapping.resource, parentId, db);
      params.push(parentId);
      where.push("parent_id=$3");
    }
    const query = args.query ?? {};
    const filter = (clause: string, value: unknown) => {
      params.push(value);
      where.push(clause.replace("?", `$${params.length}`));
    };
    if (query.type) filter("data->>'type' = ?", query.type);
    if (query.ids) filter("id = ANY(?::text[])", query.ids);
    if (query.billId)
      filter("data->'creditCardMetadata'->>'billId' = ?", query.billId);
    const ignoreDates = op.id === "transactions-list" && query.ids?.length;
    if (!ignoreDates && (query.dateFrom || query.from))
      filter(
        "(data->>'date')::timestamptz >= (?::date::timestamp AT TIME ZONE 'UTC')",
        query.dateFrom ?? query.from,
      );
    if (!ignoreDates && (query.dateTo || query.to))
      filter(
        "(data->>'date')::timestamptz < ((?::date + 1)::timestamp AT TIME ZONE 'UTC')",
        query.dateTo ?? query.to,
      );
    if (query.createdAtFrom)
      filter(
        "(data->>'createdAt')::timestamptz >= ?::timestamptz",
        query.createdAtFrom,
      );
    let offset = 0;
    const limit = query.pageSize ?? 500;
    if (
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 500 ||
      (query.page !== undefined &&
        (!Number.isInteger(query.page) || query.page < 1))
    ) {
      throw new AppError(
        "INVALID_ARGUMENTS",
        "Database pagination requires integer page >= 1 and pageSize between 1 and 500.",
      );
    }
    const fingerprint = createHash("sha256")
      .update(
        JSON.stringify({
          op: op.id,
          application: this.namespace,
          parent: freshness.parent_id,
          query: Object.fromEntries(
            Object.entries(query)
              .filter(([k]) => !["after", "page"].includes(k))
              .sort(),
          ),
          revision: freshness.revision,
        }),
      )
      .digest("hex");
    if (query.after) offset = decodeCursor(query.after, fingerprint);
    else offset = ((query.page ?? 1) - 1) * limit;
    const count = await db.query(
      `SELECT count(*)::int AS total FROM pluggy_mcp.records WHERE ${where.join(" AND ")}`,
      params,
    );
    const { rows } = await db.query(
      `SELECT data FROM pluggy_mcp.records WHERE ${where.join(" AND ")}
      ORDER BY data->>'date',id LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, mapping.single ? 1 : limit, offset],
    );
    const total = count.rows[0].total;
    const next =
      offset + limit < total
        ? `?after=${encodeURIComponent(encodeCursor(offset + limit, fingerprint))}`
        : null;
    const data =
      mapping.single || op.id === "identity-find-by-item"
        ? (rows[0]?.data ?? null)
        : op.id === "transactions-list-by-cursor"
          ? { results: rows.map((row) => row.data), next }
          : {
              results: rows.map((row) => row.data),
              page: query.page ?? 1,
              total,
              totalPages: Math.ceil(total / limit),
            };
    return { source: "database", freshness, data };
  }

  async status(): Promise<JsonObject> {
    const scopes = await this.pool.query(
      "SELECT resource,parent_id,item_id,complete,synced_at,last_event_at,last_error FROM pluggy_mcp.sync_scopes WHERE application_id=$1 ORDER BY item_id,resource,parent_id",
      [this.namespace],
    );
    const events = await this.pool.query(
      "SELECT count(*)::int AS pending,count(*) FILTER(WHERE attempts>=10)::int AS failed,count(*) FILTER(WHERE attempts>0 AND attempts<10)::int AS retrying FROM pluggy_mcp.events WHERE application_id=$1 AND processed_at IS NULL",
      [this.namespace],
    );
    return {
      itemIds: await this.itemIds(),
      scopes: scopes.rows,
      events: events.rows[0],
      failedEvents: (
        await this.pool.query(
          "SELECT id,payload->>'event' AS event,attempts,last_error,received_at,next_attempt_at FROM pluggy_mcp.events WHERE application_id=$1 AND processed_at IS NULL AND last_error IS NOT NULL ORDER BY received_at LIMIT 20",
          [this.namespace],
        )
      ).rows,
    };
  }

  async transactions(
    input: JsonObject,
    summarize = false,
  ): Promise<JsonObject> {
    return this.readSnapshot((db) =>
      this.queryTransactions(input, summarize, db),
    );
  }

  private async queryTransactions(
    input: JsonObject,
    summarize: boolean,
    db: pg.PoolClient,
  ): Promise<JsonObject> {
    const registered = await this.itemIds(db);
    const itemIds = input.itemIds?.length ? input.itemIds : registered;
    if (!itemIds.length)
      throw new AppError(
        "NO_ITEMS",
        "Set PLUGGY_ITEM_IDS in the server environment.",
      );
    if (itemIds.some((id: string) => !registered.includes(id)))
      throw new AppError(
        "ITEM_NOT_CONFIGURED",
        "This item is not enabled by PLUGGY_ITEM_IDS.",
      );
    const freshness: JsonObject[] = [];
    const accounts = await db.query(
      `SELECT id,item_id FROM pluggy_mcp.records WHERE application_id=$1 AND resource='accounts' AND item_id=ANY($2::text[])
        AND deleted_at IS NULL ${input.accountIds?.length ? "AND id=ANY($3::text[])" : ""} ORDER BY id`,
      input.accountIds?.length
        ? [this.namespace, itemIds, input.accountIds]
        : [this.namespace, itemIds],
    );
    if (
      input.accountIds?.some(
        (id: string) => !accounts.rows.some((row) => row.id === id),
      )
    )
      throw new AppError(
        "ACCOUNT_NOT_SYNCHRONIZED",
        "A requested account is missing from the selected items' mirror. Verify the IDs and synchronize first.",
      );
    const excludedAccountIds = input.accountIds?.length
      ? []
      : (
          await db.query(
            "SELECT id FROM pluggy_mcp.records WHERE application_id=$1 AND resource='accounts' AND item_id=ANY($2::text[]) AND deleted_at IS NOT NULL ORDER BY id",
            [this.namespace, itemIds],
          )
        ).rows.map((row) => row.id);
    const selectedItems = input.accountIds?.length
      ? [...new Set(accounts.rows.map((row) => row.item_id))]
      : itemIds;
    for (const item of selectedItems)
      freshness.push(await this.scope("accounts", item, db));
    for (const account of accounts.rows)
      freshness.push(await this.scope("transactions", account.id, db));
    const params: unknown[] = [
      this.namespace,
      itemIds,
      accounts.rows.map((row) => row.id),
    ];
    const where = [
      "application_id=$1",
      "resource='transactions'",
      "deleted_at IS NULL",
      "item_id=ANY($2::text[])",
      "parent_id=ANY($3::text[])",
    ];
    const filter = (clause: string, value: unknown) => {
      params.push(value);
      where.push(clause.replace("?", `$${params.length}`));
    };
    if (input.dateFrom)
      filter(
        "(data->>'date')::timestamptz >= (?::date::timestamp AT TIME ZONE 'UTC')",
        input.dateFrom,
      );
    if (input.dateTo)
      filter(
        "(data->>'date')::timestamptz < ((?::date + 1)::timestamp AT TIME ZONE 'UTC')",
        input.dateTo,
      );
    for (const field of ["status", "type", "currencyCode", "categoryId"])
      if (input[field]) filter(`data->>'${field}' = ?`, input[field]);
    if (summarize) {
      const fields: Record<string, string> = {
        accountId: "parent_id",
        type: "data->>'type'",
        status: "data->>'status'",
        currencyCode: "data->>'currencyCode'",
        category: "data->>'category'",
        categoryId: "data->>'categoryId'",
        month:
          "to_char((data->>'date')::timestamptz AT TIME ZONE 'UTC','YYYY-MM')",
      };
      // Currency is always a grouping dimension; adding different currencies is never meaningful.
      const groupBy = [
        ...new Set<string>([
          "currencyCode",
          "accountId",
          ...(input.groupBy ?? ["type", "status"]),
        ]),
      ];
      if (groupBy.some((field) => !Object.hasOwn(fields, field)))
        throw new AppError(
          "INVALID_ARGUMENTS",
          "Unsupported summary dimension.",
        );
      const expressions = groupBy.map((field) => fields[field]);
      const result = await db.query(
        `SELECT ${groupBy.map((field) => `${fields[field]} AS "${field}"`).join(",")},count(*)::int AS count,
        sum((data->>'amount')::numeric)::text AS amount FROM pluggy_mcp.records WHERE ${where.join(" AND ")}
        GROUP BY ${expressions.join(",")} ORDER BY ${expressions.join(",")} LIMIT 1001`,
        params,
      );
      if (result.rows.length > 1000)
        throw new AppError(
          "RESULT_TOO_LARGE",
          "Narrow the filters or use fewer grouping dimensions; the summary has more than 1000 groups.",
        );
      return {
        source: "database",
        freshness,
        excludedAccountIds,
        groups: result.rows,
        amountConvention:
          "Original Pluggy amounts, separated by account and currency. Bank debits are negative; credit-card charges are positive. Includes transfers and card bill payments unless filtered; these are raw totals, not household spending.",
      };
    }
    const limit = input.limit ?? 100;
    const fingerprint = createHash("sha256")
      .update(
        JSON.stringify({
          application: this.namespace,
          filters: Object.fromEntries(
            Object.entries({ ...input, limit })
              .filter(([key]) => key !== "cursor")
              .sort(),
          ),
          scopes: freshness.map((row) => [
            row.resource,
            row.parent_id,
            row.revision,
          ]),
        }),
      )
      .digest("hex");
    const offset = input.cursor ? decodeCursor(input.cursor, fingerprint) : 0;
    const result = await db.query(
      `SELECT data FROM pluggy_mcp.records WHERE ${where.join(" AND ")}
      ORDER BY data->>'date',id LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit + 1, offset],
    );
    return {
      source: "database",
      freshness,
      excludedAccountIds,
      results: result.rows.slice(0, limit).map((row) => row.data),
      nextCursor:
        result.rows.length > limit
          ? encodeCursor(offset + limit, fingerprint)
          : null,
    };
  }

  async enqueue(payload: JsonObject): Promise<void> {
    if (payload.itemId && !(await this.itemIds()).includes(payload.itemId))
      return;
    await this.pool.query(
      "INSERT INTO pluggy_mcp.events(application_id,id,payload) VALUES($1,$2,$3) ON CONFLICT DO NOTHING",
      [this.namespace, payload.eventId, JSON.stringify(payload)],
    );
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
