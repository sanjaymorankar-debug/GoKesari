/**
 * docs/onboarding-v2-2026-11, step 5 (server part): the customer's orders still waiting for a delivery location,
 * with their saved addresses and the optional referral box. Renders nothing when no order waits — which is always
 * the case with the flag off (only a v2 checkout leaves an order waiting).
 */
import { cookies } from "next/headers";

import { DeliveryLocationPrompt } from "@/components/onboarding-v2/delivery-location-prompt";
import { REFERRAL_COOKIE } from "@/lib/customer-referrals";
import { listOrdersAwaitingAddress } from "@/server/onboarding-v2/customer";
import { listAddresses } from "@/server/services/addresses";
import { getSignupReferral } from "@/server/services/customer-signup-referrals";

export async function PendingDeliveryLocation({ userId, placed = false, onlyOrderId }: { userId: string; placed?: boolean; onlyOrderId?: string }) {
  const all = await listOrdersAwaitingAddress(userId).catch(() => []);
  const pending = onlyOrderId ? all.filter((o) => o.id === onlyOrderId) : all;
  if (pending.length === 0) return null;
  const [addresses, given] = await Promise.all([listAddresses(userId), getSignupReferral(userId).catch(() => null)]);
  // The code remembered from a /r/<code> link (gk_ref) is offered pre-filled.
  const prefill = given ? null : ((await cookies()).get(REFERRAL_COOKIE)?.value ?? "");
  return (
    <div className="mb-4">
      <DeliveryLocationPrompt
        placed={placed}
        orders={pending.map((o) => ({ id: o.id, orderNumber: o.orderNumber, shopName: o.shopName, totalPaise: o.totalPaise, paymentMethod: o.paymentMethod }))}
        addresses={addresses.map((a) => ({ id: a.id, label: a.label, line1: a.line1, area: a.area, city: a.city, pincode: a.pincode }))}
        referral={prefill == null ? null : { prefill }}
      />
    </div>
  );
}
