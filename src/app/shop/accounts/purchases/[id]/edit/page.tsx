import { notFound } from "next/navigation";

import { AccountsHeader, AccountsNav } from "@/components/accounts/accounts-nav";
import { BillReview } from "@/components/accounts/bill-review";
import { Alert } from "@/components/ui";
import { purchaseToDraft } from "@/lib/accounts/bill-draft";
import { stateOfGstin } from "@/lib/accounts/gst-math";
import { AppError } from "@/lib/errors";
import { loadAccountsPage } from "@/server/accounts/page";
import { getPurchase, purchaseAsInput } from "@/server/accounts/purchases";
import { reviewFiles, reviewListings } from "@/server/accounts/review-data";

export const metadata = { title: "Correct purchase bill" };
export const dynamic = "force-dynamic";

/**
 * docs/inventory-accounting-2026-10, Part 6: reopen a confirmed bill. Saving
 * posts reversing + corrected entries (stock, books, ITC) and logs every change.
 */
export default async function CorrectPurchasePage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const { shop, lang, shopQuery } = await loadAccountsPage(await searchParams);
  let detail;
  try {
    detail = await getPurchase(shop.id, id);
  } catch (error) {
    if (error instanceof AppError && error.code === "NOT_FOUND") notFound();
    throw error;
  }
  const { purchase } = detail;
  if (purchase.status !== "CONFIRMED") {
    return (
      <div className="mx-auto w-full max-w-3xl">
        <AccountsNav lang={lang} current="purchases" shopQuery={shopQuery} />
        <Alert tone="info">A cancelled bill cannot be corrected.</Alert>
      </div>
    );
  }
  const [input, files, listings] = await Promise.all([purchaseAsInput(shop.id, id), reviewFiles(shop.id, purchase.fileIds), reviewListings(shop.id)]);
  const names = Object.fromEntries(listings.map((l) => [l.shopProductId, { name: l.name, sellableUnit: l.sellableUnit }]));
  const draft = purchaseToDraft(
    {
      ...input,
      totals: { taxablePaise: purchase.taxablePaise, cgstPaise: purchase.cgstPaise, sgstPaise: purchase.sgstPaise, igstPaise: purchase.igstPaise, cessPaise: purchase.cessPaise, totalPaise: purchase.totalPaise },
    },
    names,
    stateOfGstin(shop.gstin),
  );
  return (
    <div className="mx-auto w-full max-w-7xl">
      <AccountsNav lang={lang} current="purchases" shopQuery={shopQuery} />
      <AccountsHeader title={`Correct bill ${purchase.invoiceNo}`} subtitle={`${purchase.supplierName} · version ${purchase.version}. Saving keeps the old version in the history and posts reversing + corrected entries.`} />
      <BillReview
        shopId={shop.id}
        mode="correction"
        id={purchase.id}
        status="READY_FOR_REVIEW"
        progress={100}
        stage={null}
        error={null}
        engine={purchase.engine}
        initialDraft={draft}
        initialIssues={[]}
        files={files}
        listings={listings}
        shopQuery={shopQuery}
      />
    </div>
  );
}
