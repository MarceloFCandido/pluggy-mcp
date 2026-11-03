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

export const cachedOperations: Record<
  string,
  {
    resource: Resource;
    parent?: string;
    pathParent?: boolean;
    single?: boolean;
  }
> = {
  "items-retrieve": { resource: "items", single: true },
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
      options: "-c timezone=UTC",
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

  async registerItems(ids: string[], enable = false): Promise<void> {
    for (const id of ids)
      await this.pool.query(
        `INSERT INTO pluggy_mcp.items(application_id,id) VALUES($1,$2)
      ON CONFLICT(application_id,id) DO ${enable ? "UPDATE SET enabled=true" : "NOTHING"}`,
        [this.namespace, id],
      );
  }

  async itemIds(): Promise<string[]> {
    const result = await this.pool.query(
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
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        [`${this.namespace}:${scope.resource}:${scope.parentId}`],
      );
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
      // Keep historical transactions if an institution later shortens its history window.
      // Explicit webhook deletion events remove those; other product lists are complete snapshots.
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
  }

  async scope(resource: Resource, parentId: string): Promise<JsonObject> {
    const { rows } = await this.pool.query(
      `SELECT resource,parent_id,item_id,synced_at,last_event_at,revision,last_error,complete FROM pluggy_mcp.sync_scopes
      WHERE application_id=$1 AND resource=$2 AND parent_id=$3`,
      [this.namespace, resource, parentId],
    );
    if (!rows[0]?.complete)
      throw new AppError(
        "NOT_SYNCHRONIZED",
        "Run pluggy_sync before reading this collection from PostgreSQL, or explicitly choose source=api.",
        { resource, parentId, lastError: rows[0]?.last_error },
      );
    return rows[0];
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
      UPDATE pluggy_mcp.records SET deleted_at=now() WHERE application_id=$1 AND resource='transactions' AND id=ANY($2::text[]) RETURNING parent_id
    ) UPDATE pluggy_mcp.sync_scopes SET last_event_at=now(),revision=revision+1
      WHERE application_id=$1 AND resource='transactions' AND parent_id IN (SELECT parent_id FROM deleted)`,
      [this.namespace, ids],
    );
  }

  async read(op: Operation, args: Arguments): Promise<JsonObject> {
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
      const result = await this.pool.query(
        "SELECT parent_id FROM pluggy_mcp.records WHERE application_id=$1 AND resource=$2 AND id=$3 AND deleted_at IS NULL",
        [...params, args.path?.id],
      );
      if (!result.rows[0])
        throw new AppError(
          "NOT_FOUND_IN_DATABASE",
          "No synchronized record with this ID. Synchronize its item or choose source=api.",
        );
      freshness = await this.scope(mapping.resource, result.rows[0].parent_id);
      params.push(args.path?.id);
      where.push("id=$3");
    } else {
      const parentId = String(
        (mapping.pathParent ? args.path : args.query)?.[mapping.parent!] ?? "",
      );
      freshness = await this.scope(mapping.resource, parentId);
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
    if (query.after) {
      try {
        const cursor = JSON.parse(
          Buffer.from(query.after, "base64url").toString(),
        );
        if (
          cursor.fingerprint !== fingerprint ||
          !Number.isSafeInteger(cursor.offset) ||
          cursor.offset < 0
        )
          throw new Error();
        offset = cursor.offset;
      } catch {
        throw new AppError(
          "INVALID_CURSOR",
          "Use the database cursor with the same filters and source; restart pagination after a synchronization.",
        );
      }
    } else offset = ((query.page ?? 1) - 1) * limit;
    const count = await this.pool.query(
      `SELECT count(*)::int AS total FROM pluggy_mcp.records WHERE ${where.join(" AND ")}`,
      params,
    );
    const { rows } = await this.pool.query(
      `SELECT data FROM pluggy_mcp.records WHERE ${where.join(" AND ")}
      ORDER BY data->>'date',id LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, mapping.single ? 1 : limit, offset],
    );
    const total = count.rows[0].total;
    const next =
      offset + limit < total
        ? `?after=${encodeURIComponent(Buffer.from(JSON.stringify({ offset: offset + limit, fingerprint })).toString("base64url"))}`
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
      "SELECT count(*)::int AS pending,count(*) FILTER(WHERE last_error IS NOT NULL)::int AS failed FROM pluggy_mcp.events WHERE application_id=$1 AND processed_at IS NULL",
      [this.namespace],
    );
    return {
      itemIds: await this.itemIds(),
      scopes: scopes.rows,
      events: events.rows[0],
      failedEvents: (
        await this.pool.query(
          "SELECT id,payload->>'event' AS event,attempts,last_error,received_at FROM pluggy_mcp.events WHERE application_id=$1 AND processed_at IS NULL AND last_error IS NOT NULL ORDER BY received_at LIMIT 20",
          [this.namespace],
        )
      ).rows,
    };
  }

  async transactions(
    input: JsonObject,
    summarize = false,
  ): Promise<JsonObject> {
    const itemIds = input.itemIds?.length
      ? input.itemIds
      : await this.itemIds();
    if (!itemIds.length)
      throw new AppError(
        "NO_ITEMS",
        "Set PLUGGY_ITEM_IDS or register items with pluggy_register_items.",
      );
    const freshness: JsonObject[] = [];
    const accounts = await this.pool.query(
      `SELECT id,item_id FROM pluggy_mcp.records WHERE application_id=$1 AND resource='accounts' AND item_id=ANY($2::text[])
        AND deleted_at IS NULL ${input.accountIds?.length ? "AND id=ANY($3::text[])" : ""}`,
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
    const selectedItems = input.accountIds?.length
      ? [...new Set(accounts.rows.map((row) => row.item_id))]
      : itemIds;
    for (const item of selectedItems)
      freshness.push(await this.scope("accounts", item));
    for (const account of accounts.rows)
      freshness.push(await this.scope("transactions", account.id));
    const params: unknown[] = [this.namespace, itemIds];
    const where = [
      "application_id=$1",
      "resource='transactions'",
      "deleted_at IS NULL",
      "item_id=ANY($2::text[])",
    ];
    const filter = (clause: string, value: unknown) => {
      params.push(value);
      where.push(clause.replace("?", `$${params.length}`));
    };
    if (input.accountIds?.length)
      filter("parent_id=ANY(?::text[])", input.accountIds);
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
          ...(input.groupBy ?? ["type", "status"]),
        ]),
      ];
      if (groupBy.some((field) => !Object.hasOwn(fields, field)))
        throw new AppError(
          "INVALID_ARGUMENTS",
          "Unsupported summary dimension.",
        );
      const expressions = groupBy.map((field) => fields[field]);
      const result = await this.pool.query(
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
        groups: result.rows,
        amountConvention:
          "Unmodified Pluggy amounts, grouped by currency. Totals include internal transfers and card bill payments unless your filters exclude them; they are not automatically household spending.",
      };
    }
    const limit = input.limit ?? 100;
    const offset = input.offset ?? 0;
    const result = await this.pool.query(
      `SELECT data FROM pluggy_mcp.records WHERE ${where.join(" AND ")}
      ORDER BY data->>'date',id LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit + 1, offset],
    );
    return {
      source: "database",
      freshness,
      results: result.rows.slice(0, limit).map((row) => row.data),
      nextOffset: result.rows.length > limit ? offset + limit : null,
    };
  }

  async enqueue(payload: JsonObject): Promise<void> {
    await this.pool.query(
      "INSERT INTO pluggy_mcp.events(application_id,id,payload) VALUES($1,$2,$3) ON CONFLICT DO NOTHING",
      [this.namespace, payload.eventId, JSON.stringify(payload)],
    );
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
