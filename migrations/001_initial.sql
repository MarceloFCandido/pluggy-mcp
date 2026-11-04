CREATE SCHEMA IF NOT EXISTS pluggy_mcp;

CREATE TABLE IF NOT EXISTS pluggy_mcp.items (
  application_id text NOT NULL,
  id text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  PRIMARY KEY (application_id, id)
);

CREATE TABLE IF NOT EXISTS pluggy_mcp.records (
  application_id text NOT NULL,
  resource text NOT NULL,
  id text NOT NULL,
  item_id text NOT NULL,
  parent_id text NOT NULL,
  data jsonb NOT NULL,
  synced_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  PRIMARY KEY (application_id, resource, id)
);
CREATE INDEX IF NOT EXISTS records_scope ON pluggy_mcp.records (application_id, resource, parent_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS records_item ON pluggy_mcp.records (application_id, item_id);

CREATE TABLE IF NOT EXISTS pluggy_mcp.sync_scopes (
  application_id text NOT NULL,
  resource text NOT NULL,
  parent_id text NOT NULL,
  item_id text NOT NULL,
  complete boolean NOT NULL DEFAULT false,
  synced_at timestamptz,
  last_event_at timestamptz,
  revision bigint NOT NULL DEFAULT 0,
  last_error text,
  PRIMARY KEY (application_id, resource, parent_id)
);

CREATE TABLE IF NOT EXISTS pluggy_mcp.events (
  application_id text NOT NULL,
  id text NOT NULL,
  payload jsonb NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  received_at timestamptz NOT NULL DEFAULT now(),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  last_error text,
  PRIMARY KEY (application_id, id)
);

-- Also upgrades databases created by the first revision of this PR.
ALTER TABLE pluggy_mcp.events ADD COLUMN IF NOT EXISTS next_attempt_at timestamptz NOT NULL DEFAULT now();

COMMENT ON SCHEMA pluggy_mcp IS 'Pluggy MCP mirror, isolated by a hash of the configured client ID. Never stores API credentials.';
