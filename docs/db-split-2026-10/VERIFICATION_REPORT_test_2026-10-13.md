# Seller / customer split — verification report (test)

Run: [Database split #5](https://github.com/sanjaymorankar-debug/GoKesari/actions/runs/38418111693), migrate with replace, from `staging` (fix #152), 13 Oct 2026 14:59–15:06 UTC. Copied from the run's report (artifact `db-split-report-test`).

- When: 2026-10-13T15:06:48.400Z
- Source: neondb on ep-restless-smoke-aymbnv0z.c-5.us-east-2.aws.neon.tech (the test.gokesari.com database — only read; restore point taken first)
- Seller database: gokesari_seller on ep-restless-smoke-aymbnv0z.c-5.us-east-2.aws.neon.tech
- Customer database: gokesari_customer on ep-restless-smoke-aymbnv0z.c-5.us-east-2.aws.neon.tech
- Tables checked: 190 (90 seller, 100 customer/core)
- Rows: 29996 in the source, 29996 in the targets
- **Result: PASS — every row copied, every checksum equal, no broken cross-database link**

Not copied (stay in the source): schemas `backup_categorise_20261003121813`, `backup_pre0051_20261006` (old backups) and `neon_auth` (Neon's own). test.gokesari.com still runs on the single source database (`DB_SPLIT_MODE=single`).

## Row counts and checksums

| Table | Database | Source rows | Target rows | Checksum match |
|---|---|---:|---:|---|
| pmd.attribute_definition | seller | 81 | 81 | yes |
| pmd.brand | seller | 876 | 876 | yes |
| pmd.brand_alias | seller | 884 | 884 | yes |
| pmd.catalogue_link | seller | 837 | 837 | yes |
| pmd.category | seller | 410 | 410 | yes |
| pmd.category_mapping | seller | 1045 | 1045 | yes |
| pmd.dashboard_metric | seller | 89 | 89 | yes |
| pmd.import_error | seller | 1156 | 1156 | yes |
| pmd.ingestion_run | seller | 5 | 5 | yes |
| pmd.job | seller | 0 | 0 | yes |
| pmd.manufacturer | seller | 14 | 14 | yes |
| pmd.manufacturer_alias | seller | 14 | 14 | yes |
| pmd.match_candidate | seller | 63 | 63 | yes |
| pmd.price_history | seller | 359 | 359 | yes |
| pmd.product_attribute_conflict | seller | 0 | 0 | yes |
| pmd.product_change_log | seller | 2220 | 2220 | yes |
| pmd.product_family | seller | 53 | 53 | yes |
| pmd.product_identifier | seller | 2223 | 2223 | yes |
| pmd.product_image | seller | 2469 | 2469 | yes |
| pmd.product_master | seller | 2180 | 2180 | yes |
| pmd.product_merge_log | seller | 16 | 16 | yes |
| pmd.product_offer | seller | 352 | 352 | yes |
| pmd.product_source | seller | 2222 | 2222 | yes |
| pmd.product_specification | seller | 3049 | 3049 | yes |
| pmd.raw_record | seller | 2283 | 2283 | yes |
| pmd.reference_state | seller | 1 | 1 | yes |
| pmd.source | seller | 41 | 41 | yes |
| brands | seller | 470 | 470 | yes |
| commission_rates | seller | 1 | 1 | yes |
| distributor_types | seller | 0 | 0 | yes |
| distributors | seller | 0 | 0 | yes |
| excel_upload_items | seller | 0 | 0 | yes |
| excel_uploads | seller | 0 | 0 | yes |
| external_price_reference_history | seller | 0 | 0 | yes |
| external_price_references | seller | 0 | 0 | yes |
| gst_return_exports | seller | 0 | 0 | yes |
| gstin_lookups | seller | 0 | 0 | yes |
| hsn_tax_rates | seller | 0 | 0 | yes |
| integration_column_mappings | seller | 0 | 0 | yes |
| integration_connector_tokens | seller | 0 | 0 | yes |
| integration_imports | seller | 0 | 0 | yes |
| integration_item_links | seller | 0 | 0 | yes |
| integration_jobs | seller | 0 | 0 | yes |
| integration_sync_log | seller | 0 | 0 | yes |
| inventory_movements | seller | 23 | 23 | yes |
| migration_0038_category_renames | seller | 0 | 0 | yes |
| mrp_corrections | seller | 0 | 0 | yes |
| price_update_batches | seller | 3 | 3 | yes |
| price_update_requests | seller | 6 | 6 | yes |
| product_categories | seller | 93 | 93 | yes |
| product_images | seller | 1 | 1 | yes |
| product_mrp_history | seller | 0 | 0 | yes |
| product_price_history | seller | 12 | 12 | yes |
| product_subcategories | seller | 19 | 19 | yes |
| products | seller | 1213 | 1213 | yes |
| referral_code_requests | seller | 3 | 3 | yes |
| referral_codes | seller | 4 | 4 | yes |
| referral_commissions | seller | 0 | 0 | yes |
| referral_redemptions | seller | 9 | 9 | yes |
| registration_fee_history | seller | 1 | 1 | yes |
| registration_fee_tiers | seller | 5 | 5 | yes |
| registration_fees | seller | 1 | 1 | yes |
| registration_payments | seller | 0 | 0 | yes |
| seller_document_uploads | seller | 6 | 6 | yes |
| seller_verification_events | seller | 37 | 37 | yes |
| seller_verification_files | seller | 4 | 4 | yes |
| seller_verifications | seller | 7 | 7 | yes |
| shop_categories | seller | 45 | 45 | yes |
| shop_category_mapping | seller | 33 | 33 | yes |
| shop_classification_history | seller | 22 | 22 | yes |
| shop_delivery_staff | seller | 2 | 2 | yes |
| shop_integrations | seller | 0 | 0 | yes |
| shop_legal_document_files | seller | 11 | 11 | yes |
| shop_legal_documents | seller | 12 | 12 | yes |
| shop_media_import_items | seller | 0 | 0 | yes |
| shop_media_imports | seller | 0 | 0 | yes |
| shop_offers | seller | 1 | 1 | yes |
| shop_payments | seller | 6 | 6 | yes |
| shop_product_categories | seller | 69 | 69 | yes |
| shop_products | seller | 227 | 227 | yes |
| shop_registrations | seller | 0 | 0 | yes |
| shop_settlements | seller | 0 | 0 | yes |
| shop_sla_events | seller | 0 | 0 | yes |
| shop_staff | seller | 0 | 0 | yes |
| shop_suspension_orders | seller | 0 | 0 | yes |
| shop_suspensions | seller | 1 | 1 | yes |
| shop_wallet_transactions | seller | 22 | 22 | yes |
| shop_wallets | seller | 8 | 8 | yes |
| shops | seller | 30 | 30 | yes |
| stock_alerts | seller | 0 | 0 | yes |
| accounts | customer | 14 | 14 | yes |
| addresses | customer | 4 | 4 | yes |
| audit_logs | customer | 2809 | 2809 | yes |
| bank_account_checks | customer | 0 | 0 | yes |
| bank_accounts | customer | 6 | 6 | yes |
| bank_refund_requests | customer | 3 | 3 | yes |
| bank_verification_attempts | customer | 7 | 7 | yes |
| campaign_recipients | customer | 0 | 0 | yes |
| cart_items | customer | 11 | 11 | yes |
| carts | customer | 25 | 25 | yes |
| coupon_redemptions | customer | 0 | 0 | yes |
| coupons | customer | 0 | 0 | yes |
| credit_note_counters | customer | 1 | 1 | yes |
| credit_notes | customer | 1 | 1 | yes |
| customer_referral_codes | customer | 5 | 5 | yes |
| customer_referral_requests | customer | 3 | 3 | yes |
| customer_referrals | customer | 1 | 1 | yes |
| customer_segments | customer | 0 | 0 | yes |
| customer_signup_referrals | customer | 7 | 7 | yes |
| delivery_earnings_config | customer | 1 | 1 | yes |
| delivery_orders | customer | 3 | 3 | yes |
| delivery_partner_change_requests | customer | 0 | 0 | yes |
| delivery_partner_documents | customer | 0 | 0 | yes |
| delivery_partner_earnings | customer | 2 | 2 | yes |
| delivery_partner_sessions | customer | 2 | 2 | yes |
| delivery_partners | customer | 1 | 1 | yes |
| delivery_proofs | customer | 2 | 2 | yes |
| delivery_slot_capacities | customer | 0 | 0 | yes |
| delivery_trips | customer | 0 | 0 | yes |
| dispatch_attempts | customer | 3 | 3 | yes |
| dispute_attachments | customer | 0 | 0 | yes |
| dispute_comments | customer | 1 | 1 | yes |
| dispute_events | customer | 5 | 5 | yes |
| domain_events | customer | 179 | 179 | yes |
| einvoice_records | customer | 0 | 0 | yes |
| eway_bills | customer | 0 | 0 | yes |
| finance_ledger_entries | customer | 44 | 44 | yes |
| financial_adjustments | customer | 1 | 1 | yes |
| grievances | customer | 2 | 2 | yes |
| gst_rules | customer | 7 | 7 | yes |
| invoice_counters | customer | 1 | 1 | yes |
| login_otps | customer | 50 | 50 | yes |
| maps_api_call_log | customer | 72 | 72 | yes |
| marketing_campaigns | customer | 0 | 0 | yes |
| notification_deliveries | customer | 258 | 258 | yes |
| notification_preferences | customer | 0 | 0 | yes |
| notifications | customer | 490 | 490 | yes |
| order_disputes | customer | 1 | 1 | yes |
| order_financials | customer | 9 | 9 | yes |
| order_fulfilment_arrangements | customer | 10 | 10 | yes |
| order_groups | customer | 0 | 0 | yes |
| order_items | customer | 16 | 16 | yes |
| order_ratings | customer | 0 | 0 | yes |
| order_status_history | customer | 74 | 74 | yes |
| orders | customer | 16 | 16 | yes |
| outbound_test_messages | customer | 0 | 0 | yes |
| payments | customer | 21 | 21 | yes |
| permissions | customer | 34 | 34 | yes |
| platform_settings | customer | 28 | 28 | yes |
| reconciliation_records | customer | 0 | 0 | yes |
| referral_setting_changes | customer | 6 | 6 | yes |
| referral_settings | customer | 2 | 2 | yes |
| return_items | customer | 1 | 1 | yes |
| return_pickups | customer | 1 | 1 | yes |
| return_requests | customer | 1 | 1 | yes |
| return_status_history | customer | 3 | 3 | yes |
| rider_earning_slots | customer | 0 | 0 | yes |
| rider_earnings_ledger | customer | 4 | 4 | yes |
| rider_incentive_awards | customer | 0 | 0 | yes |
| rider_incentive_rules | customer | 0 | 0 | yes |
| rider_payouts | customer | 0 | 0 | yes |
| rider_searches | customer | 3 | 3 | yes |
| risk_flags | customer | 0 | 0 | yes |
| role_permissions | customer | 74 | 74 | yes |
| roles | customer | 4 | 4 | yes |
| sessions | customer | 0 | 0 | yes |
| societies | customer | 0 | 0 | yes |
| society_members | customer | 0 | 0 | yes |
| society_riders | customer | 0 | 0 | yes |
| society_shops | customer | 0 | 0 | yes |
| status_changes | customer | 51 | 51 | yes |
| status_transition_rules | customer | 102 | 102 | yes |
| stored_image_variants | customer | 2 | 2 | yes |
| stored_images | customer | 3 | 3 | yes |
| subscription_daily_overrides | customer | 0 | 0 | yes |
| subscription_deliveries | customer | 0 | 0 | yes |
| subscription_events | customer | 1 | 1 | yes |
| subscription_orders | customer | 0 | 0 | yes |
| subscriptions | customer | 2 | 2 | yes |
| tax_invoices | customer | 9 | 9 | yes |
| user_consents | customer | 29 | 29 | yes |
| user_role_grants | customer | 21 | 21 | yes |
| users | customer | 32 | 32 | yes |
| verification_tokens | customer | 0 | 0 | yes |
| voucher_redemptions | customer | 0 | 0 | yes |
| voucher_upload_items | customer | 0 | 0 | yes |
| voucher_uploads | customer | 0 | 0 | yes |
| vouchers | customer | 2 | 2 | yes |
| wallet_transactions | customer | 32 | 32 | yes |
| wallets | customer | 32 | 32 | yes |

## Cross-database links (enforced in the service layer)

111 links cross the two databases; for each, every value in the child exists in the parent's database.

| Child | Column | → Parent | Direction | Distinct values | Missing parents |
|---|---|---|---|---:|---:|
| bank_accounts | shop_id | shops | customer → seller | 1 | 0 |
| brands | created_by | users | seller → customer | 1 | 0 |
| cart_items | shop_product_id | shop_products | customer → seller | 11 | 0 |
| commission_rates | created_by | users | seller → customer | 0 | 0 |
| credit_note_counters | shop_id | shops | customer → seller | 1 | 0 |
| credit_notes | shop_id | shops | customer → seller | 1 | 0 |
| customer_referral_requests | issued_code_id | referral_codes | customer → seller | 1 | 0 |
| customer_segments | shop_id | shops | customer → seller | 0 | 0 |
| customer_signup_referrals | referral_code_id | referral_codes | customer → seller | 3 | 0 |
| delivery_slot_capacities | shop_id | shops | customer → seller | 0 | 0 |
| distributor_types | created_by | users | seller → customer | 0 | 0 |
| distributors | created_by | users | seller → customer | 0 | 0 |
| distributors | user_id | users | seller → customer | 0 | 0 |
| einvoice_records | shop_id | shops | customer → seller | 0 | 0 |
| eway_bills | shop_id | shops | customer → seller | 0 | 0 |
| excel_uploads | uploaded_by | users | seller → customer | 0 | 0 |
| external_price_reference_history | actor_id | users | seller → customer | 0 | 0 |
| external_price_references | created_by | users | seller → customer | 0 | 0 |
| external_price_references | verified_by | users | seller → customer | 0 | 0 |
| financial_adjustments | settlement_id | shop_settlements | customer → seller | 0 | 0 |
| financial_adjustments | shop_id | shops | customer → seller | 1 | 0 |
| gst_return_exports | generated_by | users | seller → customer | 0 | 0 |
| gstin_lookups | looked_up_by | users | seller → customer | 0 | 0 |
| hsn_tax_rates | updated_by | users | seller → customer | 0 | 0 |
| integration_column_mappings | updated_by | users | seller → customer | 0 | 0 |
| integration_connector_tokens | created_by | users | seller → customer | 0 | 0 |
| integration_imports | uploaded_by | users | seller → customer | 0 | 0 |
| integration_item_links | confirmed_by | users | seller → customer | 0 | 0 |
| inventory_movements | created_by | users | seller → customer | 2 | 0 |
| invoice_counters | shop_id | shops | customer → seller | 1 | 0 |
| marketing_campaigns | shop_id | shops | customer → seller | 0 | 0 |
| mrp_corrections | decided_by | users | seller → customer | 0 | 0 |
| mrp_corrections | submitted_by | users | seller → customer | 0 | 0 |
| order_disputes | shop_id | shops | customer → seller | 1 | 0 |
| order_financials | commission_rate_id | commission_rates | customer → seller | 1 | 0 |
| order_financials | settlement_id | shop_settlements | customer → seller | 0 | 0 |
| order_financials | shop_id | shops | customer → seller | 1 | 0 |
| order_fulfilment_arrangements | shop_id | shops | customer → seller | 1 | 0 |
| order_fulfilment_arrangements | staff_id | shop_delivery_staff | customer → seller | 1 | 0 |
| order_items | shop_product_id | shop_products | customer → seller | 5 | 0 |
| order_items | substitute_shop_product_id | shop_products | customer → seller | 0 | 0 |
| order_ratings | shop_id | shops | customer → seller | 0 | 0 |
| orders | buyer_shop_id | shops | customer → seller | 0 | 0 |
| orders | shop_id | shops | customer → seller | 4 | 0 |
| payments | shop_id | shops | customer → seller | 0 | 0 |
| pmd.catalogue_link | promoted_by | users | seller → customer | 1 | 0 |
| price_update_batches | decided_by | users | seller → customer | 0 | 0 |
| price_update_batches | submitted_by | users | seller → customer | 1 | 0 |
| price_update_requests | decided_by | users | seller → customer | 1 | 0 |
| price_update_requests | submitted_by | users | seller → customer | 1 | 0 |
| product_categories | created_by | users | seller → customer | 3 | 0 |
| product_images | created_by | users | seller → customer | 1 | 0 |
| product_images | moderated_by | users | seller → customer | 0 | 0 |
| product_images | stored_image_id | stored_images | seller → customer | 1 | 0 |
| product_mrp_history | changed_by | users | seller → customer | 0 | 0 |
| product_price_history | changed_by | users | seller → customer | 1 | 0 |
| products | approved_by | users | seller → customer | 1 | 0 |
| products | created_by | users | seller → customer | 3 | 0 |
| referral_code_requests | decided_by | users | seller → customer | 1 | 0 |
| referral_code_requests | user_id | users | seller → customer | 3 | 0 |
| referral_codes | created_by | users | seller → customer | 2 | 0 |
| referral_codes | referrer_user_id | users | seller → customer | 0 | 0 |
| referral_commissions | referrer_user_id | users | seller → customer | 0 | 0 |
| referral_redemptions | redeemed_by | users | seller → customer | 5 | 0 |
| registration_fee_history | changed_by | users | seller → customer | 1 | 0 |
| registration_fee_tiers | updated_by | users | seller → customer | 0 | 0 |
| registration_fees | created_by | users | seller → customer | 1 | 0 |
| return_requests | shop_id | shops | customer → seller | 1 | 0 |
| seller_document_uploads | confirmed_by | users | seller → customer | 1 | 0 |
| seller_document_uploads | uploaded_by | users | seller → customer | 1 | 0 |
| seller_verification_events | actor_id | users | seller → customer | 3 | 0 |
| seller_verification_files | uploaded_by | users | seller → customer | 2 | 0 |
| seller_verifications | reviewer_id | users | seller → customer | 1 | 0 |
| seller_verifications | submitted_by | users | seller → customer | 2 | 0 |
| shop_classification_history | changed_by | users | seller → customer | 3 | 0 |
| shop_delivery_staff | created_by | users | seller → customer | 1 | 0 |
| shop_integrations | connected_by | users | seller → customer | 0 | 0 |
| shop_legal_document_files | uploaded_by | users | seller → customer | 3 | 0 |
| shop_legal_documents | reviewed_by | users | seller → customer | 1 | 0 |
| shop_legal_documents | submitted_by | users | seller → customer | 3 | 0 |
| shop_media_imports | uploaded_by | users | seller → customer | 0 | 0 |
| shop_offers | created_by | users | seller → customer | 1 | 0 |
| shop_payments | owner_id | users | seller → customer | 4 | 0 |
| shop_payments | recorded_by | users | seller → customer | 2 | 0 |
| shop_product_categories | added_by | users | seller → customer | 4 | 0 |
| shop_products | content_updated_by | users | seller → customer | 1 | 0 |
| shop_registrations | owner_user_id | users | seller → customer | 0 | 0 |
| shop_settlements | approved_by | users | seller → customer | 0 | 0 |
| shop_settlements | created_by | users | seller → customer | 0 | 0 |
| shop_settlements | paid_by | users | seller → customer | 0 | 0 |
| shop_sla_events | order_id | orders | seller → customer | 0 | 0 |
| shop_staff | added_by | users | seller → customer | 0 | 0 |
| shop_staff | revoked_by | users | seller → customer | 0 | 0 |
| shop_staff | user_id | users | seller → customer | 0 | 0 |
| shop_suspension_orders | order_id | orders | seller → customer | 0 | 0 |
| shop_suspension_orders | resolved_by | users | seller → customer | 0 | 0 |
| shop_suspensions | lifted_by | users | seller → customer | 1 | 0 |
| shop_suspensions | suspended_by | users | seller → customer | 1 | 0 |
| shop_wallet_transactions | created_by | users | seller → customer | 4 | 0 |
| shop_wallet_transactions | order_id | orders | seller → customer | 9 | 0 |
| shop_wallet_transactions | payment_id | payments | seller → customer | 0 | 0 |
| shops | approved_by | users | seller → customer | 3 | 0 |
| shops | gst_verified_by | users | seller → customer | 0 | 0 |
| shops | owner_id | users | seller → customer | 12 | 0 |
| shops | pan_verified_by | users | seller → customer | 1 | 0 |
| shops | turnover_declared_by | users | seller → customer | 0 | 0 |
| society_shops | shop_id | shops | customer → seller | 0 | 0 |
| stock_alerts | acknowledged_by | users | seller → customer | 0 | 0 |
| subscriptions | shop_id | shops | customer → seller | 2 | 0 |
| subscriptions | shop_product_id | shop_products | customer → seller | 2 | 0 |
| tax_invoices | shop_id | shops | customer → seller | 1 | 0 |
