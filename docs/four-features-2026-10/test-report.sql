-- Four features (docs/four-features-2026-10): READ-ONLY evidence for the
-- end-to-end pass on the TEST site. Actions → Test database → Run workflow →
-- four-features-report prints it in the job log (the run is read-only: the
-- workflow sets default_transaction_read_only). Never prints a secret: account
-- numbers, UPI IDs and licence numbers show only whether they are encrypted
-- and their last characters; codes show only whether a hash exists.
\pset pager off
\pset null '·'

\echo '== Migrations (newest 6) and rules in force'
SELECT id, created_at FROM drizzle.__drizzle_migrations ORDER BY created_at DESC LIMIT 6;
SELECT key, value FROM platform_settings
 WHERE key IN ('fulfilmentOptions', 'legalDocuments', 'bankAccounts', 'shopReferral', 'shopWallet', 'deliveryOtp',
               'bankRefunds', 'customerSignupReferral', 'customerReferrals') ORDER BY key;

\echo '== E2E accounts (sanjaymorankar+gk-*)'
SELECT u.email, u.role, u.status, u.created_at
  FROM users u WHERE u.email LIKE 'sanjaymorankar+gk-%@gmail.com' ORDER BY u.created_at;

\echo '== E2E shops'
SELECT s.name, s.status, s.shop_type, s.delivery_available, s.created_at, s.approved_at, rc.code AS referral_code,
       (SELECT balance_paise FROM shop_wallets w WHERE w.shop_id = s.id) AS wallet_paise
  FROM shops s LEFT JOIN referral_codes rc ON rc.id = s.referral_code_id
 WHERE s.name ILIKE 'E2E%' ORDER BY s.created_at;

\echo '== 1. Delivery staff and fulfilment plans (E2E shops)'
SELECT s.name AS shop, st.name, st.phone_e164, st.is_active, st.deactivated_at
  FROM shop_delivery_staff st JOIN shops s ON s.id = st.shop_id WHERE s.name ILIKE 'E2E%' ORDER BY st.created_at;
SELECT o.order_number, o.status AS order_status, a.option, a.scheduled_start, a.scheduled_end, st.name AS staff,
       a.code_hash IS NOT NULL AS code_hashed, a.code_nonce IS NOT NULL AS pickup_nonce, a.code_attempts, a.code_resends,
       a.code_locked_at, a.out_for_delivery_at, a.completed_at, a.completed_via, a.version
  FROM order_fulfilment_arrangements a
  JOIN orders o ON o.id = a.order_id JOIN shops s ON s.id = a.shop_id
  LEFT JOIN shop_delivery_staff st ON st.id = a.staff_id
 WHERE s.name ILIKE 'E2E%' ORDER BY a.created_at;
\echo '-- pickup gives the delivery fee back (owner 9 Oct): the fee and total now, the amount given back, the wallet refund'
SELECT o.order_number, o.payment_method, o.delivery_fee_paise, o.total_paise, o.refunded_paise,
       a.delivery_fee_refunded_paise, a.delivery_fee_refunded_at,
       (SELECT t.amount_paise FROM wallet_transactions t WHERE t.idempotency_key = 'refund:order:' || o.id || ':delivery-fee-pickup') AS wallet_refund_paise
  FROM order_fulfilment_arrangements a JOIN orders o ON o.id = a.order_id JOIN shops s ON s.id = a.shop_id
 WHERE s.name ILIKE 'E2E%' AND a.option = 'PICKUP' ORDER BY a.created_at;
\echo '-- shop wallet ledger for those orders (DELIVERY_CHARGE only for GoKesari-rider deliveries)'
SELECT o.order_number, t.type, t.direction, t.amount_paise, t.balance_after_paise, t.created_at
  FROM shop_wallet_transactions t JOIN orders o ON o.id = t.order_id JOIN shops s ON s.id = o.shop_id
 WHERE s.name ILIKE 'E2E%' ORDER BY t.seq;
\echo '-- delivery records (GoKesari partner) for those orders'
SELECT o.order_number, d.status, d.delivery_otp IS NULL AS no_plain_code, d.delivery_otp_hash IS NOT NULL AS hashed,
       d.picked_up_at, d.delivered_at
  FROM delivery_orders d JOIN orders o ON o.id = d.order_id JOIN shops s ON s.id = o.shop_id
 WHERE s.name ILIKE 'E2E%' ORDER BY d.created_at;
\echo '-- events for those orders'
SELECT o.order_number, e.type, e.from_status, e.to_status, e.created_at
  FROM domain_events e JOIN orders o ON o.id = e.order_id JOIN shops s ON s.id = o.shop_id
 WHERE s.name ILIKE 'E2E%' AND (e.type LIKE 'order.fulfilment%' OR e.type LIKE 'delivery.%' OR e.type IN ('order.ready', 'order.delivered'))
 ORDER BY e.created_at;

\echo '== 2. Legal documents (E2E shops)'
SELECT s.name AS shop, d.doc_type, d.status, d.number_encrypted IS NOT NULL AS number_encrypted, d.number_last4,
       d.issuing_council, d.expiry_date, d.grace_until, d.submitted_at, d.reviewed_at, d.rejection_reason, d.expiry_reminder_sent_for
  FROM shop_legal_documents d JOIN shops s ON s.id = d.shop_id WHERE s.name ILIKE 'E2E%' ORDER BY s.name, d.doc_type;
SELECT s.name AS shop, f.content_type, f.size_bytes,
       substring(f.data_encrypted from 1 for 4) <> '\x25504446'::bytea AS not_plain_pdf, f.created_at
  FROM shop_legal_document_files f JOIN shops s ON s.id = f.shop_id WHERE s.name ILIKE 'E2E%' ORDER BY f.created_at;

