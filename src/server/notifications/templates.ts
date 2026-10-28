/**
 * Notification templates and categories.
 *
 * A template gives an event its wording (`{{variables}}` filled in by
 * `render`), the category users can opt in or out of, and whether email is on
 * by default. Callers that already have their own text keep passing
 * title/body; the catalogue below covers every important event so new call
 * sites can just say `notify({ type, userId, vars })`.
 */
import { NOTIFICATION_TYPES as T } from "./types";

export type Channel = "IN_APP" | "EMAIL" | "SMS" | "PUSH" | "WHATSAPP";
export const OUTBOUND_CHANNELS = ["EMAIL", "SMS", "PUSH", "WHATSAPP"] as const;
export type OutboundChannel = (typeof OUTBOUND_CHANNELS)[number];

export const CATEGORIES = {
  ORDERS: { label: "Your orders", description: "Placed, accepted, rider assigned, picked up, delivered, cancelled." },
  RETURNS: { label: "Returns & refunds", description: "Return requests, pickups, refunds." },
  DELIVERY: { label: "Deliveries", description: "Delivery offers and rider or dispatch updates." },
  SHOP: { label: "Shop operations", description: "New orders, approvals, suspensions, stock alerts." },
  WALLET: { label: "Wallet", description: "Top-ups and balance reminders." },
  SUBSCRIPTIONS: { label: "Subscriptions", description: "Upcoming and changed subscription deliveries." },
  COMMUNITY: { label: "Society", description: "Society membership and security notices." },
  ACCOUNT_SECURITY: { label: "Account & security", description: "Sign-ins, number and role changes. Always sent." },
  GENERAL: { label: "Other updates", description: "Everything else." },
  ANNOUNCEMENTS: { label: "Announcements", description: "News and offers GoKesari sends to everyone or to your area." }, // batch-2026-10 WS-F
} as const;
export type CategoryKey = keyof typeof CATEGORIES;

/** Categories the user cannot switch off. */
export const MANDATORY_CATEGORIES: readonly CategoryKey[] = ["ACCOUNT_SECURITY"];

const PREFIX_CATEGORY: [string, CategoryKey][] = [
  ["order.", "ORDERS"],
  ["return.", "RETURNS"],
  // A dispute is the customer's complaint about an order they already have.
  ["dispute.", "RETURNS"],
  ["delivery", "DELIVERY"],
  ["shop.", "SHOP"],
  ["inventory.", "SHOP"],
  ["product.", "SHOP"],
  ["wallet.", "WALLET"],
  ["subscription.", "SUBSCRIPTIONS"],
  ["society.", "COMMUNITY"],
  ["rating.", "COMMUNITY"],
  // A campaign's approval or rejection is news for its shop's owner. Shop
  // promotions themselves are not routed here: sendCampaign messages only
  // customers who granted marketing consent (the switch on /profile).
  ["marketing.campaign_decided", "SHOP"],
  ["security.", "ACCOUNT_SECURITY"],
  ["auth.", "ACCOUNT_SECURITY"],
  // Event layer: support alerts and risk flags are operations news (GENERAL).
  ["broadcast.", "ANNOUNCEMENTS"], // batch-2026-10 WS-F
];

export function categoryOf(type: string): CategoryKey {
  return PREFIX_CATEGORY.find(([prefix]) => type.startsWith(prefix))?.[1] ?? "GENERAL";
}

export interface Template {
  title: string;
  body: string;
  /** Email is sent by default (users can turn the category off). */
  emailByDefault: boolean;
}

const t = (title: string, body: string, emailByDefault = true): Template => ({ title, body, emailByDefault });

