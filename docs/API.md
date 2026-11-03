# API coverage

Generated from the pinned OpenAPI catalog and the separately documented status/enrichment operations. Run `npm run docs:api` after updating the catalog.

Tool arguments use `path`, `query`, and `body` groups. Financial read tools also accept `source`: `auto`, `api`, or `database`. Inspect the tool schema for the complete parameters. API-key generation stays internal.

| API | Operation ID | MCP tool | PostgreSQL reads |
| --- | --- | --- | --- |
| POST `/auth` | `auth-create` | Internal authentication | Live API |
| POST `/connect_token` | `connect-token-create` | `pluggy_connect_token_create` | Live API |
| GET `/connectors` | `connectors-list` | `pluggy_connectors_list` | Live API |
| GET `/connectors/{id}` | `connector-retrieve` | `pluggy_connector_retrieve` | Live API |
| POST `/connectors/{id}/validate` | `connectors-validate` | `pluggy_connectors_validate` | Live API |
| POST `/items` | `items-create` | `pluggy_items_create` | Live API |
| GET `/items/{id}` | `items-retrieve` | `pluggy_items_retrieve` | Yes |
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
| GET `/webhooks` | `webhooks-list` | `pluggy_webhooks_list` | Live API |
| POST `/webhooks` | `webhooks-create` | `pluggy_webhooks_create` | Live API |
| GET `/webhooks/{id}` | `webhooks-retrieve` | `pluggy_webhooks_retrieve` | Live API |
| PATCH `/webhooks/{id}` | `webhooks-update` | `pluggy_webhooks_update` | Live API |
| DELETE `/webhooks/{id}` | `webhooks-delete` | `pluggy_webhooks_delete` | Live API |
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
| GET `/payments/customers` | `payment-customers-list` | `pluggy_payment_customers_list` | Live API |
| POST `/payments/customers` | `payment-customer-create` | `pluggy_payment_customer_create` | Live API |
| GET `/payments/customers/{id}` | `payment-customer-retrieve` | `pluggy_payment_customer_retrieve` | Live API |
| DELETE `/payments/customers/{id}` | `payment-customer-delete` | `pluggy_payment_customer_delete` | Live API |
| PATCH `/payments/customers/{id}` | `payment-customer-update` | `pluggy_payment_customer_update` | Live API |
| GET `/payments/recipients` | `payment-recipients-list` | `pluggy_payment_recipients_list` | Live API |
| POST `/payments/recipients` | `payment-recipient-create` | `pluggy_payment_recipient_create` | Live API |
| GET `/payments/recipients/{id}` | `payment-recipient-retrieve` | `pluggy_payment_recipient_retrieve` | Live API |
| PATCH `/payments/recipients/{id}` | `payment-recipient-update` | `pluggy_payment_recipient_update` | Live API |
| DELETE `/payments/recipients/{id}` | `payment-recipient-delete` | `pluggy_payment_recipient_delete` | Live API |
| GET `/payments/recipients/institutions` | `payment-recipients-institution-list` | `pluggy_payment_recipients_institution_list` | Live API |
| GET `/payments/recipients/institutions/{id}` | `payment-recipient-institutions-retrieve` | `pluggy_payment_recipient_institutions_retrieve` | Live API |
| GET `/payments/requests` | `payment-requests-list` | `pluggy_payment_requests_list` | Live API |
| POST `/payments/requests` | `payment-request-create` | `pluggy_payment_request_create` | Live API |
| POST `/payments/requests/automatic-pix` | `payment-request-create-automatic-pix` | `pluggy_payment_request_create_automatic_pix` | Live API |
| POST `/payments/requests/{id}/automatic-pix/schedule` | `payment-request-create-automatic-pix-schedule` | `pluggy_payment_request_create_automatic_pix_schedule` | Live API |
| GET `/payments/requests/{id}/automatic-pix/schedules` | `payment-request-get-automatic-pix-schedules` | `pluggy_payment_request_get_automatic_pix_schedules` | Live API |
| GET `/payments/requests/{requestId}/automatic-pix/schedules/{paymentId}` | `payment-request-get-automatic-pix-schedule` | `pluggy_payment_request_get_automatic_pix_schedule` | Live API |
| POST `/payments/requests/{id}/automatic-pix/cancel` | `payment-request-cancel-automatic-pix-consent` | `pluggy_payment_request_cancel_automatic_pix_consent` | Live API |
| POST `/payments/requests/{id}/automatic-pix/schedules/{scheduleId}/cancel` | `cancel-automatic-pix-schedule` | `pluggy_cancel_automatic_pix_schedule` | Live API |
| POST `/payments/requests/{id}/automatic-pix/schedules/{scheduleId}/retry` | `retry-automatic-pix-schedule` | `pluggy_retry_automatic_pix_schedule` | Live API |
| POST `/payments/requests/pix-qr` | `payment-request-create-pix-qr` | `pluggy_payment_request_create_pix_qr` | Live API |
| GET `/payments/requests/{id}` | `payment-request-retrieve` | `pluggy_payment_request_retrieve` | Live API |
| DELETE `/payments/requests/{id}` | `payment-request-delete` | `pluggy_payment_request_delete` | Live API |
| PATCH `/payments/requests/{id}` | `payment-request-update` | `pluggy_payment_request_update` | Live API |
| GET `/payments/requests/{id}/schedules` | `payment-schedules-list` | `pluggy_payment_schedules_list` | Live API |
| POST `/payments/requests/{id}/schedules/cancel` | `payment-schedules-cancel` | `pluggy_payment_schedules_cancel` | Live API |
| POST `/payments/requests/{id}/schedules/{scheduleId}/cancel` | `payment-schedules-cancel-specific` | `pluggy_payment_schedules_cancel_specific` | Live API |
| POST `/payments/intents` | `payment-intent-create` | `pluggy_payment_intent_create` | Live API |
| GET `/payments/intents` | `payment-intents-list` | `pluggy_payment_intents_list` | Live API |
| GET `/payments/intents/{id}` | `payment-intent-retrieve` | `pluggy_payment_intent_retrieve` | Live API |
| POST `/payments/requests/pix-biometric` | `payment-request-create-pix-biometric` | `pluggy_payment_request_create_pix_biometric` | Live API |
| GET `/pix-biometric/enrollments` | `pix-biometric-enrollments-list` | `pluggy_pix_biometric_enrollments_list` | Live API |
| GET `/pix-biometric/enrollments/{id}` | `pix-biometric-enrollment-retrieve` | `pluggy_pix_biometric_enrollment_retrieve` | Live API |
| POST `/pix-biometric/enrollments/{id}/revoke` | `pix-biometric-enrollment-revoke` | `pluggy_pix_biometric_enrollment_revoke` | Live API |
| GET `/pix-biometric/enrollments/{id}/balance` | `pix-biometric-enrollment-balance-retrieve` | `pluggy_pix_biometric_enrollment_balance_retrieve` | Live API |
| DELETE `/pix-biometric/enrollments/{id}/data-consent` | `pix-biometric-enrollment-data-consent-delete` | `pluggy_pix_biometric_enrollment_data_consent_delete` | Live API |
| GET `/smart-transfers/preauthorizations` | `smart-tranfers-preauthorizations-list` | `pluggy_smart_tranfers_preauthorizations_list` | Live API |
| POST `/smart-transfers/preauthorizations` | `smart-transfer-preauthorization-create` | `pluggy_smart_transfer_preauthorization_create` | Live API |
| GET `/smart-transfers/preauthorizations/{id}` | `smart-transfer-preauthorization-retrieve` | `pluggy_smart_transfer_preauthorization_retrieve` | Live API |
| GET `/smart-transfers/preauthorizations/{id}/balance` | `smart-transfer-preauthorization-balance-retrieve` | `pluggy_smart_transfer_preauthorization_balance_retrieve` | Live API |
| DELETE `/smart-transfers/preauthorizations/{id}/data-consent` | `smart-transfer-preauthorization-data-consent-delete` | `pluggy_smart_transfer_preauthorization_data_consent_delete` | Live API |
| GET `/smart-transfers/preauthorizations/{id}/payments` | `smart-transfer-preauthorization-payments-list` | `pluggy_smart_transfer_preauthorization_payments_list` | Live API |
| POST `/smart-transfers/payments` | `smart-transfer-payment-create` | `pluggy_smart_transfer_payment_create` | Live API |
| GET `/smart-transfers/payments/{id}` | `smart-transfer-paymentretrieve` | `pluggy_smart_transfer_paymentretrieve` | Live API |
| POST `/boleto-connections` | `boleto-connection-create` | `pluggy_boleto_connection_create` | Live API |
| POST `/boleto-connections/from-item` | `boleto-connection-create-from-item` | `pluggy_boleto_connection_create_from_item` | Live API |
| DELETE `/boleto-connections/{id}` | `boleto-connection-delete` | `pluggy_boleto_connection_delete` | Live API |
| POST `/boletos` | `boleto-create` | `pluggy_boleto_create` | Live API |
| POST `/boletos/{id}/cancel` | `boleto-cancel` | `pluggy_boleto_cancel` | Live API |
| GET `/boletos/{id}` | `boleto-get` | `pluggy_boleto_get` | Live API |
| GET `/api/status` | `status-snapshot` | `pluggy_status_snapshot` | Live API |
| GET `/api/connectors-incidents` | `status-connectors-incidents` | `pluggy_status_connectors_incidents` | Live API |
| GET `/api/summary` | `status-summary` | `pluggy_status_summary` | Live API |
| POST `/categorize` | `enrichment-categorize` | `pluggy_enrichment_categorize` | Live API |
| POST `/behavior-analysis` | `enrichment-behavior-analysis` | `pluggy_enrichment_behavior_analysis` | Live API |
| POST `/recurring-payments` | `enrichment-recurring-payments` | `pluggy_enrichment_recurring_payments` | Live API |
