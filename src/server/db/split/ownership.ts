/**
 * Seller / customer database split (Task 1, docs/db-split-2026-10/README.md):
 * which database owns each table.
 *
 *   seller    gokesari_seller — shops, owners' shop records, KYC and documents,
 *             the product catalogue, inventory, pricing, the shop wallet,
 *             settlements (payouts), shop registration and its referral codes.
 *   customer  gokesari_customer — customers' addresses, carts, orders and
 *             everything that follows an order (payments, invoices, delivery,
 *             returns, disputes, ratings), the customer wallet, vouchers,
 *             coupons and subscriptions.
 *   platform  identity, roles, settings, audit, events, notifications and
 *             delivery partners. Physically in the customer database (the
 *             "core" — today's database), read from the seller database
 *             through postgres_fdw where a seller table needs it.
 *
 * Every table in src/server/db/schema.ts must appear here exactly once; a
 * unit test (tests/unit/db-split-ownership.test.ts) fails when a new table
 * is added without an owner.
 */
export type DbOwner = "seller" | "customer" | "platform";

export const TABLE_OWNERSHIP = {
  /* ------------------------------------------------------------ seller */
  shops: "seller",
  shop_categories: "seller",
  shop_category_mapping: "seller",
  shop_classification_history: "seller",
  shop_delivery_staff: "seller",
  shop_integrations: "seller",
  shop_legal_documents: "seller",
  shop_legal_document_files: "seller",
  shop_media_imports: "seller",
  shop_media_import_items: "seller",
  shop_offers: "seller",
  shop_payments: "seller",
  shop_product_categories: "seller",
  shop_products: "seller",
  shop_registrations: "seller",
  shop_settlements: "seller",
  shop_sla_events: "seller",
  shop_staff: "seller",
  shop_suspensions: "seller",
  shop_suspension_orders: "seller",
  shop_wallets: "seller",
  shop_wallet_transactions: "seller",
  seller_verifications: "seller",
  seller_verification_events: "seller",
  seller_verification_files: "seller",
  seller_document_uploads: "seller",
  // docs/inventory-accounting-2026-10: the shop's books, stock ledger and GST portal data.
  inv_settings: "seller",
  inv_product_settings: "seller",
  inv_batches: "seller",
  inv_stock_ledger: "seller",
  inv_unit_conversions: "seller",
  inv_supplier_item_maps: "seller",
  inv_bill_captures: "seller",
  acc_parties: "seller",
  acc_files: "seller",
  acc_purchase_invoices: "seller",
  acc_purchase_lines: "seller",
  acc_sales_invoices: "seller",
  acc_sales_lines: "seller",
  acc_counters: "seller",
  acc_payments: "seller",
  acc_expenses: "seller",
  acc_ledger_entries: "seller",
  acc_change_log: "seller",
  gst_itc_records: "seller",
  gst_portal_links: "seller",
  gst_portal_imports: "seller",
  gst_portal_invoices: "seller",
  gst_recon_items: "seller",
  gst_reminders: "seller",
  gstin_lookups: "seller",
  gst_return_exports: "seller",
  products: "seller",
  product_categories: "seller",
  product_subcategories: "seller",
  product_images: "seller",
  product_price_history: "seller",
  product_mrp_history: "seller",
  brands: "seller",
  hsn_tax_rates: "seller",
  mrp_corrections: "seller",
  external_price_references: "seller",
  external_price_reference_history: "seller",
  price_update_batches: "seller",
  price_update_requests: "seller",
  inventory_movements: "seller",
  stock_alerts: "seller",
  excel_uploads: "seller",
  excel_upload_items: "seller",
  product_import_jobs: "seller",
  product_import_rows: "seller",
  shop_listing_details: "seller",
  product_attributes: "seller",
  registration_fees: "seller",
  registration_fee_tiers: "seller",
  registration_fee_history: "seller",
  registration_payments: "seller",
  referral_codes: "seller",
  referral_code_requests: "seller",
  referral_redemptions: "seller",
  referral_commissions: "seller",
  distributors: "seller",
  distributor_types: "seller",
  commission_rates: "seller",
  integration_connector_tokens: "seller",
  integration_column_mappings: "seller",
  integration_imports: "seller",
  integration_item_links: "seller",
  integration_jobs: "seller",
  integration_sync_log: "seller",

  /* ------------------------------------------------------------ customer */
  addresses: "customer",
  carts: "customer",
  cart_items: "customer",
  orders: "customer",
  order_items: "customer",
  order_groups: "customer",
  order_status_history: "customer",
  order_financials: "customer",
  order_fulfilment_arrangements: "customer",
  order_ratings: "customer",
  order_disputes: "customer",
  dispute_attachments: "customer",
  dispute_comments: "customer",
  dispute_events: "customer",
  return_requests: "customer",
  return_items: "customer",
  return_pickups: "customer",
  return_status_history: "customer",
  payments: "customer",
  wallets: "customer",
  wallet_transactions: "customer",
  vouchers: "customer",
  voucher_redemptions: "customer",
  voucher_uploads: "customer",
  voucher_upload_items: "customer",
  coupons: "customer",
  coupon_redemptions: "customer",
  subscriptions: "customer",
  subscription_orders: "customer",
  subscription_daily_overrides: "customer",
  subscription_deliveries: "customer",
  subscription_events: "customer",
  customer_referral_codes: "customer",
  customer_referral_requests: "customer",
  customer_referrals: "customer",
  customer_segments: "customer",
  customer_signup_referrals: "customer",
  bank_refund_requests: "customer",
  tax_invoices: "customer",
  invoice_counters: "customer",
  credit_notes: "customer",
  credit_note_counters: "customer",
  einvoice_records: "customer",
  eway_bills: "customer",
  delivery_orders: "customer",
  delivery_proofs: "customer",
  delivery_trips: "customer",
  delivery_slot_capacities: "customer",
  dispatch_attempts: "customer",
  finance_ledger_entries: "customer",
  financial_adjustments: "customer",
  reconciliation_records: "customer",
  grievances: "customer",
  societies: "customer",
  society_members: "customer",
  society_riders: "customer",
  society_shops: "customer",
  marketing_campaigns: "customer",
  campaign_recipients: "customer",

  /* ------------------------------------------------------------ platform (core) */
  users: "platform",
  accounts: "platform",
  sessions: "platform",
  verification_tokens: "platform",
  login_otps: "platform",
  roles: "platform",
  permissions: "platform",
  role_permissions: "platform",
  user_role_grants: "platform",
  user_consents: "platform",
  platform_settings: "platform",
  status_changes: "platform",
  status_transition_rules: "platform",
  audit_logs: "platform",
  domain_events: "platform",
  notifications: "platform",
  notification_deliveries: "platform",
  notification_preferences: "platform",
  outbound_test_messages: "platform",
  maps_api_call_log: "platform",
  risk_flags: "platform",
  stored_images: "platform",
  stored_image_variants: "platform",
  gst_rules: "platform",
  referral_settings: "platform",
  referral_setting_changes: "platform",
  bank_accounts: "platform",
  bank_account_checks: "platform",
  bank_verification_attempts: "platform",
  delivery_partners: "platform",
  delivery_partner_documents: "platform",
  delivery_partner_sessions: "platform",
  delivery_partner_change_requests: "platform",
  delivery_partner_earnings: "platform",
  delivery_earnings_config: "platform",
  rider_earning_slots: "platform",
  rider_earnings_ledger: "platform",
  rider_incentive_awards: "platform",
  rider_incentive_rules: "platform",
  rider_payouts: "platform",
  rider_searches: "platform",
  /* >>> batch-2026-10 WS-A (payments, OTP, reference prices) — add entries below this line only */
  /* <<< end WS-A */
  //
  /* >>> batch-2026-10 WS-B (dispatch, QR pickup, navigation) — add entries below this line only */
  // Broadcast rider offers and pickup QR/scan records follow the order and its delivery row.
  delivery_offer_broadcasts: "customer",
  delivery_offer_recipients: "customer",
  delivery_pickup_tokens: "customer",
  delivery_pickup_scans: "customer",
  /* <<< end WS-B */
  //
  /* >>> batch-2026-10 WS-C (cancellation fee, refunds, help desk) — add entries below this line only */
  shop_cancellation_fee_settings: "seller",
  order_charges: "customer",
  order_refunds: "customer",
  order_refund_events: "customer",
  support_tickets: "customer",
  support_ticket_messages: "customer",
  support_ticket_attachments: "customer",
  support_ticket_events: "customer",
  support_canned_replies: "customer",
  support_ticket_csat: "customer",
  /* <<< end WS-C */
  //
  /* >>> batch-2026-10 WS-D (operator-limited, product master data) — add entries below this line only */
  shop_onboarding_sessions: "seller",
  pmd_manufacturer_accounts: "seller",
  pmd_manufacturer_members: "seller",
  pmd_manufacturer_api_keys: "seller",
  pmd_ingest_jobs: "seller",
  pmd_ingest_job_rows: "seller",
  pmd_object_blobs: "seller",
  pmd_image_assets: "seller",
  pmd_record_attributions: "seller",
  /* <<< end WS-D */
  //
  /* >>> batch-2026-10 WS-E (invoicing, payouts, statutory) — add entries below this line only */
  // Shop payouts and GoKesari's fee invoices to shops: shop finance → seller.
  payout_cycles: "seller",
  payout_cycle_lines: "seller",
  payout_batches: "seller",
  payout_items: "seller",
  payout_events: "seller",
  platform_invoice_counters: "seller",
  platform_invoices: "seller",
  platform_invoice_lines: "seller",
  platform_credit_debit_notes: "seller",
  // Dated statutory settings and the document email outbox: platform (core).
  statutory_rates: "platform",
  document_emails: "platform",
  /* <<< end WS-E */
  //
  /* >>> batch-2026-10 WS-F (notifications, push, broadcasts, mobile) — add entries below this line only */
  push_tokens: "platform",
  push_tickets: "platform",
  broadcasts: "platform",
  broadcast_recipients: "platform",
  /* <<< end WS-F */
  //
} as const satisfies Record<string, DbOwner>;

