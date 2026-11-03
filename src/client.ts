import { setTimeout as delay } from "node:timers/promises";
import { operationById } from "./catalog.js";
import {
  AppError,
  type Arguments,
  type Config,
  type JsonObject,
  type Operation,
} from "./types.js";

const origins = {
  api: "https://api.pluggy.ai",
  enrichment: "https://enrichment-api.pluggy.ai",
  status: "https://status.pluggy.ai",
};

export class ApiError extends AppError {
  constructor(
    public status: number,
    public operationId: string,
    details: unknown,
  ) {
    super(
      "PLUGGY_API_ERROR",
      `Pluggy returned HTTP ${status} for ${operationId}.`,
      details,
    );
  }
}

export class PluggyClient {
  private token?: { value: string; expiresAt: number };
  private authenticating?: Promise<string>;

  constructor(
    readonly config: Config,
    private fetcher: typeof fetch = fetch,
  ) {}

  private async apiKey(): Promise<string> {
    if (this.token && this.token.expiresAt > Date.now())
      return this.token.value;
    if (!this.authenticating) {
      this.authenticating = (async () => {
        const response = await this.send(
          `${origins.api}/auth`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              clientId: this.config.clientId,
              clientSecret: this.config.clientSecret,
            }),
          },
          "auth-create",
        );
        if (typeof response?.apiKey !== "string" || !response.apiKey)
          throw new AppError(
            "AUTH_FAILED",
            "Pluggy did not return an API key.",
          );
        this.token = {
          value: response.apiKey,
          expiresAt: Date.now() + (2 * 60 * 60 - 60) * 1000,
        };
        return response.apiKey as string;
      })().finally(() => {
        this.authenticating = undefined;
      });
    }
    return this.authenticating;
  }

  private async send(
    url: string,
    init: RequestInit,
    operationId: string,
  ): Promise<any> {
    let response: Response;
    try {
      response = await this.fetcher(url, {
        ...init,
        redirect: "error",
        signal: AbortSignal.timeout(this.config.timeoutMs),
      });
    } catch {
      throw new AppError(
        "REQUEST_FAILED",
        `Pluggy request failed or timed out for ${operationId}. Writes are not retried automatically; check their status before retrying.`,
      );
    }
    const text = await response.text();
    let body: any;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      throw new AppError(
        "INVALID_RESPONSE",
        `Pluggy returned a non-JSON response (HTTP ${response.status}) for ${operationId}.`,
      );
    }
    if (!response.ok) {
      // Never echo raw requests, tokens, credentials, or upstream error bodies containing personal data.
      const details = {
        status: response.status,
        code: body?.codeDescription ?? body?.code,
        requestId: response.headers.get("x-request-id"),
        retryAfter: response.headers.get("retry-after"),
      };
      throw new ApiError(response.status, operationId, details);
    }
    return body;
  }

  async request(
    operation: Operation | string,
    args: Arguments = {},
  ): Promise<any> {
    const op =
      typeof operation === "string" ? operationById.get(operation) : operation;
    if (!op)
      throw new AppError("UNKNOWN_OPERATION", "Unknown Pluggy operation.");
    if (op.id === "auth-create")
      throw new AppError(
        "INTERNAL_OPERATION",
        "API-key generation is managed internally; credentials and keys are never returned as tools.",
      );
    if (op.method !== "GET" && !this.config.allowWrites) {
      throw new AppError(
        "WRITES_DISABLED",
        "Set PLUGGY_ALLOW_WRITES=true in the server environment to enable POST, PATCH, PUT, and DELETE operations.",
      );
    }
    let path = op.path;
    for (const match of op.path.matchAll(/\{([^}]+)\}/g)) {
      const value = String(args.path?.[match[1]] ?? "");
      if (!value || value === "." || value === "..")
        throw new AppError(
          "INVALID_ARGUMENTS",
          "Path parameters must be nonempty identifiers.",
        );
      path = path.replace(match[0], encodeURIComponent(value));
    }
    const url = new URL(path, origins[op.service]);
    for (const [key, value] of Object.entries(args.query ?? {})) {
      if (value === undefined || value === null) continue;
      // Pluggy documents comma-separated arrays (ids, types), including where OAS omits style.
      url.searchParams.set(
        key,
        Array.isArray(value) ? value.join(",") : String(value),
      );
    }
    let refresh = false;
    for (let attempt = 0; ; attempt++) {
      const headers: Record<string, string> = { Accept: "application/json" };
      if (op.service === "api") headers["X-API-KEY"] = await this.apiKey();
      if (op.service === "enrichment") {
        if (!this.config.enrichmentApiKey)
          throw new AppError(
            "ENRICHMENT_NOT_CONFIGURED",
            "Set PLUGGY_ENRICHMENT_API_KEY for the separately authenticated enrichment product.",
          );
        headers["X-API-KEY"] = this.config.enrichmentApiKey;
      }
      if (args.body !== undefined) headers["Content-Type"] = "application/json";
      try {
        return await this.send(
          url.toString(),
          {
            method: op.method,
            headers,
            ...(args.body !== undefined
              ? { body: JSON.stringify(args.body) }
              : {}),
          },
          op.id,
        );
      } catch (error) {
        if (
          error instanceof ApiError &&
          error.status === 401 &&
          op.service === "api" &&
          !refresh
        ) {
          if (this.token?.value === headers["X-API-KEY"])
            this.token = undefined;
          refresh = true;
          continue;
        }
        if (
          op.method === "GET" &&
          error instanceof ApiError &&
          [429, 502, 503, 504].includes(error.status) &&
          attempt < 2
        ) {
          const retryAfter = Number((error.details as JsonObject).retryAfter);
          await delay(
            Math.min(
              5_000,
              retryAfter > 0 ? retryAfter * 1000 : 250 * 2 ** attempt,
            ),
          );
          continue;
        }
        throw error;
      }
    }
  }

  async listAll(operationId: string, args: Arguments): Promise<JsonObject[]> {
    const op = operationById.get(operationId)!;
    const query = { ...args.query };
    const rows: JsonObject[] = [];
    const seen = new Set<string>();
    for (let page = 1; page <= this.config.maxPages; page++) {
      const result = await this.request(op, { ...args, query });
      const values = Array.isArray(result) ? result : result?.results;
      if (!Array.isArray(values))
        throw new AppError(
          "INVALID_RESPONSE",
          `Expected a list from ${operationId}.`,
        );
      if (
        operationId.endsWith("list-by-cursor") &&
        !(
          result.next === null ||
          (typeof result.next === "string" && result.next.startsWith("?"))
        )
      ) {
        throw new AppError(
          "INVALID_RESPONSE",
          `Missing or invalid next cursor from ${operationId}; the collection was not committed.`,
        );
      }
      rows.push(...values);
      if (result.next) {
        if (typeof result.next !== "string" || !result.next.startsWith("?"))
          throw new AppError(
            "INVALID_CURSOR",
            "Pluggy returned an unexpected cursor format.",
          );
        if (seen.has(result.next))
          throw new AppError(
            "INVALID_CURSOR",
            "Pluggy repeated a pagination cursor.",
          );
        seen.add(result.next);
        const next = new URLSearchParams(result.next.slice(1));
        const after = next.get("after");
        if (!after)
          throw new AppError(
            "INVALID_CURSOR",
            "Pluggy's next page has no after cursor.",
          );
        // Preserve the original account/filter scope, and never follow a returned URL.
        query.after = after;
      } else if (Number(result.totalPages) > Number(query.page ?? 1)) {
        query.page = Number(query.page ?? 1) + 1;
      } else return rows;
    }
    throw new AppError(
      "SYNC_PAGE_LIMIT",
      `Reached PLUGGY_MAX_SYNC_PAGES for ${operationId}; the collection was not committed. Increase the limit and retry.`,
    );
  }
}
