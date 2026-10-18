import { redirect } from "next/navigation";

import { SectionTabs } from "@/components/board/section-tabs";
import { PlatformNoteForm } from "@/components/payout-actions";
import { Alert, Card, EmptyState, Money, PageHeader, Section, StatusBadge } from "@/components/ui";
import { todayIn } from "@/lib/dates";
import { getEnv } from "@/lib/env";
import { getCurrentUser } from "@/server/authz/guards";
import { can, PERMISSIONS } from "@/server/authz/permissions";
import { listPlatformInvoices, listPlatformNotes, platformInvoicingStatus } from "@/server/platform-invoices/service";
import { getRule } from "@/server/services/settings";

export const metadata = { title: "GoKesari invoices" };
export const dynamic = "force-dynamic";

/**
 * Admin → GoKesari invoices (batch-2026-10 WS-E, F10.2.5): GoKesari's own tax
 * invoices to shops for its fees (one per payout cycle), credit / debit
 * notes, and the monthly exports for the CA — GSTR-1-ready (GoKesari's
 * supplies), TCS (GSTR-8-style) and TDS — as CSV or JSON.
 */
export default async function PlatformInvoicesPage({ searchParams }: { searchParams: Promise<{ period?: string }> }) {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");
  if (!can(user.role, PERMISSIONS.PLATFORM_INVOICE_MANAGE)) redirect("/");
  const params = await searchParams;
  const period = params.period && /^\d{4}-\d{2}$/.test(params.period) ? params.period : todayIn(getEnv().APP_TIMEZONE).slice(0, 7);
  const [status, profile, invoices, notes] = await Promise.all([platformInvoicingStatus(), getRule("platformTaxProfile"), listPlatformInvoices({ limit: 100 }), listPlatformNotes({ limit: 100 })]);
  const report = (type: string, format: string) => `/api/admin/statutory/reports?type=${type}&period=${period}&format=${format}`;

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader
        title="GoKesari invoices"
        description="GoKesari's tax invoices to shops for commission, delivery charges, registration and billing-management fees — one per payout cycle — with credit and debit notes. GST on the fees is deducted from the shop's payout."
      />
      {!status.enabled ? (
        <div className="mb-4">
          <Alert tone="warning" title="Platform invoicing is off">
            Keep it off on gokesari.com until GoKesari&apos;s GSTIN, legal name, address and invoice prefix are entered (rule <code>platformTaxProfile</code>) and the CA has confirmed the SAC codes and rates. Then switch on rule <code>platformInvoicing</code>.
          </Alert>
        </div>
      ) : !status.ready ? (
        <div className="mb-4">
          <Alert tone="danger" title="GoKesari's GST details are incomplete">
            Missing: {status.missing.join(", ")}. No fee invoices are issued until they are entered.
          </Alert>
        </div>
      ) : null}

      <section className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Card className="p-4">
          <p className="text-xs text-ink-500">Supplier</p>
          <p className="mt-1 text-sm font-bold text-ink-900">{profile.legalName || "— not entered —"}</p>
          <p className="text-xs text-ink-500">{profile.gstin || "GSTIN not entered"} · {profile.stateCode || "state?"}</p>
        </Card>
        <Card className="p-4">
          <p className="text-xs text-ink-500">Series</p>
          <p className="mt-1 text-sm font-bold text-ink-900">{profile.invoicePrefix}/yyYY/000001</p>
          <p className="text-xs text-ink-500">notes {profile.creditNotePrefix} · {profile.debitNotePrefix}</p>
        </Card>
        <Card className="p-4">
          <p className="text-xs text-ink-500">Invoices (latest 100)</p>
          <p className="mt-1 text-xl font-bold text-ink-900">{invoices.length}</p>
        </Card>
        <Card className="p-4">
          <p className="text-xs text-ink-500">Credit / debit notes</p>
          <p className="mt-1 text-xl font-bold text-ink-900">{notes.length}</p>
        </Card>
      </section>

      <SectionTabs label="GoKesari invoice sections" labels={["Invoices", "Notes", "Monthly exports"]}>
        <Section title="Invoices">
          {invoices.length === 0 ? (
            <EmptyState title="No GoKesari invoices yet." description="They are issued when a payout cycle closes with platform invoicing on." />
          ) : (
            <Card className="divide-y divide-cream-100">
              {invoices.map(({ invoice, shopName }) => (
                <div key={invoice.id} className="flex flex-wrap items-center justify-between gap-2 p-3 text-sm">
                  <span>
                    <a className="font-medium text-kesari-700 hover:underline" href={`/api/platform-invoices/${invoice.id}/pdf`}>{invoice.invoiceNumber}</a>
                    <span className="text-ink-500"> · {shopName} · {invoice.recipientGstin ?? "unregistered"} · {invoice.supplyType === "INTER" ? "IGST" : "CGST+SGST"}</span>
                  </span>
                  <span className="flex items-center gap-2 text-xs text-ink-500">
                    GST deducted <Money paise={invoice.gstDeductedPaise} />
                    <span className="text-sm font-semibold text-ink-900"><Money paise={invoice.totalPaise} /></span>
                  </span>
                </div>
              ))}
            </Card>
          )}
        </Section>

        <Section title="Credit and debit notes">
          <Card className="mb-4 p-4">
            <PlatformNoteForm invoices={invoices.map(({ invoice, shopName }) => ({ id: invoice.id, label: `${invoice.invoiceNumber} · ${shopName}` }))} />
          </Card>
          {notes.length === 0 ? (
            <EmptyState title="No notes yet." />
          ) : (
            <Card className="divide-y divide-cream-100">
              {notes.map((n) => (
                <div key={n.id} className="flex flex-wrap items-center justify-between gap-2 p-3 text-sm">
                  <span>
                    <a className="font-medium text-kesari-700 hover:underline" href={`/api/platform-invoices/notes/${n.id}/pdf`}>{n.noteNumber}</a>
                    <span className="text-ink-500"> · {n.reason}</span>
                  </span>
                  <span className="flex items-center gap-2">
                    <StatusBadge status={n.appliedInCycleId ? "SETTLED" : "PENDING"} />
                    <Money paise={n.kind === "CREDIT" ? -n.totalPaise : n.totalPaise} />
                  </span>
                </div>
              ))}
            </Card>
          )}
        </Section>

        <Section title="Monthly exports for the CA">
          <Card className="p-4 text-sm">
            <form className="mb-4 flex flex-wrap items-end gap-2">
              <label className="flex flex-col gap-1">
                <span className="text-xs text-ink-500">Month</span>
                <input type="month" name="period" defaultValue={period} className="min-h-11 rounded-lg border border-cream-200 px-2" />
              </label>
              <button type="submit" className="min-h-11 rounded-lg bg-kesari-600 px-4 font-medium text-white">Show</button>
            </form>
            <ul className="space-y-3">
              <li>
                <p className="font-medium">GSTR-1-ready — GoKesari&apos;s own supplies (B2B, B2CS, CDNR, SAC summary, documents)</p>
                <a className="mr-3 inline-flex min-h-11 items-center font-medium text-kesari-700 underline" href={report("gstr1", "csv")}>CSV</a>
                <a className="inline-flex min-h-11 items-center font-medium text-kesari-700 underline" href={report("gstr1", "json")}>JSON</a>
              </li>
              <li>
                <p className="font-medium">GST TCS collected (s.52, GSTR-8-style)</p>
                <a className="mr-3 inline-flex min-h-11 items-center font-medium text-kesari-700 underline" href={report("tcs", "csv")}>CSV</a>
                <a className="inline-flex min-h-11 items-center font-medium text-kesari-700 underline" href={report("tcs", "json")}>JSON</a>
              </li>
              <li>
                <p className="font-medium">Income-tax TDS on e-commerce participants (s.194-O / s.393)</p>
                <a className="mr-3 inline-flex min-h-11 items-center font-medium text-kesari-700 underline" href={report("tds", "csv")}>CSV</a>
                <a className="inline-flex min-h-11 items-center font-medium text-kesari-700 underline" href={report("tds", "json")}>JSON</a>
              </li>
            </ul>
            <p className="mt-3 text-xs text-ink-500">Downloads only — GoKesari&apos;s CA checks and files the returns. Every export is in the audit log.</p>
          </Card>
        </Section>
      </SectionTabs>
    </div>
  );
}
