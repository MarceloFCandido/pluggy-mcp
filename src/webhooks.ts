import { createServer, type Server } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { UUID } from "./config.js";
import { Storage } from "./storage.js";
import { AppError, type Config, type JsonObject } from "./types.js";

const dataEvents = new Set([
  "item/created",
  "item/updated",
  "item/deleted",
  "transactions/created",
  "transactions/updated",
  "transactions/deleted",
]);

export async function startWebhooks(
  config: Config,
  storage: Storage,
): Promise<Server> {
  const expected = Buffer.from(`Bearer ${config.webhookSecret}`);
  const server = createServer(async (request, response) => {
    const finish = (status: number, text: string) => {
      response.writeHead(status, { "Content-Type": "text/plain" });
      response.end(text);
    };
    if (request.url !== "/webhooks/pluggy") {
      finish(404, "Not found");
      return;
    }
    if (request.method !== "POST") {
      finish(405, "POST required");
      return;
    }
    const actual = Buffer.from(request.headers.authorization ?? "");
    if (
      actual.length !== expected.length ||
      !timingSafeEqual(actual, expected)
    ) {
      finish(401, "Unauthorized");
      return;
    }
    const chunks: Buffer[] = [];
    try {
      let bytes = 0;
      for await (const chunk of request) {
        bytes += Buffer.byteLength(chunk);
        if (bytes > 1_048_576) {
          finish(413, "Payload too large");
          request.resume();
          return;
        }
        chunks.push(Buffer.from(chunk));
      }
      let payload: JsonObject;
      try {
        payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        finish(400, "Invalid JSON");
        return;
      }
      if (
        !payload ||
        typeof payload !== "object" ||
        typeof payload.event !== "string" ||
        typeof payload.eventId !== "string" ||
        !payload.eventId ||
        payload.eventId.length > 255
      ) {
        finish(400, "event and eventId are required");
        return;
      }
      if (!dataEvents.has(payload.event)) {
        finish(202, "Event does not affect mirrored data");
        return;
      }
      if (payload.event === "transactions/deleted") {
        if (
          !Array.isArray(payload.transactionIds) ||
          !payload.transactionIds.every(
            (id: unknown) => typeof id === "string" && UUID.test(id),
          )
        ) {
          finish(400, "transactionIds must contain UUIDs");
          return;
        }
      } else if (
        typeof payload.itemId !== "string" ||
        !UUID.test(payload.itemId)
      ) {
        finish(400, "itemId must be a UUID");
        return;
      }
      if (
        payload.event === "transactions/updated" &&
        (!Array.isArray(payload.transactionIds) ||
          !payload.transactionIds.every(
            (id: unknown) => typeof id === "string" && UUID.test(id),
          ))
      ) {
        finish(400, "transactionIds must contain UUIDs");
        return;
      }
      if (
        ["transactions/created", "transactions/updated"].includes(
          payload.event,
        ) &&
        (typeof payload.accountId !== "string" || !UUID.test(payload.accountId))
      ) {
        finish(400, "accountId must be a UUID");
        return;
      }
      if (typeof payload.itemId === "string")
        payload.itemId = payload.itemId.toLowerCase();
      if (typeof payload.accountId === "string")
        payload.accountId = payload.accountId.toLowerCase();
      if (Array.isArray(payload.transactionIds))
        payload.transactionIds = payload.transactionIds.map((id: string) =>
          id.toLowerCase(),
        );
      await storage.enqueue(payload);
      // Commit to the durable queue before acknowledging; processing happens outside the request.
      finish(202, "Queued");
    } catch {
      if (!response.headersSent)
        finish(503, "Could not queue event; retry later");
    }
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;
  await new Promise<void>((resolve, reject) => {
    server.once("error", () =>
      reject(
        new AppError(
          "WEBHOOK_LISTEN_FAILED",
          "Could not bind the webhook listener. Check PLUGGY_WEBHOOK_HOST and PLUGGY_WEBHOOK_PORT; another worker may already use the port.",
        ),
      ),
    );
    server.listen(config.webhookPort, config.webhookHost, resolve);
  });
  return server;
}
