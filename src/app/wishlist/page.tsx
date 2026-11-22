import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { Card, PageHeader } from "@/components/ui";
import { ScanListTile } from "@/components/smart-list/scan-list-tile";
import { getCurrentUser } from "@/server/authz/guards";
import { getBoardLang } from "@/server/board-lang";
import { isFeatureEnabled } from "@/server/services/feature-flags";
import { listWishlists } from "@/server/services/smart-list/wishlist";

export const metadata = { title: "My wishlists" };
export const dynamic = "force-dynamic";

/** docs/smart-shopping-2026-11: the customer's saved wishlists (from photo lists), to reuse or re-order. */
export default async function WishlistsPage() {
  if (!(await isFeatureEnabled("smart_list_scan_enabled"))) notFound();
  const user = await getCurrentUser();
  if (!user) redirect("/signin?next=/wishlist");
  const [lists, lang] = await Promise.all([listWishlists(user.id), getBoardLang()]);
  return (
    <>
      <PageHeader title="My wishlists" description="Lists you scanned or typed. Open one to edit it, compare shop prices again or re-order." />
      <div className="mb-4">
        <ScanListTile lang={lang} />
      </div>
      {lists.length === 0 ? (
        <Card className="p-5 text-sm text-ink-600">No wishlists yet — scan your shopping list to make one.</Card>
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2" data-testid="wishlists">
          {lists.map((l) => (
            <li key={l.id}>
              <Link href={`/wishlist/${l.id}`} className="block rounded-2xl border bg-white p-4 hover:shadow-md">
                <div className="font-bold">{l.name}</div>
                <div className="text-sm text-ink-600">
                  {l.items} items · {l.scanId ? "📸 from a photo · " : ""}
                  {new Date(l.updatedAt).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric", timeZone: "Asia/Kolkata" })}
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
