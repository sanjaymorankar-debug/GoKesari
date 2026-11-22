import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { PageHeader } from "@/components/ui";
import { WishlistEditor, type EditorItem } from "@/components/smart-list/wishlist-editor";
import type { BaseUnit } from "@/lib/qty-words";
import { getCurrentUser } from "@/server/authz/guards";
import { getBoardLang } from "@/server/board-lang";
import { isFeatureEnabled } from "@/server/services/feature-flags";
import { getRule } from "@/server/services/settings";
import { getWishlist } from "@/server/services/smart-list/wishlist";

export const metadata = { title: "Wishlist" };
export const dynamic = "force-dynamic";

const STATUS: Record<string, string> = { IN_CART: "In cart", ORDERED: "Ordered", NOT_ORDERED: "Not ordered" };

export default async function WishlistPage({ params }: { params: Promise<{ id: string }> }) {
  if (!(await isFeatureEnabled("smart_list_scan_enabled"))) notFound();
  const user = await getCurrentUser();
  const { id } = await params;
  if (!user) redirect(`/signin?next=/wishlist/${id}`);
  const list = await getWishlist(user.id, id).catch(() => null);
  if (!list) notFound();
  const [lang, rule] = await Promise.all([getBoardLang(), getRule("smartShopping")]);
  const items: EditorItem[] = list.items.map((i) => ({
    key: i.id,
    originalText: i.originalText,
    originalLang: i.originalLang,
    nameEn: i.nameEn,
    nameLocal: i.nameLocal,
    productId: i.productId,
    productName: i.product?.name ?? null,
    aiProductId: i.aiProductId,
    matchConfidence: i.matchConfidence,
    candidates: [],
    quantityAmount: i.quantityAmount,
    quantityUnit: i.quantityUnit as BaseUnit,
    userEdited: i.userEdited,
    status: i.status,
  }));
  const notOrdered = list.items.filter((i) => i.status === "NOT_ORDERED");
  return (
    <>
      <PageHeader title={list.name} description="Check the items, then compare prices at shops near you." />
      <div className="mb-4 flex flex-wrap gap-2">
        <Link href={`/wishlist/${id}/compare`} className="inline-flex h-12 items-center rounded-xl bg-kesari-600 px-5 font-bold text-white" data-testid="compare-link">
          Compare shop prices
        </Link>
        {notOrdered.length > 0 ? (
          <Link href={`/wishlist/${id}/compare?pending=1`} className="inline-flex h-12 items-center rounded-xl border-2 border-kesari-600 px-5 font-bold text-kesari-800">
            Order the {notOrdered.length} not-ordered items from another shop
          </Link>
        ) : null}
        {list.scanId ? (
          <a href={`/api/smart-list/scans/${list.scanId}/pages/1`} target="_blank" rel="noreferrer" className="inline-flex h-12 items-center rounded-xl border px-4 text-sm font-semibold">
            📸 Original photo
          </a>
        ) : null}
      </div>
      {list.items.some((i) => i.status !== "PENDING") ? (
        <ul className="mb-4 flex flex-wrap gap-2 text-xs" data-testid="wishlist-status">
          {list.items
            .filter((i) => i.status !== "PENDING")
            .map((i) => (
              <li key={i.id} className={`rounded-full px-2.5 py-1 ${i.status === "NOT_ORDERED" ? "bg-red-50 text-red-800" : "bg-leaf-50 text-leaf-800"}`}>
                {i.nameEn}: {STATUS[i.status] ?? i.status}
              </li>
            ))}
        </ul>
      ) : null}
      <WishlistEditor lang={lang} initial={items} lowConfidenceBelow={rule.lowConfidenceBelow} wishlistId={id} initialName={list.name} />
    </>
  );
}
