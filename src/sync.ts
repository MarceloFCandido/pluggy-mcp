import { PluggyClient, ApiError } from "./client.js";
import { Storage, type Resource } from "./storage.js";
import { AppError, type JsonObject } from "./types.js";

export class Synchronizer {
  private running?: Promise<JsonObject>;
  constructor(
    readonly client: PluggyClient,
    readonly storage: Storage,
  ) {}

  async sync(itemIds?: string[]): Promise<JsonObject> {
    // One run per process; reject instead of silently dropping a different requested scope.
    if (this.running)
      throw new AppError(
        "SYNC_IN_PROGRESS",
        "A synchronization is already running. Check pluggy_sync_status and retry later.",
      );
    this.running = this.run(itemIds).finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  async waitForIdle(): Promise<void> {
    try {
      await this.running;
    } catch {
      /* The caller already receives the sync error. */
    }
  }

  private async run(requested?: string[]): Promise<JsonObject> {
    const ids = requested?.length ? requested : await this.storage.itemIds();
    if (!ids.length)
      throw new AppError(
        "NO_ITEMS",
        "Set PLUGGY_ITEM_IDS or use pluggy_register_items. Meu Pluggy cannot discover item IDs through GET /v2/items.",
      );
    await this.storage.registerItems(ids, !!requested?.length);
    const results: JsonObject[] = [];
    await this.storage.withSyncLock(async () => {
      for (const itemId of ids) results.push(await this.item(itemId));
    });
    return {
      source: "api",
      storedIn: "database",
      items: results,
      complete: results.every((result) => result.errors.length === 0),
    };
  }

  private async item(itemId: string): Promise<JsonObject> {
    const counts: JsonObject = {};
    const errors: JsonObject[] = [];
    const capture = async (
      resource: Resource,
      parentId: string,
      load: () => Promise<JsonObject[]>,
    ) => {
      const scope = { resource, parentId, itemId };
      try {
        const rows = await load();
        await this.storage.snapshot(scope, rows);
        counts[resource] = (counts[resource] ?? 0) + rows.length;
        return rows;
      } catch (error) {
        const code =
          error instanceof ApiError
            ? `HTTP_${error.status}`
            : error instanceof AppError
              ? error.code
              : "SYNC_FAILED";
        await this.storage.failed(scope, code);
        errors.push({ resource, parentId, code });
        return undefined;
      }
    };
    const item = await capture("items", itemId, async () => [
      await this.client.request("items-retrieve", { path: { id: itemId } }),
    ]);
    if (!item) return { itemId, counts, errors };
    // Missing product lists are treated as unknown, not as empty entitlement lists.
    const products: string[] | undefined = item[0].products;
    const enabled = (...names: string[]) =>
      !products || names.some((name) => products.includes(name));
    if (enabled("ACCOUNTS", "CREDIT_CARDS", "TRANSACTIONS")) {
      const accounts = await capture("accounts", itemId, () =>
        this.client.listAll("accounts-list", { query: { itemId } }),
      );
      for (const account of accounts ?? []) {
        if (enabled("TRANSACTIONS"))
          await capture("transactions", account.id, () =>
            this.client.listAll("transactions-list-by-cursor", {
              query: { accountId: account.id },
            }),
          );
        if (account.type === "CREDIT")
          await capture("bills", account.id, () =>
            this.client.listAll("bills-list", {
              query: { accountId: account.id, pageSize: 500 },
            }),
          );
      }
    }
    if (enabled("INVESTMENTS", "INVESTMENTS_TRANSACTIONS")) {
      const investments = await capture("investments", itemId, () =>
        this.client.listAll("investments-list", {
          query: { itemId, pageSize: 500 },
        }),
      );
      if (enabled("INVESTMENTS_TRANSACTIONS"))
        for (const investment of investments ?? []) {
          await capture("investment_transactions", investment.id, () =>
            this.client.listAll("investment-transactions-list", {
              path: { id: investment.id },
              query: { pageSize: 500 },
            }),
          );
        }
    }
    if (enabled("IDENTITY"))
      await capture("identity", itemId, async () => {
        const value = await this.client.request("identity-find-by-item", {
          query: { itemId },
        });
        return Array.isArray(value?.results)
          ? value.results
          : value
            ? [value]
            : [];
      });
    if (enabled("LOANS"))
      await capture("loans", itemId, () =>
        this.client.listAll("loans-list", { query: { itemId } }),
      );
    await capture("consents", itemId, () =>
      this.client.listAll("consents-list", { query: { itemId } }),
    );
    return { itemId, counts, errors };
  }

  async processEvents(): Promise<void> {
    // Hold the application lock while applying events as well, so an older snapshot cannot resurrect deletions.
    try {
      await this.storage.withSyncLock(async () => {
        const pending = await this.storage.pool.query(
          "SELECT id,payload FROM pluggy_mcp.events WHERE application_id=$1 AND processed_at IS NULL AND attempts<5 ORDER BY received_at,id LIMIT 20",
          [this.storage.namespace],
        );
        for (const { id, payload } of pending.rows) {
          try {
            await this.event(payload);
            await this.storage.pool.query(
              "UPDATE pluggy_mcp.events SET processed_at=now(),last_error=NULL WHERE application_id=$1 AND id=$2",
              [this.storage.namespace, id],
            );
          } catch (error) {
            const code =
              error instanceof ApiError
                ? `HTTP_${error.status}`
                : error instanceof AppError
                  ? error.code
                  : "EVENT_FAILED";
            await this.storage.pool.query(
              "UPDATE pluggy_mcp.events SET attempts=attempts+1,last_error=$3 WHERE application_id=$1 AND id=$2",
              [this.storage.namespace, id, code],
            );
          }
        }
      });
    } catch (error) {
      if (!(error instanceof AppError && error.code === "SYNC_IN_PROGRESS"))
        throw error;
    }
  }

  private async event(payload: JsonObject): Promise<void> {
    if (payload.event === "transactions/deleted") {
      if (!Array.isArray(payload.transactionIds))
        throw new AppError(
          "INVALID_EVENT",
          "Deletion event requires transactionIds.",
        );
      await this.storage.deleteTransactions(payload.transactionIds);
      return;
    }
    if (payload.event === "item/deleted") {
      await this.storage.deleteItem(payload.itemId);
      return;
    }
    if (
      ["transactions/created", "transactions/updated"].includes(
        payload.event,
      ) &&
      payload.itemId &&
      payload.accountId
    ) {
      let baseline = false;
      try {
        const scope = await this.storage.scope(
          "transactions",
          payload.accountId,
        );
        if (scope.item_id !== payload.itemId)
          throw new AppError(
            "INVALID_EVENT",
            "Event item does not own this account's synchronized transactions.",
          );
        baseline = true;
      } catch (error) {
        if (!(error instanceof AppError && error.code === "NOT_SYNCHRONIZED"))
          throw error;
      }
      if (baseline) {
        const query: JsonObject = { accountId: payload.accountId };
        const records: JsonObject[] = [];
        if (
          payload.event === "transactions/updated" &&
          Array.isArray(payload.transactionIds)
        ) {
          for (
            let start = 0;
            start < payload.transactionIds.length;
            start += 500
          ) {
            records.push(
              ...(await this.client.listAll("transactions-list-by-cursor", {
                query: {
                  ...query,
                  ids: payload.transactionIds.slice(start, start + 500),
                },
              })),
            );
          }
        } else {
          let createdAtFrom = payload.transactionsCreatedAtFrom;
          if (
            !createdAtFrom &&
            typeof payload.createdTransactionsLink === "string"
          ) {
            const link = new URL(payload.createdTransactionsLink);
            if (
              link.origin !== "https://api.pluggy.ai" ||
              !["/transactions", "/v2/transactions"].includes(link.pathname) ||
              link.searchParams.get("accountId")?.toLowerCase() !==
                payload.accountId
            ) {
              throw new AppError(
                "INVALID_EVENT",
                "Unexpected created-transactions link.",
              );
            }
            createdAtFrom = link.searchParams.get("createdAtFrom");
          }
          if (
            typeof createdAtFrom !== "string" ||
            !Number.isFinite(Date.parse(createdAtFrom))
          )
            throw new AppError(
              "INVALID_EVENT",
              "Creation event requires a valid creation timestamp.",
            );
          records.push(
            ...(await this.client.listAll("transactions-list-by-cursor", {
              query: { ...query, createdAtFrom },
            })),
          );
        }
        await this.storage.snapshot(
          {
            resource: "transactions",
            itemId: payload.itemId,
            parentId: payload.accountId,
          },
          records,
          false,
        );
        return;
      }
    }
    if (
      [
        "item/created",
        "item/updated",
        "transactions/created",
        "transactions/updated",
      ].includes(payload.event)
    ) {
      if (!payload.itemId)
        throw new AppError("INVALID_EVENT", "Data event requires itemId.");
      await this.storage.registerItems([payload.itemId]);
      // Re-read an authoritative snapshot: handles out-of-order notifications and does not trust URLs in payloads.
      const result = await this.item(payload.itemId);
      if (
        result.errors.some(
          (error: JsonObject) => !["HTTP_403", "HTTP_404"].includes(error.code),
        )
      )
        throw new AppError(
          "SYNC_INCOMPLETE",
          "Event synchronization was incomplete.",
        );
    }
  }
}
