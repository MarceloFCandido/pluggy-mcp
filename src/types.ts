export type JsonObject = Record<string, any>;

export interface Operation {
  id: string;
  name: string;
  method: string;
  path: string;
  service: "api" | "enrichment" | "status";
  tag: string;
  summary: string;
  description: string;
  deprecated: boolean;
  inputSchema: JsonObject;
  parameters: JsonObject[];
}

export interface Arguments {
  path?: JsonObject;
  query?: JsonObject;
  body?: unknown;
  source?: "auto" | "api" | "database";
}

export interface Config {
  clientId: string;
  clientSecret: string;
  enrichmentApiKey?: string;
  databaseUrl?: string;
  namespace: string;
  allowWrites: boolean;
  itemIds: string[];
  timeoutMs: number;
  syncIntervalSeconds: number;
  webhookPort?: number;
  webhookHost: string;
  webhookSecret?: string;
  maxPages: number;
}

export class AppError extends Error {
  constructor(
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
    this.name = "AppError";
  }
}
