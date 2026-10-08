import { desc, eq } from "drizzle-orm";
import { redirect } from "next/navigation";

import { EinvoiceDeclaration } from "@/components/gst/einvoice-declaration";
import { Alert, Card, Field, PageHeader, inputClass } from "@/components/ui";
import { AppError } from "@/lib/errors";
import { formatPaise } from "@/lib/money";
import { getCurrentUser } from "@/server/authz/guards";
import { can, PERMISSIONS } from "@/server/authz/permissions";
import { db } from "@/server/db";
import { gstReturnExports, shops } from "@/server/db/schema";
import { buildGstr1 } from "@/server/gst/gstr1";
import { listShopsForOwner } from "@/server/services/shops";

export const metadata = { title: "GST returns" };
export const dynamic = "force-dynamic";

function previousMonth(): string {
  const ist = new Date(Date.now() + 330 * 60_000);
  ist.setUTCDate(1);
  ist.setUTCMonth(ist.getUTCMonth() - 1);
  return ist.toISOString().slice(0, 7);
}

/** Module 2, Phase 3: the shop's GSTR-1-ready file for a month (GoKesari sales only). */
export default async function GstReturnsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  const user = await getCurrentUser();
  if (!user) redirect("/signin");
  const wanted = typeof params.shop === "string" && /^[0-9a-f-]{36}$/i.test(params.shop) ? params.shop : null;
  const [shop] = wanted
    ? await db.select().from(shops).where(eq(shops.id, wanted))
    : await listShopsForOwner(user.id);
  if (!shop) redirect("/shop");
  if (shop.ownerId !== user.id && !can(user.role, PERMISSIONS.SHOP_GST_PAN_VERIFY)) redirect("/shop");

  const period = typeof params.period === "string" && /^\d{4}-\d{2}$/.test(params.period) ? params.period : previousMonth();
  let summary: Awaited<ReturnType<typeof buildGstr1>> | null = null;
  let problem: string | null = null;
  try {
    summary = await buildGstr1(shop.id, period);
  } catch (error) {
    if (error instanceof AppError) problem = error.message;
    else throw error;
  }
  const exports = await db.select().from(gstReturnExports).where(eq(gstReturnExports.shopId, shop.id)).orderBy(desc(gstReturnExports.generatedAt)).limit(10);
  const link = (format: string) => `/api/shops/${shop.id}/gst/gstr1?period=${period}&format=${format}`;

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <PageHeader
        title="GST returns"
        description={`${shop.name} — your GoKesari sales for a month in the GSTR-1 format, to check and upload yourself or give to your CA. GoKesari does not file returns.`}
      />
      <Card className="space-y-3 p-4">
        <form className="flex flex-wrap items-end gap-2">
          {wanted ? <input type="hidden" name="shop" value={shop.id} /> : null}
          <Field label="Month">
            <input type="month" name="period" defaultValue={period} className={inputClass} />
          </Field>
          <button type="submit" className="rounded-lg border border-cream-200 px-4 py-2 text-sm">Show</button>
        </form>
        {problem ? <Alert tone="warning">{problem}</Alert> : null}
        {summary ? (
          <>
            <dl className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
              <div><dt className="text-xs text-ink-500">Invoices</dt><dd>{summary.totals.invoices}</dd></div>
              <div><dt className="text-xs text-ink-500">Credit notes</dt><dd>{summary.totals.creditNotes}</dd></div>
              <div><dt className="text-xs text-ink-500">Taxable value (net)</dt><dd>{formatPaise(summary.totals.taxablePaise)}</dd></div>
              <div><dt className="text-xs text-ink-500">Tax (net)</dt><dd>{formatPaise(summary.totals.taxPaise)}</dd></div>
            </dl>
            <p className="text-xs text-ink-500">
              B2B {summary.counts.b2b} · B2C large {summary.counts.b2cl} · B2C small rows {summary.counts.b2cs} · credit notes registered {summary.counts.cdnr} / unregistered {summary.counts.cdnur} · HSN rows {summary.counts.hsnB2b + summary.counts.hsnB2c}
            </p>
            {summary.warnings.length ? (
              <Alert tone="warning" title="Check before uploading">
                <ul className="list-disc pl-4">
                  {summary.warnings.slice(0, 10).map((w) => <li key={w}>{w}</li>)}
                </ul>
              </Alert>
            ) : null}
            <div className="flex flex-wrap gap-2">
              <a href={link("json")} className="rounded-lg bg-kesari-600 px-4 py-2 text-sm font-medium text-white hover:bg-kesari-800">Download JSON (GST offline tool)</a>
              <a href={link("xlsx")} className="rounded-lg border border-cream-200 px-4 py-2 text-sm font-medium text-ink-700 hover:bg-cream-100">Download Excel</a>
            </div>
          </>
        ) : null}
      </Card>
      <Card className="space-y-2 p-4">
        <h2 className="text-base font-semibold text-ink-900">E-invoicing</h2>
        <EinvoiceDeclaration shopId={shop.id} band={shop.declaredTurnoverBand} />
      </Card>
      {exports.length ? (
        <Card className="p-4">
          <h2 className="text-base font-semibold text-ink-900">Downloaded</h2>
          <ul className="mt-2 text-sm text-ink-700">
            {exports.map((e) => (
              <li key={e.id}>
                {e.period} · {e.format} · {e.generatedAt.toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
    </div>
  );
}