\echo '== 3. Bank accounts and ₹1 verifications (E2E users)'
SELECT u.email, b.holder_type, b.method, b.account_holder_name, b.account_number_last4,
       b.account_number_encrypted IS NOT NULL AS acct_encrypted, b.account_number_encrypted !~ '^[0-9]+$' AS acct_not_plain,
       b.upi_id_masked, b.upi_id_encrypted IS NOT NULL AS upi_encrypted, b.ifsc, b.status, b.matched_account_holder_name,
       b.name_match_score, b.match_method, b.verified_at, b.verification_payment_method, b.gateway_reference,
       b.failure_reason, b.is_current, b.superseded_at
  FROM bank_accounts b JOIN users u ON u.id = b.user_id WHERE u.email LIKE 'sanjaymorankar+gk-%@gmail.com' ORDER BY b.created_at;
SELECT u.email, a.gateway, a.gateway_order_id, a.amount_paise, a.status, a.payment_method, a.gateway_payment_id,
       a.failure_reason, a.refund_status, a.refund_reference, a.refunded_at, a.completed_at
  FROM bank_verification_attempts a JOIN users u ON u.id = a.user_id WHERE u.email LIKE 'sanjaymorankar+gk-%@gmail.com' ORDER BY a.created_at;

\echo '== 4. Referral-code requests (newest 15) and E2E referral codes'
SELECT 'RCR-' || upper(substr(replace(r.id::text, '-', ''), 1, 8)) AS ref, r.name, r.mobile_e164, r.shop_type, r.area, r.city, r.pincode,
       r.latitude, r.longitude, r.location_accuracy_m, r.maps_url, r.location_status, r.status, r.issued_code, r.decision_note,
       r.email_status, r.email_error, r.email_sent_at, r.created_at
  FROM referral_code_requests r ORDER BY r.created_at DESC LIMIT 15;
SELECT rc.code, rc.status, rc.label, rc.expires_at, rc.created_at,
       (SELECT count(*) FROM shops s WHERE s.referral_code_id = rc.id) AS shops_attributed
  FROM referral_codes rc WHERE rc.code ILIKE 'E2E%' OR rc.code LIKE 'GKS%' OR rc.label ILIKE '%RCR-%' ORDER BY rc.created_at;

\echo '== 5. Refunds to bank (E2E users; owner 9 Oct)'
SELECT u.email, r.status, r.amount_paise, r.account_label, r.payout_reference, r.failure_reason,
       r.created_at, r.processing_at, r.paid_at, r.failed_at, r.cancelled_at,
       (SELECT t.amount_paise FROM wallet_transactions t WHERE t.id = r.debit_transaction_id) AS wallet_debit_paise,
       (SELECT t.amount_paise FROM wallet_transactions t WHERE t.id = r.return_transaction_id) AS wallet_return_paise
  FROM bank_refund_requests r JOIN users u ON u.id = r.user_id
 WHERE u.email LIKE 'sanjaymorankar+gk-%@gmail.com' ORDER BY r.created_at;

\echo '== 6. Referral codes given at customer registration (E2E users, and customers per code)'
SELECT u.email, c.kind, c.code, c.created_at
  FROM customer_signup_referrals c JOIN users u ON u.id = c.user_id
 WHERE u.email LIKE 'sanjaymorankar+gk-%@gmail.com' ORDER BY c.created_at;
SELECT c.code, c.kind, count(*) AS customers, max(c.created_at) AS latest
  FROM customer_signup_referrals c GROUP BY c.code, c.kind ORDER BY latest DESC LIMIT 20;

\echo '== 7. Customers asking for a referral code (owner 9 Oct, second round; E2E users)'
SELECT u.email, r.name, r.mobile_e164, r.city, r.pincode, r.location_status, r.maps_url, r.status,
       r.issued_code, r.decision_note, r.email_status, left(r.email_error, 120) AS email_error, r.created_at, r.decided_at
  FROM customer_referral_requests r JOIN users u ON u.id = r.user_id
 WHERE u.email LIKE 'sanjaymorankar+gk-%@gmail.com' ORDER BY r.created_at;

\echo '== 8. Shops whose legal documents block new orders (grace over / rejected / expired)'
SELECT s.name, d.doc_type, d.status, d.grace_until, d.expiry_date, d.updated_at
  FROM shop_legal_documents d JOIN shops s ON s.id = d.shop_id
 WHERE d.status <> 'APPROVED' OR d.expiry_date < current_date ORDER BY d.updated_at DESC LIMIT 20;

\echo '== Email outbox for the E2E accounts (newest 40; addresses are the test aliases)'
SELECT d.created_at, u.email, d.type, d.status, d.attempts, d.next_attempt_at, d.sent_at, left(d.last_error, 120) AS last_error
  FROM notification_deliveries d JOIN users u ON u.id = d.user_id
 WHERE u.email LIKE 'sanjaymorankar+gk-%@gmail.com' AND d.channel = 'EMAIL'
 ORDER BY d.created_at DESC LIMIT 40;

\echo '== Audit trail of the four features (newest 40)'
SELECT a.created_at, a.action, a.entity_type, u.email AS actor
  FROM audit_logs a LEFT JOIN users u ON u.id = a.actor_id
 WHERE a.action LIKE 'order.fulfilment%' OR a.action LIKE 'shop.delivery_staff%' OR a.action LIKE 'shop.legal_document%'
    OR a.action LIKE 'bank_account%' OR a.action LIKE 'referral_request%'
    OR a.action LIKE 'bank_refund%' OR a.action LIKE 'customer_referral_request%'
    OR a.action IN ('order.delivery_fee_refunded', 'customer.signup_referral')
 ORDER BY a.created_at DESC LIMIT 40;
