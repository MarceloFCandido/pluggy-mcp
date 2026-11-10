import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig } from "../../dist/config.js";
import { operationById, validateArguments } from "../../dist/catalog.js";

test("polling intervals cannot overflow Node's timer and UUID casing does not split mirror scopes", () => {
  const env = {
    PLUGGY_CLIENT_ID: "test",
    PLUGGY_CLIENT_SECRET: "secret",
    DATABASE_URL: "postgresql://localhost/test",
  };
  assert.throws(
    () => loadConfig({ ...env, PLUGGY_SYNC_INTERVAL_SECONDS: "2592000" }),
    /2147483/,
  );
  const upper = "ABCDEFAB-0000-4000-8000-000000000001";
  assert.deepEqual(
    loadConfig({ ...env, PLUGGY_ITEM_IDS: `${upper},${upper.toLowerCase()}` })
      .itemIds,
    [upper.toLowerCase()],
  );
  assert.equal(
    validateArguments(operationById.get("accounts-list"), {
      query: { itemId: upper },
    }).query.itemId,
    upper.toLowerCase(),
  );
});
