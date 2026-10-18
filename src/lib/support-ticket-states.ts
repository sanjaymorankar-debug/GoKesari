/**
 * Help desk ticket lifecycle (F6.3.3, SM-006) — client-safe constants.
 *
 *   OPEN → ACKNOWLEDGED → IN_PROGRESS → AWAITING_CUSTOMER / AWAITING_SHOP
 *        → RESOLVED → CLOSED
 *   plus ESCALATED (manual, or automatic on an SLA breach) and REOPENED
 *   (the requester is not satisfied with a resolution).
 *
 * Rules of the table below:
 *  - Support may jump ahead (OPEN → IN_PROGRESS, OPEN → RESOLVED for a quick
 *    answer); every move out of OPEN counts as the acknowledgement.
 *  - CLOSED only follows RESOLVED (the requester confirms, or the resolved
 *    ticket closes itself after rule helpdesk.autoCloseResolvedAfterDays).
 *  - CLOSED is final; a RESOLVED ticket can be REOPENED.
 *  - An ESCALATED ticket goes back into work, or is resolved.
 */
export const TICKET_STATUSES = [
  "OPEN",
  "ACKNOWLEDGED",
  "IN_PROGRESS",
  "AWAITING_CUSTOMER",
  "AWAITING_SHOP",
  "ESCALATED",
  "RESOLVED",
  "REOPENED",
  "CLOSED",
] as const;
export type TicketStatus = (typeof TICKET_STATUSES)[number];

const WORKING: readonly TicketStatus[] = ["IN_PROGRESS", "AWAITING_CUSTOMER", "AWAITING_SHOP", "ESCALATED", "RESOLVED"];

export const TICKET_TRANSITIONS: Record<TicketStatus, readonly TicketStatus[]> = {
  OPEN: ["ACKNOWLEDGED", ...WORKING],
  ACKNOWLEDGED: WORKING,
  IN_PROGRESS: ["AWAITING_CUSTOMER", "AWAITING_SHOP", "ESCALATED", "RESOLVED"],
  AWAITING_CUSTOMER: ["IN_PROGRESS", "AWAITING_SHOP", "ESCALATED", "RESOLVED"],
  AWAITING_SHOP: ["IN_PROGRESS", "AWAITING_CUSTOMER", "ESCALATED", "RESOLVED"],
  ESCALATED: ["IN_PROGRESS", "AWAITING_CUSTOMER", "AWAITING_SHOP", "RESOLVED"],
  RESOLVED: ["CLOSED", "REOPENED"],
  REOPENED: ["ACKNOWLEDGED", ...WORKING],
  CLOSED: [],
};

export function canMoveTicket(from: TicketStatus, to: TicketStatus): boolean {
  return TICKET_TRANSITIONS[from]?.includes(to) ?? false;
}

/** Still being worked (counts against the SLA clock). */
export const LIVE_TICKET_STATUSES: readonly TicketStatus[] = [
  "OPEN",
  "ACKNOWLEDGED",
  "IN_PROGRESS",
  "AWAITING_CUSTOMER",
  "AWAITING_SHOP",
  "ESCALATED",
  "REOPENED",
];

export function isTicketLive(status: string): boolean {
  return (LIVE_TICKET_STATUSES as readonly string[]).includes(status);
}

export const TICKET_STATUS_LABELS: Record<TicketStatus, string> = {
  OPEN: "Open",
  ACKNOWLEDGED: "Acknowledged",
  IN_PROGRESS: "In progress",
  AWAITING_CUSTOMER: "Waiting for your reply",
  AWAITING_SHOP: "Waiting for the shop",
  ESCALATED: "Escalated",
  RESOLVED: "Resolved",
  REOPENED: "Reopened",
  CLOSED: "Closed",
};

/** Staff wording where "your" would be wrong. */
export const TICKET_STATUS_STAFF_LABELS: Record<TicketStatus, string> = {
  ...TICKET_STATUS_LABELS,
  AWAITING_CUSTOMER: "Awaiting requester",
};

export const TICKET_CATEGORIES = [
  "ORDER",
  "DELIVERY",
  "CANCELLATION",
  "REFUND_PAYMENT",
  "PRODUCT_QUALITY",
  "WALLET",
  "ACCOUNT",
  "SHOP_PAYOUT",
  "GRIEVANCE",
  "OTHER",
] as const;
export type TicketCategory = (typeof TICKET_CATEGORIES)[number];

export const TICKET_CATEGORY_LABELS: Record<TicketCategory, string> = {
  ORDER: "An order",
  DELIVERY: "Delivery",
  CANCELLATION: "Cancellation",
  REFUND_PAYMENT: "Refund or payment",
  PRODUCT_QUALITY: "Product quality",
  WALLET: "Wallet",
  ACCOUNT: "My account",
  SHOP_PAYOUT: "Shop payout or settlement",
  GRIEVANCE: "Formal grievance",
  OTHER: "Something else",
};

export const TICKET_PRIORITIES = ["LOW", "NORMAL", "HIGH", "URGENT"] as const;
export type TicketPriority = (typeof TICKET_PRIORITIES)[number];
