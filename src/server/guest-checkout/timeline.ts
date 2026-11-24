/**
 * docs/guest-checkout-2026-11: one timeline over a multi-shop purchase — each shop's order keeps its
 * own status (each shop prepares and delivers its part), and an overall line says where the whole
 * purchase stands. Pure: the pages pass in rows they have already read.
 */

export type ChildStatus =
  | "PENDING"
  | "CONFIRMED"
  | "PREPARING"
  | "READY"
  | "OUT_FOR_DELIVERY"
  | "DELIVERED"
  | "CANCELLED"
  | "PAYMENT_FAILED"
  | "WALLET_INSUFFICIENT"
  | "REFUND_PENDING"
  | "REFUNDED"
  | "ACCEPTED"
  | "ASSIGNED"
  | "PICKED_UP"
  | "FAILED"
  | "RETURNED"
  | "DISPUTED";

/** The steps every order goes through, in order. */
export const TIMELINE_STAGES = ["PLACED", "ACCEPTED", "PACKING", "ON_THE_WAY", "DELIVERED"] as const;
export type TimelineStage = (typeof TIMELINE_STAGES)[number];

export const STAGE_LABELS: Record<TimelineStage, string> = {
  PLACED: "Order placed",
  ACCEPTED: "Accepted by shop",
  PACKING: "Being packed",
  ON_THE_WAY: "On the way",
  DELIVERED: "Delivered",
};

/** Statuses after which an order will not move forward (it did not reach the customer). */
const STOPPED: ReadonlySet<ChildStatus> = new Set(["CANCELLED", "PAYMENT_FAILED", "REFUND_PENDING", "REFUNDED", "FAILED", "RETURNED"]);

export function stageOf(status: ChildStatus): TimelineStage | null {
  switch (status) {
    case "PENDING":
    case "WALLET_INSUFFICIENT":
      return "PLACED";
    case "CONFIRMED":
    case "ACCEPTED":
      return "ACCEPTED";
    case "PREPARING":
    case "READY":
      return "PACKING";
    case "ASSIGNED":
    case "PICKED_UP":
    case "OUT_FOR_DELIVERY":
      return "ON_THE_WAY";
    case "DELIVERED":
    case "DISPUTED":
      return "DELIVERED";
    default:
      return null;
  }
}

export interface TimelineChild {
  id: string;
  shopName: string;
  status: ChildStatus;
  statusLabel: string;
}

export interface TimelineEvent {
  orderId: string;
  status: ChildStatus;
  at: Date;
}

export interface GroupTimeline {
  /** Where the whole purchase stands. */
  overall: { stage: TimelineStage | "STOPPED"; label: string; delivered: number; active: number; stopped: number };
  /** Each step with how many of the shop orders have reached it (stopped orders not counted). */
  stages: { stage: TimelineStage; label: string; reached: number; of: number }[];
  /** Per shop: its own stage, for the "status per shop" rows. */
  shops: { orderId: string; shopName: string; status: ChildStatus; statusLabel: string; stage: TimelineStage | null; stopped: boolean }[];
  /** Every status change of every shop order, oldest first, with the shop named. */
  events: { orderId: string; shopName: string; status: ChildStatus; statusLabel: string; at: Date }[];
}

export function buildGroupTimeline(
  children: TimelineChild[],
  history: TimelineEvent[],
  labelOf: (status: ChildStatus) => string = (s) => s,
): GroupTimeline {
  const shops = children.map((c) => ({
    orderId: c.id,
    shopName: c.shopName,
    status: c.status,
    statusLabel: c.statusLabel,
    stage: STOPPED.has(c.status) ? null : stageOf(c.status),
    stopped: STOPPED.has(c.status),
  }));
  const active = shops.filter((s) => !s.stopped);
  const delivered = active.filter((s) => s.stage === "DELIVERED").length;
  const stopped = shops.length - active.length;
  const rank = (s: TimelineStage | null) => (s ? TIMELINE_STAGES.indexOf(s) : 0);

  let overall: GroupTimeline["overall"];
  if (shops.length === 0 || active.length === 0) {
    overall = { stage: "STOPPED", label: shops.length === 0 ? "No orders" : "Cancelled", delivered: 0, active: 0, stopped };
  } else {
    // The purchase is as far along as its slowest live shop order.
    const slowest = TIMELINE_STAGES[Math.min(...active.map((s) => rank(s.stage)))];
    let label: string = STAGE_LABELS[slowest];
    if (slowest === "DELIVERED") label = stopped > 0 ? "Delivered (some items cancelled)" : "Delivered";
    else if (delivered > 0) label = `Partly delivered — ${delivered} of ${active.length} shops`;
    overall = { stage: slowest, label, delivered, active: active.length, stopped };
  }

  const stages = TIMELINE_STAGES.map((stage) => ({
    stage,
    label: STAGE_LABELS[stage],
    reached: active.filter((s) => rank(s.stage) >= TIMELINE_STAGES.indexOf(stage)).length,
    of: active.length,
  }));

  const nameOf = new Map(children.map((c) => [c.id, c.shopName]));
  const events = history
    .filter((e) => nameOf.has(e.orderId))
    .map((e) => ({ orderId: e.orderId, shopName: nameOf.get(e.orderId)!, status: e.status, statusLabel: labelOf(e.status), at: e.at }))
    .sort((a, b) => a.at.getTime() - b.at.getTime());

  return { overall, stages, shops, events };
}
