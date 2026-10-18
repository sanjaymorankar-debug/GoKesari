import { redirect } from "next/navigation";

import { ShopFeeForm } from "@/components/aftercare/shop-fee-form";
import { Alert, Card, PageHeader } from "@/components/ui";
import { formatPaise } from "@/lib/money";
import { activeShop } from "@/server/active-shop";
import { getCurrentUser } from "@/server/authz/guards";
import { can, PERMISSIONS } from "@/server/authz/permissions";
import { describeFeePolicy, getShopCancellationFeeSettings } from "@/server/aftercare/cancellation-fee";
import { listShopsForOwner } from "@/server/services/shops";

export const metadata = { title: "Cancellation fee" };
export const dynamic = "force-dynamic";

/**
 * F6.1.3 (batch-2026-10 WS-C): the shop's own fee for a customer cancelling
 * an order after it was packed, within GoKesari's limits.
 */
export default async function ShopCancellationFeePage() {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");
  if (!can(user.role, PERMISSIONS.SHOP_CANCELLATION_FEE_MANAGE_OWN)) redirect("/shop");
  const shops = await listShopsForOwner(user.id);
  if (shops.length === 0) redirect("/shop");
  const shop = await activeShop(shops);
  const view = await getShopCancellationFeeSettings(shop.id, user);
  const { rule, own, effective } = view;
  const platformDefault = describeFeePolicy({
    feeType: rule.defaultFeeType,
    feePaise: rule.defaultFeePaise,
    feeBp: rule.defaultFeeBp,
    capPaise: rule.defaultCapPaise,
  });

  return (
    <>
      <PageHeader
        title="Cancellation fee after packing"
        description={`${shop.name} — when a customer cancels an order you have already packed, this fee is kept from their refund and shown to them before they confirm.`}
      />
      <div className="space-y-4">
        {!rule.enabled ? (
          <Alert tone="info" title="Not switched on yet">
            GoKesari has not turned on cancellation after packing, so customers cannot cancel packed orders yet. You can still set your fee now.
          </Alert>
        ) : null}
        <Card className="space-y-1 p-5 text-sm" data-testid="fee-summary">
          <p>
            <strong>Fee now:</strong> {effective.active ? view.effectiveLabel : "no fee"} ({own ? "your shop's setting" : "GoKesari's default"})
          </p>
          <p className="text-ink-600">GoKesari default: {platformDefault}</p>
          <p className="text-ink-600">
            Limits: at most {formatPaise(rule.maxFeePaise)}, or {(rule.maxFeeBp / 100).toFixed(2)}% of the items.{" "}
            {rule.feeBeneficiary === "SHOP" ? "The fee is paid to your shop in the next settlement." : "The fee is kept by GoKesari."}
          </p>
        </Card>
        {rule.shopOverrideAllowed ? (
          <ShopFeeForm
            shopId={shop.id}
            initial={{
              enabled: own?.enabled ?? true,
              feeType: own?.feeType ?? rule.defaultFeeType,
              feePaise: own?.feePaise ?? rule.defaultFeePaise,
              feeBp: own?.feeBp ?? rule.defaultFeeBp,
              capPaise: own?.capPaise ?? null,
              own: own != null,
            }}
            limits={{ maxFeePaise: rule.maxFeePaise, maxFeeBp: rule.maxFeeBp }}
          />
        ) : (
          <Alert tone="info">GoKesari&apos;s default fee applies to every shop; shops cannot set their own.</Alert>
        )}
      </div>
    </>
  );
}
