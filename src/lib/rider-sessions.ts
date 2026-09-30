/**
 * KPI-013: how long a rider may go without a location heartbeat and still be
 * counted as online. Shared by the session bookkeeping in delivery-partners.ts
 * and the online-hours KPI in analytics.ts so the two can never disagree.
 */
export const RIDER_IDLE_CAP_MINUTES = 15;
