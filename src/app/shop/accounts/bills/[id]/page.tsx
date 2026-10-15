import { notFound } from "next/navigation";

import { AccountsHeader, AccountsNav } from "@/components/accounts/accounts-nav";
import { BillReview } from "@/components/accounts/bill-review";
import type { BillDraft } from "@/lib/accounts/bill-draft";
import { AppError } from "@/lib/errors";
import { getCapture } from "@/server/accounts/capture/service";
import { loadAccountsPage } from "@/server/accounts/page";
import { reviewFiles, reviewListings } from "@/server/accounts/review-data";

export const metadata = { title: "Check bill" };
export const dynamic = "force-dynamic";

/** docs/inventory-accounting-2026-10, Part 6: the review & correction screen for one bill. */
export default async function BillReviewPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const { shop, lang, shopQuery } = await loadAccountsPage(await searchParams);
  let capture;
  try {
    capture = await getCapture(shop.id, id);
  } catch (error) {
    if (error instanceof AppError && error.code === "NOT_FOUND") notFound();
    throw error;
  }
  const [files, listings] = await Promise.all([reviewFiles(shop.id, capture.fileIds), reviewListings(shop.id)]);
  const draft = capture.draft as unknown as BillDraft | null;
  return (
    <div className="mx-auto w-full max-w-7xl">
      <AccountsNav lang={lang} current="bills" shopQuery={shopQuery} />
      <AccountsHeader title="Check the bill" subtitle="Compare with the original, correct anything misread, then confirm." />
      <BillReview
        key={`${capture.status}-${capture.updatedAt.getTime()}`}
        shopId={shop.id}
        mode="capture"
        id={capture.id}
        status={capture.status}
        progress={capture.progress}
        stage={capture.stage}
        error={capture.error}
        engine={capture.engine}
        initialDraft={draft}
        initialIssues={capture.issues}
        files={files}
        listings={listings}
        shopQuery={shopQuery}
      />
    </div>
  );
}
