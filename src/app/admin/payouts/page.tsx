import Link from "next/link";
import { redirect } from "next/navigation";

import { SectionTabs } from "@/components/board/section-tabs";
import { BatchButtons, CloseCycleButton, ItemActions } from "@/components/payout-actions";
import { Alert, Card, EmptyState, Money, PageHeader, Section, StatusBadge } from "@/components/ui";
import { addDays } from "@/lib/dates";
import { getCurrentUser } from "@/server/authz/guards";
import { can, PERMISSIONS } from "@/server/authz/permissions";
import { listPayoutBatches, listPayoutCycles, listPayoutItems } from "@/server/payouts/batches";
import { HOLD_REASONS } from "@/server/payouts/cycle";
import { getPayoutProvider } from "@/server/payouts/providers";
import { LINE_LABELS } from "@/server/payouts/statements";
import { getRule } from "@/server/services/settings";

export const metadata = { title: "Payouts" };
export const dynamic = "force-dynamic";

/**
 * Admin → Payouts (batch-2026-10 WS-E, F10.2.4): automated shop payout
 * cycles, their batches (approve with maker-checker, pay through the
 * provider or download the bank file) and each shop's payment (mark paid
 * with the UTR / failed, retry, move to the next cycle). Tile Board layout:
 * figures first, then one section at a time.
 */
