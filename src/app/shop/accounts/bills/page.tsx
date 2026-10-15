import Link from "next/link";

import { AccountsHeader, AccountsNav } from "@/components/accounts/accounts-nav";
import { Badge, EmptyState, LinkButton } from "@/components/ui";
import { tr } from "@/lib/board/i18n";
import { ACCOUNTS_TILES } from "@/lib/accounts/menu";
import { listCaptures } from "@/server/accounts/capture/service";
import { loadAccountsPage } from "@/server/accounts/page";

export const metadata = { title: "Bills to check" };
export const dynamic = "force-dynamic";

const STATUS: Record<string, { label: string; tone: "neutral" | "success" | "warning" | "danger" | "info" }> = {
  QUEUED: { label: "Waiting to be read", tone: "info" },
  PROCESSING: { label: "Reading…", tone: "info" },
  READY_FOR_REVIEW: { label: "Ready to check", tone: "warning" },
  CONFIRMED: { label: "In your books", tone: "success" },
  FAILED: { label: "Could not read", tone: "danger" },
  DISCARDED: { label: "Discarded", tone: "neutral" },
};

/** docs/inventory-accounting-2026-10: every bill uploaded, scanned, shared or emailed, newest first. */
export default async function BillsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  const { shop, lang, shopQuery } = await loadAccountsPage(params);
  const showAll = params.all === "1";
  const rows = await listCaptures(shop.id, showAll ? undefined : ["QUEUED", "PROCESSING", "READY_FOR_REVIEW", "FAILED"]);
  const tile = ACCOUNTS_TILES.find((t) => t.key === "review")!;
  const q = shopQuery ? `${shopQuery}&` : "?";
  return (
    <div className="mx-auto w-full max-w-5xl">
      <AccountsNav lang={lang} current="bills" shopQuery={shopQuery} />
      <AccountsHeader
        title={tr(tile.label, lang)}
        subtitle="Nothing reaches your stock until you check a bill and confirm it."
        action={<LinkButton href={`/shop/accounts/capture${shopQuery}`}>+ Add bill</LinkButton>}
      />
      <p className="mb-2 text-sm">
        <Link href={`/shop/accounts/bills${showAll ? shopQuery : `${q}all=1`}`} className="font-semibold text-kesari-800 underline">
          {showAll ? "Show only bills to check" : "Show all, including confirmed"}
        </Link>
      </p>
      {rows.length === 0 ? (
        <EmptyState title="No bills waiting" description="Scan a paper bill or upload a PDF / e-invoice to add stock." />
      ) : (
        <ul className="space-y-1.5" data-testid="bills-list">
          {rows.map((r) => (
            <li key={r.id}>
              <Link href={r.status === "CONFIRMED" && r.purchaseInvoiceId ? `/shop/accounts/purchases/${r.purchaseInvoiceId}${shopQuery}` : `/shop/accounts/bills/${r.id}${shopQuery}`} className="flex min-h-14 items-center gap-3 rounded-2xl border border-[var(--gk-line)] bg-white px-3 py-2 hover:bg-kesari-50">
                <div className="min-w-0 flex-1">
                  <p className="truncate font-semibold text-ink-900">{[r.supplier, r.invoiceNo].filter(Boolean).join(" · ") || "Bill"}</p>
                  <p className="text-xs text-ink-600">
                    {new Date(r.createdAt).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", dateStyle: "medium", timeStyle: "short" })} · {r.kind === "HARD" ? "paper (scanned)" : "soft copy"} · {r.pages} page{r.pages === 1 ? "" : "s"} · {r.source.toLowerCase()}
                  </p>
                </div>
                <Badge tone={STATUS[r.status].tone}>{r.status === "PROCESSING" ? `${STATUS[r.status].label} ${r.progress}%` : STATUS[r.status].label}</Badge>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