export type OwnedTable = keyof typeof TABLE_OWNERSHIP;

/**
 * Whole schemas with one owner. pmd is the product master (catalogue
 * ingestion, matching, master products — src/server/pmd), so it goes with the
 * catalogue to the seller database. Its tables are named "pmd.<table>".
 */
export const SCHEMA_OWNERSHIP: Record<string, DbOwner> = { pmd: "seller" };

/**
 * Tables a migration created for its own rollback, not in the Drizzle schema.
 * migration_0038_category_renames keeps product-category renames → catalogue → seller.
 */
export const MIGRATION_TABLE_OWNERSHIP: Record<string, DbOwner> = { migration_0038_category_renames: "seller" };

/**
 * Tables that are not GoKesari data and are left in the source, never copied.
 * playing_with_neon is the sample table Neon creates in every new project.
 */
export const NOT_SPLIT_TABLES: readonly string[] = ["playing_with_neon"];

/** The physical database a table lives in after the split: platform tables stay in the customer (core) database. */
export function physicalDatabase(table: string): "seller" | "customer" | null {
  const dot = table.indexOf(".");
  const owner =
    dot > 0
      ? SCHEMA_OWNERSHIP[table.slice(0, dot)]
      : ((TABLE_OWNERSHIP as Record<string, DbOwner>)[table] ?? MIGRATION_TABLE_OWNERSHIP[table]);
  if (!owner) return null;
  return owner === "seller" ? "seller" : "customer";
}

export function tablesOwnedBy(db: "seller" | "customer"): string[] {
  return Object.keys(TABLE_OWNERSHIP)
    .filter((t) => physicalDatabase(t) === db)
    .sort();
}

/**
 * Platform tables the seller database reads through postgres_fdw (owner
 * names, emails for KYC name matching, settings). Read-only there.
 */
export const SELLER_READS_FROM_CORE = ["users", "platform_settings", "roles", "user_role_grants"] as const;

/**
 * Seller tables the customer (core) database reads through postgres_fdw for
 * order → shop → product reads (order pages, invoices, admin).
 */
export const CUSTOMER_READS_FROM_SELLER = ["shops", "shop_products", "products", "product_categories", "product_images", "shop_wallets"] as const;
