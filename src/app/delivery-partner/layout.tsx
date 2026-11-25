import { eq } from "drizzle-orm";
import { headers } from "next/headers";

import { RiderShell, type RiderShellProps } from "@/components/rider-shell/rider-shell";
import { REQUEST_PATH_HEADER } from "@/lib/request-path";
import { getCurrentUser } from "@/server/authz/guards";
import { PERMISSIONS, can } from "@/server/authz/permissions";
import { getBoardLang } from "@/server/board-lang";
import { db } from "@/server/db";
import { deliveryPartners, orders } from "@/server/db/schema";
import { getMyActiveDeliveryOrder } from "@/server/services/delivery-assignment";
import { getAvailabilityGate } from "@/server/services/delivery-partners";
import { getRule } from "@/server/services/settings";

/** Rider pages that never get the v2 frame: the application and sign-up forms. */
const NO_SHELL = ["/delivery-partner/apply", "/delivery-partner/register"];

/**
 * What the Rider App v2 frame needs, or null when it is not shown: rule
 * riderAppV2 off, not signed in, not an approved rider, the Delivery Partner
 * role not the active one, or an application / sign-up page. Best-effort: any
 * failure leaves the page exactly as without the frame.
 */
async function loadShell(): Promise<RiderShellProps | null> {
  const path = (await headers()).get(REQUEST_PATH_HEADER) ?? "";
  if (NO_SHELL.some((p) => path === p || path.startsWith(`${p}/`))) return null;
  if (!(await getRule("riderAppV2")).enabled) return null;
  const user = await getCurrentUser();
  if (!user || !can(user.role, PERMISSIONS.DELIVERY_ORDER_MANAGE_OWN)) return null;
  const partner = await db.query.deliveryPartners.findFirst({ where: eq(deliveryPartners.userId, user.id) });
  if (!partner || partner.deletedAt || partner.status !== "APPROVED") return null;

  const [lang, gate, active, sos, tiers] = await Promise.all([
    getBoardLang(),
    getAvailabilityGate(partner),
    getMyActiveDeliveryOrder(user.id),
    getRule("riderSos"),
    getRule("riderTiers"),
  ]);
  const activeOrder = active
    ? await db.query.orders.findFirst({ where: eq(orders.id, active.orderId), columns: { orderNumber: true } })
    : null;
  return {
    availability: partner.availability,
    canGoOnline: gate.allowed,
    hasActiveDelivery: Boolean(active),
    activeOrderNumber: activeOrder?.orderNumber ?? null,
    sosNumber: sos.enabled ? sos.emergencyNumber : null,
    tiersOn: tiers.enabled,
    lang,
  };
}

/**
 * Rider App v2 (rule riderAppV2, off by default): approved riders get the
 * header (Online/Offline, Help, SOS, tier badge) and the bottom bar on
 * /delivery-partner and its sub-pages. With the rule off every page renders
 * exactly as before; each page still runs its own sign-in and checks.
 */
export default async function DeliveryPartnerLayout({ children }: { children: React.ReactNode }) {
  const shell = await loadShell().catch((error) => {
    console.error("[rider-shell] frame skipped", error);
    return null;
  });
  if (!shell) return children;
  return <RiderShell {...shell}>{children}</RiderShell>;
}
