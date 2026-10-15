import Link from "next/link";
import { notFound } from "next/navigation";

import { AccountsHeader, AccountsNav } from "@/components/accounts/accounts-nav";
import { CancelPurchase } from "@/components/accounts/purchase-actions";
import { Alert, Badge, Card, LinkButton } from "@/components/ui";
import { formatPaise } from "@/lib/money";
import { formatMilli } from "@/lib/accounts/units";
import { stateLabel } from "@/lib/gst-states";
import { AppError } from "@/lib/errors";
import { db } from "@/server/db";
import { accChangeLog, users } from "@/server/db/schema";
import { getPurchase } from "@/server/accounts/purchases";
import { loadAccountsPage } from "@/server/accounts/page";
import { and, desc, eq, inArray } from "drizzle-orm";

export const metadata = { title: "Purchase bill" };
export const dynamic = "force-dynamic";

const ITC: Record<string, string> = {
  PENDING_RECON: "Waiting for GSTR-2B match",
  MATCHED: "Matched with GSTR-2B — counted as input credit",
  MISMATCH: "Amount differs from GSTR-2B",
  NOT_ON_PORTAL: "Supplier has not reported it on the GST portal",
  INELIGIBLE: "Not eligible as input credit",
  REVERSED: "Reversed (corrected or cancelled)",
};

