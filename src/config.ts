import { createHash } from "node:crypto";
import { AppError, type Config } from "./types.js";

export const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const integer = (
    name: string,
    fallback: number,
    min = 1,
    max = 2_147_483_647,
  ) => {
    const value = env[name] === undefined ? fallback : Number(env[name]);
    if (!Number.isInteger(value) || value < min || value > max) {
      throw new AppError(
        "INVALID_CONFIG",
        `${name} must be an integer between ${min} and ${max}.`,
      );
    }
    return value;
  };
  const clientId = env.PLUGGY_CLIENT_ID?.trim();
  const clientSecret = env.PLUGGY_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) {
    throw new AppError(
      "INVALID_CONFIG",
      "Set PLUGGY_CLIENT_ID and PLUGGY_CLIENT_SECRET in the server environment.",
    );
  }
  if (
    env.PLUGGY_ALLOW_WRITES &&
    !["true", "false"].includes(env.PLUGGY_ALLOW_WRITES)
  ) {
    throw new AppError(
      "INVALID_CONFIG",
      "PLUGGY_ALLOW_WRITES must be true or false.",
    );
  }
  const databaseUrl = env.DATABASE_URL?.trim() || undefined;
  if (databaseUrl) {
    try {
      if (!["postgres:", "postgresql:"].includes(new URL(databaseUrl).protocol))
        throw new Error();
    } catch {
      throw new AppError(
        "INVALID_CONFIG",
        "DATABASE_URL must be a PostgreSQL connection string.",
      );
    }
  }
  const itemIds = [
    ...new Set(
      (env.PLUGGY_ITEM_IDS ?? "")
        .split(",")
        .map((x) => x.trim().toLowerCase())
        .filter(Boolean),
    ),
  ];
  if (itemIds.some((id) => !UUID.test(id)))
    throw new AppError(
      "INVALID_CONFIG",
      "PLUGGY_ITEM_IDS must contain comma-separated UUIDs.",
    );
  const webhookPort = env.PLUGGY_WEBHOOK_PORT
    ? integer("PLUGGY_WEBHOOK_PORT", 0, 1, 65535)
    : undefined;
  // Node timers overflow to 1ms above 2^31-1 milliseconds.
  const syncIntervalSeconds = integer(
    "PLUGGY_SYNC_INTERVAL_SECONDS",
    0,
    0,
    2_147_483,
  );
  const webhookSecret = env.PLUGGY_WEBHOOK_SECRET;
  if ((webhookPort || syncIntervalSeconds) && !databaseUrl) {
    throw new AppError(
      "INVALID_CONFIG",
      "Scheduled sync and webhook ingestion require DATABASE_URL.",
    );
  }
  if (webhookPort && (!webhookSecret || webhookSecret.length < 32)) {
    throw new AppError(
      "INVALID_CONFIG",
      "Set PLUGGY_WEBHOOK_SECRET to at least 32 characters before enabling the webhook receiver.",
    );
  }
  return {
    clientId,
    clientSecret,
    databaseUrl,
    namespace: createHash("sha256").update(clientId).digest("hex"),
    enrichmentApiKey: env.PLUGGY_ENRICHMENT_API_KEY?.trim() || undefined,
    allowWrites: env.PLUGGY_ALLOW_WRITES === "true",
    itemIds,
    timeoutMs: integer("PLUGGY_TIMEOUT_MS", 30_000, 100, 300_000),
    maxPages: integer("PLUGGY_MAX_SYNC_PAGES", 1000, 1, 100_000),
    syncIntervalSeconds,
    webhookPort,
    webhookSecret,
    webhookHost: env.PLUGGY_WEBHOOK_HOST || "127.0.0.1",
  };
}
