#!/usr/bin/env node

import "dotenv/config";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { PluggyClient } from "./client.js";
import { Storage } from "./storage.js";
import { Synchronizer } from "./sync.js";
import { createServer } from "./server.js";
import { startWebhooks } from "./webhooks.js";
import { AppError } from "./types.js";

async function main(): Promise<void> {
  const command = process.argv[2];
  if (["--help", "-h"].includes(command)) {
    console.log(
      "pluggy-mcp [sync|worker]\n\nDefault: run the MCP server over stdio.\nsync: synchronize configured items to DATABASE_URL once, then exit.\nworker: run configured PostgreSQL polling/webhooks without an LLM session.\n\nSee README.md for credentials, optional PostgreSQL, and webhook setup.",
    );
    return;
  }
  if (command && !["sync", "worker"].includes(command))
    throw new AppError(
      "INVALID_COMMAND",
      "Use pluggy-mcp, pluggy-mcp sync, pluggy-mcp worker, or pluggy-mcp --help.",
    );
  const config = loadConfig();
  if (
    command === "worker" &&
    (!config.databaseUrl ||
      (!config.webhookPort && !config.syncIntervalSeconds))
  )
    throw new AppError(
      "INVALID_CONFIG",
      "Worker mode requires DATABASE_URL and a webhook port or sync interval.",
    );
  const client = new PluggyClient(config);
  const storage = config.databaseUrl
    ? new Storage(config.databaseUrl, config.namespace)
    : undefined;
  const sync = storage ? new Synchronizer(client, storage) : undefined;
  if (command === "sync") {
    if (!storage)
      throw new AppError(
        "DATABASE_NOT_CONFIGURED",
        "Set DATABASE_URL before running pluggy-mcp sync.",
      );
    try {
      await storage.initialize();
      await storage.registerItems(config.itemIds);
      const result = await sync!.sync();
      console.log(JSON.stringify(result, null, 2));
      if (!result.complete) process.exitCode = 2;
    } finally {
      await storage.close();
    }
    return;
  }
  const server =
    command === "worker"
      ? undefined
      : createServer(config, client, storage, sync);
  let webhooks: Awaited<ReturnType<typeof startWebhooks>> | undefined;
  const timers: NodeJS.Timeout[] = [];
  let background: Promise<void> = Promise.resolve();
  let busy = false;
  let stopping = false;
  try {
    if (storage) {
      await storage.initialize();
      await storage.registerItems(config.itemIds);
    }
    if (config.webhookPort) webhooks = await startWebhooks(config, storage!);
    const schedule = (job: () => Promise<unknown>, interval: number) => {
      const timer = setInterval(() => {
        if (busy || stopping) return;
        busy = true;
        background = job()
          .then(
            (result) => {
              if (
                result &&
                typeof result === "object" &&
                "complete" in result &&
                result.complete === false
              )
                console.error(
                  "Synchronization completed with product errors; inspect pluggy_sync_status.",
                );
            },
            (error) => {
              console.error(
                error instanceof AppError
                  ? `${error.code}: ${error.message}`
                  : "Background synchronization failed; inspect pluggy_sync_status.",
              );
            },
          )
          .finally(() => {
            busy = false;
          });
      }, interval);
      if (command !== "worker") timer.unref();
      timers.push(timer);
    };
    if (config.syncIntervalSeconds)
      schedule(() => sync!.sync(), config.syncIntervalSeconds * 1000);
    if (storage) schedule(() => sync!.processEvents(), 5000);
    const stop = async () => {
      if (stopping) return;
      stopping = true;
      timers.forEach(clearInterval);
      if (webhooks)
        await new Promise<void>((resolve) => webhooks!.close(() => resolve()));
      await background;
      await sync?.waitForIdle();
      await server?.close();
      await storage?.close();
    };
    const shutdown = () => {
      void stop().catch(() => {
        console.error("Shutdown failed while closing server resources.");
        process.exitCode = 1;
      });
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
    if (server) {
      server.onclose = shutdown;
      await server.connect(new StdioServerTransport());
    }
  } catch (error) {
    timers.forEach(clearInterval);
    webhooks?.close();
    await storage?.close();
    throw error;
  }
}

main().catch((error) => {
  console.error(
    error instanceof AppError
      ? `${error.code}: ${error.message}`
      : "Pluggy MCP could not start. Check API credentials, DATABASE_URL, and database permissions.",
  );
  process.exitCode = 1;
});
