# Seller / customer split — verification report (production)

Run: [Database split #19](https://github.com/sanjaymorankar-debug/GoKesari/actions/runs/38577858247), migrate, from `main` @ 797e7e0, 14 Oct 2026 14:08–14:12 UTC. Copied from the run's report (artifact `db-split-report-production`). Preceded by dry run [#18](https://github.com/sanjaymorankar-debug/GoKesari/actions/runs/38577754484), which confirmed all six database secrets point at the right databases.

- When: 2026-10-14T14:12:29.769Z
- Source: neondb on ep-billowing-queen-axqwtstz-pooler.c-4.us-east-2.aws.neon.tech (the gokesari.com database; only read; a restore point was taken at 14:09 UTC before the copy)
- Seller database: PROD_SELLER_DATABASE_URL on ep-billowing-queen-axqwtstz.c-4.us-east-2.aws.neon.tech
- Customer database: PROD_CUSTOMER_DATABASE_URL on ep-billowing-queen-axqwtstz.c-4.us-east-2.aws.neon.tech
- Tables checked: 190 (90 seller, 100 customer/core), the same set as the test split
- Rows: 486 in the source, 486 in the targets
- **Result: PASS. Every row was copied, every checksum is equal, and no cross-database link is broken.**

Not copied (these stay in the source): `playing_with_neon` (Neon's sample table), any backup schemas, and `neon_auth` (Neon's own schema). gokesari.com still runs on the single source database (`DB_SPLIT_MODE=single`). The two new databases are a verified copy, ready for the switch-over.

Before the copy, the workflow checked that the test split still verifies cleanly (it does).

Cross-database reads: [Database split #20](https://github.com/sanjaymorankar-debug/GoKesari/actions/runs/38578578883) (fdw, 14:13 UTC) set up postgres_fdw both ways: seller tables are readable in the customer database (schema `seller_remote`) and core tables in the seller database (schema `core_remote`).

Rollback: the source was only read, so gokesari.com is unaffected. To undo, drop and recreate the two new databases, or restore the source to the 14:09 UTC restore point.

## Row counts and checksums

| Table | Database | Source rows | Target rows | Checksum match |
|---|---|---:|---:|---|
| pmd.attribute_definition | seller | 0 | 0 | yes |
| pmd.brand | seller | 0 | 0 | yes |
| pmd.brand_alias | seller | 0 | 0 | yes |
| pmd.catalogue_link | seller | 0 | 0 | yes |
| pmd.category | seller | 0 | 0 | yes |
| pmd.category_mapping | seller | 0 | 0 | yes |
| pmd.dashboard_metric | seller | 19 | 19 | yes |
| pmd.import_error | seller | 0 | 0 | yes |
| pmd.ingestion_run | seller | 0 | 0 | yes |
| pmd.job | seller | 0 | 0 | yes |
| pmd.manufacturer | seller | 0 | 0 | yes |
| pmd.manufacturer_alias | seller | 0 | 0 | yes |
| pmd.match_candidate | seller | 0 | 0 | yes |
| pmd.price_history | seller | 0 | 0 | yes |
| pmd.product_attribute_conflict | seller | 0 | 0 | yes |
| pmd.product_change_log | seller | 0 | 0 | yes |
| pmd.product_family | seller | 0 | 0 | yes |
| pmd.product_identifier | seller | 0 | 0 | yes |
| pmd.product_image | seller | 0 | 0 | yes |
| pmd.product_master | seller | 0 | 0 | yes |
| pmd.product_merge_log | seller | 0 | 0 | yes |
| pmd.product_offer | seller | 0 | 0 | yes |
| pmd.product_source | seller | 0 | 0 | yes |
| pmd.product_specification | seller | 0 | 0 | yes |
| pmd.raw_record | seller | 0 | 0 | yes |
| pmd.reference_state | seller | 0 | 0 | yes |
| pmd.source | seller | 0 | 0 | yes |
| brands | seller | 3 | 3 | yes |
| commission_rates | seller | 0 | 0 | yes |
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
| inventory_movements | seller | 0 | 0 | yes |
| migration_0038_category_renames | seller | 0 | 0 | yes |
| mrp_corrections | seller | 0 | 0 | yes |
| price_update_batches | seller | 0 | 0 | yes |
| price_update_requests | seller | 0 | 0 | yes |
| product_categories | seller | 13 | 13 | yes |
| product_images | seller | 0 | 0 | yes |
| product_mrp_history | seller | 0 | 0 | yes |
| product_price_history | seller | 0 | 0 | yes |
| product_subcategories | seller | 10 | 10 | yes |
| products | seller | 44 | 44 | yes |
| referral_code_requests | seller | 0 | 0 | yes |
| referral_codes | seller | 0 | 0 | yes |
| referral_commissions | seller | 0 | 0 | yes |
| referral_redemptions | seller | 0 | 0 | yes |
| registration_fee_history | seller | 0 | 0 | yes |
| registration_fee_tiers | seller | 5 | 5 | yes |
| registration_fees | seller | 0 | 0 | yes |
| registration_payments | seller | 0 | 0 | yes |
| seller_document_uploads | seller | 0 | 0 | yes |
| seller_verification_events | seller | 0 | 0 | yes |
| seller_verification_files | seller | 0 | 0 | yes |
| seller_verifications | seller | 0 | 0 | yes |
| shop_categories | seller | 45 | 45 | yes |
| shop_category_mapping | seller | 8 | 8 | yes |
| shop_classification_history | seller | 2 | 2 | yes |
| shop_delivery_staff | seller | 0 | 0 | yes |
| shop_integrations | seller | 0 | 0 | yes |
| shop_legal_document_files | seller | 0 | 0 | yes |
| shop_legal_documents | seller | 0 | 0 | yes |
| shop_media_import_items | seller | 0 | 0 | yes |
| shop_media_imports | seller | 0 | 0 | yes |
| shop_offers | seller | 0 | 0 | yes |
| shop_payments | seller | 0 | 0 | yes |
| shop_product_categories | seller | 19 | 19 | yes |
| shop_products | seller | 44 | 44 | yes |
| shop_registrations | seller | 0 | 0 | yes |
| shop_settlements | seller | 0 | 0 | yes |
| shop_sla_events | seller | 0 | 0 | yes |
| shop_staff | seller | 0 | 0 | yes |
| shop_suspension_orders | seller | 0 | 0 | yes |
| shop_suspensions | seller | 0 | 0 | yes |
| shop_wallet_transactions | seller | 0 | 0 | yes |
| shop_wallets | seller | 0 | 0 | yes |
| shops | seller | 8 | 8 | yes |
| stock_alerts | seller | 0 | 0 | yes |
| accounts | customer | 11 | 11 | yes |
| addresses | customer | 1 | 1 | yes |
| audit_logs | customer | 34 | 34 | yes |
| bank_account_checks | customer | 0 | 0 | yes |
| bank_accounts | customer | 0 | 0 | yes |
| bank_refund_requests | customer | 0 | 0 | yes |
| bank_verification_attempts | customer | 0 | 0 | yes |
| campaign_recipients | customer | 0 | 0 | yes |
| cart_items | customer | 0 | 0 | yes |
| carts | customer | 12 | 12 | yes |
| coupon_redemptions | customer | 0 | 0 | yes |
| coupons | customer | 0 | 0 | yes |
| credit_note_counters | customer | 0 | 0 | yes |
| credit_notes | customer | 0 | 0 | yes |
| customer_referral_codes | customer | 0 | 0 | yes |
| customer_referral_requests | customer | 0 | 0 | yes |
| customer_referrals | customer | 0 | 0 | yes |
| customer_segments | customer | 0 | 0 | yes |
| customer_signup_referrals | customer | 0 | 0 | yes |
| delivery_earnings_config | customer | 1 | 1 | yes |
| delivery_orders | customer | 0 | 0 | yes |
| delivery_partner_change_requests | customer | 0 | 0 | yes |
| delivery_partner_documents | customer | 0 | 0 | yes |
| delivery_partner_earnings | customer | 0 | 0 | yes |
| delivery_partner_sessions | customer | 0 | 0 | yes |
| delivery_partners | customer | 0 | 0 | yes |
| delivery_proofs | customer | 0 | 0 | yes |
| delivery_slot_capacities | customer | 0 | 0 | yes |
| delivery_trips | customer | 0 | 0 | yes |
| dispatch_attempts | customer | 0 | 0 | yes |
| dispute_attachments | customer | 0 | 0 | yes |
| dispute_comments | customer | 0 | 0 | yes |
| dispute_events | customer | 0 | 0 | yes |
| domain_events | customer | 0 | 0 | yes |
| einvoice_records | customer | 0 | 0 | yes |
| eway_bills | customer | 0 | 0 | yes |
| finance_ledger_entries | customer | 0 | 0 | yes |
| financial_adjustments | customer | 0 | 0 | yes |
| grievances | customer | 0 | 0 | yes |
| gst_rules | customer | 7 | 7 | yes |
| invoice_counters | customer | 0 | 0 | yes |
| login_otps | customer | 0 | 0 | yes |
| maps_api_call_log | customer | 12 | 12 | yes |
| marketing_campaigns | customer | 0 | 0 | yes |
| notification_deliveries | customer | 7 | 7 | yes |
| notification_preferences | customer | 0 | 0 | yes |
| notifications | customer | 9 | 9 | yes |
| order_disputes | customer | 0 | 0 | yes |
| order_financials | customer | 0 | 0 | yes |
| order_fulfilment_arrangements | customer | 0 | 0 | yes |
| order_groups | customer | 0 | 0 | yes |
| order_items | customer | 0 | 0 | yes |
| order_ratings | customer | 0 | 0 | yes |
| order_status_history | customer | 0 | 0 | yes |
| orders | customer | 0 | 0 | yes |
| outbound_test_messages | customer | 0 | 0 | yes |
| payments | customer | 0 | 0 | yes |
| permissions | customer | 0 | 0 | yes |
| platform_settings | customer | 9 | 9 | yes |
| reconciliation_records | customer | 0 | 0 | yes |
| referral_setting_changes | customer | 0 | 0 | yes |
| referral_settings | customer | 2 | 2 | yes |
| return_items | customer | 0 | 0 | yes |
| return_pickups | customer | 0 | 0 | yes |
| return_requests | customer | 0 | 0 | yes |
| return_status_history | customer | 0 | 0 | yes |
| rider_earning_slots | customer | 0 | 0 | yes |
| rider_earnings_ledger | customer | 0 | 0 | yes |
| rider_incentive_awards | customer | 0 | 0 | yes |
| rider_incentive_rules | customer | 0 | 0 | yes |
| rider_payouts | customer | 0 | 0 | yes |
| rider_searches | customer | 0 | 0 | yes |
| risk_flags | customer | 0 | 0 | yes |
| role_permissions | customer | 0 | 0 | yes |
| roles | customer | 0 | 0 | yes |
| sessions | customer | 0 | 0 | yes |
| societies | customer | 0 | 0 | yes |
| society_members | customer | 0 | 0 | yes |
| society_riders | customer | 0 | 0 | yes |
| society_shops | customer | 0 | 0 | yes |
| status_changes | customer | 10 | 10 | yes |
| status_transition_rules | customer | 102 | 102 | yes |
| stored_image_variants | customer | 0 | 0 | yes |
| stored_images | customer | 0 | 0 | yes |
| subscription_daily_overrides | customer | 0 | 0 | yes |
| subscription_deliveries | customer | 0 | 0 | yes |
| subscription_events | customer | 0 | 0 | yes |
| subscription_orders | customer | 0 | 0 | yes |
| subscriptions | customer | 0 | 0 | yes |
| tax_invoices | customer | 0 | 0 | yes |
| user_consents | customer | 15 | 15 | yes |
| user_role_grants | customer | 7 | 7 | yes |
| users | customer | 15 | 15 | yes |
| verification_tokens | customer | 0 | 0 | yes |
| voucher_redemptions | customer | 0 | 0 | yes |
| voucher_upload_items | customer | 0 | 0 | yes |
| voucher_uploads | customer | 0 | 0 | yes |
| vouchers | customer | 0 | 0 | yes |
| wallet_transactions | customer | 0 | 0 | yes |
| wallets | customer | 12 | 12 | yes |

## Cross-database links (enforced in the service layer)

All 111 links: 0 missing parents.

| Child | Column | → Parent | Direction | Distinct values | Missing parents |
|---|---|---|---|---:|---:|
| bank_accounts | shop_id | shops | customer → seller | 0 | 0 |
| brands | created_by | users | seller → customer | 0 | 0 |
| cart_items | shop_product_id | shop_products | customer → seller | 0 | 0 |
| commission_rates | created_by | users | seller → customer | 0 | 0 |
| credit_note_counters | shop_id | shops | customer → seller | 0 | 0 |
| credit_notes | shop_id | shops | customer → seller | 0 | 0 |
| customer_referral_requests | issued_code_id | referral_codes | customer → seller | 0 | 0 |
| customer_segments | shop_id | shops | customer → seller | 0 | 0 |
| customer_signup_referrals | referral_code_id | referral_codes | customer → seller | 0 | 0 |
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
| financial_adjustments | shop_id | shops | customer → seller | 0 | 0 |
| gst_return_exports | generated_by | users | seller → customer | 0 | 0 |
| gstin_lookups | looked_up_by | users | seller → customer | 0 | 0 |
| hsn_tax_rates | updated_by | users | seller → customer | 0 | 0 |
| integration_column_mappings | updated_by | users | seller → customer | 0 | 0 |
| integration_connector_tokens | created_by | users | seller → customer | 0 | 0 |
| integration_imports | uploaded_by | users | seller → customer | 0 | 0 |
| integration_item_links | confirmed_by | users | seller → customer | 0 | 0 |
| inventory_movements | created_by | users | seller → customer | 0 | 0 |
| invoice_counters | shop_id | shops | customer → seller | 0 | 0 |
| marketing_campaigns | shop_id | shops | customer → seller | 0 | 0 |
| mrp_corrections | decided_by | users | seller → customer | 0 | 0 |
| mrp_corrections | submitted_by | users | seller → customer | 0 | 0 |
| order_disputes | shop_id | shops | customer → seller | 0 | 0 |
| order_financials | commission_rate_id | commission_rates | customer → seller | 0 | 0 |
| order_financials | settlement_id | shop_settlements | customer → seller | 0 | 0 |
| order_financials | shop_id | shops | customer → seller | 0 | 0 |
| order_fulfilment_arrangements | shop_id | shops | customer → seller | 0 | 0 |
| order_fulfilment_arrangements | staff_id | shop_delivery_staff | customer → seller | 0 | 0 |
| order_items | shop_product_id | shop_products | customer → seller | 0 | 0 |
| order_items | substitute_shop_product_id | shop_products | customer → seller | 0 | 0 |
| order_ratings | shop_id | shops | customer → seller | 0 | 0 |
| orders | buyer_shop_id | shops | customer → seller | 0 | 0 |
| orders | shop_id | shops | customer → seller | 0 | 0 |
| payments | shop_id | shops | customer → seller | 0 | 0 |
| pmd.catalogue_link | promoted_by | users | seller → customer | 0 | 0 |
| price_update_batches | decided_by | users | seller → customer | 0 | 0 |
| price_update_batches | submitted_by | users | seller → customer | 0 | 0 |
| price_update_requests | decided_by | users | seller → customer | 0 | 0 |
| price_update_requests | submitted_by | users | seller → customer | 0 | 0 |
| product_categories | created_by | users | seller → customer | 0 | 0 |
| product_images | created_by | users | seller → customer | 0 | 0 |
| product_images | moderated_by | users | seller → customer | 0 | 0 |
| product_images | stored_image_id | stored_images | seller → customer | 0 | 0 |
| product_mrp_history | changed_by | users | seller → customer | 0 | 0 |
| product_price_history | changed_by | users | seller → customer | 0 | 0 |
| products | approved_by | users | seller → customer | 0 | 0 |
| products | created_by | users | seller → customer | 0 | 0 |
| referral_code_requests | decided_by | users | seller → customer | 0 | 0 |
| referral_code_requests | user_id | users | seller → customer | 0 | 0 |
| referral_codes | created_by | users | seller → customer | 0 | 0 |
| referral_codes | referrer_user_id | users | seller → customer | 0 | 0 |
| referral_commissions | referrer_user_id | users | seller → customer | 0 | 0 |
| referral_redemptions | redeemed_by | users | seller → customer | 0 | 0 |
| registration_fee_history | changed_by | users | seller → customer | 0 | 0 |
| registration_fee_tiers | updated_by | users | seller → customer | 0 | 0 |
| registration_fees | created_by | users | seller → customer | 0 | 0 |
| return_requests | shop_id | shops | customer → seller | 0 | 0 |
| seller_document_uploads | confirmed_by | users | seller → customer | 0 | 0 |
| seller_document_uploads | uploaded_by | users | seller → customer | 0 | 0 |
| seller_verification_events | actor_id | users | seller → customer | 0 | 0 |
| seller_verification_files | uploaded_by | users | seller → customer | 0 | 0 |
| seller_verifications | reviewer_id | users | seller → customer | 0 | 0 |
| seller_verifications | submitted_by | users | seller → customer | 0 | 0 |
| shop_classification_history | changed_by | users | seller → customer | 1 | 0 |
| shop_delivery_staff | created_by | users | seller → customer | 0 | 0 |
| shop_integrations | connected_by | users | seller → customer | 0 | 0 |
| shop_legal_document_files | uploaded_by | users | seller → customer | 0 | 0 |
| shop_legal_documents | reviewed_by | users | seller → customer | 0 | 0 |
| shop_legal_documents | submitted_by | users | seller → customer | 0 | 0 |
| shop_media_imports | uploaded_by | users | seller → customer | 0 | 0 |
| shop_offers | created_by | users | seller → customer | 0 | 0 |
| shop_payments | owner_id | users | seller → customer | 0 | 0 |
| shop_payments | recorded_by | users | seller → customer | 0 | 0 |
| shop_product_categories | added_by | users | seller → customer | 0 | 0 |
| shop_products | content_updated_by | users | seller → customer | 0 | 0 |
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
| shop_suspensions | lifted_by | users | seller → customer | 0 | 0 |
| shop_suspensions | suspended_by | users | seller → customer | 0 | 0 |
| shop_wallet_transactions | created_by | users | seller → customer | 0 | 0 |
| shop_wallet_transactions | order_id | orders | seller → customer | 0 | 0 |
| shop_wallet_transactions | payment_id | payments | seller → customer | 0 | 0 |
| shops | approved_by | users | seller → customer | 1 | 0 |
| shops | gst_verified_by | users | seller → customer | 0 | 0 |
| shops | owner_id | users | seller → customer | 5 | 0 |
| shops | pan_verified_by | users | seller → customer | 0 | 0 |
| shops | turnover_declared_by | users | seller → customer | 0 | 0 |
| society_shops | shop_id | shops | customer → seller | 0 | 0 |
| stock_alerts | acknowledged_by | users | seller → customer | 0 | 0 |
| subscriptions | shop_id | shops | customer → seller | 0 | 0 |
| subscriptions | shop_product_id | shop_products | customer → seller | 0 | 0 |
| tax_invoices | shop_id | shops | customer → seller | 0 | 0 |
