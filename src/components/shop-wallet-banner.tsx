import { Alert, LinkButton, Money } from "@/components/ui";

/**
 * "Recharge wallet" notice on the shop's pages (rule shopWallet). Purely
 * presentational: the server decides whether the shop may accept orders, and
 * refuses an accept on its own when it may not.
 */
export function ShopWalletBanner({
  enabled,
  balancePaise,
  minBalancePaise,
  canAcceptOrders,
  lowBalance,
}: {
  enabled: boolean;
  balancePaise: number;
  minBalancePaise: number;
  canAcceptOrders: boolean;
  lowBalance: boolean;
}) {
  if (!enabled || (canAcceptOrders && !lowBalance)) return null;
  return (
    <div className="mb-6" data-testid="shop-wallet-banner">
      <Alert tone={canAcceptOrders ? "warning" : "danger"} title={canAcceptOrders ? "Shop wallet running low" : "Recharge wallet to accept orders"}>
        <p>
          Your shop wallet balance is <Money paise={balancePaise} />.{" "}
          {canAcceptOrders ? (
            <>
              Below <Money paise={minBalancePaise} /> you cannot accept new orders and customers cannot order from your shop.
            </>
          ) : (
            <>
              You need at least <Money paise={minBalancePaise} /> to accept new orders. Until then customers see your shop as not
              taking orders and cannot check out from it. Orders already accepted carry on as usual.
            </>
          )}
        </p>
        <div className="mt-2">
          <LinkButton href="/shop/wallet">Recharge wallet</LinkButton>
        </div>
      </Alert>
    </div>
  );
}
