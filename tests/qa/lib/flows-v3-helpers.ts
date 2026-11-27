/**
 * Flow spec v3 (docs/flows-v3; flags flow_f1 … flow_f22, migrations 0221–0225: ON on test.gokesari.com since
 * 27-Nov-2026, OFF elsewhere unless switched on). The older checks whose Expected result a flag changes read the
 * flag here — Admin → Feature flags, read only, never switched — and assert the behaviour of the flag's state.
 * The flag decides which expected result applies; a check never accepts "either".
 *
 *   flow_f1   a guest's customer referral link goes to sign-up (/signin?ref=<code>)
 *   flow_f2   the cart's pay button reads "Choose how to pay" until a method is picked
 *   flow_f11  a rider applies with the account's verified mobile and e-mail (locked) and a photo
 *   flow_f15  a society applies with its authorised person and a proof document
 *   flow_f16  the customer may cancel until packing (full refund); a packed order only by asking the shop;
 *             food and medicines are not returnable (except damaged, wrong or expired)
 *   flow_f18  linking or changing the mobile needs an SMS code sent to the new number
 */
import { as } from "./actors";
import { shopOf, type Listing } from "./flows";
import { call, expectStatus } from "./http";
import { ruleOn } from "./orders-helpers";
import { blocked } from "./record";
import { IS_PROD } from "./target";

const known = new Map<string, boolean>();

/** Whether feature flag `key` is on on this site (on for every district, or for some). Read once per worker. */
export async function flowOn(key: string): Promise<boolean> {
  const cached = known.get(key);
  if (cached != null) return cached;
  if (IS_PROD) return false;
  const res = await call(await as("admin"), "GET", "/api/admin/feature-flags");
  if (res.status === 401 || res.status === 403) blocked(`the admin session cannot read the feature flags (HTTP ${res.status}) to know whether ${key} is on`);
  expectStatus(res, 200, "GET /api/admin/feature-flags");
  for (const f of (res.body?.flags ?? []) as { key: string; enabled: boolean; districtCodes: string[] | null }[]) {
    known.set(f.key, Boolean(f.enabled) && (f.districtCodes == null || f.districtCodes.length > 0));
  }
  if (!known.has(key)) known.set(key, false);
  return known.get(key)!;
}

/**
 * Whether the customer may cancel a packed order (READY / ASSIGNED) for a fee by themselves: rule
 * afterPackingCancellation on, and flow_f16 off — with flow_f16 on a packed order is cancelled only when the shop
 * agrees (src/server/flows/wave2-rules.ts afterPackingCancellationRule).
 */
export async function packedSelfCancelOpen(): Promise<boolean> {
  if (await flowOn("flow_f16")) return false;
  return ruleOn("afterPackingCancellation");
}

/** The default non-returnable shop types of rule orderFlowsV3 (src/server/config/rules.ts), used if the rule cannot be read. */
const DEFAULT_NON_RETURNABLE = ["FRUIT_VEGETABLE", "DAIRY", "BAKERY", "MEAT_SHOP", "SWEET_SHOP", "RESTAURANT", "FAST_FOOD", "CAFE", "PHARMACY"];

async function nonReturnable(): Promise<{ departments: Set<string>; slugs: Set<string> }> {
  const res = await call(await as("admin"), "GET", "/api/admin/settings");
  const rule = res.status === 200 ? ((res.body?.rules ?? []) as { key: string; value: Record<string, unknown> }[]).find((r) => r.key === "orderFlowsV3") : undefined;
  const departments = (rule?.value?.nonReturnableDepartments as string[] | undefined) ?? DEFAULT_NON_RETURNABLE;
  const slugs = (rule?.value?.nonReturnableCategorySlugs as string[] | undefined) ?? [];
  return { departments: new Set(departments), slugs: new Set(slugs) };
}

interface OpsListing {
  id: string;
  productId: string;
  onlinePricePaise: number | null;
  onlineSaleEnabled: boolean;
  isAvailable: boolean;
  trackInventory: boolean;
  onlineStock: number;
  product?: { name: string; mrpPaise?: number | null };
  category?: { department?: string | null; slug?: string | null } | null;
}

/**
 * A product of shop A that may be returned under flow_f16: on sale online, priced at least `minPricePaise`, with
 * `minStock` in stock, in a category outside the rule's food / medicine list (cheapest first). Blocks the check
 * when shop A sells none (test data).
 */
export async function returnableListing(minPricePaise = 0, minStock = 5): Promise<Listing> {
  const shop = await shopOf("A");
  const res = await call(await as("ops"), "GET", `/api/shops/${shop.id}/products?onlineOnly=true`);
  expectStatus(res, 200, "shop A's listings");
  const { departments, slugs } = await nonReturnable();
  const row = (res.body as OpsListing[])
    .filter((r) => r.onlineSaleEnabled && r.isAvailable && (r.onlinePricePaise ?? 0) >= Math.max(1, minPricePaise))
    .filter((r) => !r.trackInventory || r.onlineStock >= minStock)
    .filter((r) => !departments.has(r.category?.department ?? "") && !slugs.has(r.category?.slug ?? ""))
    .sort((a, b) => (a.onlinePricePaise ?? 0) - (b.onlinePricePaise ?? 0))[0];
  if (!row) blocked(`shop A sells no returnable product (outside food and medicines) priced ₹${minPricePaise / 100}+ with ${minStock}+ in stock`);
  return {
    shopProductId: row.id,
    productId: row.productId,
    name: row.product?.name ?? "",
    pricePaise: row.onlinePricePaise,
    mrpPaise: row.product?.mrpPaise ?? null,
    stock: row.trackInventory ? row.onlineStock : undefined,
    shopId: shop.id,
    shopName: shop.name,
  };
}

/**
 * The SMS code the MOCK provider wrote for `mobile10` (10 digits) at or after `since` (test site only; read with
 * the admin session, as lib/dual-auth.ts does). Null when none came.
 */
export async function mockSmsCode(mobile10: string, since: number, tries = 15): Promise<string | null> {
  for (let i = 0; i < tries; i++) {
    const out = await call(await as("admin"), "GET", `/api/admin/test-messages?to=${mobile10}`);
    const hit = ((out.body?.messages ?? []) as { body?: string; createdAt?: string }[]).find((m) => !m.createdAt || new Date(m.createdAt).getTime() >= since - 5_000);
    const code = hit?.body?.match(/\b(\d{6})\b/)?.[1];
    if (code) return code;
    await new Promise((r) => setTimeout(r, 2_000));
  }
  return null;
}

/**
 * The cart asks the customer to choose how to pay — nothing preselected, the pay button reads "Choose how to pay"
 * and is disabled until a method is picked (flow_f2, as onboarding v2 already does: src/components/cart-view.tsx
 * explicitPay).
 */
export async function paymentChoiceExplicit(): Promise<boolean> {
  return (await flowOn("flow_f2")) || (await flowOn("onboarding_v2"));
}
