# API coverage

Generated from the household-finance selection in the pinned OpenAPI catalog and the separately documented status/enrichment operations. Run `npm run docs:api` after updating the catalog.

Tool arguments use `path`, `query`, and `body` groups. Financial read tools also accept `source`: `auto`, `api`, or `database`. Inspect the tool schema for the complete parameters. API-key generation stays internal. Payment initiation, boleto issuing, credit-risk analysis, connect-token generation, connector credential validation, and webhook administration are excluded. Connection health always uses the API; cached account balances reflect their synchronization time.

| API | Operation ID | MCP tool | PostgreSQL reads |
| --- | --- | --- | --- |
| POST `/auth` | `auth-create` | Internal authentication | Live API |
| GET `/connectors` | `connectors-list` | `pluggy_connectors_list` | Live API |
| GET `/connectors/{id}` | `connector-retrieve` | `pluggy_connector_retrieve` | Live API |
| POST `/items` | `items-create` | `pluggy_items_create` | Live API |
| GET `/items/{id}` | `items-retrieve` | `pluggy_items_retrieve` | Live API |
| PATCH `/items/{id}` | `items-update` | `pluggy_items_update` | Live API |
| DELETE `/items/{id}` | `items-delete` | `pluggy_items_delete` | Live API |
| GET `/items/{id}/resources` | `items-resources` | `pluggy_items_resources` | Live API |
| POST `/items/{id}/mfa` | `items-send-mfa` | `pluggy_items_send_mfa` | Live API |
| PATCH `/items/{id}/disable-auto-sync` | `items-disable-autosync` | `pluggy_items_disable_autosync` | Live API |
| GET `/items/{id}/scr` | `items-retrieve-scr` | `pluggy_items_retrieve_scr` | Live API |
| GET `/consents` | `consents-list` | `pluggy_consents_list` | Yes |
| GET `/consents/{id}` | `consent-retrieve` | `pluggy_consent_retrieve` | Yes |
| GET `/accounts` | `accounts-list` | `pluggy_accounts_list` | Yes |
| GET `/accounts/{id}` | `accounts-retrieve` | `pluggy_accounts_retrieve` | Yes |
| GET `/accounts/{id}/balance` | `account-balance-get` | `pluggy_account_balance_get` | Live API |
| GET `/transactions` | `transactions-list` | `pluggy_transactions_list` | Yes |
| GET `/v2/items` | `items-list-by-cursor` | `pluggy_items_list_by_cursor` | Live API |
| GET `/v2/transactions` | `transactions-list-by-cursor` | `pluggy_transactions_list_by_cursor` | Yes |
| GET `/transactions/{id}` | `transactions-retrieve` | `pluggy_transactions_retrieve` | Yes |
| PATCH `/transactions/{id}` | `transactions-Update` | `pluggy_transactions_update` | Live API |
| GET `/investments` | `investments-list` | `pluggy_investments_list` | Yes |
| GET `/investments/{id}` | `investments-retrieve` | `pluggy_investments_retrieve` | Yes |
| GET `/investments/{id}/transactions` | `investment-transactions-list` | `pluggy_investment_transactions_list` | Yes |
| GET `/identity` | `identity-find-by-item` | `pluggy_identity_find_by_item` | Yes |
| GET `/identity/{id}` | `identity-retrieve` | `pluggy_identity_retrieve` | Yes |
| GET `/categories` | `categories-list` | `pluggy_categories_list` | Live API |
| GET `/categories/{id}` | `categories-retrieve` | `pluggy_categories_retrieve` | Live API |
| GET `/categories/rules` | `client-category-rules-list` | `pluggy_client_category_rules_list` | Live API |
| POST `/categories/rules` | `client-category-rules-create` | `pluggy_client_category_rules_create` | Live API |
| DELETE `/categories/rules/{id}` | `client-category-rules-delete` | `pluggy_client_category_rules_delete` | Live API |
| GET `/loans` | `loans-list` | `pluggy_loans_list` | Yes |
| GET `/loans/{id}` | `loans-retrieve` | `pluggy_loans_retrieve` | Yes |
| GET `/merchants` | `merchants-get-by-cnpj` | `pluggy_merchants_get_by_cnpj` | Live API |
| GET `/bills` | `bills-list` | `pluggy_bills_list` | Yes |
| GET `/bills/{id}` | `bills-retrieve` | `pluggy_bills_retrieve` | Yes |
| GET `/api/status` | `status-snapshot` | `pluggy_status_snapshot` | Live API |
| GET `/api/connectors-incidents` | `status-connectors-incidents` | `pluggy_status_connectors_incidents` | Live API |
| GET `/api/summary` | `status-summary` | `pluggy_status_summary` | Live API |
| POST `/categorize` | `enrichment-categorize` | `pluggy_enrichment_categorize` | Live API |
| POST `/recurring-payments` | `enrichment-recurring-payments` | `pluggy_enrichment_recurring_payments` | Live API |
