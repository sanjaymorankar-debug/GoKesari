CREATE TABLE `accounts` (
	`user_id` varchar(36) NOT NULL,
	`type` text NOT NULL,
	`provider` varchar(255) NOT NULL,
	`provider_account_id` varchar(255) NOT NULL,
	`refresh_token` text,
	`access_token` text,
	`expires_at` int,
	`token_type` text,
	`scope` text,
	`id_token` text,
	`session_state` text,
	CONSTRAINT `accounts_provider_provider_account_id_pk` PRIMARY KEY(`provider`,`provider_account_id`)
);
--> statement-breakpoint
CREATE TABLE `addresses` (
	`id` varchar(36) NOT NULL,
	`user_id` varchar(36) NOT NULL,
	`label` text,
	`recipient_name` text,
	`recipient_phone` text,
	`address_type` varchar(255) NOT NULL DEFAULT 'OTHER',
	`line1` text NOT NULL,
	`line2` text,
	`area` text,
	`city` text NOT NULL,
	`state` text,
	`pincode` varchar(255) NOT NULL,
	`latitude` text,
	`longitude` text,
	`landmark` text,
	`delivery_instructions` text,
	`society_id` varchar(36),
	`is_default` boolean NOT NULL DEFAULT false,
	`location_verified` boolean NOT NULL DEFAULT false,
	`location_verified_at` datetime(3),
	`location_source` text,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`deleted_at` datetime(3),
	CONSTRAINT `addresses_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `audit_logs` (
	`id` varchar(36) NOT NULL,
	`actor_id` varchar(36),
	`actor_role` enum('CUSTOMER','SHOP_OWNER','OPERATOR','ADMIN','DELIVERY_PARTNER','SOCIETY_ADMIN'),
	`action` text NOT NULL,
	`entity_type` varchar(255) NOT NULL,
	`entity_id` varchar(255),
	`previous_value` json,
	`new_value` json,
	`ip_address` text,
	`user_agent` text,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `audit_logs_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `brands` (
	`id` varchar(36) NOT NULL,
	`name` varchar(255) NOT NULL,
	`slug` varchar(255) NOT NULL,
	`description` text,
	`logo_url` text,
	`is_active` boolean NOT NULL DEFAULT true,
	`created_by` varchar(36),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`deleted_at` datetime(3),
	CONSTRAINT `brands_id` PRIMARY KEY(`id`),
	CONSTRAINT `brands_slug_unique` UNIQUE(`slug`)
);
--> statement-breakpoint
CREATE TABLE `campaign_recipients` (
	`id` varchar(36) NOT NULL,
	`campaign_id` varchar(36) NOT NULL,
	`user_id` varchar(36) NOT NULL,
	`notification_key` text NOT NULL,
	`sent_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `campaign_recipients_id` PRIMARY KEY(`id`),
	CONSTRAINT `campaign_recipients_unique` UNIQUE(`campaign_id`,`user_id`)
);
--> statement-breakpoint
CREATE TABLE `cart_items` (
	`id` varchar(36) NOT NULL,
	`cart_id` varchar(36) NOT NULL,
	`shop_product_id` varchar(36) NOT NULL,
	`quantity` int NOT NULL,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `cart_items_id` PRIMARY KEY(`id`),
	CONSTRAINT `cart_items_cart_product_unique` UNIQUE(`cart_id`,`shop_product_id`),
	CONSTRAINT `cart_items_quantity_positive` CHECK(`cart_items`.`quantity` > 0)
);
--> statement-breakpoint
CREATE TABLE `carts` (
	`id` varchar(36) NOT NULL,
	`user_id` varchar(36) NOT NULL,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `carts_id` PRIMARY KEY(`id`),
	CONSTRAINT `carts_user_unique` UNIQUE(`user_id`)
);
--> statement-breakpoint
CREATE TABLE `commission_rates` (
	`id` varchar(36) NOT NULL,
	`scope` enum('DEFAULT','SHOP_TYPE','SHOP') NOT NULL,
	`shop_type` enum('GROCERY_KIRANA','SUPERMARKET','CONVENIENCE_STORE','FRUIT_VEGETABLE','DAIRY','BAKERY','MEAT_SHOP','SWEET_SHOP','PHARMACY','OPTICAL_STORE','CLOTHING_STORE','FOOTWEAR_STORE','JEWELLERY_STORE','COSMETICS_BEAUTY','MOBILE_PHONE_STORE','ELECTRONICS_STORE','COMPUTER_STORE','FURNITURE_STORE','HOME_APPLIANCE_STORE','HARDWARE_STORE','PAINT_SANITARY_STORE','STATIONERY_STORE','BOOKSTORE','TOY_STORE','SPORTS_STORE','PET_STORE','AUTO_SPARE_PARTS','AUTO_ACCESSORIES','MOBILE_ELECTRONICS_REPAIR','GIFT_SHOP','FLOWER_SHOP','BUILDING_MATERIALS','ELECTRICAL_SHOP','AGRICULTURAL_SUPPLY','POULTRY_SUPPLY','RESTAURANT','FAST_FOOD','CAFE','MEDICAL_EQUIPMENT','PRINTING_PHOTOCOPY','GENERAL_TRADING','PACKAGING_MATERIALS','WHOLESALE_STORE','ONLINE_STORE'),
	`shop_id` varchar(36),
	`rate_bp` int NOT NULL,
	`is_active` boolean NOT NULL DEFAULT true,
	`note` text,
	`created_by` varchar(36),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `commission_rates_id` PRIMARY KEY(`id`),
	CONSTRAINT `commission_rates_range` CHECK(`commission_rates`.`rate_bp` BETWEEN 0 AND 5000),
	CONSTRAINT `commission_rates_scope_target` CHECK((`commission_rates`.`scope` = 'DEFAULT' AND `commission_rates`.`shop_type` IS NULL AND `commission_rates`.`shop_id` IS NULL)
          OR (`commission_rates`.`scope` = 'SHOP_TYPE' AND `commission_rates`.`shop_type` IS NOT NULL AND `commission_rates`.`shop_id` IS NULL)
          OR (`commission_rates`.`scope` = 'SHOP' AND `commission_rates`.`shop_id` IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE `counters` (
	`name` varchar(64) NOT NULL,
	`value` bigint NOT NULL DEFAULT 0,
	CONSTRAINT `counters_name` PRIMARY KEY(`name`)
);
--> statement-breakpoint
CREATE TABLE `customer_segments` (
	`id` varchar(36) NOT NULL,
	`shop_id` varchar(36) NOT NULL,
	`name` text NOT NULL,
	`rules` json NOT NULL,
	`created_by` varchar(36),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`deleted_at` datetime(3),
	CONSTRAINT `customer_segments_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `delivery_earnings_config` (
	`id` varchar(36) NOT NULL,
	`base_fee_paise` bigint NOT NULL,
	`per_km_fee_paise` bigint NOT NULL,
	`is_active` boolean NOT NULL DEFAULT true,
	`note` text,
	`created_by` varchar(36),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `delivery_earnings_config_id` PRIMARY KEY(`id`),
	CONSTRAINT `delivery_earnings_config_non_negative` CHECK(`delivery_earnings_config`.`base_fee_paise` >= 0 AND `delivery_earnings_config`.`per_km_fee_paise` >= 0)
);
--> statement-breakpoint
CREATE TABLE `delivery_orders` (
	`id` varchar(36) NOT NULL,
	`order_id` varchar(36) NOT NULL,
	`delivery_partner_id` varchar(36) NOT NULL,
	`status` enum('OFFERED','ACCEPTED','REJECTED','PICKED_UP','DELIVERED','CANCELLED','FAILED') NOT NULL DEFAULT 'OFFERED',
	`distance_km` text,
	`offered_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`accepted_at` datetime(3),
	`picked_up_at` datetime(3),
	`delivered_at` datetime(3),
	`cancelled_at` datetime(3),
	`cancellation_reason` text,
	`pickup_code` text,
	`delivery_otp` text,
	`delivery_otp_attempts` int NOT NULL DEFAULT 0,
	`out_for_delivery_at` datetime(3),
	`arrived_at_shop_at` datetime(3),
	`arrived_at_customer_at` datetime(3),
	`failed_at` datetime(3),
	`failure_reason` text,
	`delivery_confirmation` text,
	`proof_note` text,
	`rejected_partner_ids` json NOT NULL DEFAULT ('[]'),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `delivery_orders_id` PRIMARY KEY(`id`),
	CONSTRAINT `delivery_orders_order_id_unique` UNIQUE(`order_id`)
);
--> statement-breakpoint
CREATE TABLE `delivery_partner_earnings` (
	`id` varchar(36) NOT NULL,
	`delivery_partner_id` varchar(36) NOT NULL,
	`delivery_order_id` varchar(36),
	`return_pickup_id` varchar(36),
	`base_paise` bigint NOT NULL,
	`distance_paise` bigint NOT NULL,
	`order_component_paise` bigint NOT NULL DEFAULT 0,
	`slot_incentive_paise` bigint NOT NULL DEFAULT 0,
	`min_top_up_paise` bigint NOT NULL DEFAULT 0,
	`order_incentive_paise` bigint NOT NULL DEFAULT 0,
	`other_incentive_paise` bigint NOT NULL DEFAULT 0,
	`deductions_paise` bigint NOT NULL DEFAULT 0,
	`slot_id` varchar(36),
	`total_paise` bigint NOT NULL,
	`payout_id` varchar(36),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `delivery_partner_earnings_id` PRIMARY KEY(`id`),
	CONSTRAINT `delivery_partner_earnings_order_unique` UNIQUE(`delivery_order_id`),
	CONSTRAINT `delivery_partner_earnings_return_unique` UNIQUE(`return_pickup_id`)
);
--> statement-breakpoint
CREATE TABLE `delivery_partner_sessions` (
	`id` varchar(36) NOT NULL,
	`delivery_partner_id` varchar(36) NOT NULL,
	`started_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`ended_at` datetime(3),
	CONSTRAINT `delivery_partner_sessions_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `delivery_partners` (
	`id` varchar(36) NOT NULL,
	`user_id` varchar(36) NOT NULL,
	`full_name` text NOT NULL,
	`mobile` text NOT NULL,
	`email` text,
	`date_of_birth` date,
	`profile_photo_url` text,
	`government_id_type` text,
	`pan_number` text,
	`government_id_number` text,
	`bank_account_holder_name` text,
	`bank_account_number` text,
	`bank_ifsc` text,
	`pan_number_encrypted` text,
	`government_id_number_encrypted` text,
	`bank_account_holder_name_encrypted` text,
	`bank_account_number_encrypted` text,
	`bank_ifsc_encrypted` text,
	`driving_licence_number_encrypted` text,
	`vehicle_type` text NOT NULL,
	`vehicle_registration_number` text,
	`driving_licence_number` text,
	`latitude` text,
	`longitude` text,
	`operating_radius_km` int NOT NULL DEFAULT 5,
	`rating_avg_x100` int NOT NULL DEFAULT 0,
	`rating_count` int NOT NULL DEFAULT 0,
	`location_verified` boolean NOT NULL DEFAULT false,
	`location_verified_at` datetime(3),
	`location_source` text,
	`status` enum('REGISTERED','UNDER_REVIEW','APPROVED','REJECTED','SUSPENDED','DEACTIVATED') NOT NULL DEFAULT 'REGISTERED',
	`review_notes` text,
	`rejection_reason` text,
	`reviewed_by` varchar(36),
	`reviewed_at` datetime(3),
	`is_online` boolean NOT NULL DEFAULT false,
	`last_location_latitude` text,
	`last_location_longitude` text,
	`last_location_at` datetime(3),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`deleted_at` datetime(3),
	CONSTRAINT `delivery_partners_id` PRIMARY KEY(`id`),
	CONSTRAINT `delivery_partners_user_id_unique` UNIQUE(`user_id`)
);
--> statement-breakpoint
CREATE TABLE `dispatch_attempts` (
	`id` varchar(36) NOT NULL,
	`order_id` varchar(36) NOT NULL,
	`search_id` varchar(36),
	`attempt_no` int NOT NULL,
	`trigger` text NOT NULL,
	`outcome` varchar(255) NOT NULL,
	`delivery_order_id` varchar(36),
	`delivery_partner_id` varchar(36),
	`detail` text,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `dispatch_attempts_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `excel_upload_items` (
	`id` varchar(36) NOT NULL,
	`upload_id` varchar(36) NOT NULL,
	`row_number` int NOT NULL,
	`raw_data` json,
	`product_code` text,
	`product_name` text,
	`unit` text,
	`parsed_price_paise` bigint,
	`previous_price_paise` bigint,
	`matched_shop_product_id` varchar(36),
	`matched_product_id` varchar(36),
	`possible_duplicate_product_id` varchar(36),
	`status` enum('VALID','NO_CHANGE','INVALID_PRICE','DUPLICATE','NOT_FOUND','MISSING_FIELD','NEW_PRODUCT') NOT NULL,
	`error_message` text,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `excel_upload_items_id` PRIMARY KEY(`id`),
	CONSTRAINT `excel_upload_items_row_unique` UNIQUE(`upload_id`,`row_number`)
);
--> statement-breakpoint
CREATE TABLE `excel_uploads` (
	`id` varchar(36) NOT NULL,
	`shop_id` varchar(36) NOT NULL,
	`uploaded_by` varchar(36) NOT NULL,
	`upload_type` enum('GOODS','PRICES') NOT NULL DEFAULT 'PRICES',
	`status` enum('VALIDATED','APPLIED','CANCELLED','FAILED') NOT NULL DEFAULT 'VALIDATED',
	`file_name` text NOT NULL,
	`file_size_bytes` int NOT NULL DEFAULT 0,
	`total_rows` int NOT NULL DEFAULT 0,
	`valid_rows` int NOT NULL DEFAULT 0,
	`invalid_rows` int NOT NULL DEFAULT 0,
	`unchanged_rows` int NOT NULL DEFAULT 0,
	`duplicate_rows` int NOT NULL DEFAULT 0,
	`not_found_rows` int NOT NULL DEFAULT 0,
	`summary` json,
	`error_message` text,
	`applied_at` datetime(3),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `excel_uploads_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `external_price_reference_history` (
	`id` varchar(36) NOT NULL,
	`reference_id` varchar(36) NOT NULL,
	`action` text NOT NULL,
	`previous` json,
	`next` json NOT NULL,
	`note` text,
	`actor_id` varchar(36),
	`actor_role` text,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `external_price_reference_history_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `external_price_references` (
	`id` varchar(36) NOT NULL,
	`product_id` varchar(36) NOT NULL,
	`price_paise` bigint NOT NULL,
	`unit_basis` text,
	`source_type` text NOT NULL,
	`source_name` text NOT NULL,
	`source_identifier` text,
	`reference_url` text,
	`market_location` text,
	`pincode` text,
	`referenced_at` datetime(3) NOT NULL,
	`verification_status` varchar(255) NOT NULL DEFAULT 'UNVERIFIED',
	`verified_by` varchar(36),
	`verified_at` datetime(3),
	`verification_note` text,
	`created_by` varchar(36),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `external_price_references_id` PRIMARY KEY(`id`),
	CONSTRAINT `external_price_refs_price_positive` CHECK(`external_price_references`.`price_paise` > 0)
);
--> statement-breakpoint
CREATE TABLE `finance_ledger_entries` (
	`id` varchar(36) NOT NULL,
	`order_id` varchar(36),
	`entity_type` enum('SHOP','RIDER','PLATFORM') NOT NULL,
	`entity_id` varchar(36),
	`entry_type` enum('GOODS_SALE','COMMISSION','DELIVERY_FEE','PROMOTIONAL_DISCOUNT','RIDER_EARNING','REFUND','ADJUSTMENT','SHOP_SETTLEMENT','RIDER_PAYOUT','REVERSAL','COD_CASH') NOT NULL,
	`direction` enum('CREDIT','DEBIT') NOT NULL,
	`amount_paise` bigint NOT NULL,
	`currency` varchar(255) NOT NULL DEFAULT 'INR',
	`source_type` text NOT NULL,
	`source_id` text NOT NULL,
	`reference` text,
	`status` varchar(255) NOT NULL DEFAULT 'POSTED',
	`idempotency_key` varchar(255) NOT NULL,
	`created_by` varchar(36),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `finance_ledger_entries_id` PRIMARY KEY(`id`),
	CONSTRAINT `finance_ledger_idempotency_unique` UNIQUE(`idempotency_key`),
	CONSTRAINT `finance_ledger_amount_positive` CHECK(`finance_ledger_entries`.`amount_paise` > 0)
);
--> statement-breakpoint
CREATE TABLE `financial_adjustments` (
	`id` varchar(36) NOT NULL,
	`type` enum('REFUND_SHOP','REFUND_PLATFORM','SHOP_ADJUSTMENT','RIDER_ADJUSTMENT','DELIVERY_ADJUSTMENT','MARKETPLACE_ADJUSTMENT','COD_CASH_COLLECTED','COD_CASH_DEPOSITED') NOT NULL,
	`party` enum('SHOP','RIDER','PLATFORM') NOT NULL,
	`status` enum('PENDING','SETTLED','RECORDED') NOT NULL DEFAULT 'PENDING',
	`shop_id` varchar(36),
	`delivery_partner_id` varchar(36),
	`order_id` varchar(36),
	`wallet_transaction_id` varchar(36),
	`amount_paise` bigint NOT NULL,
	`customer_refund_paise` bigint NOT NULL DEFAULT 0,
	`reason` text NOT NULL,
	`settlement_id` varchar(36),
	`payout_id` varchar(36),
	`idempotency_key` varchar(255) NOT NULL,
	`created_by` varchar(36),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `financial_adjustments_id` PRIMARY KEY(`id`),
	CONSTRAINT `financial_adjustments_idempotency_unique` UNIQUE(`idempotency_key`),
	CONSTRAINT `financial_adjustments_party_target` CHECK((`financial_adjustments`.`party` = 'SHOP' AND `financial_adjustments`.`shop_id` IS NOT NULL)
          OR (`financial_adjustments`.`party` = 'RIDER' AND `financial_adjustments`.`delivery_partner_id` IS NOT NULL)
          OR `financial_adjustments`.`party` = 'PLATFORM')
);
--> statement-breakpoint
CREATE TABLE `grievances` (
	`id` varchar(36) NOT NULL,
	`ticket_number` varchar(255) NOT NULL,
	`submitted_by_user_id` varchar(36),
	`order_id` varchar(36),
	`name` text NOT NULL,
	`email` varchar(255) NOT NULL,
	`phone` text,
	`category` enum('PAYMENT','WALLET','ORDER','SUBSCRIPTION','SELLER','PRODUCT','PRIVACY','OTHER') NOT NULL DEFAULT 'OTHER',
	`subject` text NOT NULL,
	`description` text NOT NULL,
	`status` enum('OPEN','IN_PROGRESS','RESOLVED','CLOSED') NOT NULL DEFAULT 'OPEN',
	`assigned_to_user_id` varchar(36),
	`resolution_notes` text,
	`resolved_at` datetime(3),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `grievances_id` PRIMARY KEY(`id`),
	CONSTRAINT `grievances_ticket_number_unique` UNIQUE(`ticket_number`)
);
--> statement-breakpoint
CREATE TABLE `inventory_movements` (
	`id` varchar(36) NOT NULL,
	`shop_product_id` varchar(36) NOT NULL,
	`channel` text NOT NULL,
	`delta_units` int NOT NULL,
	`previous_units` int NOT NULL,
	`new_units` int NOT NULL,
	`reason` text NOT NULL,
	`order_id` varchar(36),
	`created_by` varchar(36),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `inventory_movements_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `login_otps` (
	`id` varchar(36) NOT NULL,
	`user_id` varchar(36),
	`phone_e164` varchar(255) NOT NULL,
	`channel` text NOT NULL,
	`code_hash` text NOT NULL,
	`expires_at` datetime(3) NOT NULL,
	`attempts` int NOT NULL DEFAULT 0,
	`max_attempts` int NOT NULL,
	`consumed_at` datetime(3),
	`superseded_at` datetime(3),
	`ip_address` text,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `login_otps_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `maps_api_call_log` (
	`id` varchar(36) NOT NULL,
	`service` varchar(255) NOT NULL,
	`purpose` text NOT NULL,
	`entity_type` varchar(255),
	`entity_id` varchar(255),
	`success` boolean NOT NULL,
	`response_time_ms` int,
	`error_message` text,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `maps_api_call_log_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `marketing_campaigns` (
	`id` varchar(36) NOT NULL,
	`shop_id` varchar(36) NOT NULL,
	`segment_id` varchar(36) NOT NULL,
	`title` text NOT NULL,
	`message` text NOT NULL,
	`offer_text` text,
	`max_recipients` int NOT NULL,
	`attribution_days` int NOT NULL DEFAULT 7,
	`status` enum('DRAFT','SUBMITTED','APPROVED','REJECTED','SENT','CANCELLED') NOT NULL DEFAULT 'DRAFT',
	`submitted_at` datetime(3),
	`decided_by` varchar(36),
	`decided_at` datetime(3),
	`rejection_reason` text,
	`sent_at` datetime(3),
	`sent_count` int NOT NULL DEFAULT 0,
	`suppressed_count` int NOT NULL DEFAULT 0,
	`created_by` varchar(36),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `marketing_campaigns_id` PRIMARY KEY(`id`),
	CONSTRAINT `marketing_campaigns_max_recipients` CHECK(`marketing_campaigns`.`max_recipients` BETWEEN 1 AND 5000),
	CONSTRAINT `marketing_campaigns_attribution_days` CHECK(`marketing_campaigns`.`attribution_days` BETWEEN 1 AND 30)
);
--> statement-breakpoint
CREATE TABLE `mrp_corrections` (
	`id` varchar(36) NOT NULL,
	`product_id` varchar(36) NOT NULL,
	`shop_id` varchar(36),
	`claimed_mrp_paise` bigint NOT NULL,
	`note` text,
	`submitted_by` varchar(36) NOT NULL,
	`status` varchar(255) NOT NULL DEFAULT 'PENDING',
	`previous_verification_status` text,
	`decided_by` varchar(36),
	`decided_at` datetime(3),
	`decision_note` text,
	`applied_mrp_paise` bigint,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `mrp_corrections_id` PRIMARY KEY(`id`),
	CONSTRAINT `mrp_corrections_claim_non_negative` CHECK(`mrp_corrections`.`claimed_mrp_paise` >= 0)
);
--> statement-breakpoint
CREATE TABLE `notification_deliveries` (
	`id` varchar(36) NOT NULL,
	`notification_id` varchar(36),
	`user_id` varchar(36) NOT NULL,
	`type` text NOT NULL,
	`category` text NOT NULL,
	`channel` enum('IN_APP','EMAIL','SMS','PUSH','WHATSAPP') NOT NULL,
	`status` varchar(255) NOT NULL DEFAULT 'PENDING',
	`attempts` int NOT NULL DEFAULT 0,
	`max_attempts` int NOT NULL DEFAULT 4,
	`next_attempt_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`last_error` text,
	`provider_ref` text,
	`to_address` text,
	`subject` text NOT NULL,
	`body` text NOT NULL,
	`html` text,
	`action_url` text,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`sent_at` datetime(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `notification_deliveries_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `notification_preferences` (
	`id` varchar(36) NOT NULL,
	`user_id` varchar(36) NOT NULL,
	`category` varchar(255) NOT NULL,
	`channel` enum('IN_APP','EMAIL','SMS','PUSH','WHATSAPP') NOT NULL,
	`enabled` boolean NOT NULL,
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `notification_preferences_id` PRIMARY KEY(`id`),
	CONSTRAINT `notification_preferences_unique` UNIQUE(`user_id`,`category`,`channel`)
);
--> statement-breakpoint
CREATE TABLE `notifications` (
	`id` varchar(36) NOT NULL,
	`user_id` varchar(36) NOT NULL,
	`type` text NOT NULL,
	`channel` enum('IN_APP','EMAIL','SMS','PUSH','WHATSAPP') NOT NULL DEFAULT 'IN_APP',
	`title` text NOT NULL,
	`body` text NOT NULL,
	`action_url` text,
	`metadata` json,
	`read_at` datetime(3),
	`sent_at` datetime(3),
	`dedupe_key` varchar(255),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `notifications_id` PRIMARY KEY(`id`),
	CONSTRAINT `notifications_dedupe_unique` UNIQUE(`dedupe_key`)
);
--> statement-breakpoint
CREATE TABLE `order_financials` (
	`order_id` varchar(36) NOT NULL,
	`shop_id` varchar(36) NOT NULL,
	`customer_id` varchar(36) NOT NULL,
	`payment_transaction_id` varchar(36),
	`goods_paise` bigint NOT NULL,
	`discount_paise` bigint NOT NULL DEFAULT 0,
	`delivery_fee_paise` bigint NOT NULL,
	`gmv_paise` bigint NOT NULL,
	`commission_rate_bp` int NOT NULL,
	`commission_rate_id` varchar(36),
	`commission_paise` bigint NOT NULL,
	`shop_payable_paise` bigint NOT NULL,
	`delivered_at` datetime(3) NOT NULL,
	`settlement_id` varchar(36),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `order_financials_order_id` PRIMARY KEY(`order_id`)
);
--> statement-breakpoint
CREATE TABLE `order_items` (
	`id` varchar(36) NOT NULL,
	`order_id` varchar(36) NOT NULL,
	`shop_product_id` varchar(36) NOT NULL,
	`product_name_snapshot` text NOT NULL,
	`unit_snapshot` text NOT NULL,
	`unit_price_paise` bigint NOT NULL,
	`quantity_milli` int NOT NULL,
	`line_total_paise` bigint NOT NULL,
	`fulfilment_status` enum('PENDING','PICKED','SUBSTITUTION_PROPOSED','SUBSTITUTED','REMOVED') NOT NULL DEFAULT 'PENDING',
	`substitute_shop_product_id` varchar(36),
	`substitute_name_snapshot` text,
	`substitute_unit_snapshot` text,
	`substitute_quantity_milli` int,
	`substitute_line_total_paise` bigint,
	`fulfilment_note` text,
	`fulfilment_updated_at` datetime(3),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `order_items_id` PRIMARY KEY(`id`),
	CONSTRAINT `order_items_quantity_positive` CHECK(`order_items`.`quantity_milli` > 0),
	CONSTRAINT `order_items_amounts_non_negative` CHECK(`order_items`.`unit_price_paise` >= 0 AND `order_items`.`line_total_paise` >= 0)
);
--> statement-breakpoint
CREATE TABLE `order_ratings` (
	`id` varchar(36) NOT NULL,
	`order_id` varchar(36) NOT NULL,
	`target_type` enum('SHOP','DELIVERY_PARTNER') NOT NULL,
	`customer_id` varchar(36) NOT NULL,
	`shop_id` varchar(36) NOT NULL,
	`delivery_partner_id` varchar(36),
	`score` int NOT NULL,
	`comment` text,
	`status` enum('VISIBLE','HIDDEN') NOT NULL DEFAULT 'VISIBLE',
	`moderated_by` varchar(36),
	`moderated_at` datetime(3),
	`moderation_reason` text,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `order_ratings_id` PRIMARY KEY(`id`),
	CONSTRAINT `order_ratings_order_target_unique` UNIQUE(`order_id`,`target_type`),
	CONSTRAINT `order_ratings_score_range` CHECK(`order_ratings`.`score` BETWEEN 1 AND 5),
	CONSTRAINT `order_ratings_target_partner` CHECK((`order_ratings`.`target_type` = 'DELIVERY_PARTNER') = (`order_ratings`.`delivery_partner_id` IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE `order_status_history` (
	`id` varchar(36) NOT NULL,
	`order_id` varchar(36) NOT NULL,
	`previous_status` enum('PENDING','CONFIRMED','PREPARING','READY','OUT_FOR_DELIVERY','DELIVERED','CANCELLED','PAYMENT_FAILED','WALLET_INSUFFICIENT','REFUND_PENDING','REFUNDED','ACCEPTED','ASSIGNED','PICKED_UP','FAILED','RETURNED','DISPUTED'),
	`new_status` enum('PENDING','CONFIRMED','PREPARING','READY','OUT_FOR_DELIVERY','DELIVERED','CANCELLED','PAYMENT_FAILED','WALLET_INSUFFICIENT','REFUND_PENDING','REFUNDED','ACCEPTED','ASSIGNED','PICKED_UP','FAILED','RETURNED','DISPUTED') NOT NULL,
	`changed_by` varchar(36),
	`note` text,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `order_status_history_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `orders` (
	`id` varchar(36) NOT NULL,
	`order_number` varchar(255) NOT NULL,
	`user_id` varchar(36) NOT NULL,
	`shop_id` varchar(36) NOT NULL,
	`address_id` varchar(36),
	`delivery_address_snapshot` json,
	`status` enum('PENDING','CONFIRMED','PREPARING','READY','OUT_FOR_DELIVERY','DELIVERED','CANCELLED','PAYMENT_FAILED','WALLET_INSUFFICIENT','REFUND_PENDING','REFUNDED','ACCEPTED','ASSIGNED','PICKED_UP','FAILED','RETURNED','DISPUTED') NOT NULL DEFAULT 'PENDING',
	`source` enum('DIRECT','SUBSCRIPTION') NOT NULL DEFAULT 'DIRECT',
	`order_type` enum('PERSONAL','B2B') NOT NULL DEFAULT 'PERSONAL',
	`payment_method` enum('WALLET','COD') NOT NULL DEFAULT 'WALLET',
	`checkout_key` varchar(255),
	`cod_collected_at` datetime(3),
	`placed_while_closed` boolean NOT NULL DEFAULT false,
	`expected_open_at` datetime(3),
	`shop_open_alert_sent_at` datetime(3),
	`society_id` varchar(36),
	`buyer_shop_id` varchar(36),
	`subtotal_paise` bigint NOT NULL,
	`delivery_fee_paise` bigint NOT NULL DEFAULT 0,
	`tax_paise` bigint NOT NULL DEFAULT 0,
	`total_paise` bigint NOT NULL,
	`paid_at` datetime(3),
	`delivery_date` date,
	`notes` text,
	`cancellation_reason` text,
	`delivery_window` enum('EXPRESS_30','STANDARD_60','SCHEDULED'),
	`promised_by_at` datetime(3),
	`accepted_at` datetime(3),
	`packed_at` datetime(3),
	`refunded_paise` bigint NOT NULL DEFAULT 0,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `orders_id` PRIMARY KEY(`id`),
	CONSTRAINT `orders_number_unique` UNIQUE(`order_number`),
	CONSTRAINT `orders_checkout_key_unique` UNIQUE(`checkout_key`),
	CONSTRAINT `orders_totals_non_negative` CHECK(`orders`.`subtotal_paise` >= 0 AND `orders`.`total_paise` >= 0),
	CONSTRAINT `orders_buyer_shop_matches_type` CHECK((`orders`.`order_type` = 'B2B') = (`orders`.`buyer_shop_id` IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE `payments` (
	`id` varchar(36) NOT NULL,
	`user_id` varchar(36) NOT NULL,
	`gateway` varchar(255) NOT NULL DEFAULT 'CASHFREE',
	`gateway_order_id` varchar(255) NOT NULL,
	`gateway_payment_id` varchar(255),
	`gateway_signature` text,
	`amount_paise` bigint NOT NULL,
	`currency` varchar(255) NOT NULL DEFAULT 'INR',
	`status` enum('CREATED','PENDING','SUCCESS','FAILED','REFUNDED') NOT NULL DEFAULT 'CREATED',
	`purpose` varchar(255) NOT NULL DEFAULT 'WALLET_TOPUP',
	`failure_reason` text,
	`raw_payload` json,
	`voucher_code` text,
	`verified_at` datetime(3),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `payments_id` PRIMARY KEY(`id`),
	CONSTRAINT `payments_gateway_order_unique` UNIQUE(`gateway_order_id`),
	CONSTRAINT `payments_gateway_payment_unique` UNIQUE(`gateway_payment_id`),
	CONSTRAINT `payments_amount_positive` CHECK(`payments`.`amount_paise` > 0)
);
--> statement-breakpoint
CREATE TABLE `permissions` (
	`key` varchar(255) NOT NULL,
	`description` text NOT NULL,
	CONSTRAINT `permissions_key` PRIMARY KEY(`key`)
);
--> statement-breakpoint
CREATE TABLE `platform_settings` (
	`key` varchar(255) NOT NULL,
	`value` json NOT NULL,
	`updated_by` varchar(36),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `platform_settings_key` PRIMARY KEY(`key`)
);
--> statement-breakpoint
CREATE TABLE `price_update_batches` (
	`id` varchar(36) NOT NULL,
	`shop_id` varchar(36) NOT NULL,
	`source` enum('SHOP_OWNER','OPERATOR','ADMIN') NOT NULL,
	`submitted_by` varchar(36) NOT NULL,
	`excel_upload_id` varchar(36),
	`status` enum('PENDING','APPROVED','REJECTED','SUPERSEDED','CANCELLED') NOT NULL DEFAULT 'PENDING',
	`note` text,
	`decided_by` varchar(36),
	`decided_at` datetime(3),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `price_update_batches_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `price_update_requests` (
	`id` varchar(36) NOT NULL,
	`batch_id` varchar(36) NOT NULL,
	`shop_id` varchar(36) NOT NULL,
	`shop_product_id` varchar(36) NOT NULL,
	`price_type` text NOT NULL,
	`previous_price_paise` bigint,
	`proposed_price_paise` bigint NOT NULL,
	`status` enum('PENDING','APPROVED','REJECTED','SUPERSEDED','CANCELLED') NOT NULL DEFAULT 'PENDING',
	`source` enum('SHOP_OWNER','OPERATOR','ADMIN') NOT NULL,
	`submitted_by` varchar(36) NOT NULL,
	`decided_by` varchar(36),
	`decided_at` datetime(3),
	`rejection_reason` text,
	`applied_at` datetime(3),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `price_update_requests_id` PRIMARY KEY(`id`),
	CONSTRAINT `price_update_requests_price_non_negative` CHECK(`price_update_requests`.`proposed_price_paise` >= 0)
);
--> statement-breakpoint
CREATE TABLE `product_categories` (
	`id` varchar(36) NOT NULL,
	`department` enum('GROCERY_KIRANA','SUPERMARKET','CONVENIENCE_STORE','FRUIT_VEGETABLE','DAIRY','BAKERY','MEAT_SHOP','SWEET_SHOP','PHARMACY','OPTICAL_STORE','CLOTHING_STORE','FOOTWEAR_STORE','JEWELLERY_STORE','COSMETICS_BEAUTY','MOBILE_PHONE_STORE','ELECTRONICS_STORE','COMPUTER_STORE','FURNITURE_STORE','HOME_APPLIANCE_STORE','HARDWARE_STORE','PAINT_SANITARY_STORE','STATIONERY_STORE','BOOKSTORE','TOY_STORE','SPORTS_STORE','PET_STORE','AUTO_SPARE_PARTS','AUTO_ACCESSORIES','MOBILE_ELECTRONICS_REPAIR','GIFT_SHOP','FLOWER_SHOP','BUILDING_MATERIALS','ELECTRICAL_SHOP','AGRICULTURAL_SUPPLY','POULTRY_SUPPLY','RESTAURANT','FAST_FOOD','CAFE','MEDICAL_EQUIPMENT','PRINTING_PHOTOCOPY','GENERAL_TRADING','PACKAGING_MATERIALS','WHOLESALE_STORE','ONLINE_STORE') NOT NULL,
	`name` text NOT NULL,
	`slug` varchar(255) NOT NULL,
	`description` text,
	`image_url` text,
	`sort_order` int NOT NULL DEFAULT 0,
	`is_active` boolean NOT NULL DEFAULT true,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`deleted_at` datetime(3),
	CONSTRAINT `product_categories_id` PRIMARY KEY(`id`),
	CONSTRAINT `product_categories_slug_unique` UNIQUE(`slug`)
);
--> statement-breakpoint
CREATE TABLE `product_images` (
	`id` varchar(36) NOT NULL,
	`product_id` varchar(36) NOT NULL,
	`shop_product_id` varchar(36),
	`stored_image_id` varchar(36),
	`url` text NOT NULL,
	`alt_text` text,
	`is_primary` boolean NOT NULL DEFAULT false,
	`sort_order` int NOT NULL DEFAULT 0,
	`created_by` varchar(36),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`primary_product_key` varchar(36) GENERATED ALWAYS AS (CASE WHEN is_primary AND shop_product_id IS NULL THEN product_id END) VIRTUAL,
	`primary_listing_key` varchar(36) GENERATED ALWAYS AS (CASE WHEN is_primary AND shop_product_id IS NOT NULL THEN shop_product_id END) VIRTUAL,
	CONSTRAINT `product_images_id` PRIMARY KEY(`id`),
	CONSTRAINT `product_images_one_primary_product` UNIQUE(`primary_product_key`),
	CONSTRAINT `product_images_one_primary_listing` UNIQUE(`primary_listing_key`)
);
--> statement-breakpoint
CREATE TABLE `product_mrp_history` (
	`id` varchar(36) NOT NULL,
	`product_id` varchar(36) NOT NULL,
	`previous_mrp_paise` bigint,
	`new_mrp_paise` bigint NOT NULL,
	`source` enum('GS1','BRAND','ADMIN','IMPORT','API','SELLER_SUBMITTED') NOT NULL,
	`effective_from` date,
	`reason` text,
	`changed_by` varchar(36),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `product_mrp_history_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `product_price_history` (
	`id` varchar(36) NOT NULL,
	`shop_product_id` varchar(36) NOT NULL,
	`price_type` text NOT NULL,
	`previous_price_paise` bigint,
	`new_price_paise` bigint NOT NULL,
	`changed_by` varchar(36) NOT NULL,
	`reason` text,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `product_price_history_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `product_subcategories` (
	`id` varchar(36) NOT NULL,
	`category_id` varchar(36) NOT NULL,
	`name` text NOT NULL,
	`slug` varchar(255) NOT NULL,
	`sort_order` int NOT NULL DEFAULT 0,
	`is_active` boolean NOT NULL DEFAULT true,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`deleted_at` datetime(3),
	CONSTRAINT `product_subcategories_id` PRIMARY KEY(`id`),
	CONSTRAINT `product_subcategories_slug_unique` UNIQUE(`slug`)
);
--> statement-breakpoint
CREATE TABLE `products` (
	`id` varchar(36) NOT NULL,
	`category_id` varchar(36) NOT NULL,
	`code` varchar(255) NOT NULL,
	`name` varchar(255) NOT NULL,
	`slug` varchar(255) NOT NULL,
	`description` text,
	`specifications` text,
	`sub_category` text,
	`subcategory_id` varchar(36),
	`brand_id` varchar(36),
	`image_url` text,
	`kind` enum('PACKAGED','LOOSE') NOT NULL DEFAULT 'PACKAGED',
	`gtin` varchar(255),
	`barcode` varchar(255),
	`variant` text,
	`mrp_paise` bigint,
	`mrp_source` enum('GS1','BRAND','ADMIN','IMPORT','API','SELLER_SUBMITTED'),
	`mrp_effective_from` date,
	`mrp_verification_status` enum('UNVERIFIED','PENDING_VERIFICATION','VERIFIED','DISPUTED') NOT NULL DEFAULT 'UNVERIFIED',
	`mrp_updated_at` datetime(3),
	`hsn_code` text,
	`gst_rate_bp` int,
	`default_low_stock_threshold` int,
	`default_reorder_level` int,
	`default_reorder_quantity` int,
	`manufacturer_name` text,
	`manufacturer_address` text,
	`country_of_origin` text,
	`net_quantity` int,
	`net_quantity_unit` text,
	`unit` text NOT NULL,
	`unit_size_milli` int NOT NULL DEFAULT 1000,
	`subscribable` boolean NOT NULL DEFAULT false,
	`is_active` boolean NOT NULL DEFAULT true,
	`approval_status` enum('PENDING_APPROVAL','APPROVED','REJECTED') NOT NULL DEFAULT 'APPROVED',
	`created_by` varchar(36),
	`approved_by` varchar(36),
	`approved_at` datetime(3),
	`rejection_reason` text,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`deleted_at` datetime(3),
	CONSTRAINT `products_id` PRIMARY KEY(`id`),
	CONSTRAINT `products_slug_unique` UNIQUE(`slug`),
	CONSTRAINT `products_code_unique` UNIQUE(`code`),
	CONSTRAINT `products_gtin_unique` UNIQUE(`gtin`),
	CONSTRAINT `products_mrp_non_negative` CHECK(`products`.`mrp_paise` IS NULL OR `products`.`mrp_paise` >= 0),
	CONSTRAINT `products_gst_rate_sane` CHECK(`products`.`gst_rate_bp` IS NULL OR (`products`.`gst_rate_bp` >= 0 AND `products`.`gst_rate_bp` <= 10000))
);
--> statement-breakpoint
CREATE TABLE `reconciliation_records` (
	`id` varchar(36) NOT NULL,
	`entity_type` enum('PAYMENT','ORDER','SHOP','RIDER','SETTLEMENT','PAYOUT') NOT NULL,
	`entity_id` varchar(255) NOT NULL,
	`reference` text NOT NULL,
	`check_type` varchar(255) NOT NULL,
	`expected_paise` bigint,
	`actual_paise` bigint,
	`status` enum('UNMATCHED','MATCHED','PARTIAL','EXCEPTION','RECONCILED') NOT NULL,
	`detail` text,
	`last_checked_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`resolved_by` varchar(36),
	`resolved_at` datetime(3),
	`resolution_note` text,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `reconciliation_records_id` PRIMARY KEY(`id`),
	CONSTRAINT `reconciliation_entity_check_unique` UNIQUE(`entity_type`,`entity_id`,`check_type`)
);
--> statement-breakpoint
CREATE TABLE `referral_codes` (
	`id` varchar(36) NOT NULL,
	`code` varchar(255) NOT NULL,
	`label` text,
	`referrer_name` text,
	`referrer_user_id` varchar(36),
	`status` enum('ACTIVE','INACTIVE','EXPIRED') NOT NULL DEFAULT 'ACTIVE',
	`expires_at` date,
	`note` text,
	`created_by` varchar(36) NOT NULL,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `referral_codes_id` PRIMARY KEY(`id`),
	CONSTRAINT `referral_codes_code_unique` UNIQUE(`code`)
);
--> statement-breakpoint
CREATE TABLE `referral_redemptions` (
	`id` varchar(36) NOT NULL,
	`referral_code_id` varchar(36) NOT NULL,
	`shop_id` varchar(36) NOT NULL,
	`registration_fee_paise` bigint,
	`redeemed_by` varchar(36),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `referral_redemptions_id` PRIMARY KEY(`id`),
	CONSTRAINT `referral_redemptions_shop_unique` UNIQUE(`shop_id`)
);
--> statement-breakpoint
CREATE TABLE `registration_fee_history` (
	`id` varchar(36) NOT NULL,
	`registration_fee_id` varchar(36) NOT NULL,
	`previous_amount_paise` bigint,
	`new_amount_paise` bigint NOT NULL,
	`effective_from` date NOT NULL,
	`changed_by` varchar(36) NOT NULL,
	`reason` text,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `registration_fee_history_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `registration_fees` (
	`id` varchar(36) NOT NULL,
	`amount_paise` bigint NOT NULL,
	`currency` varchar(255) NOT NULL DEFAULT 'INR',
	`effective_from` date NOT NULL,
	`is_active` boolean NOT NULL DEFAULT true,
	`note` text,
	`created_by` varchar(36),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `registration_fees_id` PRIMARY KEY(`id`),
	CONSTRAINT `registration_fees_amount_non_negative` CHECK(`registration_fees`.`amount_paise` >= 0)
);
--> statement-breakpoint
CREATE TABLE `registration_locks` (
	`name` varchar(191) NOT NULL,
	CONSTRAINT `registration_locks_name` PRIMARY KEY(`name`)
);
--> statement-breakpoint
CREATE TABLE `return_items` (
	`id` varchar(36) NOT NULL,
	`return_id` varchar(36) NOT NULL,
	`order_item_id` varchar(36) NOT NULL,
	`quantity_milli` int NOT NULL,
	`condition` text NOT NULL,
	`comment` text,
	`image_ids` json NOT NULL DEFAULT ('[]'),
	`refund_paise` bigint NOT NULL,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `return_items_id` PRIMARY KEY(`id`),
	CONSTRAINT `return_items_quantity_positive` CHECK(`return_items`.`quantity_milli` > 0)
);
--> statement-breakpoint
CREATE TABLE `return_pickups` (
	`id` varchar(36) NOT NULL,
	`return_id` varchar(36) NOT NULL,
	`delivery_partner_id` varchar(36),
	`status` varchar(255) NOT NULL DEFAULT 'PENDING',
	`scheduled_for` datetime(3),
	`handover_code` text NOT NULL,
	`handover_attempts` int NOT NULL DEFAULT 0,
	`offered_at` datetime(3),
	`accepted_at` datetime(3),
	`en_route_at` datetime(3),
	`picked_up_at` datetime(3),
	`failed_at` datetime(3),
	`failure_reason` text,
	`rejected_partner_ids` json NOT NULL DEFAULT ('[]'),
	`attempts` int NOT NULL DEFAULT 0,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`live_return_key` varchar(36) GENERATED ALWAYS AS (CASE WHEN status IN ('PENDING','OFFERED','ACCEPTED','EN_ROUTE') THEN return_id END) VIRTUAL,
	CONSTRAINT `return_pickups_id` PRIMARY KEY(`id`),
	CONSTRAINT `return_pickups_one_live` UNIQUE(`live_return_key`)
);
--> statement-breakpoint
CREATE TABLE `return_requests` (
	`id` varchar(36) NOT NULL,
	`return_number` varchar(255) NOT NULL,
	`order_id` varchar(36) NOT NULL,
	`user_id` varchar(36) NOT NULL,
	`shop_id` varchar(36) NOT NULL,
	`status` varchar(255) NOT NULL DEFAULT 'RETURN_REQUESTED',
	`reason` text NOT NULL,
	`comment` text,
	`refund_amount_paise` bigint NOT NULL,
	`charge_to` text NOT NULL,
	`pickup_required` boolean NOT NULL DEFAULT true,
	`pickup_address` json,
	`refunded_paise` bigint,
	`refund_adjustment_id` varchar(36),
	`decided_by` varchar(36),
	`decided_at` datetime(3),
	`decision_note` text,
	`inspected_by` varchar(36),
	`inspected_at` datetime(3),
	`inspection_note` text,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `return_requests_id` PRIMARY KEY(`id`),
	CONSTRAINT `return_requests_number_unique` UNIQUE(`return_number`),
	CONSTRAINT `return_requests_refund_non_negative` CHECK(`return_requests`.`refund_amount_paise` >= 0)
);
--> statement-breakpoint
CREATE TABLE `return_status_history` (
	`id` varchar(36) NOT NULL,
	`return_id` varchar(36) NOT NULL,
	`from_status` text,
	`to_status` text NOT NULL,
	`changed_by` varchar(36),
	`changed_by_role` text,
	`note` text,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `return_status_history_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `rider_earning_slots` (
	`id` varchar(36) NOT NULL,
	`name` text NOT NULL,
	`start_time` text NOT NULL,
	`end_time` text NOT NULL,
	`days_of_week` json NOT NULL DEFAULT ('[]'),
	`base_fee_paise` bigint,
	`per_km_fee_paise` bigint,
	`min_earning_paise` bigint,
	`order_fee_paise` bigint NOT NULL DEFAULT 0,
	`order_percent_bp` int NOT NULL DEFAULT 0,
	`peak_bonus_paise` bigint NOT NULL DEFAULT 0,
	`is_peak` boolean NOT NULL DEFAULT false,
	`priority` int NOT NULL DEFAULT 0,
	`valid_from` date,
	`valid_to` date,
	`is_active` boolean NOT NULL DEFAULT true,
	`created_by` varchar(36),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `rider_earning_slots_id` PRIMARY KEY(`id`),
	CONSTRAINT `rider_slots_percent_range` CHECK(`rider_earning_slots`.`order_percent_bp` BETWEEN 0 AND 10000),
	CONSTRAINT `rider_slots_amounts_non_negative` CHECK(`rider_earning_slots`.`order_fee_paise` >= 0 AND `rider_earning_slots`.`peak_bonus_paise` >= 0
          AND (`rider_earning_slots`.`base_fee_paise` IS NULL OR `rider_earning_slots`.`base_fee_paise` >= 0)
          AND (`rider_earning_slots`.`per_km_fee_paise` IS NULL OR `rider_earning_slots`.`per_km_fee_paise` >= 0)
          AND (`rider_earning_slots`.`min_earning_paise` IS NULL OR `rider_earning_slots`.`min_earning_paise` >= 0))
);
--> statement-breakpoint
CREATE TABLE `rider_earnings_ledger` (
	`id` varchar(36) NOT NULL,
	`delivery_partner_id` varchar(36) NOT NULL,
	`earning_id` varchar(36) NOT NULL,
	`delivery_order_id` varchar(36),
	`component` text NOT NULL,
	`amount_paise` bigint NOT NULL,
	`description` text NOT NULL,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `rider_earnings_ledger_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `rider_incentive_awards` (
	`id` varchar(36) NOT NULL,
	`rule_id` varchar(36) NOT NULL,
	`delivery_partner_id` varchar(36) NOT NULL,
	`earning_id` varchar(36),
	`period_key` varchar(255) NOT NULL,
	`amount_paise` bigint NOT NULL,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `rider_incentive_awards_id` PRIMARY KEY(`id`),
	CONSTRAINT `rider_incentive_awards_unique` UNIQUE(`rule_id`,`delivery_partner_id`,`period_key`)
);
--> statement-breakpoint
CREATE TABLE `rider_incentive_rules` (
	`id` varchar(36) NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`type` text NOT NULL,
	`threshold_value` int NOT NULL DEFAULT 0,
	`reward_paise` bigint NOT NULL,
	`period` varchar(255) NOT NULL DEFAULT 'DAY',
	`start_time` text,
	`end_time` text,
	`days_of_week` json NOT NULL DEFAULT ('[]'),
	`valid_from` date,
	`valid_to` date,
	`is_active` boolean NOT NULL DEFAULT true,
	`created_by` varchar(36),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `rider_incentive_rules_id` PRIMARY KEY(`id`),
	CONSTRAINT `rider_incentive_reward_positive` CHECK(`rider_incentive_rules`.`reward_paise` > 0)
);
--> statement-breakpoint
CREATE TABLE `rider_payouts` (
	`id` varchar(36) NOT NULL,
	`delivery_partner_id` varchar(36) NOT NULL,
	`period_start` date NOT NULL,
	`period_end` date NOT NULL,
	`earnings_count` int NOT NULL,
	`gross_paise` bigint NOT NULL,
	`adjustments_paise` bigint NOT NULL,
	`amount_paise` bigint NOT NULL,
	`status` enum('PENDING','ELIGIBLE','PROCESSING','PAID','FAILED','REVERSED','CANCELLED') NOT NULL DEFAULT 'PENDING',
	`payment_reference` text,
	`failure_reason` text,
	`approved_by` varchar(36),
	`approved_at` datetime(3),
	`processing_at` datetime(3),
	`paid_by` varchar(36),
	`paid_at` datetime(3),
	`failed_at` datetime(3),
	`reversed_at` datetime(3),
	`created_by` varchar(36),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `rider_payouts_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `rider_searches` (
	`id` varchar(36) NOT NULL,
	`order_id` varchar(36) NOT NULL,
	`status` varchar(255) NOT NULL DEFAULT 'SEARCHING',
	`stop_reason` text,
	`attempts` int NOT NULL DEFAULT 0,
	`max_attempts` int NOT NULL,
	`started_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`last_attempt_at` datetime(3),
	`next_attempt_at` datetime(3),
	`stopped_at` datetime(3),
	`started_by` varchar(36),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `rider_searches_id` PRIMARY KEY(`id`),
	CONSTRAINT `rider_searches_order_unique` UNIQUE(`order_id`)
);
--> statement-breakpoint
CREATE TABLE `risk_flags` (
	`id` varchar(36) NOT NULL,
	`subject_type` enum('USER','SHOP','DELIVERY_PARTNER') NOT NULL,
	`subject_id` varchar(36) NOT NULL,
	`rule_code` varchar(255) NOT NULL,
	`severity` enum('LOW','MEDIUM','HIGH') NOT NULL,
	`status` enum('OPEN','DISMISSED','ACTIONED') NOT NULL DEFAULT 'OPEN',
	`summary` text NOT NULL,
	`details` json,
	`occurrences` int NOT NULL DEFAULT 1,
	`first_detected_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`last_detected_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`reviewed_by` varchar(36),
	`reviewed_at` datetime(3),
	`review_note` text,
	`open_flag_key` varchar(600) GENERATED ALWAYS AS (CASE WHEN status = 'OPEN' THEN CONCAT(subject_type,':',subject_id,':',rule_code) END) VIRTUAL,
	CONSTRAINT `risk_flags_id` PRIMARY KEY(`id`),
	CONSTRAINT `risk_flags_open_unique` UNIQUE(`open_flag_key`)
);
--> statement-breakpoint
CREATE TABLE `role_permissions` (
	`role_key` enum('CUSTOMER','SHOP_OWNER','OPERATOR','ADMIN','DELIVERY_PARTNER','SOCIETY_ADMIN') NOT NULL,
	`permission_key` varchar(255) NOT NULL,
	CONSTRAINT `role_permissions_role_key_permission_key_pk` PRIMARY KEY(`role_key`,`permission_key`)
);
--> statement-breakpoint
CREATE TABLE `roles` (
	`key` enum('CUSTOMER','SHOP_OWNER','OPERATOR','ADMIN','DELIVERY_PARTNER','SOCIETY_ADMIN') NOT NULL,
	`label` text NOT NULL,
	`description` text,
	CONSTRAINT `roles_key` PRIMARY KEY(`key`)
);
--> statement-breakpoint
CREATE TABLE `sessions` (
	`session_token` varchar(255) NOT NULL,
	`user_id` varchar(36) NOT NULL,
	`expires` timestamp(3) NOT NULL,
	CONSTRAINT `sessions_session_token` PRIMARY KEY(`session_token`)
);
--> statement-breakpoint
CREATE TABLE `shop_categories` (
	`id` varchar(36) NOT NULL,
	`name` varchar(255) NOT NULL,
	`slug` varchar(255) NOT NULL,
	`description` text,
	`status` varchar(255) NOT NULL DEFAULT 'ACTIVE',
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `shop_categories_id` PRIMARY KEY(`id`),
	CONSTRAINT `shop_categories_slug_unique` UNIQUE(`slug`),
	CONSTRAINT `shop_categories_name_unique` UNIQUE(`name`)
);
--> statement-breakpoint
CREATE TABLE `shop_category_mapping` (
	`id` varchar(36) NOT NULL,
	`shop_id` varchar(36) NOT NULL,
	`category_id` varchar(36) NOT NULL,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `shop_category_mapping_id` PRIMARY KEY(`id`),
	CONSTRAINT `shop_category_mapping_unique` UNIQUE(`shop_id`,`category_id`)
);
--> statement-breakpoint
CREATE TABLE `shop_classification_history` (
	`id` varchar(36) NOT NULL,
	`shop_id` varchar(36) NOT NULL,
	`previous_value` enum('KESARI','GREEN'),
	`new_value` enum('KESARI','GREEN') NOT NULL,
	`changed_by` varchar(36) NOT NULL,
	`reason` text,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `shop_classification_history_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `shop_payments` (
	`id` varchar(36) NOT NULL,
	`reference` varchar(255) NOT NULL,
	`shop_id` varchar(36) NOT NULL,
	`owner_id` varchar(36) NOT NULL,
	`payment_type` enum('REGISTRATION_FEE','RENEWAL','ADJUSTMENT','REFUND','REVERSAL') NOT NULL,
	`amount_paise` bigint NOT NULL,
	`currency` varchar(255) NOT NULL DEFAULT 'INR',
	`method` enum('CASH','UPI','BANK_TRANSFER','CARD','CHEQUE','RAZORPAY','OTHER') NOT NULL DEFAULT 'CASH',
	`transaction_id` text,
	`fee_snapshot_paise` bigint,
	`paid_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`note` text,
	`receipt_url` text,
	`reversal_of_id` varchar(36),
	`recorded_by` varchar(36) NOT NULL,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `shop_payments_id` PRIMARY KEY(`id`),
	CONSTRAINT `shop_payments_reference_unique` UNIQUE(`reference`),
	CONSTRAINT `shop_payments_amount_non_zero` CHECK(`shop_payments`.`amount_paise` <> 0)
);
--> statement-breakpoint
CREATE TABLE `shop_products` (
	`id` varchar(36) NOT NULL,
	`shop_id` varchar(36) NOT NULL,
	`product_id` varchar(36) NOT NULL,
	`description` text,
	`image_url` text,
	`online_price_paise` bigint,
	`offline_price_paise` bigint,
	`online_sale_enabled` boolean NOT NULL DEFAULT false,
	`offline_sale_enabled` boolean NOT NULL DEFAULT false,
	`track_inventory` boolean NOT NULL DEFAULT true,
	`online_stock` int NOT NULL DEFAULT 0,
	`offline_stock` int NOT NULL DEFAULT 0,
	`low_stock_threshold` int NOT NULL DEFAULT 0,
	`reorder_level` int,
	`reorder_quantity` int,
	`minimum_order_quantity` int NOT NULL DEFAULT 1,
	`maximum_order_quantity` int,
	`stock_alerts_disabled` boolean NOT NULL DEFAULT false,
	`is_active` boolean NOT NULL DEFAULT true,
	`is_available` boolean NOT NULL DEFAULT true,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`deleted_at` datetime(3),
	CONSTRAINT `shop_products_id` PRIMARY KEY(`id`),
	CONSTRAINT `shop_products_shop_product_unique` UNIQUE(`shop_id`,`product_id`),
	CONSTRAINT `shop_products_online_requires_price` CHECK((`shop_products`.`online_sale_enabled` = false) OR (`shop_products`.`online_price_paise` IS NOT NULL)),
	CONSTRAINT `shop_products_offline_requires_price` CHECK((`shop_products`.`offline_sale_enabled` = false) OR (`shop_products`.`offline_price_paise` IS NOT NULL)),
	CONSTRAINT `shop_products_prices_non_negative` CHECK((`shop_products`.`online_price_paise` IS NULL OR `shop_products`.`online_price_paise` >= 0)
          AND (`shop_products`.`offline_price_paise` IS NULL OR `shop_products`.`offline_price_paise` >= 0)),
	CONSTRAINT `shop_products_stock_non_negative` CHECK(`shop_products`.`online_stock` >= 0 AND `shop_products`.`offline_stock` >= 0),
	CONSTRAINT `shop_products_thresholds_non_negative` CHECK(`shop_products`.`low_stock_threshold` >= 0
          AND (`shop_products`.`reorder_level` IS NULL OR `shop_products`.`reorder_level` >= 0)
          AND (`shop_products`.`reorder_quantity` IS NULL OR `shop_products`.`reorder_quantity` > 0)
          AND `shop_products`.`minimum_order_quantity` > 0
          AND (`shop_products`.`maximum_order_quantity` IS NULL OR `shop_products`.`maximum_order_quantity` >= `shop_products`.`minimum_order_quantity`))
);
--> statement-breakpoint
CREATE TABLE `shop_settlements` (
	`id` varchar(36) NOT NULL,
	`shop_id` varchar(36) NOT NULL,
	`period_start` date NOT NULL,
	`period_end` date NOT NULL,
	`order_count` int NOT NULL,
	`goods_paise` bigint NOT NULL,
	`commission_paise` bigint NOT NULL,
	`refunds_paise` bigint NOT NULL,
	`adjustments_paise` bigint NOT NULL,
	`net_payable_paise` bigint NOT NULL,
	`status` enum('PENDING','ELIGIBLE','PROCESSING','PAID','FAILED','REVERSED','CANCELLED') NOT NULL DEFAULT 'PENDING',
	`payment_reference` text,
	`failure_reason` text,
	`approved_by` varchar(36),
	`approved_at` datetime(3),
	`processing_at` datetime(3),
	`paid_by` varchar(36),
	`paid_at` datetime(3),
	`failed_at` datetime(3),
	`reversed_at` datetime(3),
	`created_by` varchar(36),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `shop_settlements_id` PRIMARY KEY(`id`),
	CONSTRAINT `shop_settlements_period` CHECK(`shop_settlements`.`period_end` > `shop_settlements`.`period_start`)
);
--> statement-breakpoint
CREATE TABLE `shop_suspension_orders` (
	`id` varchar(36) NOT NULL,
	`suspension_id` varchar(36) NOT NULL,
	`order_id` varchar(36) NOT NULL,
	`status_at_suspension` text NOT NULL,
	`planned_action` text NOT NULL,
	`outcome` varchar(255) NOT NULL,
	`note` text,
	`resolved_by` varchar(36),
	`resolved_at` datetime(3),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `shop_suspension_orders_id` PRIMARY KEY(`id`),
	CONSTRAINT `shop_suspension_orders_unique` UNIQUE(`suspension_id`,`order_id`)
);
--> statement-breakpoint
CREATE TABLE `shop_suspensions` (
	`id` varchar(36) NOT NULL,
	`shop_id` varchar(36) NOT NULL,
	`reason` text NOT NULL,
	`expected_action` text NOT NULL,
	`suspended_by` varchar(36),
	`effective_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`status` varchar(255) NOT NULL DEFAULT 'ACTIVE',
	`lifted_at` datetime(3),
	`lifted_by` varchar(36),
	`lift_note` text,
	`policy` json NOT NULL DEFAULT ('{}'),
	`impact` json NOT NULL DEFAULT ('{}'),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`active_shop_key` varchar(36) GENERATED ALWAYS AS (CASE WHEN status = 'ACTIVE' THEN shop_id END) VIRTUAL,
	CONSTRAINT `shop_suspensions_id` PRIMARY KEY(`id`),
	CONSTRAINT `shop_suspensions_one_active` UNIQUE(`active_shop_key`)
);
--> statement-breakpoint
CREATE TABLE `shops` (
	`id` varchar(36) NOT NULL,
	`owner_id` varchar(36) NOT NULL,
	`name` text NOT NULL,
	`slug` varchar(255) NOT NULL,
	`owner_name` text NOT NULL,
	`phone` text NOT NULL,
	`email` text,
	`address_line1` text NOT NULL,
	`address_line2` text,
	`area` text,
	`city` varchar(255) NOT NULL,
	`state` text,
	`pincode` varchar(255) NOT NULL,
	`latitude` text,
	`longitude` text,
	`shop_type` enum('GROCERY_KIRANA','SUPERMARKET','CONVENIENCE_STORE','FRUIT_VEGETABLE','DAIRY','BAKERY','MEAT_SHOP','SWEET_SHOP','PHARMACY','OPTICAL_STORE','CLOTHING_STORE','FOOTWEAR_STORE','JEWELLERY_STORE','COSMETICS_BEAUTY','MOBILE_PHONE_STORE','ELECTRONICS_STORE','COMPUTER_STORE','FURNITURE_STORE','HOME_APPLIANCE_STORE','HARDWARE_STORE','PAINT_SANITARY_STORE','STATIONERY_STORE','BOOKSTORE','TOY_STORE','SPORTS_STORE','PET_STORE','AUTO_SPARE_PARTS','AUTO_ACCESSORIES','MOBILE_ELECTRONICS_REPAIR','GIFT_SHOP','FLOWER_SHOP','BUILDING_MATERIALS','ELECTRICAL_SHOP','AGRICULTURAL_SUPPLY','POULTRY_SUPPLY','RESTAURANT','FAST_FOOD','CAFE','MEDICAL_EQUIPMENT','PRINTING_PHOTOCOPY','GENERAL_TRADING','PACKAGING_MATERIALS','WHOLESALE_STORE','ONLINE_STORE') NOT NULL,
	`status` enum('PENDING_APPROVAL','APPROVED','REJECTED','SUSPENDED','INACTIVE') NOT NULL DEFAULT 'PENDING_APPROVAL',
	`classification` enum('KESARI','GREEN'),
	`logo_url` text,
	`photos` json NOT NULL DEFAULT ('[]'),
	`opening_hours` json NOT NULL DEFAULT ('[]'),
	`delivery_available` boolean NOT NULL DEFAULT false,
	`cod_enabled` boolean NOT NULL DEFAULT false,
	`service_radius_km` int NOT NULL DEFAULT 5,
	`delivery_pincodes` json NOT NULL DEFAULT ('[]'),
	`default_low_stock_threshold` int NOT NULL DEFAULT 0,
	`default_reorder_level` int,
	`default_reorder_quantity` int,
	`min_order_paise` bigint NOT NULL DEFAULT 0,
	`orders_paused` boolean NOT NULL DEFAULT false,
	`rating_avg_x100` int NOT NULL DEFAULT 0,
	`rating_count` int NOT NULL DEFAULT 0,
	`delivery_fee_paise` bigint NOT NULL DEFAULT 0,
	`free_delivery_above_paise` bigint,
	`preparation_time_minutes` int NOT NULL DEFAULT 15,
	`description` text,
	`rejection_reason` text,
	`approved_at` datetime(3),
	`approved_by` varchar(36),
	`registration_number` varchar(255) NOT NULL,
	`registration_date` date,
	`registration_fee_paise` bigint,
	`registration_fee_id` varchar(36),
	`referral_code_id` varchar(36),
	`fee_payment_status` enum('PENDING','PARTIALLY_PAID','PAID','REFUNDED','CANCELLED') NOT NULL DEFAULT 'PENDING',
	`amount_paid_paise` bigint NOT NULL DEFAULT 0,
	`legal_business_name` text,
	`gstin` text,
	`fssai_license_number` text,
	`gst_status` enum('UNKNOWN','NOT_REGISTERED','PENDING_VERIFICATION','REGISTERED','COMPOSITION','VERIFICATION_FAILED') NOT NULL DEFAULT 'UNKNOWN',
	`gst_trade_name` text,
	`gst_verification_source` enum('PROVIDER_VERIFIED','SELF_DECLARED','ADMIN_VERIFIED'),
	`gst_verified_at` datetime(3),
	`gst_verified_by` varchar(36),
	`pan_status` enum('UNKNOWN','PENDING_VERIFICATION','VERIFIED','VERIFICATION_FAILED') NOT NULL DEFAULT 'UNKNOWN',
	`pan_number_encrypted` text,
	`pan_last4` text,
	`pan_holder_name` text,
	`pan_verification_source` enum('PROVIDER_VERIFIED','SELF_DECLARED','ADMIN_VERIFIED'),
	`pan_verified_at` datetime(3),
	`pan_verified_by` varchar(36),
	`pan_hash` varchar(255),
	`shop_act_number` text,
	`shop_act_key` varchar(255),
	`udyam_number` varchar(255),
	`return_policy_text` text,
	`pickup_latitude` text,
	`pickup_longitude` text,
	`pickup_instructions` text,
	`landmark` text,
	`location_verified` boolean NOT NULL DEFAULT false,
	`location_verified_at` datetime(3),
	`location_source` text,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`deleted_at` datetime(3),
	`shop_act_active_key` varchar(255) GENERATED ALWAYS AS (CASE WHEN shop_act_key IS NOT NULL AND deleted_at IS NULL AND status <> 'REJECTED' THEN shop_act_key END) VIRTUAL,
	CONSTRAINT `shops_id` PRIMARY KEY(`id`),
	CONSTRAINT `shops_slug_unique` UNIQUE(`slug`),
	CONSTRAINT `shops_registration_number_unique` UNIQUE(`registration_number`),
	CONSTRAINT `shops_shop_act_key_active_unique` UNIQUE(`shop_act_active_key`),
	CONSTRAINT `shops_shop_act_key_with_number` CHECK((`shops`.`shop_act_number` IS NULL) = (`shops`.`shop_act_key` IS NULL)),
	CONSTRAINT `shops_delivery_fee_non_negative` CHECK(`shops`.`delivery_fee_paise` >= 0),
	CONSTRAINT `shops_min_order_non_negative` CHECK(`shops`.`min_order_paise` >= 0),
	CONSTRAINT `shops_service_radius_range` CHECK(`shops`.`service_radius_km` BETWEEN 1 AND 50),
	CONSTRAINT `shops_registration_amounts_non_negative` CHECK((`shops`.`registration_fee_paise` IS NULL OR `shops`.`registration_fee_paise` >= 0)
          AND `shops`.`amount_paid_paise` >= 0)
);
--> statement-breakpoint
CREATE TABLE `societies` (
	`id` varchar(36) NOT NULL,
	`name` text NOT NULL,
	`slug` varchar(255) NOT NULL,
	`address_line1` text NOT NULL,
	`area` text,
	`city` text NOT NULL,
	`pincode` varchar(255) NOT NULL,
	`latitude` text,
	`longitude` text,
	`boundary_radius_meters` int NOT NULL DEFAULT 300,
	`status` enum('APPLIED','VERIFIED','REJECTED','SUSPENDED') NOT NULL DEFAULT 'APPLIED',
	`delivery_instructions` text,
	`security_notify_enabled` boolean NOT NULL DEFAULT false,
	`gate_entry_mode` varchar(255) NOT NULL DEFAULT 'OPEN',
	`gate_contact_name` text,
	`gate_contact_phone` text,
	`share_gate_contact_with_rider` boolean NOT NULL DEFAULT false,
	`notify_customer_at_gate` boolean NOT NULL DEFAULT true,
	`exclusive_riders` boolean NOT NULL DEFAULT false,
	`registered_by` varchar(36),
	`verified_by` varchar(36),
	`verified_at` datetime(3),
	`rejection_reason` text,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`deleted_at` datetime(3),
	CONSTRAINT `societies_id` PRIMARY KEY(`id`),
	CONSTRAINT `societies_slug_unique` UNIQUE(`slug`),
	CONSTRAINT `societies_boundary_range` CHECK(`societies`.`boundary_radius_meters` BETWEEN 50 AND 3000)
);
--> statement-breakpoint
CREATE TABLE `society_members` (
	`id` varchar(36) NOT NULL,
	`society_id` varchar(36) NOT NULL,
	`user_id` varchar(36) NOT NULL,
	`role` enum('ADMIN','OPERATOR','RESIDENT') NOT NULL DEFAULT 'RESIDENT',
	`status` enum('PENDING','ACTIVE','REMOVED') NOT NULL DEFAULT 'PENDING',
	`unit_label` text,
	`approved_by` varchar(36),
	`approved_at` datetime(3),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `society_members_id` PRIMARY KEY(`id`),
	CONSTRAINT `society_members_unique` UNIQUE(`society_id`,`user_id`)
);
--> statement-breakpoint
CREATE TABLE `society_riders` (
	`id` varchar(36) NOT NULL,
	`society_id` varchar(36) NOT NULL,
	`delivery_partner_id` varchar(36) NOT NULL,
	`status` enum('ACTIVE','REVOKED') NOT NULL DEFAULT 'ACTIVE',
	`preferred` boolean NOT NULL DEFAULT false,
	`added_by` varchar(36),
	`revoked_by` varchar(36),
	`revoked_at` datetime(3),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `society_riders_id` PRIMARY KEY(`id`),
	CONSTRAINT `society_riders_unique` UNIQUE(`society_id`,`delivery_partner_id`)
);
--> statement-breakpoint
CREATE TABLE `society_shops` (
	`id` varchar(36) NOT NULL,
	`society_id` varchar(36) NOT NULL,
	`shop_id` varchar(36) NOT NULL,
	`status` enum('ACTIVE','REVOKED') NOT NULL DEFAULT 'ACTIVE',
	`added_by` varchar(36),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `society_shops_id` PRIMARY KEY(`id`),
	CONSTRAINT `society_shops_unique` UNIQUE(`society_id`,`shop_id`)
);
--> statement-breakpoint
CREATE TABLE `stock_alerts` (
	`id` varchar(36) NOT NULL,
	`shop_product_id` varchar(36) NOT NULL,
	`shop_id` varchar(36) NOT NULL,
	`alert_type` enum('LOW_STOCK','OUT_OF_STOCK','REORDER') NOT NULL,
	`status` enum('OPEN','ACKNOWLEDGED','RESOLVED') NOT NULL DEFAULT 'OPEN',
	`stock_at_alert` int NOT NULL,
	`threshold_at_alert` int NOT NULL,
	`acknowledged_by` varchar(36),
	`acknowledged_at` datetime(3),
	`resolved_at` datetime(3),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`open_alert_key` varchar(600) GENERATED ALWAYS AS (CASE WHEN status = 'OPEN' THEN CONCAT(shop_product_id,':',alert_type) END) VIRTUAL,
	CONSTRAINT `stock_alerts_id` PRIMARY KEY(`id`),
	CONSTRAINT `stock_alerts_open_unique` UNIQUE(`open_alert_key`)
);
--> statement-breakpoint
CREATE TABLE `stored_images` (
	`id` varchar(36) NOT NULL,
	`owner_id` varchar(36),
	`purpose` text NOT NULL,
	`content_type` text NOT NULL,
	`size_bytes` int NOT NULL,
	`width` int NOT NULL,
	`height` int NOT NULL,
	`sha256` varchar(255) NOT NULL,
	`data` longblob NOT NULL,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `stored_images_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `subscription_daily_overrides` (
	`id` varchar(36) NOT NULL,
	`subscription_id` varchar(36) NOT NULL,
	`delivery_date` date NOT NULL,
	`type` enum('QUANTITY','SKIP') NOT NULL,
	`quantity_milli` int,
	`created_by` varchar(36),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `subscription_daily_overrides_id` PRIMARY KEY(`id`),
	CONSTRAINT `sub_override_sub_date_unique` UNIQUE(`subscription_id`,`delivery_date`),
	CONSTRAINT `sub_override_quantity_matches_type` CHECK((`subscription_daily_overrides`.`type` = 'SKIP' AND `subscription_daily_overrides`.`quantity_milli` IS NULL)
          OR (`subscription_daily_overrides`.`type` = 'QUANTITY' AND `subscription_daily_overrides`.`quantity_milli` IS NOT NULL AND `subscription_daily_overrides`.`quantity_milli` > 0))
);
--> statement-breakpoint
CREATE TABLE `subscription_events` (
	`id` varchar(36) NOT NULL,
	`subscription_id` varchar(36) NOT NULL,
	`action` text NOT NULL,
	`from_status` enum('ACTIVE','PAUSED','CANCELLED','COMPLETED','PAYMENT_PENDING'),
	`to_status` enum('ACTIVE','PAUSED','CANCELLED','COMPLETED','PAYMENT_PENDING'),
	`note` text,
	`actor_id` varchar(36),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `subscription_events_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `subscription_orders` (
	`id` varchar(36) NOT NULL,
	`subscription_id` varchar(36) NOT NULL,
	`order_id` varchar(36),
	`delivery_date` date NOT NULL,
	`quantity_milli` int NOT NULL,
	`unit_price_paise` bigint NOT NULL,
	`total_paise` bigint NOT NULL,
	`status` enum('PENDING','CONFIRMED','PREPARING','READY','OUT_FOR_DELIVERY','DELIVERED','CANCELLED','PAYMENT_FAILED','WALLET_INSUFFICIENT','REFUND_PENDING','REFUNDED','ACCEPTED','ASSIGNED','PICKED_UP','FAILED','RETURNED','DISPUTED') NOT NULL DEFAULT 'PENDING',
	`failure_reason` text,
	`generated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `subscription_orders_id` PRIMARY KEY(`id`),
	CONSTRAINT `subscription_orders_sub_date_unique` UNIQUE(`subscription_id`,`delivery_date`)
);
--> statement-breakpoint
CREATE TABLE `subscriptions` (
	`id` varchar(36) NOT NULL,
	`user_id` varchar(36) NOT NULL,
	`shop_id` varchar(36) NOT NULL,
	`shop_product_id` varchar(36) NOT NULL,
	`address_id` varchar(36),
	`quantity_milli` int NOT NULL,
	`frequency` enum('DAILY','WEEKLY') NOT NULL DEFAULT 'DAILY',
	`weekdays` json NOT NULL DEFAULT ('[]'),
	`start_date` date NOT NULL,
	`end_date` date,
	`next_delivery_date` date,
	`status` enum('ACTIVE','PAUSED','CANCELLED','COMPLETED','PAYMENT_PENDING') NOT NULL DEFAULT 'ACTIVE',
	`pause_from` date,
	`pause_until` date,
	`cancelled_at` datetime(3),
	`cancellation_reason` text,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `subscriptions_id` PRIMARY KEY(`id`),
	CONSTRAINT `subscriptions_quantity_positive` CHECK(`subscriptions`.`quantity_milli` > 0),
	CONSTRAINT `subscriptions_pause_window_valid` CHECK((`subscriptions`.`pause_from` IS NULL AND `subscriptions`.`pause_until` IS NULL)
          OR (`subscriptions`.`pause_from` IS NOT NULL AND `subscriptions`.`pause_until` IS NOT NULL AND `subscriptions`.`pause_until` >= `subscriptions`.`pause_from`))
);
--> statement-breakpoint
CREATE TABLE `user_consents` (
	`id` varchar(36) NOT NULL,
	`user_id` varchar(36) NOT NULL,
	`consent_type` enum('TERMS_AND_PRIVACY','MARKETING_COMMUNICATIONS') NOT NULL,
	`version` text NOT NULL,
	`granted` boolean NOT NULL DEFAULT true,
	`ip_address` text,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `user_consents_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `user_role_grants` (
	`id` varchar(36) NOT NULL,
	`user_id` varchar(36) NOT NULL,
	`role` enum('CUSTOMER','SHOP_OWNER','OPERATOR','ADMIN','DELIVERY_PARTNER','SOCIETY_ADMIN') NOT NULL,
	`status` enum('ACTIVE','REVOKED') NOT NULL DEFAULT 'ACTIVE',
	`source` text NOT NULL,
	`granted_by` varchar(36),
	`granted_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`revoked_by` varchar(36),
	`revoked_at` datetime(3),
	CONSTRAINT `user_role_grants_id` PRIMARY KEY(`id`),
	CONSTRAINT `user_role_grants_user_role_unique` UNIQUE(`user_id`,`role`)
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` varchar(36) NOT NULL,
	`name` text,
	`email` varchar(255) NOT NULL,
	`email_verified` timestamp(3),
	`image` text,
	`phone` text,
	`phone_e164` varchar(255),
	`phone_verified_at` datetime(3),
	`role` enum('CUSTOMER','SHOP_OWNER','OPERATOR','ADMIN','DELIVERY_PARTNER','SOCIETY_ADMIN') NOT NULL DEFAULT 'CUSTOMER',
	`status` enum('ACTIVE','SUSPENDED','DELETED') NOT NULL DEFAULT 'ACTIVE',
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`deleted_at` datetime(3),
	`active_phone_key` varchar(255) GENERATED ALWAYS AS (CASE WHEN phone_e164 IS NOT NULL AND deleted_at IS NULL THEN phone_e164 END) VIRTUAL,
	CONSTRAINT `users_id` PRIMARY KEY(`id`),
	CONSTRAINT `users_email_unique` UNIQUE(`email`),
	CONSTRAINT `users_phone_e164_unique` UNIQUE(`active_phone_key`)
);
--> statement-breakpoint
CREATE TABLE `verification_tokens` (
	`identifier` varchar(255) NOT NULL,
	`token` varchar(255) NOT NULL,
	`expires` timestamp(3) NOT NULL,
	CONSTRAINT `verification_tokens_identifier_token_pk` PRIMARY KEY(`identifier`,`token`)
);
--> statement-breakpoint
CREATE TABLE `voucher_redemptions` (
	`id` varchar(36) NOT NULL,
	`voucher_id` varchar(36) NOT NULL,
	`user_id` varchar(36) NOT NULL,
	`wallet_id` varchar(36) NOT NULL,
	`payment_id` varchar(36),
	`topup_amount_paise` bigint NOT NULL,
	`bonus_percent` bigint NOT NULL,
	`bonus_amount_paise` bigint NOT NULL,
	`status` enum('PENDING','APPLIED','REVERSED','REJECTED') NOT NULL DEFAULT 'PENDING',
	`idempotency_key` varchar(255) NOT NULL,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `voucher_redemptions_id` PRIMARY KEY(`id`),
	CONSTRAINT `voucher_redemptions_idempotency_unique` UNIQUE(`idempotency_key`),
	CONSTRAINT `voucher_redemptions_amounts_non_negative` CHECK(`voucher_redemptions`.`topup_amount_paise` >= 0 AND `voucher_redemptions`.`bonus_amount_paise` >= 0)
);
--> statement-breakpoint
CREATE TABLE `voucher_upload_items` (
	`id` varchar(36) NOT NULL,
	`upload_id` varchar(36) NOT NULL,
	`row_number` int NOT NULL,
	`raw_data` json,
	`voucher_name` text,
	`voucher_code` text,
	`status` enum('VALID','DUPLICATE_IN_FILE','DUPLICATE_EXISTING','INVALID') NOT NULL,
	`error_message` text,
	`created_voucher_id` varchar(36),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `voucher_upload_items_id` PRIMARY KEY(`id`),
	CONSTRAINT `voucher_upload_items_row_unique` UNIQUE(`upload_id`,`row_number`)
);
--> statement-breakpoint
CREATE TABLE `voucher_uploads` (
	`id` varchar(36) NOT NULL,
	`uploaded_by` varchar(36) NOT NULL,
	`file_name` text NOT NULL,
	`status` enum('VALIDATED','APPLIED','CANCELLED') NOT NULL DEFAULT 'VALIDATED',
	`total_records` int NOT NULL DEFAULT 0,
	`successful_records` int NOT NULL DEFAULT 0,
	`failed_records` int NOT NULL DEFAULT 0,
	`summary` json,
	`applied_at` datetime(3),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `voucher_uploads_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `vouchers` (
	`id` varchar(36) NOT NULL,
	`name` text NOT NULL,
	`code` varchar(255),
	`description` text,
	`terms_and_conditions` text,
	`apply_mode` enum('CODE','AUTO_APPLY') NOT NULL DEFAULT 'CODE',
	`bonus_percent` bigint NOT NULL,
	`minimum_topup_paise` bigint NOT NULL DEFAULT 0,
	`maximum_bonus_paise` bigint,
	`start_date` date NOT NULL,
	`end_date` date NOT NULL,
	`usage_limit` int,
	`per_customer_limit` int NOT NULL DEFAULT 1,
	`total_budget_paise` bigint,
	`budget_used_paise` bigint NOT NULL DEFAULT 0,
	`redemption_count` int NOT NULL DEFAULT 0,
	`status` enum('DRAFT','ACTIVE','PAUSED','EXPIRED','BUDGET_EXHAUSTED') NOT NULL DEFAULT 'DRAFT',
	`applicable_scope` text,
	`created_by` varchar(36),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `vouchers_id` PRIMARY KEY(`id`),
	CONSTRAINT `vouchers_code_unique` UNIQUE(`code`),
	CONSTRAINT `vouchers_bonus_percent_range` CHECK(`vouchers`.`bonus_percent` > 0 AND `vouchers`.`bonus_percent` <= 100),
	CONSTRAINT `vouchers_minimum_topup_non_negative` CHECK(`vouchers`.`minimum_topup_paise` >= 0),
	CONSTRAINT `vouchers_maximum_bonus_non_negative` CHECK(`vouchers`.`maximum_bonus_paise` IS NULL OR `vouchers`.`maximum_bonus_paise` >= 0),
	CONSTRAINT `vouchers_dates_valid` CHECK(`vouchers`.`end_date` >= `vouchers`.`start_date`),
	CONSTRAINT `vouchers_usage_limit_positive` CHECK(`vouchers`.`usage_limit` IS NULL OR `vouchers`.`usage_limit` > 0),
	CONSTRAINT `vouchers_per_customer_limit_positive` CHECK(`vouchers`.`per_customer_limit` > 0),
	CONSTRAINT `vouchers_budget_non_negative` CHECK((`vouchers`.`total_budget_paise` IS NULL OR `vouchers`.`total_budget_paise` >= 0) AND `vouchers`.`budget_used_paise` >= 0)
);
--> statement-breakpoint
CREATE TABLE `wallet_transactions` (
	`id` varchar(36) NOT NULL,
	`wallet_id` varchar(36) NOT NULL,
	`user_id` varchar(36) NOT NULL,
	`type` enum('TOP_UP','PRODUCT_PURCHASE','SUBSCRIPTION_DEDUCTION','REFUND','PROMOTIONAL_CREDIT','MANUAL_CREDIT','MANUAL_DEBIT','REVERSAL') NOT NULL,
	`status` enum('COMPLETED','REVERSED') NOT NULL DEFAULT 'COMPLETED',
	`amount_paise` bigint NOT NULL,
	`previous_balance_paise` bigint NOT NULL,
	`new_balance_paise` bigint NOT NULL,
	`promotional_amount_paise` bigint NOT NULL DEFAULT 0,
	`order_id` varchar(36),
	`subscription_id` varchar(36),
	`payment_id` varchar(36),
	`reversal_of_id` varchar(36),
	`voucher_redemption_id` varchar(36),
	`idempotency_key` varchar(255) NOT NULL,
	`description` text NOT NULL,
	`created_by` varchar(36),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `wallet_transactions_id` PRIMARY KEY(`id`),
	CONSTRAINT `wallet_txn_idempotency_unique` UNIQUE(`idempotency_key`),
	CONSTRAINT `wallet_txn_amount_non_zero` CHECK(`wallet_transactions`.`amount_paise` <> 0),
	CONSTRAINT `wallet_txn_balances_non_negative` CHECK(`wallet_transactions`.`previous_balance_paise` >= 0 AND `wallet_transactions`.`new_balance_paise` >= 0),
	CONSTRAINT `wallet_txn_arithmetic` CHECK(`wallet_transactions`.`new_balance_paise` = `wallet_transactions`.`previous_balance_paise` + `wallet_transactions`.`amount_paise`),
	CONSTRAINT `wallet_txn_promotional_within_amount` CHECK((`wallet_transactions`.`amount_paise` >= 0 AND `wallet_transactions`.`promotional_amount_paise` >= 0 AND `wallet_transactions`.`promotional_amount_paise` <= `wallet_transactions`.`amount_paise`)
          OR (`wallet_transactions`.`amount_paise` < 0 AND `wallet_transactions`.`promotional_amount_paise` <= 0 AND `wallet_transactions`.`promotional_amount_paise` >= `wallet_transactions`.`amount_paise`))
);
--> statement-breakpoint
CREATE TABLE `wallets` (
	`id` varchar(36) NOT NULL,
	`user_id` varchar(36) NOT NULL,
	`balance_paise` bigint NOT NULL DEFAULT 0,
	`promotional_balance_paise` bigint NOT NULL DEFAULT 0,
	`currency` varchar(255) NOT NULL DEFAULT 'INR',
	`low_balance_threshold_paise` bigint NOT NULL DEFAULT 50000,
	`auto_recharge_enabled` boolean NOT NULL DEFAULT false,
	`auto_recharge_trigger_paise` bigint,
	`auto_recharge_amount_paise` bigint,
	`status` varchar(255) NOT NULL DEFAULT 'ACTIVE',
	`low_balance_notified_at` datetime(3),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `wallets_id` PRIMARY KEY(`id`),
	CONSTRAINT `wallets_user_unique` UNIQUE(`user_id`),
	CONSTRAINT `wallets_balance_non_negative` CHECK(`wallets`.`balance_paise` >= 0),
	CONSTRAINT `wallets_promotional_balance_bounded` CHECK(`wallets`.`promotional_balance_paise` >= 0 AND `wallets`.`promotional_balance_paise` <= `wallets`.`balance_paise`)
);
--> statement-breakpoint
ALTER TABLE `accounts` ADD CONSTRAINT `accounts_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `addresses` ADD CONSTRAINT `addresses_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `addresses` ADD CONSTRAINT `addresses_society_id_societies_id_fk` FOREIGN KEY (`society_id`) REFERENCES `societies`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `audit_logs` ADD CONSTRAINT `audit_logs_actor_id_users_id_fk` FOREIGN KEY (`actor_id`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `brands` ADD CONSTRAINT `brands_created_by_users_id_fk` FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `campaign_recipients` ADD CONSTRAINT `campaign_recipients_campaign_id_marketing_campaigns_id_fk` FOREIGN KEY (`campaign_id`) REFERENCES `marketing_campaigns`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `campaign_recipients` ADD CONSTRAINT `campaign_recipients_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `cart_items` ADD CONSTRAINT `cart_items_cart_id_carts_id_fk` FOREIGN KEY (`cart_id`) REFERENCES `carts`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `cart_items` ADD CONSTRAINT `cart_items_shop_product_id_shop_products_id_fk` FOREIGN KEY (`shop_product_id`) REFERENCES `shop_products`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `carts` ADD CONSTRAINT `carts_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `commission_rates` ADD CONSTRAINT `commission_rates_shop_id_shops_id_fk` FOREIGN KEY (`shop_id`) REFERENCES `shops`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `commission_rates` ADD CONSTRAINT `commission_rates_created_by_users_id_fk` FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `customer_segments` ADD CONSTRAINT `customer_segments_shop_id_shops_id_fk` FOREIGN KEY (`shop_id`) REFERENCES `shops`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `customer_segments` ADD CONSTRAINT `customer_segments_created_by_users_id_fk` FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `delivery_earnings_config` ADD CONSTRAINT `delivery_earnings_config_created_by_users_id_fk` FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `delivery_orders` ADD CONSTRAINT `delivery_orders_order_id_orders_id_fk` FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `delivery_orders` ADD CONSTRAINT `delivery_orders_delivery_partner_id_delivery_partners_id_fk` FOREIGN KEY (`delivery_partner_id`) REFERENCES `delivery_partners`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `delivery_partner_earnings` ADD CONSTRAINT `dp_earnings_order_fk` FOREIGN KEY (`delivery_order_id`) REFERENCES `delivery_orders`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `delivery_partner_earnings` ADD CONSTRAINT `dp_earnings_partner_fk` FOREIGN KEY (`delivery_partner_id`) REFERENCES `delivery_partners`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `delivery_partner_sessions` ADD CONSTRAINT `dp_sessions_partner_fk` FOREIGN KEY (`delivery_partner_id`) REFERENCES `delivery_partners`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `delivery_partners` ADD CONSTRAINT `delivery_partners_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `delivery_partners` ADD CONSTRAINT `delivery_partners_reviewed_by_users_id_fk` FOREIGN KEY (`reviewed_by`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `dispatch_attempts` ADD CONSTRAINT `dispatch_attempts_order_id_orders_id_fk` FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `dispatch_attempts` ADD CONSTRAINT `dispatch_attempts_search_id_rider_searches_id_fk` FOREIGN KEY (`search_id`) REFERENCES `rider_searches`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `dispatch_attempts` ADD CONSTRAINT `dispatch_attempts_delivery_order_id_delivery_orders_id_fk` FOREIGN KEY (`delivery_order_id`) REFERENCES `delivery_orders`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `dispatch_attempts` ADD CONSTRAINT `dispatch_attempts_delivery_partner_id_delivery_partners_id_fk` FOREIGN KEY (`delivery_partner_id`) REFERENCES `delivery_partners`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `excel_upload_items` ADD CONSTRAINT `excel_upload_items_upload_id_excel_uploads_id_fk` FOREIGN KEY (`upload_id`) REFERENCES `excel_uploads`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `excel_upload_items` ADD CONSTRAINT `excel_upload_items_matched_shop_product_id_shop_products_id_fk` FOREIGN KEY (`matched_shop_product_id`) REFERENCES `shop_products`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `excel_upload_items` ADD CONSTRAINT `excel_upload_items_matched_product_id_products_id_fk` FOREIGN KEY (`matched_product_id`) REFERENCES `products`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `excel_upload_items` ADD CONSTRAINT `excel_upload_items_possible_duplicate_product_id_products_id_fk` FOREIGN KEY (`possible_duplicate_product_id`) REFERENCES `products`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `excel_uploads` ADD CONSTRAINT `excel_uploads_shop_id_shops_id_fk` FOREIGN KEY (`shop_id`) REFERENCES `shops`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `excel_uploads` ADD CONSTRAINT `excel_uploads_uploaded_by_users_id_fk` FOREIGN KEY (`uploaded_by`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `external_price_reference_history` ADD CONSTRAINT `external_price_reference_history_actor_id_users_id_fk` FOREIGN KEY (`actor_id`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `external_price_reference_history` ADD CONSTRAINT `eprh_reference_fk` FOREIGN KEY (`reference_id`) REFERENCES `external_price_references`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `external_price_references` ADD CONSTRAINT `external_price_references_product_id_products_id_fk` FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `external_price_references` ADD CONSTRAINT `external_price_references_verified_by_users_id_fk` FOREIGN KEY (`verified_by`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `external_price_references` ADD CONSTRAINT `external_price_references_created_by_users_id_fk` FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `finance_ledger_entries` ADD CONSTRAINT `finance_ledger_entries_order_id_orders_id_fk` FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `finance_ledger_entries` ADD CONSTRAINT `finance_ledger_entries_created_by_users_id_fk` FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `financial_adjustments` ADD CONSTRAINT `financial_adjustments_shop_id_shops_id_fk` FOREIGN KEY (`shop_id`) REFERENCES `shops`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `financial_adjustments` ADD CONSTRAINT `financial_adjustments_order_id_orders_id_fk` FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `financial_adjustments` ADD CONSTRAINT `financial_adjustments_settlement_id_shop_settlements_id_fk` FOREIGN KEY (`settlement_id`) REFERENCES `shop_settlements`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `financial_adjustments` ADD CONSTRAINT `financial_adjustments_payout_id_rider_payouts_id_fk` FOREIGN KEY (`payout_id`) REFERENCES `rider_payouts`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `financial_adjustments` ADD CONSTRAINT `financial_adjustments_created_by_users_id_fk` FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `financial_adjustments` ADD CONSTRAINT `fin_adjustments_partner_fk` FOREIGN KEY (`delivery_partner_id`) REFERENCES `delivery_partners`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `grievances` ADD CONSTRAINT `grievances_submitted_by_user_id_users_id_fk` FOREIGN KEY (`submitted_by_user_id`) REFERENCES `users`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `grievances` ADD CONSTRAINT `grievances_order_id_orders_id_fk` FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `grievances` ADD CONSTRAINT `grievances_assigned_to_user_id_users_id_fk` FOREIGN KEY (`assigned_to_user_id`) REFERENCES `users`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `inventory_movements` ADD CONSTRAINT `inventory_movements_shop_product_id_shop_products_id_fk` FOREIGN KEY (`shop_product_id`) REFERENCES `shop_products`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `inventory_movements` ADD CONSTRAINT `inventory_movements_created_by_users_id_fk` FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `login_otps` ADD CONSTRAINT `login_otps_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `marketing_campaigns` ADD CONSTRAINT `marketing_campaigns_shop_id_shops_id_fk` FOREIGN KEY (`shop_id`) REFERENCES `shops`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `marketing_campaigns` ADD CONSTRAINT `marketing_campaigns_segment_id_customer_segments_id_fk` FOREIGN KEY (`segment_id`) REFERENCES `customer_segments`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `marketing_campaigns` ADD CONSTRAINT `marketing_campaigns_decided_by_users_id_fk` FOREIGN KEY (`decided_by`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `marketing_campaigns` ADD CONSTRAINT `marketing_campaigns_created_by_users_id_fk` FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `mrp_corrections` ADD CONSTRAINT `mrp_corrections_product_id_products_id_fk` FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `mrp_corrections` ADD CONSTRAINT `mrp_corrections_shop_id_shops_id_fk` FOREIGN KEY (`shop_id`) REFERENCES `shops`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `mrp_corrections` ADD CONSTRAINT `mrp_corrections_submitted_by_users_id_fk` FOREIGN KEY (`submitted_by`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `mrp_corrections` ADD CONSTRAINT `mrp_corrections_decided_by_users_id_fk` FOREIGN KEY (`decided_by`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `notification_deliveries` ADD CONSTRAINT `notification_deliveries_notification_id_notifications_id_fk` FOREIGN KEY (`notification_id`) REFERENCES `notifications`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `notification_deliveries` ADD CONSTRAINT `notification_deliveries_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `notification_preferences` ADD CONSTRAINT `notification_preferences_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `notifications` ADD CONSTRAINT `notifications_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `order_financials` ADD CONSTRAINT `order_financials_order_id_orders_id_fk` FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `order_financials` ADD CONSTRAINT `order_financials_shop_id_shops_id_fk` FOREIGN KEY (`shop_id`) REFERENCES `shops`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `order_financials` ADD CONSTRAINT `order_financials_customer_id_users_id_fk` FOREIGN KEY (`customer_id`) REFERENCES `users`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `order_financials` ADD CONSTRAINT `order_financials_commission_rate_id_commission_rates_id_fk` FOREIGN KEY (`commission_rate_id`) REFERENCES `commission_rates`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `order_financials` ADD CONSTRAINT `order_financials_settlement_id_shop_settlements_id_fk` FOREIGN KEY (`settlement_id`) REFERENCES `shop_settlements`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `order_items` ADD CONSTRAINT `order_items_order_id_orders_id_fk` FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `order_items` ADD CONSTRAINT `order_items_shop_product_id_shop_products_id_fk` FOREIGN KEY (`shop_product_id`) REFERENCES `shop_products`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `order_items` ADD CONSTRAINT `order_items_substitute_shop_product_id_shop_products_id_fk` FOREIGN KEY (`substitute_shop_product_id`) REFERENCES `shop_products`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `order_ratings` ADD CONSTRAINT `order_ratings_order_id_orders_id_fk` FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `order_ratings` ADD CONSTRAINT `order_ratings_customer_id_users_id_fk` FOREIGN KEY (`customer_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `order_ratings` ADD CONSTRAINT `order_ratings_shop_id_shops_id_fk` FOREIGN KEY (`shop_id`) REFERENCES `shops`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `order_ratings` ADD CONSTRAINT `order_ratings_delivery_partner_id_delivery_partners_id_fk` FOREIGN KEY (`delivery_partner_id`) REFERENCES `delivery_partners`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `order_ratings` ADD CONSTRAINT `order_ratings_moderated_by_users_id_fk` FOREIGN KEY (`moderated_by`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `order_status_history` ADD CONSTRAINT `order_status_history_order_id_orders_id_fk` FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `order_status_history` ADD CONSTRAINT `order_status_history_changed_by_users_id_fk` FOREIGN KEY (`changed_by`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `orders` ADD CONSTRAINT `orders_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `orders` ADD CONSTRAINT `orders_shop_id_shops_id_fk` FOREIGN KEY (`shop_id`) REFERENCES `shops`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `orders` ADD CONSTRAINT `orders_address_id_addresses_id_fk` FOREIGN KEY (`address_id`) REFERENCES `addresses`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `orders` ADD CONSTRAINT `orders_society_id_societies_id_fk` FOREIGN KEY (`society_id`) REFERENCES `societies`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `orders` ADD CONSTRAINT `orders_buyer_shop_id_shops_id_fk` FOREIGN KEY (`buyer_shop_id`) REFERENCES `shops`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `payments` ADD CONSTRAINT `payments_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `platform_settings` ADD CONSTRAINT `platform_settings_updated_by_users_id_fk` FOREIGN KEY (`updated_by`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `price_update_batches` ADD CONSTRAINT `price_update_batches_shop_id_shops_id_fk` FOREIGN KEY (`shop_id`) REFERENCES `shops`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `price_update_batches` ADD CONSTRAINT `price_update_batches_submitted_by_users_id_fk` FOREIGN KEY (`submitted_by`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `price_update_batches` ADD CONSTRAINT `price_update_batches_excel_upload_id_excel_uploads_id_fk` FOREIGN KEY (`excel_upload_id`) REFERENCES `excel_uploads`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `price_update_batches` ADD CONSTRAINT `price_update_batches_decided_by_users_id_fk` FOREIGN KEY (`decided_by`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `price_update_requests` ADD CONSTRAINT `price_update_requests_batch_id_price_update_batches_id_fk` FOREIGN KEY (`batch_id`) REFERENCES `price_update_batches`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `price_update_requests` ADD CONSTRAINT `price_update_requests_shop_id_shops_id_fk` FOREIGN KEY (`shop_id`) REFERENCES `shops`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `price_update_requests` ADD CONSTRAINT `price_update_requests_shop_product_id_shop_products_id_fk` FOREIGN KEY (`shop_product_id`) REFERENCES `shop_products`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `price_update_requests` ADD CONSTRAINT `price_update_requests_submitted_by_users_id_fk` FOREIGN KEY (`submitted_by`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `price_update_requests` ADD CONSTRAINT `price_update_requests_decided_by_users_id_fk` FOREIGN KEY (`decided_by`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `product_images` ADD CONSTRAINT `product_images_product_id_products_id_fk` FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `product_images` ADD CONSTRAINT `product_images_shop_product_id_shop_products_id_fk` FOREIGN KEY (`shop_product_id`) REFERENCES `shop_products`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `product_images` ADD CONSTRAINT `product_images_stored_image_id_stored_images_id_fk` FOREIGN KEY (`stored_image_id`) REFERENCES `stored_images`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `product_images` ADD CONSTRAINT `product_images_created_by_users_id_fk` FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `product_mrp_history` ADD CONSTRAINT `product_mrp_history_product_id_products_id_fk` FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `product_mrp_history` ADD CONSTRAINT `product_mrp_history_changed_by_users_id_fk` FOREIGN KEY (`changed_by`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `product_price_history` ADD CONSTRAINT `product_price_history_shop_product_id_shop_products_id_fk` FOREIGN KEY (`shop_product_id`) REFERENCES `shop_products`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `product_price_history` ADD CONSTRAINT `product_price_history_changed_by_users_id_fk` FOREIGN KEY (`changed_by`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `product_subcategories` ADD CONSTRAINT `product_subcategories_category_id_product_categories_id_fk` FOREIGN KEY (`category_id`) REFERENCES `product_categories`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `products` ADD CONSTRAINT `products_category_id_product_categories_id_fk` FOREIGN KEY (`category_id`) REFERENCES `product_categories`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `products` ADD CONSTRAINT `products_subcategory_id_product_subcategories_id_fk` FOREIGN KEY (`subcategory_id`) REFERENCES `product_subcategories`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `products` ADD CONSTRAINT `products_brand_id_brands_id_fk` FOREIGN KEY (`brand_id`) REFERENCES `brands`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `products` ADD CONSTRAINT `products_created_by_users_id_fk` FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `products` ADD CONSTRAINT `products_approved_by_users_id_fk` FOREIGN KEY (`approved_by`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `reconciliation_records` ADD CONSTRAINT `reconciliation_records_resolved_by_users_id_fk` FOREIGN KEY (`resolved_by`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `referral_codes` ADD CONSTRAINT `referral_codes_referrer_user_id_users_id_fk` FOREIGN KEY (`referrer_user_id`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `referral_codes` ADD CONSTRAINT `referral_codes_created_by_users_id_fk` FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `referral_redemptions` ADD CONSTRAINT `referral_redemptions_referral_code_id_referral_codes_id_fk` FOREIGN KEY (`referral_code_id`) REFERENCES `referral_codes`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `referral_redemptions` ADD CONSTRAINT `referral_redemptions_shop_id_shops_id_fk` FOREIGN KEY (`shop_id`) REFERENCES `shops`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `referral_redemptions` ADD CONSTRAINT `referral_redemptions_redeemed_by_users_id_fk` FOREIGN KEY (`redeemed_by`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `registration_fee_history` ADD CONSTRAINT `registration_fee_history_changed_by_users_id_fk` FOREIGN KEY (`changed_by`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `registration_fee_history` ADD CONSTRAINT `reg_fee_history_fee_fk` FOREIGN KEY (`registration_fee_id`) REFERENCES `registration_fees`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `registration_fees` ADD CONSTRAINT `registration_fees_created_by_users_id_fk` FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `return_items` ADD CONSTRAINT `return_items_return_id_return_requests_id_fk` FOREIGN KEY (`return_id`) REFERENCES `return_requests`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `return_items` ADD CONSTRAINT `return_items_order_item_id_order_items_id_fk` FOREIGN KEY (`order_item_id`) REFERENCES `order_items`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `return_pickups` ADD CONSTRAINT `return_pickups_return_id_return_requests_id_fk` FOREIGN KEY (`return_id`) REFERENCES `return_requests`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `return_pickups` ADD CONSTRAINT `return_pickups_delivery_partner_id_delivery_partners_id_fk` FOREIGN KEY (`delivery_partner_id`) REFERENCES `delivery_partners`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `return_requests` ADD CONSTRAINT `return_requests_order_id_orders_id_fk` FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `return_requests` ADD CONSTRAINT `return_requests_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `return_requests` ADD CONSTRAINT `return_requests_shop_id_shops_id_fk` FOREIGN KEY (`shop_id`) REFERENCES `shops`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `return_requests` ADD CONSTRAINT `return_requests_decided_by_users_id_fk` FOREIGN KEY (`decided_by`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `return_requests` ADD CONSTRAINT `return_requests_inspected_by_users_id_fk` FOREIGN KEY (`inspected_by`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `return_status_history` ADD CONSTRAINT `return_status_history_return_id_return_requests_id_fk` FOREIGN KEY (`return_id`) REFERENCES `return_requests`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `return_status_history` ADD CONSTRAINT `return_status_history_changed_by_users_id_fk` FOREIGN KEY (`changed_by`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `rider_earning_slots` ADD CONSTRAINT `rider_earning_slots_created_by_users_id_fk` FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `rider_earnings_ledger` ADD CONSTRAINT `rider_earnings_ledger_earning_id_delivery_partner_earnings_id_fk` FOREIGN KEY (`earning_id`) REFERENCES `delivery_partner_earnings`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `rider_earnings_ledger` ADD CONSTRAINT `rider_earnings_ledger_delivery_order_id_delivery_orders_id_fk` FOREIGN KEY (`delivery_order_id`) REFERENCES `delivery_orders`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `rider_earnings_ledger` ADD CONSTRAINT `earnings_ledger_partner_fk` FOREIGN KEY (`delivery_partner_id`) REFERENCES `delivery_partners`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `rider_incentive_awards` ADD CONSTRAINT `rider_incentive_awards_rule_id_rider_incentive_rules_id_fk` FOREIGN KEY (`rule_id`) REFERENCES `rider_incentive_rules`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `rider_incentive_awards` ADD CONSTRAINT `incentive_awards_earning_fk` FOREIGN KEY (`earning_id`) REFERENCES `delivery_partner_earnings`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `rider_incentive_awards` ADD CONSTRAINT `incentive_awards_partner_fk` FOREIGN KEY (`delivery_partner_id`) REFERENCES `delivery_partners`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `rider_incentive_rules` ADD CONSTRAINT `rider_incentive_rules_created_by_users_id_fk` FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `rider_payouts` ADD CONSTRAINT `rider_payouts_delivery_partner_id_delivery_partners_id_fk` FOREIGN KEY (`delivery_partner_id`) REFERENCES `delivery_partners`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `rider_payouts` ADD CONSTRAINT `rider_payouts_approved_by_users_id_fk` FOREIGN KEY (`approved_by`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `rider_payouts` ADD CONSTRAINT `rider_payouts_paid_by_users_id_fk` FOREIGN KEY (`paid_by`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `rider_payouts` ADD CONSTRAINT `rider_payouts_created_by_users_id_fk` FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `rider_searches` ADD CONSTRAINT `rider_searches_order_id_orders_id_fk` FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `rider_searches` ADD CONSTRAINT `rider_searches_started_by_users_id_fk` FOREIGN KEY (`started_by`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `risk_flags` ADD CONSTRAINT `risk_flags_reviewed_by_users_id_fk` FOREIGN KEY (`reviewed_by`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `role_permissions` ADD CONSTRAINT `role_permissions_role_key_roles_key_fk` FOREIGN KEY (`role_key`) REFERENCES `roles`(`key`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `role_permissions` ADD CONSTRAINT `role_permissions_permission_key_permissions_key_fk` FOREIGN KEY (`permission_key`) REFERENCES `permissions`(`key`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `sessions` ADD CONSTRAINT `sessions_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `shop_category_mapping` ADD CONSTRAINT `shop_category_mapping_shop_id_shops_id_fk` FOREIGN KEY (`shop_id`) REFERENCES `shops`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `shop_category_mapping` ADD CONSTRAINT `shop_category_mapping_category_id_shop_categories_id_fk` FOREIGN KEY (`category_id`) REFERENCES `shop_categories`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `shop_classification_history` ADD CONSTRAINT `shop_classification_history_shop_id_shops_id_fk` FOREIGN KEY (`shop_id`) REFERENCES `shops`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `shop_classification_history` ADD CONSTRAINT `shop_classification_history_changed_by_users_id_fk` FOREIGN KEY (`changed_by`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `shop_payments` ADD CONSTRAINT `shop_payments_shop_id_shops_id_fk` FOREIGN KEY (`shop_id`) REFERENCES `shops`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `shop_payments` ADD CONSTRAINT `shop_payments_owner_id_users_id_fk` FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `shop_payments` ADD CONSTRAINT `shop_payments_recorded_by_users_id_fk` FOREIGN KEY (`recorded_by`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `shop_products` ADD CONSTRAINT `shop_products_shop_id_shops_id_fk` FOREIGN KEY (`shop_id`) REFERENCES `shops`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `shop_products` ADD CONSTRAINT `shop_products_product_id_products_id_fk` FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `shop_settlements` ADD CONSTRAINT `shop_settlements_shop_id_shops_id_fk` FOREIGN KEY (`shop_id`) REFERENCES `shops`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `shop_settlements` ADD CONSTRAINT `shop_settlements_approved_by_users_id_fk` FOREIGN KEY (`approved_by`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `shop_settlements` ADD CONSTRAINT `shop_settlements_paid_by_users_id_fk` FOREIGN KEY (`paid_by`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `shop_settlements` ADD CONSTRAINT `shop_settlements_created_by_users_id_fk` FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `shop_suspension_orders` ADD CONSTRAINT `shop_suspension_orders_suspension_id_shop_suspensions_id_fk` FOREIGN KEY (`suspension_id`) REFERENCES `shop_suspensions`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `shop_suspension_orders` ADD CONSTRAINT `shop_suspension_orders_order_id_orders_id_fk` FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `shop_suspension_orders` ADD CONSTRAINT `shop_suspension_orders_resolved_by_users_id_fk` FOREIGN KEY (`resolved_by`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `shop_suspensions` ADD CONSTRAINT `shop_suspensions_shop_id_shops_id_fk` FOREIGN KEY (`shop_id`) REFERENCES `shops`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `shop_suspensions` ADD CONSTRAINT `shop_suspensions_suspended_by_users_id_fk` FOREIGN KEY (`suspended_by`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `shop_suspensions` ADD CONSTRAINT `shop_suspensions_lifted_by_users_id_fk` FOREIGN KEY (`lifted_by`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `shops` ADD CONSTRAINT `shops_owner_id_users_id_fk` FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `shops` ADD CONSTRAINT `shops_approved_by_users_id_fk` FOREIGN KEY (`approved_by`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `shops` ADD CONSTRAINT `shops_gst_verified_by_users_id_fk` FOREIGN KEY (`gst_verified_by`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `shops` ADD CONSTRAINT `shops_pan_verified_by_users_id_fk` FOREIGN KEY (`pan_verified_by`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `societies` ADD CONSTRAINT `societies_registered_by_users_id_fk` FOREIGN KEY (`registered_by`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `societies` ADD CONSTRAINT `societies_verified_by_users_id_fk` FOREIGN KEY (`verified_by`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `society_members` ADD CONSTRAINT `society_members_society_id_societies_id_fk` FOREIGN KEY (`society_id`) REFERENCES `societies`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `society_members` ADD CONSTRAINT `society_members_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `society_members` ADD CONSTRAINT `society_members_approved_by_users_id_fk` FOREIGN KEY (`approved_by`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `society_riders` ADD CONSTRAINT `society_riders_society_id_societies_id_fk` FOREIGN KEY (`society_id`) REFERENCES `societies`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `society_riders` ADD CONSTRAINT `society_riders_delivery_partner_id_delivery_partners_id_fk` FOREIGN KEY (`delivery_partner_id`) REFERENCES `delivery_partners`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `society_riders` ADD CONSTRAINT `society_riders_added_by_users_id_fk` FOREIGN KEY (`added_by`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `society_riders` ADD CONSTRAINT `society_riders_revoked_by_users_id_fk` FOREIGN KEY (`revoked_by`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `society_shops` ADD CONSTRAINT `society_shops_society_id_societies_id_fk` FOREIGN KEY (`society_id`) REFERENCES `societies`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `society_shops` ADD CONSTRAINT `society_shops_shop_id_shops_id_fk` FOREIGN KEY (`shop_id`) REFERENCES `shops`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `society_shops` ADD CONSTRAINT `society_shops_added_by_users_id_fk` FOREIGN KEY (`added_by`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `stock_alerts` ADD CONSTRAINT `stock_alerts_shop_product_id_shop_products_id_fk` FOREIGN KEY (`shop_product_id`) REFERENCES `shop_products`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `stock_alerts` ADD CONSTRAINT `stock_alerts_shop_id_shops_id_fk` FOREIGN KEY (`shop_id`) REFERENCES `shops`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `stock_alerts` ADD CONSTRAINT `stock_alerts_acknowledged_by_users_id_fk` FOREIGN KEY (`acknowledged_by`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `stored_images` ADD CONSTRAINT `stored_images_owner_id_users_id_fk` FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `subscription_daily_overrides` ADD CONSTRAINT `subscription_daily_overrides_subscription_id_subscriptions_id_fk` FOREIGN KEY (`subscription_id`) REFERENCES `subscriptions`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `subscription_daily_overrides` ADD CONSTRAINT `subscription_daily_overrides_created_by_users_id_fk` FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `subscription_events` ADD CONSTRAINT `subscription_events_subscription_id_subscriptions_id_fk` FOREIGN KEY (`subscription_id`) REFERENCES `subscriptions`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `subscription_events` ADD CONSTRAINT `subscription_events_actor_id_users_id_fk` FOREIGN KEY (`actor_id`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `subscription_orders` ADD CONSTRAINT `subscription_orders_subscription_id_subscriptions_id_fk` FOREIGN KEY (`subscription_id`) REFERENCES `subscriptions`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `subscription_orders` ADD CONSTRAINT `subscription_orders_order_id_orders_id_fk` FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `subscriptions` ADD CONSTRAINT `subscriptions_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `subscriptions` ADD CONSTRAINT `subscriptions_shop_id_shops_id_fk` FOREIGN KEY (`shop_id`) REFERENCES `shops`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `subscriptions` ADD CONSTRAINT `subscriptions_shop_product_id_shop_products_id_fk` FOREIGN KEY (`shop_product_id`) REFERENCES `shop_products`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `subscriptions` ADD CONSTRAINT `subscriptions_address_id_addresses_id_fk` FOREIGN KEY (`address_id`) REFERENCES `addresses`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `user_consents` ADD CONSTRAINT `user_consents_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `user_role_grants` ADD CONSTRAINT `user_role_grants_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `user_role_grants` ADD CONSTRAINT `user_role_grants_granted_by_users_id_fk` FOREIGN KEY (`granted_by`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `user_role_grants` ADD CONSTRAINT `user_role_grants_revoked_by_users_id_fk` FOREIGN KEY (`revoked_by`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `voucher_redemptions` ADD CONSTRAINT `voucher_redemptions_voucher_id_vouchers_id_fk` FOREIGN KEY (`voucher_id`) REFERENCES `vouchers`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `voucher_redemptions` ADD CONSTRAINT `voucher_redemptions_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `voucher_redemptions` ADD CONSTRAINT `voucher_redemptions_wallet_id_wallets_id_fk` FOREIGN KEY (`wallet_id`) REFERENCES `wallets`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `voucher_redemptions` ADD CONSTRAINT `voucher_redemptions_payment_id_payments_id_fk` FOREIGN KEY (`payment_id`) REFERENCES `payments`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `voucher_upload_items` ADD CONSTRAINT `voucher_upload_items_upload_id_voucher_uploads_id_fk` FOREIGN KEY (`upload_id`) REFERENCES `voucher_uploads`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `voucher_upload_items` ADD CONSTRAINT `voucher_upload_items_created_voucher_id_vouchers_id_fk` FOREIGN KEY (`created_voucher_id`) REFERENCES `vouchers`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `voucher_uploads` ADD CONSTRAINT `voucher_uploads_uploaded_by_users_id_fk` FOREIGN KEY (`uploaded_by`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `vouchers` ADD CONSTRAINT `vouchers_created_by_users_id_fk` FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `wallet_transactions` ADD CONSTRAINT `wallet_transactions_wallet_id_wallets_id_fk` FOREIGN KEY (`wallet_id`) REFERENCES `wallets`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `wallet_transactions` ADD CONSTRAINT `wallet_transactions_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `wallet_transactions` ADD CONSTRAINT `wallet_transactions_order_id_orders_id_fk` FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `wallet_transactions` ADD CONSTRAINT `wallet_transactions_payment_id_payments_id_fk` FOREIGN KEY (`payment_id`) REFERENCES `payments`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `wallet_transactions` ADD CONSTRAINT `wallet_transactions_created_by_users_id_fk` FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `wallets` ADD CONSTRAINT `wallets_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `accounts_user_idx` ON `accounts` (`user_id`);--> statement-breakpoint
CREATE INDEX `addresses_user_idx` ON `addresses` (`user_id`);--> statement-breakpoint
CREATE INDEX `addresses_pincode_idx` ON `addresses` (`pincode`);--> statement-breakpoint
CREATE INDEX `audit_logs_actor_idx` ON `audit_logs` (`actor_id`);--> statement-breakpoint
CREATE INDEX `audit_logs_entity_idx` ON `audit_logs` (`entity_type`,`entity_id`);--> statement-breakpoint
CREATE INDEX `audit_logs_created_idx` ON `audit_logs` (`created_at`);--> statement-breakpoint
CREATE INDEX `brands_name_idx` ON `brands` (`name`);--> statement-breakpoint
CREATE INDEX `campaign_recipients_user_idx` ON `campaign_recipients` (`user_id`,`sent_at`);--> statement-breakpoint
CREATE INDEX `cart_items_cart_idx` ON `cart_items` (`cart_id`);--> statement-breakpoint
CREATE INDEX `commission_rates_lookup_idx` ON `commission_rates` (`scope`,`shop_type`,`shop_id`);--> statement-breakpoint
CREATE INDEX `customer_segments_shop_idx` ON `customer_segments` (`shop_id`);--> statement-breakpoint
CREATE INDEX `delivery_orders_partner_idx` ON `delivery_orders` (`delivery_partner_id`);--> statement-breakpoint
CREATE INDEX `delivery_orders_status_idx` ON `delivery_orders` (`status`);--> statement-breakpoint
CREATE INDEX `delivery_partner_earnings_payout_idx` ON `delivery_partner_earnings` (`payout_id`);--> statement-breakpoint
CREATE INDEX `delivery_partner_earnings_partner_idx` ON `delivery_partner_earnings` (`delivery_partner_id`);--> statement-breakpoint
CREATE INDEX `delivery_partner_sessions_partner_idx` ON `delivery_partner_sessions` (`delivery_partner_id`);--> statement-breakpoint
CREATE INDEX `delivery_partner_sessions_started_idx` ON `delivery_partner_sessions` (`started_at`);--> statement-breakpoint
CREATE INDEX `delivery_partners_status_idx` ON `delivery_partners` (`status`);--> statement-breakpoint
CREATE INDEX `dispatch_attempts_order_idx` ON `dispatch_attempts` (`order_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `excel_upload_items_upload_idx` ON `excel_upload_items` (`upload_id`);--> statement-breakpoint
CREATE INDEX `excel_uploads_shop_idx` ON `excel_uploads` (`shop_id`);--> statement-breakpoint
CREATE INDEX `excel_uploads_uploader_idx` ON `excel_uploads` (`uploaded_by`);--> statement-breakpoint
CREATE INDEX `excel_uploads_created_idx` ON `excel_uploads` (`created_at`);--> statement-breakpoint
CREATE INDEX `external_price_ref_history_idx` ON `external_price_reference_history` (`reference_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `external_price_refs_product_idx` ON `external_price_references` (`product_id`,`referenced_at`);--> statement-breakpoint
CREATE INDEX `finance_ledger_order_idx` ON `finance_ledger_entries` (`order_id`);--> statement-breakpoint
CREATE INDEX `finance_ledger_entity_idx` ON `finance_ledger_entries` (`entity_type`,`entity_id`);--> statement-breakpoint
CREATE INDEX `finance_ledger_created_idx` ON `finance_ledger_entries` (`created_at`);--> statement-breakpoint
CREATE INDEX `financial_adjustments_shop_idx` ON `financial_adjustments` (`shop_id`);--> statement-breakpoint
CREATE INDEX `financial_adjustments_partner_idx` ON `financial_adjustments` (`delivery_partner_id`);--> statement-breakpoint
CREATE INDEX `financial_adjustments_order_idx` ON `financial_adjustments` (`order_id`);--> statement-breakpoint
CREATE INDEX `grievances_status_idx` ON `grievances` (`status`);--> statement-breakpoint
CREATE INDEX `grievances_email_idx` ON `grievances` (`email`);--> statement-breakpoint
CREATE INDEX `grievances_submitted_by_idx` ON `grievances` (`submitted_by_user_id`);--> statement-breakpoint
CREATE INDEX `inventory_movements_sp_idx` ON `inventory_movements` (`shop_product_id`);--> statement-breakpoint
CREATE INDEX `login_otps_phone_created_idx` ON `login_otps` (`phone_e164`,`created_at`);--> statement-breakpoint
CREATE INDEX `login_otps_user_idx` ON `login_otps` (`user_id`);--> statement-breakpoint
CREATE INDEX `maps_api_call_log_service_idx` ON `maps_api_call_log` (`service`);--> statement-breakpoint
CREATE INDEX `maps_api_call_log_created_idx` ON `maps_api_call_log` (`created_at`);--> statement-breakpoint
CREATE INDEX `maps_api_call_log_entity_idx` ON `maps_api_call_log` (`entity_type`,`entity_id`);--> statement-breakpoint
CREATE INDEX `marketing_campaigns_shop_idx` ON `marketing_campaigns` (`shop_id`);--> statement-breakpoint
CREATE INDEX `marketing_campaigns_status_idx` ON `marketing_campaigns` (`status`);--> statement-breakpoint
CREATE INDEX `mrp_corrections_status_idx` ON `mrp_corrections` (`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `mrp_corrections_product_idx` ON `mrp_corrections` (`product_id`);--> statement-breakpoint
CREATE INDEX `notification_deliveries_due_idx` ON `notification_deliveries` (`status`,`next_attempt_at`);--> statement-breakpoint
CREATE INDEX `notification_deliveries_user_idx` ON `notification_deliveries` (`user_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `notifications_user_idx` ON `notifications` (`user_id`);--> statement-breakpoint
CREATE INDEX `notifications_read_idx` ON `notifications` (`user_id`,`read_at`);--> statement-breakpoint
CREATE INDEX `order_financials_shop_idx` ON `order_financials` (`shop_id`);--> statement-breakpoint
CREATE INDEX `order_financials_settlement_idx` ON `order_financials` (`settlement_id`);--> statement-breakpoint
CREATE INDEX `order_financials_delivered_idx` ON `order_financials` (`delivered_at`);--> statement-breakpoint
CREATE INDEX `order_items_order_idx` ON `order_items` (`order_id`);--> statement-breakpoint
CREATE INDEX `order_ratings_shop_idx` ON `order_ratings` (`shop_id`);--> statement-breakpoint
CREATE INDEX `order_ratings_partner_idx` ON `order_ratings` (`delivery_partner_id`);--> statement-breakpoint
CREATE INDEX `order_status_history_order_idx` ON `order_status_history` (`order_id`);--> statement-breakpoint
CREATE INDEX `orders_user_idx` ON `orders` (`user_id`);--> statement-breakpoint
CREATE INDEX `orders_shop_idx` ON `orders` (`shop_id`);--> statement-breakpoint
CREATE INDEX `orders_status_idx` ON `orders` (`status`);--> statement-breakpoint
CREATE INDEX `orders_created_idx` ON `orders` (`created_at`);--> statement-breakpoint
CREATE INDEX `orders_buyer_shop_idx` ON `orders` (`buyer_shop_id`);--> statement-breakpoint
CREATE INDEX `orders_society_idx` ON `orders` (`society_id`);--> statement-breakpoint
CREATE INDEX `orders_open_alert_pending_idx` ON `orders` (`shop_id`);--> statement-breakpoint
CREATE INDEX `payments_user_idx` ON `payments` (`user_id`);--> statement-breakpoint
CREATE INDEX `price_update_batches_shop_idx` ON `price_update_batches` (`shop_id`);--> statement-breakpoint
CREATE INDEX `price_update_batches_status_idx` ON `price_update_batches` (`status`);--> statement-breakpoint
CREATE INDEX `price_update_requests_batch_idx` ON `price_update_requests` (`batch_id`);--> statement-breakpoint
CREATE INDEX `price_update_requests_shop_idx` ON `price_update_requests` (`shop_id`);--> statement-breakpoint
CREATE INDEX `price_update_requests_status_idx` ON `price_update_requests` (`status`);--> statement-breakpoint
CREATE INDEX `price_update_requests_sp_idx` ON `price_update_requests` (`shop_product_id`);--> statement-breakpoint
CREATE INDEX `product_categories_dept_idx` ON `product_categories` (`department`);--> statement-breakpoint
CREATE INDEX `product_images_product_idx` ON `product_images` (`product_id`);--> statement-breakpoint
CREATE INDEX `product_images_shop_product_idx` ON `product_images` (`shop_product_id`);--> statement-breakpoint
CREATE INDEX `product_mrp_history_product_idx` ON `product_mrp_history` (`product_id`);--> statement-breakpoint
CREATE INDEX `price_history_shop_product_idx` ON `product_price_history` (`shop_product_id`);--> statement-breakpoint
CREATE INDEX `product_subcategories_category_idx` ON `product_subcategories` (`category_id`);--> statement-breakpoint
CREATE INDEX `products_category_idx` ON `products` (`category_id`);--> statement-breakpoint
CREATE INDEX `products_approval_status_idx` ON `products` (`approval_status`);--> statement-breakpoint
CREATE INDEX `products_barcode_idx` ON `products` (`barcode`);--> statement-breakpoint
CREATE INDEX `products_brand_idx` ON `products` (`brand_id`);--> statement-breakpoint
CREATE INDEX `products_subcategory_idx` ON `products` (`subcategory_id`);--> statement-breakpoint
CREATE INDEX `products_name_idx` ON `products` (`name`);--> statement-breakpoint
CREATE INDEX `reconciliation_status_idx` ON `reconciliation_records` (`status`);--> statement-breakpoint
CREATE INDEX `referral_codes_status_idx` ON `referral_codes` (`status`);--> statement-breakpoint
CREATE INDEX `referral_redemptions_code_idx` ON `referral_redemptions` (`referral_code_id`);--> statement-breakpoint
CREATE INDEX `registration_fee_history_created_idx` ON `registration_fee_history` (`created_at`);--> statement-breakpoint
CREATE INDEX `registration_fees_effective_idx` ON `registration_fees` (`effective_from`);--> statement-breakpoint
CREATE INDEX `return_items_return_idx` ON `return_items` (`return_id`);--> statement-breakpoint
CREATE INDEX `return_items_order_item_idx` ON `return_items` (`order_item_id`);--> statement-breakpoint
CREATE INDEX `return_pickups_return_idx` ON `return_pickups` (`return_id`);--> statement-breakpoint
CREATE INDEX `return_pickups_partner_idx` ON `return_pickups` (`delivery_partner_id`,`status`);--> statement-breakpoint
CREATE INDEX `return_requests_order_idx` ON `return_requests` (`order_id`);--> statement-breakpoint
CREATE INDEX `return_requests_user_idx` ON `return_requests` (`user_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `return_requests_shop_status_idx` ON `return_requests` (`shop_id`,`status`);--> statement-breakpoint
CREATE INDEX `return_status_history_return_idx` ON `return_status_history` (`return_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `rider_earnings_ledger_earning_idx` ON `rider_earnings_ledger` (`earning_id`);--> statement-breakpoint
CREATE INDEX `rider_earnings_ledger_partner_idx` ON `rider_earnings_ledger` (`delivery_partner_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `rider_payouts_partner_idx` ON `rider_payouts` (`delivery_partner_id`);--> statement-breakpoint
CREATE INDEX `rider_payouts_status_idx` ON `rider_payouts` (`status`);--> statement-breakpoint
CREATE INDEX `rider_searches_status_next_idx` ON `rider_searches` (`status`,`next_attempt_at`);--> statement-breakpoint
CREATE INDEX `risk_flags_status_idx` ON `risk_flags` (`status`,`severity`);--> statement-breakpoint
CREATE INDEX `risk_flags_subject_idx` ON `risk_flags` (`subject_type`,`subject_id`);--> statement-breakpoint
CREATE INDEX `sessions_user_idx` ON `sessions` (`user_id`);--> statement-breakpoint
CREATE INDEX `shop_category_mapping_category_idx` ON `shop_category_mapping` (`category_id`);--> statement-breakpoint
CREATE INDEX `shop_class_hist_shop_idx` ON `shop_classification_history` (`shop_id`);--> statement-breakpoint
CREATE INDEX `shop_payments_shop_idx` ON `shop_payments` (`shop_id`);--> statement-breakpoint
CREATE INDEX `shop_payments_owner_idx` ON `shop_payments` (`owner_id`);--> statement-breakpoint
CREATE INDEX `shop_payments_paid_idx` ON `shop_payments` (`paid_at`);--> statement-breakpoint
CREATE INDEX `shop_products_shop_idx` ON `shop_products` (`shop_id`);--> statement-breakpoint
CREATE INDEX `shop_products_product_idx` ON `shop_products` (`product_id`);--> statement-breakpoint
CREATE INDEX `shop_products_stock_idx` ON `shop_products` (`online_stock`);--> statement-breakpoint
CREATE INDEX `shop_settlements_shop_idx` ON `shop_settlements` (`shop_id`);--> statement-breakpoint
CREATE INDEX `shop_settlements_status_idx` ON `shop_settlements` (`status`);--> statement-breakpoint
CREATE INDEX `shop_suspension_orders_order_idx` ON `shop_suspension_orders` (`order_id`);--> statement-breakpoint
CREATE INDEX `shop_suspension_orders_outcome_idx` ON `shop_suspension_orders` (`outcome`);--> statement-breakpoint
CREATE INDEX `shop_suspensions_shop_idx` ON `shop_suspensions` (`shop_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `shops_owner_idx` ON `shops` (`owner_id`);--> statement-breakpoint
CREATE INDEX `shops_status_idx` ON `shops` (`status`);--> statement-breakpoint
CREATE INDEX `shops_city_idx` ON `shops` (`city`);--> statement-breakpoint
CREATE INDEX `shops_pincode_idx` ON `shops` (`pincode`);--> statement-breakpoint
CREATE INDEX `shops_fee_status_idx` ON `shops` (`fee_payment_status`);--> statement-breakpoint
CREATE INDEX `shops_referral_idx` ON `shops` (`referral_code_id`);--> statement-breakpoint
CREATE INDEX `shops_pan_hash_idx` ON `shops` (`pan_hash`);--> statement-breakpoint
CREATE INDEX `shops_udyam_number_idx` ON `shops` (`udyam_number`);--> statement-breakpoint
CREATE INDEX `societies_status_idx` ON `societies` (`status`);--> statement-breakpoint
CREATE INDEX `societies_pincode_idx` ON `societies` (`pincode`);--> statement-breakpoint
CREATE INDEX `society_members_user_idx` ON `society_members` (`user_id`);--> statement-breakpoint
CREATE INDEX `society_riders_partner_idx` ON `society_riders` (`delivery_partner_id`);--> statement-breakpoint
CREATE INDEX `stock_alerts_shop_status_idx` ON `stock_alerts` (`shop_id`,`status`);--> statement-breakpoint
CREATE INDEX `stock_alerts_shop_product_idx` ON `stock_alerts` (`shop_product_id`);--> statement-breakpoint
CREATE INDEX `stored_images_owner_idx` ON `stored_images` (`owner_id`);--> statement-breakpoint
CREATE INDEX `stored_images_sha_idx` ON `stored_images` (`sha256`);--> statement-breakpoint
CREATE INDEX `subscription_events_subscription_idx` ON `subscription_events` (`subscription_id`);--> statement-breakpoint
CREATE INDEX `subscription_orders_date_idx` ON `subscription_orders` (`delivery_date`);--> statement-breakpoint
CREATE INDEX `subscription_orders_status_idx` ON `subscription_orders` (`status`);--> statement-breakpoint
CREATE INDEX `subscriptions_user_idx` ON `subscriptions` (`user_id`);--> statement-breakpoint
CREATE INDEX `subscriptions_shop_idx` ON `subscriptions` (`shop_id`);--> statement-breakpoint
CREATE INDEX `subscriptions_status_idx` ON `subscriptions` (`status`);--> statement-breakpoint
CREATE INDEX `subscriptions_next_delivery_idx` ON `subscriptions` (`next_delivery_date`);--> statement-breakpoint
CREATE INDEX `user_consents_user_idx` ON `user_consents` (`user_id`);--> statement-breakpoint
CREATE INDEX `user_consents_type_idx` ON `user_consents` (`consent_type`);--> statement-breakpoint
CREATE INDEX `user_role_grants_user_idx` ON `user_role_grants` (`user_id`);--> statement-breakpoint
CREATE INDEX `voucher_redemptions_voucher_idx` ON `voucher_redemptions` (`voucher_id`);--> statement-breakpoint
CREATE INDEX `voucher_redemptions_user_idx` ON `voucher_redemptions` (`user_id`);--> statement-breakpoint
CREATE INDEX `voucher_upload_items_upload_idx` ON `voucher_upload_items` (`upload_id`);--> statement-breakpoint
CREATE INDEX `voucher_uploads_uploader_idx` ON `voucher_uploads` (`uploaded_by`);--> statement-breakpoint
CREATE INDEX `vouchers_status_idx` ON `vouchers` (`status`);--> statement-breakpoint
CREATE INDEX `vouchers_dates_idx` ON `vouchers` (`start_date`,`end_date`);--> statement-breakpoint
CREATE INDEX `wallet_txn_wallet_idx` ON `wallet_transactions` (`wallet_id`);--> statement-breakpoint
CREATE INDEX `wallet_txn_user_idx` ON `wallet_transactions` (`user_id`);--> statement-breakpoint
CREATE INDEX `wallet_txn_created_idx` ON `wallet_transactions` (`created_at`);