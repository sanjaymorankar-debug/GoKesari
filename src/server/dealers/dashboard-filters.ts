/** docs/dealer-platform phase 6: the dashboard's filters from query parameters (defaults: the last 12 months, IST). */
import { DEALER_STATUSES, type DealerStatus } from "@/lib/dealers";

import type { DashboardFilters } from "./platform-dashboard";

const DATE = /^\d{4}-\d{2}-\d{2}$/;

export function dashboardFilters(params: Record<string, string | string[] | undefined>): DashboardFilters {
  const one = (k: string) => {
    const v = params[k];
    const s = (Array.isArray(v) ? v[0] : v)?.trim();
    return s ? s.slice(0, 60) : null;
  };
  const today = new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
  const yearAgo = new Date(Date.now() + 330 * 60_000 - 365 * 86_400_000).toISOString().slice(0, 10);
  const from = one("from");
  const to = one("to");
  const status = one("dealerStatus");
  const shop = one("shopStatus");
  return {
    from: from && DATE.test(from) ? from : yearAgo,
    to: to && DATE.test(to) ? to : today,
    scheme: one("scheme")?.toUpperCase().replace(/[^A-Z0-9_]/g, "") || null,
    dealerId: one("dealerId") && /^[0-9a-f-]{36}$/i.test(one("dealerId")!) ? one("dealerId") : null,
    state: one("state")?.toUpperCase().replace(/[^A-Z]/g, "").slice(0, 2) || null,
    district: one("district")?.toUpperCase().replace(/[^A-Z0-9-]/g, "") || null,
    city: one("city"),
    dealerStatus: status && (DEALER_STATUSES as readonly string[]).includes(status) ? (status as DealerStatus) : null,
    shopStatus: shop === "ACTIVATED" || shop === "NOT_ACTIVATED" ? shop : null,
  };
}