/** Important events. Variables are documented in the body text. */
export const TEMPLATES: Record<string, Template> = {
  [T.ORDER_CONFIRMED]: t("Order placed", "Your order {{orderNumber}} from {{shopName}} is confirmed."),
  [T.SHOP_ORDER_WHILE_CLOSED]: t(
    "New order while your shop is closed",
    "Order {{orderNumber}} ({{amount}}) was placed while {{shopName}} is closed; the customer chose to wait. You will get another alert when your shop opens.",
  ),
  [T.SHOP_OPENED_ORDERS_WAITING]: t(
    "Your shop is open — orders are waiting",
    "{{count}} order(s) placed while {{shopName}} was closed are waiting for you to accept.",
  ),
  [T.ORDER_QUEUED_SHOP_CLOSED]: t(
    "Order placed — shop is closed now",
    "Your order {{orderNumber}} was sent to {{shopName}}. The shop is closed right now, so it may be processed once it opens{{opensAt}}.",
  ),
  [T.ORDER_SHOP_NOW_OPEN]: t("The shop is open now", "{{shopName}} is open now and can accept your order {{orderNumber}}."),
  [T.ORDER_ACCEPTED]: t("Order accepted", "{{shopName}} accepted your order {{orderNumber}} and is preparing it."),
  [T.ORDER_ASSIGNED]: t("Rider assigned", "A rider has been assigned to your order {{orderNumber}}."),
  [T.ORDER_RIDER_ARRIVING]: t("Your rider is arriving", "Your rider for order {{orderNumber}} has reached you. Keep your delivery code ready."),
  [T.ORDER_PICKED_UP]: t("Order picked up", "Your order {{orderNumber}} has been picked up and is on its way."),
  [T.ORDER_DELIVERED]: t("Order delivered", "Your order {{orderNumber}} has been delivered. Enjoy!"),
  [T.ORDER_CANCELLED]: t("Order cancelled", "Your order {{orderNumber}} was cancelled. {{reason}}"),
  [T.ORDER_DELIVERY_FAILED]: t("Delivery attempt failed", "We could not deliver order {{orderNumber}}. {{reason}}"),
  [T.DISPUTE_OPENED]: t(
    "We are looking into your order",
    "Dispute {{caseNumber}} has been opened for order {{orderNumber}} and is with our team.",
  ),
  [T.DISPUTE_RESOLUTION_PROPOSED]: t(
    "We have proposed a resolution",
    "For dispute {{caseNumber}} we have proposed: {{proposal}}. Reply to accept or tell us if this does not work.",
  ),
  [T.DISPUTE_RESOLVED]: t("Dispute resolved", "Dispute {{caseNumber}} is resolved. {{outcome}}"),
  [T.DISPUTE_REJECTED]: t("Dispute closed", "Dispute {{caseNumber}} was closed without a refund: {{reason}}"),
  [T.RETURN_REQUESTED]: t("Return requested", "Return {{returnNumber}} has been requested and is awaiting review."),
  [T.RETURN_APPROVED]: t("Return approved", "Return {{returnNumber}} is approved. {{nextStep}}"),
  [T.RETURN_REJECTED]: t("Return declined", "Return {{returnNumber}} was declined: {{reason}}"),
  [T.RETURN_REFUND_INITIATED]: t("Refund started", "Your refund of {{amount}} for return {{returnNumber}} is being processed."),
  [T.RETURN_REFUND_COMPLETED]: t("Refund completed", "{{amount}} for return {{returnNumber}} is back in your wallet."),
  [T.SHOP_SUSPENDED]: t(
    "Your shop has been suspended",
    "{{shopName}} was suspended on {{effectiveAt}}. Reason: {{reason}}. {{impact}} {{expectedAction}}",
  ),
  [T.SHOP_REACTIVATED]: t("Your shop is open again", "{{shopName}} has been reinstated and can take orders again."),
  [T.DELIVERY_SEARCH_STOPPED]: t(
    "Rider assignment failed",
    "No rider could be found for order {{orderNumber}}. {{detail}} You can try again or deliver it yourself.",
  ),
  [T.SECURITY_SIGN_IN]: t("New sign-in to your account", "Someone signed in to your Gokesari account at {{at}}. If this was not you, contact support."),
  [T.SECURITY_PHONE_CHANGED]: t("Mobile number changed", "The mobile number on your account was {{action}}. If this was not you, contact support."),
  [T.SECURITY_ROLE_CHANGED]: t("Account role changed", "Your account role was changed: {{detail}}."),
  [T.SECURITY_ACCOUNT_STATUS]: t("Account status changed", "Your account was {{status}}. {{detail}}"),
  [T.SHOP_APPROVED]: t("Shop approved", "{{shopName}} is approved and can start selling."),
  [T.SHOP_REJECTED]: t("Shop not approved", "{{shopName}} was not approved: {{reason}}"),
  [T.SHOP_DOCUMENTS_REMINDER]: t(
    "Upload your documents to go live",
    "{{shopName}} is waiting for your documents: {{documents}}. Upload them so we can verify them and approve your shop.",
  ),
  [T.SHOP_STAFF_ADDED]: t(
    "You can now edit a shop's products",
    "{{ownerName}} added you to {{shopName}}: you can add and change its product photos and descriptions.",
  ),
  [T.SHOP_STAFF_REMOVED]: t("Shop access removed", "You can no longer edit product photos and descriptions for {{shopName}}.", false),
  [T.SHOP_SELF_REGISTERED]: t(
    "Your shop is live on GoKesari",
    "{{shopName}} is approved — shop no. {{registrationNumber}}. Sign in with your mobile number {{mobile}} to complete your profile and add products. Fee receipt {{receiptNumber}}.",
  ),
  [T.INTEGRATION_SYNC_FAILED]: t(
    "Could not send to your accounting software",
    "{{shopName}}: {{what}} — {{reason}} {{fix}}",
  ),
  [T.SHOP_MEDIA_IMPORT_FINISHED]: t(
    "Bulk photo upload finished",
    "{{shopName}}: {{applied}} applied, {{failed}} could not be applied. Open the upload for details.",
    false,
  ),
  [T.SHOP_PRODUCT_IMPORT_FINISHED]: t(
    "Bulk product upload finished",
    "{{shopName}}: {{fileName}} — {{created}} created, {{updated}} updated, {{deactivated}} deactivated, {{failed}} failed. Open the upload for the full report.",
    false,
  ),
  [T.GRIEVANCE_RESOLVED]: t("Your complaint was resolved", "Ticket {{ticket}} has been resolved."),
  /* ------------------------------------- event layer (docs/event-driven-2026-10) */
  [T.ORDER_READY]: t("Order packed", "Your order {{orderNumber}} is packed and ready.", false),
  [T.ORDER_OUT_FOR_DELIVERY]: t(
    "Your order is on the way",
    "Your rider has left with order {{orderNumber}}. Track it live from your orders page and keep your delivery code ready.",
  ),
  [T.ORDER_RIDER_SEARCH]: t("Finding a rider", "We are assigning a rider to your order {{orderNumber}}.", false),
  [T.SHOP_RIDER_SEARCH_STARTED]: t(
    "Finding a rider",
    "Order {{orderNumber}}: the offer has gone to a rider near you. You will hear as soon as one accepts.",
    false,
  ),
  [T.SHOP_RIDER_DECLINED]: t(
    "Rider declined — asking the next one",
    "Order {{orderNumber}}: a rider {{why}}. We are offering it to the next nearest rider now.",
    false,
  ),
  [T.SHOP_RIDER_ASSIGNED]: t(
    "Rider on the way to you",
    "{{riderName}} accepted order {{orderNumber}} and is coming to collect it. Read them the pickup code shown on the order.",
  ),
  [T.SHOP_ORDER_PICKED_UP]: t("Order picked up", "Order {{orderNumber}} has been collected by {{riderName}}.", false),
  [T.SHOP_ORDER_OUT_FOR_DELIVERY]: t("Order on the way", "{{riderName}} is on the way to the customer with order {{orderNumber}}.", false),
  [T.SHOP_ORDER_DELIVERED]: t("Order delivered", "Order {{orderNumber}} has been delivered to the customer."),
  [T.SHOP_ACCEPT_ESCALATED]: t(
    "Order waiting — support will call",
    "Order {{orderNumber}} was not accepted within {{minutes}} minutes. Our support team has been asked to follow up; accept or reject it now.",
  ),
  [T.DELIVERY_CANCELLED]: t("Delivery cancelled", "Order {{orderNumber}} no longer needs you: {{reason}}"),
  [T.SHOP_DOCUMENT_IN_REVIEW]: t(
    "{{docLabel}} is being reviewed",
    "{{shopName}}'s {{docLabel}} needs a quick check by our team. Nothing to do now — we will tell you as soon as it is decided.",
  ),
  [T.SHOP_DISPUTE_OPENED]: t(
    "Dispute opened on an order",
    "The customer opened dispute {{caseNumber}} on order {{orderNumber}}: {{reason}}. Reply on the case so support has your side.",
  ),
  [T.DISPUTE_UPDATED]: t("Dispute {{caseNumber}} updated", "Dispute {{caseNumber}} on order {{orderNumber}} is now {{status}}. {{detail}}"),
  [T.DISPUTE_COMMENT]: t("New reply on dispute {{caseNumber}}", "{{author}} wrote on dispute {{caseNumber}}: {{excerpt}}"),
  [T.SUPPORT_ACCEPT_OVERDUE]: t(
    "Shop has not accepted an order",
    "Order {{orderNumber}} at {{shopName}} was not accepted within {{minutes}} minutes. Contact the shop, or cancel it with a refund.",
  ),
  [T.SUPPORT_RIDER_UNASSIGNED]: t(
    "No rider for an order",
    "Order {{orderNumber}} at {{shopName}} has had no rider accept for {{minutes}} minutes ({{attempts}} offers). Assign one by hand or ask the shop to deliver.",
  ),
  [T.SUPPORT_NOTIFICATION_DEAD]: t(
    "Notifications could not be sent",
    "{{count}} message(s) failed after {{attempts}} attempts and were given up — latest: {{type}} by {{channel}} ({{error}}). Check the channel, then retry them from Notifications.",
    false,
  ),
  [T.SUPPORT_SELLER_REVIEW]: t(
    "Seller document to review",
    "{{shopName}}'s {{docLabel}} needs a manual review ({{why}}).",
  ),
  [T.SUPPORT_SELLER_REVIEW_REMINDER]: t(
    "Seller documents waiting for review",
    "{{count}} seller document(s) have waited more than {{hours}} hours for review — oldest: {{oldest}}.",
  ),
  [T.SUPPORT_SELLER_DECIDED]: t("Seller document decided", "{{shopName}}'s {{docLabel}} was {{decision}} by {{by}}. {{reason}}", false),
  [T.SUPPORT_SHOP_SELF_REGISTERED]: t(
    "New self-registered shop",
    "{{shopName}} ({{registrationNumber}}) registered with code {{referralCode}} and paid {{fee}}. It is live; its profile is not complete yet.",
    false,
  ),
  [T.SUPPORT_REGISTRATION_PAYMENT_MISMATCH]: t(
    "Registration payment needs attention",
    "{{problem}} Shop: {{shopName}}; paid {{paid}} against a fee of {{fee}} (order {{orderId}}). Check it in Admin → Shop registrations.",
    false,
  ),
  [T.SUPPORT_SHOP_AUTO_APPROVED]: t(
    "Shop approved automatically",
    "{{shopName}} was approved automatically: every mandatory document is verified and nothing else was outstanding.",
    false,
  ),
  [T.SUPPORT_DISPUTE_OPENED]: t(
    "New dispute {{caseNumber}}",
    "Dispute {{caseNumber}} on order {{orderNumber}} ({{amount}}, {{reason}}) was opened{{level}}.",
  ),
  [T.SUPPORT_DISPUTE_UPDATED]: t("Dispute {{caseNumber}} updated", "{{detail}}", false),
  [T.SUPPORT_DISPUTE_ESCALATED]: t(
    "Dispute {{caseNumber}} escalated to you",
    "Dispute {{caseNumber}} on order {{orderNumber}} was escalated: {{why}}",
  ),
  [T.RISK_FLAG_RAISED]: t("Risk flag raised", "{{severity}} — {{label}}: {{summary}}", false),
  // Time-critical for the shop (it has acceptMinutes to act) or the seller (they
  // must act on the result): emailed by default as well as in the app.
  [T.SHOP_NEW_ORDER]: t("New order", "Order {{orderNumber}} is waiting for you to accept it."),
  [T.SHOP_ACCEPT_REMINDER]: t("Accept the new order", "Order {{orderNumber}} is cancelled automatically unless you accept it in the next {{minutes}} min."),
  [T.SHOP_ORDER_TIMED_OUT]: t("Order cancelled — not accepted in time", "Order {{orderNumber}} was cancelled and the customer refunded because it was not accepted in time."),
  [T.SHOP_DOCUMENT_VERIFIED]: t("{{docLabel}} verified", "{{shopName}}'s {{docLabel}} has been verified."),
  [T.SHOP_DOCUMENT_ATTENTION]: t("{{docLabel}} needs your attention", "We couldn't verify {{shopName}}'s {{docLabel}}. {{detail}}"),
  /* Shop wallet & delivery code (docs/shop-wallet-delivery-otp-2026-10). */
  [T.SHOP_WALLET_TOPUP_SUCCESS]: t("Shop wallet recharged", "{{amount}} was added to {{shopName}}'s wallet. New balance: {{balance}}."),
  [T.SHOP_WALLET_LOW_BALANCE]: t("Recharge your shop wallet", "{{shopName}}'s wallet balance is {{balance}}. {{detail}}"),
  [T.SHOP_BILL_READY]: t("Bill ready to check", "Your bill {{label}} has been read. Check it and confirm to add the stock.", false),
  [T.SHOP_GST_DUE_REMINDER]: t("GST return due", "{{label}} is due on {{dueDate}}. Verify with your CA before filing."),
  [T.SHOP_WALLET_ADJUSTED]: t("Shop wallet adjusted", "{{amount}} was {{change}} {{shopName}}'s wallet by GoKesari: {{reason}}. New balance: {{balance}}."),
  [T.DELIVERY_CONFIRMED]: t("Delivery confirmed", "Order {{orderNumber}} is confirmed as delivered. Thank you!", false),
  [T.ORDER_DELIVERY_CODE_LOCKED]: t(
    "We're checking your delivery",
    "Too many wrong delivery codes were entered for order {{orderNumber}}, so the delivery is on hold. Our support team will contact you (ticket {{ticketNumber}}). Never share your code until you have your order.",
  ),
  [T.SHOP_DELIVERY_CODE_LOCKED]: t(
    "Delivery code locked",
    "Too many wrong delivery codes were entered for order {{orderNumber}}. Support is confirming the delivery with the customer (ticket {{ticketNumber}}).",
    false,
  ),
  [T.SUPPORT_DELIVERY_CODE_LOCKED]: t(
    "Delivery code locked — confirm the drop",
    "Order {{orderNumber}} ({{shopName}}): {{attempts}} wrong delivery codes, so the rider cannot complete it. Ticket {{ticketNumber}}. Call the customer, then confirm the delivery or mark it failed from the exceptions queue.",
  ),
  /* >>> batch-2026-10 WS-A (payments, OTP, reference prices) — add entries below this line only */
  [T.ORDER_PAYMENT_CAPTURED]: t("Payment received", "We received your payment of {{amount}} for {{reference}}. Thank you!"),
  [T.ORDER_PAYMENT_FAILED]: t(
    "Payment failed",
    "Your payment of {{amount}} for {{reference}} did not go through{{reason}}. Open the order to try again.",
  ),
  [T.ORDER_PAYMENT_EXPIRED]: t(
    "Payment not completed",
    "The payment of {{amount}} for {{reference}} was not completed in time. Open the order to pay again.",
  ),
  [T.ORDER_PAYMENT_REFUNDED]: t(
    "Refund sent",
    "{{amount}} for {{reference}} has been refunded to your original payment method. Banks usually take 5–7 working days to show it.",
  ),
  [T.SUPPORT_PAYMENT_ATTENTION]: t("Payment needs attention", "{{reference}}: {{problem}}", false),
  /* <<< end WS-A */
  //
  /* >>> batch-2026-10 WS-B (dispatch, QR pickup, navigation) — add entries below this line only */
  [T.DELIVERY_BROADCAST_OFFERED]: t(
    "Delivery available — first to accept gets it",
    "Order {{orderNumber}} from {{shopName}} (~{{distanceKm}} km from you) is open to riders nearby. Accept it before someone else does.",
    false,
  ),
  [T.DELIVERY_OFFER_TAKEN]: t("Offer taken", "Order {{orderNumber}} was accepted by another rider.", false),
  [T.SHOP_RIDER_OFFER_BROADCAST]: t(
    "Asking all riders nearby",
    "Order {{orderNumber}}: the first rider did not accept in time, so the offer has gone to every rider within {{radiusKm}} km. You will hear as soon as one accepts.",
    false,
  ),
  /* <<< end WS-B */
  //
  /* >>> batch-2026-10 WS-C (cancellation fee, refunds, help desk) — add entries below this line only */
  [T.ORDER_REFUND_UPDATED]: t("Refund {{statusLabel}} — order {{orderNumber}}", "{{amount}} {{detail}}"),
  [T.SHOP_ORDER_CANCELLED_AFTER_PACKING]: t(
    "Packed order cancelled by the customer",
    "Order {{orderNumber}} was cancelled after packing. A {{fee}} cancellation fee was kept{{beneficiaryNote}}. Please put the items back in stock.",
  ),
  [T.TICKET_RECEIVED]: t(
    "We've received your request — {{ticketNumber}}",
    "Ticket {{ticketNumber}} ({{subject}}) is with our support team. We will acknowledge it by {{acknowledgeBy}} and aim to resolve it by {{resolveBy}}.",
  ),
  [T.TICKET_STATUS_CHANGED]: t("Ticket {{ticketNumber}}: {{statusLabel}}", "Your ticket {{ticketNumber}} ({{subject}}) is now {{statusLabel}}. {{note}}"),
  [T.TICKET_REPLY]: t("New reply on ticket {{ticketNumber}}", "{{author}}: {{excerpt}}"),
  [T.TICKET_CSAT_REQUESTED]: t("How did we do? — {{ticketNumber}}", "Your ticket {{ticketNumber}} is closed. Please rate the help you got (1–5)."),
  [T.SHOP_TICKET_AWAITING]: t(
    "Support needs your reply — {{ticketNumber}}",
    "A ticket about order {{orderNumber}} needs the shop's input: {{subject}}. Reply from Support tickets.",
  ),
  [T.SUPPORT_TICKET_NEW]: t("New ticket {{ticketNumber}}", "{{category}} — {{subject}} (from {{requester}}). Acknowledge by {{acknowledgeBy}}.", false),
  [T.SUPPORT_TICKET_ASSIGNED]: t("Ticket {{ticketNumber}} assigned to you", "{{subject}} — resolve by {{resolveBy}}."),
  [T.SUPPORT_TICKET_ESCALATED]: t("Ticket {{ticketNumber}} escalated", "{{subject}}: {{why}}"),
  [T.SUPPORT_TICKET_REPLY]: t("Reply on ticket {{ticketNumber}}", "{{author}}: {{excerpt}}", false),
  /* <<< end WS-C */
  //
  /* >>> batch-2026-10 WS-D (operator-limited, product master data) — add entries below this line only */
  [T.SHOP_ONBOARDED_BY_OPERATOR]: t(
    "Your shop has been registered",
    "{{operatorName}} registered {{shopName}} for you on GoKesari after you confirmed the code we emailed. Registration {{registrationNumber}} is now with our team.",
  ),
  [T.SHOP_REGISTRATION_FEE_LINK]: t(
    "Pay your GoKesari registration fee",
    "Pay the registration fee of {{amount}} for {{shopName}} here: {{link}} — the link works until {{expiresAt}}.",
  ),
  [T.SHOP_REGISTRATION_FEE_PAID]: t(
    "Registration fee received",
    "We received the registration fee of {{amount}} for {{shopName}}. {{nextStep}}",
  ),
  [T.SHOP_REGISTRATION_FEE_FAILED]: t(
    "Registration fee not received",
    "The registration fee for {{shopName}} was not paid ({{reason}}). The shop now waits for an administrator's approval.",
    false,
  ),
  [T.SUPPORT_SHOP_FEE_FAILED]: t(
    "Shop waiting for approval — fee not paid",
    "{{shopName}} was onboarded by {{operatorName}} but its registration fee was not paid ({{reason}}). It is pending administrator approval.",
    false,
  ),
  [T.PMD_IMPORT_FINISHED]: t(
    "Product import finished",
    "{{fileName}}: {{staged}} product(s) staged, {{failed}} row(s) need attention ({{status}}).",
    false,
  ),
  /* <<< end WS-D */
  //
  /* >>> batch-2026-10 WS-E (invoicing, payouts, statutory) — add entries below this line only */
  // Emailed with the document attached by the document outbox (documents/email.ts), so no plain copy here.
  [T.SHOP_INVOICE_COPY]: t("Invoice {{invoiceNumber}} issued", "Order {{orderNumber}} was delivered and invoice {{invoiceNumber}} ({{amount}}) was issued to the customer in your shop's name.", false),
  [T.SHOP_PAYOUT_PAID]: t("Payout {{amount}} paid", "{{shopName}}'s payout for {{period}} was paid to your bank account. Bank reference (UTR): {{utr}}. Your statement is in Finance → Statements.", false),
  [T.SHOP_PAYOUT_HELD]: t("Payout on hold", "{{shopName}}'s payout of {{amount}} for {{period}} is on hold: {{reason}} It moves to the next payout cycle."),
  [T.SHOP_PAYOUT_FAILED]: t("Payout could not be paid", "The transfer of {{amount}} to {{shopName}}'s bank account failed: {{reason}} {{next}}"),
  [T.SHOP_PLATFORM_INVOICE]: t("GoKesari invoice {{invoiceNumber}}", "GoKesari's tax invoice {{invoiceNumber}} for its fees ({{amount}} incl. GST) for {{period}} is in Finance → Statements.", false),
  [T.SUPPORT_PAYOUT_BATCH_DRAFTED]: t("Payout batch ready to approve", "The payout batch for {{period}} has {{items}} shop payment(s) totalling {{amount}} ({{held}} held). Approve it in Admin → Payouts.", false),
  [T.SUPPORT_PAYOUT_FAILED]: t("Payout failed", "The payout of {{amount}} to {{shopName}} failed after {{attempts}} attempt(s): {{reason}}", false),
  /* <<< end WS-E */
  //
  /* >>> batch-2026-10 WS-F (notifications, push, broadcasts, mobile) — add entries below this line only */
  // A broadcast carries its own title and message; email only for people who switched Announcements email on.
  [T.BROADCAST]: t("{{title}}", "{{message}}", false),
  [T.SUPPORT_BROADCAST_FINISHED]: t(
    "Broadcast sent",
    "\"{{title}}\" reached {{recipients}} people.",
    false,
  ),
  /* <<< end WS-F */
  //
  /* >>> purchase lists (docs/purchase-lists-2026-10) */
  [T.PURCHASE_LIST_DUE]: t(
    "Time to reorder: {{listName}}",
    "Your {{frequency}} list \"{{listName}}\" is due. Update the quantities and order it in a minute.",
    false,
  ),
  // docs/dealer-programme
  [T.DEALER_APPLICATION_RECEIVED]: t(
    "Dealer application received",
    "Thank you, {{legalName}}. Your GoKesari dealer application is with our team for approval. We will tell you when it is decided.",
  ),
  [T.DEALER_STATUS_CHANGED]: t("Dealer account: {{statusLabel}}", "Your GoKesari dealer account is now {{statusLabel}}. {{detail}}"),
  [T.DEALER_SHOP_ATTRIBUTED]: t("New shop: {{shopName}}", "{{shopName}} ({{area}}) registered and is counted for you{{employee}}. It earns commission as it completes the onboarding milestones."),
  [T.DEALER_LEAD_CLOSED]: t("Lead closed: {{shopName}}", "Your lead for {{shopName}} was closed: {{reason}}. If you believe the shop is yours, raise a claim from your dealer page."),
  [T.DEALER_DISPUTE_DECIDED]: t("Your claim was {{decision}}", "Your claim about the shop with mobile ending {{phoneTail}} was {{decision}}. {{note}}"),
  [T.DEALER_ASSISTED_SHOP_REGISTERED]: t(
    "{{dealerName}} registered your shop",
    "{{dealerName}}, an authorised GoKesari dealer, registered {{shopName}} for you. Open My shop to pay the registration fee and finish your registration.",
  ),
  [T.DEALER_PAYOUT_PAID]: t("Commission paid: {{amount}}", "GoKesari paid you {{amount}} in dealer commission (bank reference {{reference}}). Your statement is on your dealer page."),
  [T.DEALER_RATING_CHANGED]: t("Your dealer rating is now {{rating}}", "GoKesari changed your onboarding rating to {{rating}}. Reason: {{reason}}. It applies to commission earned from now on."),
  [T.DEALER_SHOP_APPROVED]: t("Shop approved: {{shopName}}", "{{shopName}}, counted for you, is approved and can now add products and take orders."),
  [T.SHOP_READY_FOR_PRODUCT_UPLOAD]: t(
    "Registration successful — {{shopName}} is ready for product upload",
    "Your GST/PAN was verified with the government records and your registration fee is received, so {{shopName}} (shop ID {{shopId}}) is approved. Add your products now: {{addProductsUrl}} — or upload many at once from Excel: {{bulkUploadUrl}}",
  ),
  [T.DEALER_DOCUMENT_REJECTED]: t(
    "Dealer document needs another upload",
    "Your {{docLabel}} was not accepted: {{note}} Please upload it again from your dealer application.",
  ),
  /* <<< end purchase lists */
  //
};

