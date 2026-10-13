# Seller / customer split — verification report

- When: 2026-10-13T02:42:22.220Z
- Source: dairy_bakery_test on localhost
- Seller database: gokesari_seller on localhost
- Customer database: gokesari_customer on localhost
- Tables checked: 190 (90 seller, 100 customer/core)
- Rows: 1885 in the source, 1885 in the targets
- **Result: PASS — every row copied, every checksum equal, no broken cross-database link**

## Row counts and checksums

| Table | Database | Source rows | Target rows | Checksum match |
|---|---|---:|---:|---|
| pmd.attribute_definition | seller | 85 | 85 | yes |
| pmd.brand | seller | 6 | 6 | yes |
| pmd.brand_alias | seller | 6 | 6 | yes |
| pmd.catalogue_link | seller | 0 | 0 | yes |
| pmd.category | seller | 410 | 410 | yes |
| pmd.category_mapping | seller | 1045 | 1045 | yes |
| pmd.dashboard_metric | seller | 27 | 27 | yes |
| pmd.import_error | seller | 0 | 0 | yes |
| pmd.ingestion_run | seller | 1 | 1 | yes |
| pmd.job | seller | 0 | 0 | yes |
| pmd.manufacturer | seller | 0 | 0 | yes |
| pmd.manufacturer_alias | seller | 0 | 0 | yes |
| pmd.match_candidate | seller | 0 | 0 | yes |
| pmd.price_history | seller | 10 | 10 | yes |
| pmd.product_attribute_conflict | seller | 0 | 0 | yes |
| pmd.product_change_log | seller | 12 | 12 | yes |
| pmd.product_family | seller | 0 | 0 | yes |
| pmd.product_identifier | seller | 2 | 2 | yes |
| pmd.product_image | seller | 0 | 0 | yes |
| pmd.product_master | seller | 12 | 12 | yes |
| pmd.product_merge_log | seller | 0 | 0 | yes |
| pmd.product_offer | seller | 10 | 10 | yes |
| pmd.product_source | seller | 12 | 12 | yes |
| pmd.product_specification | seller | 10 | 10 | yes |
| pmd.raw_record | seller | 12 | 12 | yes |
| pmd.reference_state | seller | 1 | 1 | yes |
| pmd.source | seller | 55 | 55 | yes |
| brands | seller | 0 | 0 | yes |
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
| product_categories | seller | 1 | 1 | yes |
| product_images | seller | 0 | 0 | yes |
| product_mrp_history | seller | 0 | 0 | yes |
| product_price_history | seller | 0 | 0 | yes |
| product_subcategories | seller | 0 | 0 | yes |
| products | seller | 2 | 2 | yes |
| referral_code_requests | seller | 0 | 0 | yes |
| referral_codes | seller | 0 | 0 | yes |
| referral_commissions | seller | 0 | 0 | yes |
| referral_redemptions | seller | 0 | 0 | yes |
| registration_fee_history | seller | 0 | 0 | yes |
| registration_fee_tiers | seller | 0 | 0 | yes |
| registration_fees | seller | 0 | 0 | yes |
| registration_payments | seller | 0 | 0 | yes |
| seller_document_uploads | seller | 0 | 0 | yes |
| seller_verification_events | seller | 0 | 0 | yes |
| seller_verification_files | seller | 0 | 0 | yes |
| seller_verifications | seller | 0 | 0 | yes |
| shop_categories | seller | 45 | 45 | yes |
| shop_category_mapping | seller | 0 | 0 | yes |
| shop_classification_history | seller | 0 | 0 | yes |
| shop_delivery_staff | seller | 0 | 0 | yes |
| shop_integrations | seller | 0 | 0 | yes |
| shop_legal_document_files | seller | 0 | 0 | yes |
| shop_legal_documents | seller | 0 | 0 | yes |
| shop_media_import_items | seller | 0 | 0 | yes |
| shop_media_imports | seller | 0 | 0 | yes |
| shop_offers | seller | 0 | 0 | yes |
| shop_payments | seller | 0 | 0 | yes |
| shop_product_categories | seller | 2 | 2 | yes |
| shop_products | seller | 2 | 2 | yes |
| shop_registrations | seller | 0 | 0 | yes |
| shop_settlements | seller | 0 | 0 | yes |
| shop_sla_events | seller | 0 | 0 | yes |
| shop_staff | seller | 0 | 0 | yes |
| shop_suspension_orders | seller | 0 | 0 | yes |
| shop_suspensions | seller | 0 | 0 | yes |
| shop_wallet_transactions | seller | 0 | 0 | yes |
| shop_wallets | seller | 0 | 0 | yes |
| shops | seller | 2 | 2 | yes |
| stock_alerts | seller | 0 | 0 | yes |
| accounts | customer | 0 | 0 | yes |
| addresses | customer | 0 | 0 | yes |
| audit_logs | customer | 0 | 0 | yes |
| bank_account_checks | customer | 0 | 0 | yes |
| bank_accounts | customer | 0 | 0 | yes |
| bank_refund_requests | customer | 0 | 0 | yes |
| bank_verification_attempts | customer | 0 | 0 | yes |
| campaign_recipients | customer | 0 | 0 | yes |
| cart_items | customer | 0 | 0 | yes |
| carts | customer | 0 | 0 | yes |
| coupon_redemptions | customer | 0 | 0 | yes |
| coupons | customer | 0 | 0 | yes |
| credit_note_counters | customer | 0 | 0 | yes |
| credit_notes | customer | 0 | 0 | yes |
| customer_referral_codes | customer | 0 | 0 | yes |
| customer_referral_requests | customer | 0 | 0 | yes |
| customer_referrals | customer | 0 | 0 | yes |
| customer_segments | customer | 0 | 0 | yes |
| customer_signup_referrals | customer | 0 | 0 | yes |
| delivery_earnings_config | customer | 0 | 0 | yes |
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
| gst_rules | customer | 0 | 0 | yes |
| invoice_counters | customer | 0 | 0 | yes |
| login_otps | customer | 0 | 0 | yes |
| maps_api_call_log | customer | 0 | 0 | yes |
| marketing_campaigns | customer | 0 | 0 | yes |
| notification_deliveries | customer | 0 | 0 | yes |
| notification_preferences | customer | 0 | 0 | yes |
| notifications | customer | 0 | 0 | yes |
| order_disputes | customer | 0 | 0 | yes |
| order_financials | customer | 0 | 0 | yes |
| order_fulfilment_arrangements | customer | 0 | 0 | yes |
| order_groups | customer | 0 | 0 | yes |
| order_items | customer | 1 | 1 | yes |
| order_ratings | customer | 0 | 0 | yes |
| order_status_history | customer | 0 | 0 | yes |
| orders | customer | 1 | 1 | yes |
| outbound_test_messages | customer | 2 | 2 | yes |
| payments | customer | 0 | 0 | yes |
| permissions | customer | 0 | 0 | yes |
| platform_settings | customer | 1 | 1 | yes |
| reconciliation_records | customer | 0 | 0 | yes |
| referral_setting_changes | customer | 0 | 0 | yes |
| referral_settings | customer | 0 | 0 | yes |
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
| status_changes | customer | 2 | 2 | yes |
| status_transition_rules | customer | 102 | 102 | yes |
| stored_image_variants | customer | 0 | 0 | yes |
| stored_images | customer | 0 | 0 | yes |
| subscription_daily_overrides | customer | 0 | 0 | yes |
| subscription_deliveries | customer | 0 | 0 | yes |
| subscription_events | customer | 0 | 0 | yes |
| subscription_orders | customer | 0 | 0 | yes |
| subscriptions | customer | 0 | 0 | yes |
| tax_invoices | customer | 0 | 0 | yes |
| user_consents | customer | 0 | 0 | yes |
| user_role_grants | customer | 0 | 0 | yes |
| users | customer | 4 | 4 | yes |
| verification_tokens | customer | 0 | 0 | yes |
| voucher_redemptions | customer | 0 | 0 | yes |
| voucher_upload_items | customer | 0 | 0 | yes |
| voucher_uploads | customer | 0 | 0 | yes |
| vouchers | customer | 0 | 0 | yes |
| wallet_transactions | customer | 0 | 0 | yes |
| wallets | customer | 2 | 2 | yes |

## Cross-database links (enforced in the service layer)

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
| order_items | shop_product_id | shop_products | customer → seller | 1 | 0 |
| order_items | substitute_shop_product_id | shop_products | customer → seller | 0 | 0 |
| order_ratings | shop_id | shops | customer → seller | 0 | 0 |
| orders | buyer_shop_id | shops | customer → seller | 0 | 0 |
| orders | shop_id | shops | customer → seller | 1 | 0 |
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
| shop_classification_history | changed_by | users | seller → customer | 0 | 0 |
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
| shops | approved_by | users | seller → customer | 0 | 0 |
| shops | gst_verified_by | users | seller → customer | 0 | 0 |
| shops | owner_id | users | seller → customer | 2 | 0 |
| shops | pan_verified_by | users | seller → customer | 0 | 0 |
| shops | turnover_declared_by | users | seller → customer | 0 | 0 |
| society_shops | shop_id | shops | customer → seller | 0 | 0 |
| stock_alerts | acknowledged_by | users | seller → customer | 0 | 0 |
| subscriptions | shop_id | shops | customer → seller | 0 | 0 |
| subscriptions | shop_product_id | shop_products | customer → seller | 0 | 0 |
| tax_invoices | shop_id | shops | customer → seller | 0 | 0 |
