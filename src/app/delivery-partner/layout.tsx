import { eq } from "drizzle-orm";
import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { RiderBottomNav } from "@/components/rider-bottom-nav";
import { RiderShell, type RiderShellProps } from "@/components/rider-shell/rider-shell";
import { REQUEST_PATH_HEADER } from "@/lib/request-path";
import { getCurrentUser } from "@/server/authz/guards";
import { PERMISSIONS, can } from "@/server/authz/permissions";
import { getBoardLang } from "@/server/board-lang";
import { db } from "@/server/db";
import { deliveryPartners, orders } from "@/server/db/schema";
import { getMyActiveDeliveryOrder } from "@/server/services/delivery-assignment";
import { getAvailabilityGate, getMyDeliveryPartnerProfile } from "@/server/services/delivery-partners";
import { getRule } from "@/server/services/settings";
import { riderDualVerifyRedirect } from "@/server/dual-auth/policy";

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

async function riderVerifyAt(): Promise<string | null> {
  const user = await getCurrentUser();
  if (!user) return null;
  const path = (await headers()).get(REQUEST_PATH_HEADER) || "/delivery-partner";
  return riderDualVerifyRedirect(user.id, path);
}

/** The phone tab bar of docs/ux-mobile-2026-11, for delivery partners who do not get the v2 frame. */
async function plainTabBar(): Promise<React.ReactNode> {
  const user = await getCurrentUser();
  if (!user) return null;
  const [partner, lang] = await Promise.all([getMyDeliveryPartnerProfile(user.id).catch(() => null), getBoardLang()]);
  return partner ? <RiderBottomNav lang={lang} approved={partner.status === "APPROVED"} /> : null;
}

/**
 * Rider App v2 (rule riderAppV2, on by default since 26-Nov-2026): approved riders get the
 * header (Online/Offline, Help, SOS, tier badge) and the v2 bottom bar on /delivery-partner
 * and its sub-pages. Everyone else who is a delivery partner (rule switched off, still
 * applying, not approved) gets the plain phone tab bar (docs/ux-mobile-2026-11) instead,
 * never both. Each page still runs its own sign-in and checks.
 */
export default async function DeliveryPartnerLayout({ children }: { children: React.ReactNode }) {
  // docs/flows-v3 (flag flow_f1, with dual_auth in force): applying and working as a rider need a verified mobile
  // AND e-mail first. Off, or on error: the pages behave as before.
  const verifyAt = await riderVerifyAt().catch(() => null);
  if (verifyAt) redirect(verifyAt);
  const shell = await loadShell().catch((error) => {
    console.error("[rider-shell] frame skipped", error);
    return null;
  });
  if (shell) return <RiderShell {...shell}>{children}</RiderShell>;
  const tabBar = await plainTabBar().catch(() => null);
  return (
    <>
      {children}
      {tabBar}
    </>
  );
}