/** Fills `{{name}}` placeholders; a missing variable becomes an empty string and extra spaces are tidied. */
export function interpolate(text: string, vars: Record<string, string | number | null | undefined> = {}): string {
  return text
    .replace(/\{\{(\w+)\}\}/g, (_, key: string) => String(vars[key] ?? ""))
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\s+([.,])/g, "$1")
    .trim();
}

export function renderTemplate(
  type: string,
  vars: Record<string, string | number | null | undefined>,
): { title: string; body: string } | null {
  const template = TEMPLATES[type];
  return template ? { title: interpolate(template.title, vars), body: interpolate(template.body, vars) } : null;
}

export function emailByDefault(type: string): boolean {
  return TEMPLATES[type]?.emailByDefault ?? false;
}

/* ---------------------------------------------------------------- email */

const escapeHtml = (value: string) =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** A row under an e-mail's body: an order line, a fee, the total (TC-SPI-004). */
export interface EmailDetailRow {
  label: string;
  value: string;
}

export function renderEmail(input: {
  title: string;
  body: string;
  actionUrl?: string | null;
  baseUrl?: string;
  /** Rows shown under the body, e-mail only (the in-app notice, SMS and push keep the short body). */
  detail?: EmailDetailRow[];
}): {
  subject: string;
  text: string;
  html: string;
} {
  const rows = input.detail ?? [];
  const detailText = rows.length ? `\n${rows.map((r) => `${r.label}: ${r.value}`).join("\n")}\n` : "";
  const detailHtml = rows.length
    ? `<table style="border-collapse:collapse;width:100%;color:#44403c;font-size:14px;margin:0 0 12px">` +
      rows
        .map(
          (r) =>
            `<tr><td style="padding:4px 0;border-bottom:1px solid #f5f5f4">${escapeHtml(r.label)}</td>` +
            `<td style="padding:4px 0;border-bottom:1px solid #f5f5f4;text-align:right;white-space:nowrap">${escapeHtml(r.value)}</td></tr>`,
        )
        .join("") +
      `</table>`
    : "";
  // Only an in-app path ("/orders") or a full http(s) URL becomes a link; anything else is dropped.
  const raw = input.actionUrl ?? "";
  const link = raw.startsWith("/")
    ? `${(input.baseUrl ?? "").replace(/\/$/, "")}${raw}`
    : /^https?:\/\//i.test(raw)
      ? raw
      : null;
  const showLink = link !== null && /^https?:\/\//i.test(link);
  return {
    subject: `${input.title} — Gokesari`,
    text: `${input.title}\n\n${input.body}\n${detailText}${showLink ? `\n${link}\n` : ""}\nYou receive this because of your notification settings on Gokesari.`,
    html:
      `<div style="font-family:system-ui,sans-serif;max-width:480px">` +
      `<h2 style="margin:0 0 8px;color:#1c1917">${escapeHtml(input.title)}</h2>` +
      `<p style="color:#44403c;line-height:1.5">${escapeHtml(input.body)}</p>` +
      detailHtml +
      (showLink
        ? `<p><a href="${escapeHtml(link)}" style="display:inline-block;padding:10px 18px;background:#ea580c;color:#fff;border-radius:8px;text-decoration:none">Open in Gokesari</a></p>`
        : "") +
      `<p style="color:#78716c;font-size:12px">You receive this because of your notification settings on Gokesari.</p></div>`,
  };
}

