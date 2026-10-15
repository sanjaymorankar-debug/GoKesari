import { AccountsHeader, AccountsNav } from "@/components/accounts/accounts-nav";
import { BillCapture } from "@/components/accounts/bill-capture";
import { tr } from "@/lib/board/i18n";
import { ACCOUNTS_TILES } from "@/lib/accounts/menu";
import { loadAccountsPage } from "@/server/accounts/page";

export const metadata = { title: "Add a supplier bill" };
export const dynamic = "force-dynamic";

/** docs/inventory-accounting-2026-10, Parts 4–5: scan, upload or type a supplier bill. */
export default async function CapturePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  const { shop, lang, shopQuery } = await loadAccountsPage(params);
  const upload = ACCOUNTS_TILES.find((t) => t.key === "upload")!;
  return (
    <div className="mx-auto w-full max-w-5xl">
      <AccountsNav lang={lang} current="capture" shopQuery={shopQuery} />
      <AccountsHeader title={tr(upload.label, lang)} subtitle={`${shop.name} — add a purchase bill from your supplier`} />
      <BillCapture shopId={shop.id} lang={lang} startWithScanner={params.mode === "scan"} shopQuery={shopQuery} />
    </div>
  );
}