export default async function PayoutsPage({ searchParams }: { searchParams: Promise<{ batch?: string }> }) {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");
  if (!can(user.role, PERMISSIONS.PAYOUT_VIEW)) redirect("/");
  const canManage = can(user.role, PERMISSIONS.PAYOUT_MANAGE);
  const canApprove = can(user.role, PERMISSIONS.PAYOUT_APPROVE);
  const params = await searchParams;

  const [rule, cycles, batches] = await Promise.all([getRule("payouts"), listPayoutCycles(20), listPayoutBatches(20)]);
  const current = batches.find((b) => b.batch.id === params.batch) ?? batches[0];
  const items = current ? await listPayoutItems({ batchId: current.batch.id }) : [];
  const provider = rule.provider === "BANK_FILE" ? null : getPayoutProvider(rule.provider);
  const open = batches.filter((b) => ["DRAFT", "APPROVED", "PROCESSING"].includes(b.batch.status));
  const toPay = open.reduce((s, b) => s + b.batch.totalPaise, 0);
  const failed = items.filter((i) => i.item.status === "FAILED").length;

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader
        title="Payouts"
        description={`Shops are paid every ${rule.cycleDays} days (from ${rule.anchorDate}), after a ${rule.holdDays}-day hold, to verified bank accounts only. Provider: ${rule.provider === "BANK_FILE" ? "bank file + mark paid with UTR" : rule.provider}.`}
        action={canManage && rule.enabled ? <CloseCycleButton /> : undefined}
      />
      {!rule.enabled ? (
        <div className="mb-4">
          <Alert tone="warning" title="Automated payouts are off">
            The weekly settlement under Admin → Finance is in use. Switch on rule <code>payouts</code> under Admin → Business rules when you are ready.
          </Alert>
        </div>
      ) : null}
      {provider && !provider.isConfigured() ? (
        <div className="mb-4">
          <Alert tone="danger" title={`${rule.provider} is not configured`}>
            Its keys are not set (or the sandbox is on the production site). Use the bank file until they are.
          </Alert>
        </div>
      ) : null}

      <section className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4" data-testid="payout-tiles">
        <Tile label="Open batches" value={String(open.length)} hint="draft, approved or being paid" />
        <Tile label="To pay" value={<Money paise={toPay} />} hint="in open batches" />
        <Tile label="Last cycle" value={cycles[0] ? `${cycles[0].cycleStart}` : "—"} hint={cycles[0] ? `to ${addDays(cycles[0].cycleEnd, -1)}` : "none closed yet"} />
        <Tile label="Failed in this batch" value={String(failed)} hint={failed ? "retry or mark by hand" : "none"} tone={failed ? "alert" : undefined} />
      </section>

      <SectionTabs label="Payout sections" labels={["Batch", "Batches", "Cycles"]}>
        <Section title={current ? `Batch for ${current.cycleStart} to ${addDays(current.cycleEnd, -1)}` : "Batch"}>
          {!current ? (
            <EmptyState title="No payout batch yet." description="A batch is drafted when a cycle closes." />
          ) : (
            <>
              <Card className="mb-4 p-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="text-sm">
                    <StatusBadge status={current.batch.status} />
                    <span className="ml-2 text-ink-700">
                      {current.batch.itemCount} payment(s) · <Money paise={current.batch.totalPaise} />
                      {current.batch.provider ? ` · ${current.batch.provider}` : ""}
                      {current.batch.fileExportedAt ? " · bank file exported" : ""}
                    </span>
                    <p className="mt-1 text-xs text-ink-500">
                      {current.batch.createdBy ? "Drafted by an administrator" : "Drafted by the payout-cycle job"}
                      {rule.makerChecker ? " · maker-checker on: the creator cannot approve" : ""}
                      {current.batch.approvedAt ? ` · approved ${current.batch.approvedAt.toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}` : ""}
                    </p>
                  </div>
                  <BatchButtons batchId={current.batch.id} status={current.batch.status} provider={current.batch.provider} canApprove={canApprove} canManage={canManage} />
                </div>
              </Card>
              {items.length === 0 ? (
                <EmptyState title="No shops in this batch." />
              ) : (
                <Card className="divide-y divide-cream-100" data-testid="payout-items">
                  {items.map(({ item, shopName }) => (
                    <div key={item.id} className="p-3 text-sm">
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <div>
                          <p className="font-medium text-ink-900">{shopName}</p>
                          <p className="text-xs text-ink-500">
                            {Object.entries(item.breakdown)
                              .filter(([, v]) => v !== 0)
                              .map(([k, v]) => `${LINE_LABELS[k] ?? k} ₹${(v / 100).toFixed(2)}`)
                              .join(" · ")}
                          </p>
                          <p className="text-xs text-ink-500">
                            {item.holdReason ? `Held: ${HOLD_REASONS[item.holdReason] ?? item.holdReason} ` : ""}
                            {item.utr ? `UTR ${item.utr} ` : ""}
                            {item.failureReason ? `· ${item.failureReason} ` : ""}
                            {item.attempts ? `· attempt ${item.attempts}` : ""}
                            {item.nextAttemptAt ? ` · retry after ${item.nextAttemptAt.toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}` : ""}
                          </p>
                          <a className="text-xs font-medium text-kesari-700 hover:underline" href={`/api/payouts/statements/${item.id}`}>Statement PDF</a>
                          <span className="text-xs text-ink-500"> · </span>
                          <a className="text-xs font-medium text-kesari-700 hover:underline" href={`/api/payouts/statements/${item.id}?format=csv`}>CSV</a>
                        </div>
                        <div className="flex items-center gap-2">
                          <StatusBadge status={item.status} />
                          <span className="font-semibold"><Money paise={item.amountPaise} /></span>
                        </div>
                      </div>
                      {canManage && current.batch.status !== "DRAFT" && current.batch.status !== "CANCELLED" ? (
                        <ItemActions itemId={item.id} status={item.status} provider={item.provider} />
                      ) : null}
                    </div>
                  ))}
                </Card>
              )}
            </>
          )}
        </Section>

        <Section title="Batches">
          {batches.length === 0 ? (
            <EmptyState title="No batches yet." />
          ) : (
            <Card className="divide-y divide-cream-100">
              {batches.map(({ batch, cycleStart, cycleEnd }) => (
                <Link key={batch.id} href={`/admin/payouts?batch=${batch.id}`} className="flex min-h-11 flex-wrap items-center justify-between gap-2 p-3 text-sm hover:bg-cream-50">
                  <span>{cycleStart} to {addDays(cycleEnd, -1)} · {batch.itemCount} payment(s)</span>
                  <span className="flex items-center gap-2">
                    <StatusBadge status={batch.status} />
                    <Money paise={batch.totalPaise} />
                  </span>
                </Link>
              ))}
            </Card>
          )}
        </Section>

        <Section title="Cycles">
          {cycles.length === 0 ? (
            <EmptyState title="No cycle closed yet." />
          ) : (
            <Card className="divide-y divide-cream-100">
              {cycles.map((c) => (
                <div key={c.id} className="p-3 text-sm">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span>{c.cycleStart} to {addDays(c.cycleEnd, -1)} ({c.cycleDays} days) · {c.shopCount} shop(s)</span>
                    <span className="flex items-center gap-2">
                      <StatusBadge status={c.status} />
                      <Money paise={c.netPayablePaise} />
                    </span>
                  </div>
                  {c.warnings.length ? <p className="mt-1 text-xs text-amber-800">{c.warnings.join(" ")}</p> : null}
                </div>
              ))}
            </Card>
          )}
        </Section>
      </SectionTabs>
    </div>
  );
}

function Tile({ label, value, hint, tone }: { label: string; value: React.ReactNode; hint?: string; tone?: "alert" }) {
  return (
    <Card className={tone === "alert" ? "border-red-200 p-4" : "p-4"}>
      <p className="text-xs text-ink-500">{label}</p>
      <p className="mt-1 text-xl font-bold text-ink-900">{value}</p>
      {hint ? <p className="mt-0.5 text-xs text-ink-500">{hint}</p> : null}
    </Card>
  );
}