/**
 * The customer's delivery code email (delivery-otp.ts). Sent directly and never
 * stored or queued — the database keeps only a hash of the code.
 */
export function renderDeliveryCodeEmail(input: {
  code: string;
  orderNumber: string;
  shopName: string;
}): { subject: string; text: string; html: string } {
  return {
    subject: `${input.code} is your delivery code for order ${input.orderNumber}`,
    text:
      `Your order ${input.orderNumber} from ${input.shopName} is on the way.\n\n` +
      `Delivery code: ${input.code}\n\n` +
      `Give it to the rider only once you have your order in hand. It works once. ` +
      `You can get a new code from your orders page on Gokesari.\n`,
    html:
      `<p>Your order ${escapeHtml(input.orderNumber)} from ${escapeHtml(input.shopName)} is on the way.</p>` +
      `<p>Delivery code</p>` +
      `<p style="font-size:28px;letter-spacing:6px;font-weight:600">${escapeHtml(input.code)}</p>` +
      `<p style="color:#666;font-size:12px">Give it to the rider only once you have your order in hand. It works once. ` +
      `You can get a new code from your orders page on Gokesari.</p>`,
  };
}

/** The sign-in code email. Rendered here for one consistent look, but never stored or queued. */
export function renderEmailChangeOtpEmail(code: string, expiryMinutes: number): { subject: string; text: string; html: string } {
  return {
    subject: `${code} is your Gokesari email confirmation code`,
    text:
      `Use ${code} to confirm this address as the new email on your Gokesari account.\n\n` +
      `It works once and expires in ${expiryMinutes} minutes. If you did not ask for this, ignore this email.\n`,
    html:
      `<p>Use this code to confirm this address as the new email on your Gokesari account:</p>` +
      `<p style="font-size:28px;letter-spacing:6px;font-weight:600">${escapeHtml(code)}</p>` +
      `<p style="color:#666;font-size:12px">It works once and expires in ${expiryMinutes} minutes. ` +
      `If you did not ask for this, ignore this email.</p>`,
  };
}

export function renderOtpEmail(code: string, expiryMinutes: number): { subject: string; text: string; html: string } {
  return {
    subject: `${code} is your Gokesari sign-in code`,
    text:
      `Your Gokesari sign-in code is ${code}.\n\n` +
      `It works once and expires in ${expiryMinutes} minutes. ` +
      `If you did not ask for it, ignore this email — nobody can sign in without the code.\n`,
    html:
      `<p>Your Gokesari sign-in code is</p>` +
      `<p style="font-size:28px;letter-spacing:6px;font-weight:600">${escapeHtml(code)}</p>` +
      `<p style="color:#666;font-size:12px">It works once and expires in ${expiryMinutes} minutes. ` +
      `If you did not ask for it, ignore this email.</p>`,
  };
}