/** docs/inventory-accounting-2026-10: one purchase, its lines, ITC, original file and full change history. */
export default async function PurchasePage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const sp = await searchParams;
  const { shop, lang, shopQuery } = await loadAccountsPage(sp);
  let detail;
  try {
    detail = await getPurchase(shop.id, id);
  } catch (error) {
    if (error instanceof AppError && error.code === "NOT_FOUND") notFound();
    throw error;
  }
  const { purchase: p, lines, itc } = detail;
  const history = await db.select().from(accChangeLog).where(and(eq(accChangeLog.shopId, shop.id), eq(accChangeLog.entityId, id))).orderBy(desc(accChangeLog.createdAt));
  const actorIds = [...new Set(history.map((h) => h.actorId).filter(Boolean) as string[])];
  const names = actorIds.length ? await db.select({ id: users.id, name: users.name, email: users.email }).from(users).where(inArray(users.id, actorIds)) : [];
  const who = (uid: string | null) => names.find((n) => n.id === uid)?.name ?? names.find((n) => n.id === uid)?.email ?? "—";
  const currentItc = itc.find((r) => !r.supersededAt);
  return (
    <div className="mx-auto w-full max-w-5xl">
      <AccountsNav lang={lang} current="purchases" shopQuery={shopQuery} />
      {sp.confirmed ? <div className="mb-2"><Alert tone="success">Confirmed: stock added, supplier account and GST credit updated.</Alert></div> : null}
      {sp.corrected ? <div className="mb-2"><Alert tone="success">Correction saved: reversing and corrected entries posted. Stock, accounts and GST are back in step.</Alert></div> : null}
      <AccountsHeader
        title={`${p.supplierName} · ${p.invoiceNo}`}
        subtitle={`${p.invoiceDate} · ${p.supplierGstin ?? "unregistered supplier"} · place of supply ${stateLabel(p.placeOfSupply) ?? "—"} · ${p.interState ? "IGST" : "CGST + SGST"}`}
        action={
          p.status === "CONFIRMED" ? (
            <div className="flex flex-wrap gap-2">
              <LinkButton href={`/shop/accounts/purchases/${p.id}/edit${shopQuery}`}>Reopen & correct</LinkButton>
              <CancelPurchase shopId={shop.id} purchaseId={p.id} />
            </div>
          ) : (
            <Badge tone="neutral">Cancelled</Badge>
          )
        }
      />
      <div className="grid gap-3 lg:grid-cols-3">
        <Card className="overflow-x-auto p-0 lg:col-span-2">
          <table className="w-full min-w-[560px] text-sm">
            <thead className="bg-cream-50 text-left text-xs text-ink-600">
              <tr>
                <th className="p-2">#</th>
                <th className="p-2">Item → your product</th>
                <th className="p-2 text-right">Qty</th>
                <th className="p-2 text-right">Rate</th>
                <th className="p-2 text-right">GST</th>
                <th className="p-2 text-right">Total</th>
              </tr>
            </thead>
            <tbody>
              {lines.map((l) => (
                <tr key={l.id} className="border-t border-cream-100 align-top">
                  <td className="p-2">{l.lineNo}</td>
                  <td className="p-2">
                    {l.description}
                    <span className="block text-xs text-ink-600">
                      → {l.productName ?? "—"}
                      {l.stockQtyMilli != null ? ` · +${formatMilli(l.stockQtyMilli)} in stock` : ""}
                      {l.batchNo ? ` · batch ${l.batchNo}` : ""}
                      {l.expiryDate ? ` · exp ${l.expiryDate}` : ""}
                      {l.hsn ? ` · HSN ${l.hsn}` : ""}
                    </span>
                  </td>
                  <td className="p-2 text-right tabular-nums">{formatMilli(l.qtyMilli, l.unit)}</td>
                  <td className="p-2 text-right tabular-nums">{formatPaise(l.ratePaise)}</td>
                  <td className="p-2 text-right tabular-nums">{l.gstRateBp / 100}%</td>
                  <td className="p-2 text-right tabular-nums">{formatPaise(l.totalPaise)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
        <Card className="space-y-1 p-3 text-sm">
          <Row k="Taxable" v={formatPaise(p.taxablePaise)} />
          {p.interState ? <Row k="IGST" v={formatPaise(p.igstPaise)} /> : (<><Row k="CGST" v={formatPaise(p.cgstPaise)} /><Row k="SGST" v={formatPaise(p.sgstPaise)} /></>)}
          {p.cessPaise ? <Row k="Cess" v={formatPaise(p.cessPaise)} /> : null}
          {p.otherChargesPaise ? <Row k="Other charges" v={formatPaise(p.otherChargesPaise)} /> : null}
          {p.roundOffPaise ? <Row k="Round off" v={formatPaise(p.roundOffPaise)} /> : null}
          <Row k="Total" v={formatPaise(p.totalPaise)} strong />
          <p className="pt-2 text-xs text-ink-700">Input credit: {currentItc ? ITC[currentItc.status] : p.supplierGstin ? "No GST on this bill" : "None (unregistered supplier)"}</p>
          <p className="text-xs text-ink-700">Version {p.version} · {p.engine.toLowerCase().replace(/_/g, " ")}</p>
          {p.fileIds.length ? (
            <p className="text-xs">
              Original:{" "}
              {p.fileIds.map((f, i) => (
                <a key={f} href={`/api/shops/${shop.id}/accounts/files/${f}`} target="_blank" rel="noreferrer" className="mr-2 font-semibold text-kesari-800 underline">
                  page {i + 1}
                </a>
              ))}
            </p>
          ) : null}
        </Card>
      </div>
      <h2 className="mt-4 mb-2 text-base font-bold text-ink-900">History (who, when, old → new)</h2>
      <ol className="space-y-1.5" data-testid="purchase-history">
        {history.map((h) => (
          <li key={h.id} className="rounded-xl border border-[var(--gk-line)] bg-white p-2 text-sm">
            <p className="font-semibold">
              {h.action === "CONFIRM" ? "Confirmed" : h.action === "CORRECT" ? "Corrected" : h.action === "CANCEL" ? "Cancelled" : h.action} by {who(h.actorId)} ·{" "}
              {new Date(h.createdAt).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", dateStyle: "medium", timeStyle: "short" })}
            </p>
            {h.reason ? <p className="text-xs text-ink-700">Reason: {h.reason}</p> : null}
            {h.changes.length ? (
              <ul className="mt-1 text-xs text-ink-700">
                {h.changes.slice(0, 40).map((c, i) => (
                  <li key={i}>
                    {c.field}: <span className="line-through">{String(c.old ?? "—")}</span> → <strong>{String(c.new ?? "—")}</strong>
                  </li>
                ))}
              </ul>
            ) : null}
          </li>
        ))}
      </ol>
      <p className="mt-3 text-sm">
        <Link href={`/shop/accounts/purchases${shopQuery}`} className="font-semibold text-kesari-800 underline">
          ← All purchases
        </Link>
      </p>
    </div>
  );
}

function Row({ k, v, strong }: { k: string; v: string; strong?: boolean }) {
  return (
    <p className="flex justify-between gap-2">
      <span className="text-ink-600">{k}</span>
      <span className={strong ? "font-bold tabular-nums" : "tabular-nums"}>{v}</span>
    </p>
  );
}
