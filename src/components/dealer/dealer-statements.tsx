"use client";

import { Badge, Card } from "@/components/ui";

/** A month's statement as the dealer page receives it (services: dealers/monthly-payout.ts). */
export interface MonthStatementView {
  month: string;
  label: string;
  closed: boolean;
  registrations: { shopId: string; shopName: string; registrationNumber: string | null; registeredOn: string; employee: string | null; attribution: string; shopStatus: string }[];
  /** totalPaise is the gross; netPaise (gross − TDS) is what reaches the bank. */
  payout: { status: string; totalPaise: number; tdsPaise?: number; netPaise?: number; paymentReference: string | null; paidAt: string | null } | null;
  /** One line per entry type (direct-1, direct-2, override, renewal, development, bonus). */
  lines?: { key: string; label: string; amountPaise: number }[];
  totals: {
    registrations: number;
    activated: number;
    earnedPaise: number;
    heldPaise: number;
    aboveCapPaise: number;
    reversedPaise: number;
    awaitingApprovalPaise: number;
    carriedForwardPaise: number;
  };
}

const rs = (paise: number) => `₹${(paise / 100).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;

/**
 * Monthly statements (owner, 28 Oct 2026): commission is paid once a month —
 * the month is closed on the payout day (the 5th unless an admin changes it) —
 * with a statement of the shops the dealer registered and what they earned.
 */
export function DealerStatements({ statements, payoutDay, open }: { statements: MonthStatementView[]; payoutDay: number; open?: string | null }) {
  return (
    <Card className="space-y-3 p-4" id="dealer-statements" data-testid="dealer-statements">
      <h2 className="text-base font-bold text-ink-900">Monthly statements</h2>
      <p className="text-sm text-ink-700">
        Commission is paid monthly. On the {payoutDay}
        {payoutDay === 1 ? "st" : payoutDay === 2 ? "nd" : payoutDay === 3 ? "rd" : "th"} of each month the month before is closed: your approved
        commission goes into one payout, and GoKesari transfers it to your bank account. You get the statement in the app and by email.
      </p>
      <ul className="divide-y divide-cream-200">
        {statements.map((s) => (
          <li key={s.month} className="py-2">
            <details open={open === s.month}>
              <summary className="flex min-h-11 cursor-pointer flex-wrap items-center justify-between gap-2">
                <span className="font-semibold text-ink-900">
                  {s.label} {s.closed ? null : <Badge tone="info">so far</Badge>}
                </span>
                <span className="text-sm text-ink-700">
                  {s.totals.registrations} shops · earned {rs(s.totals.earnedPaise)}
                  {s.payout ? (
                    <>
                      {" "}
                      · payout {rs(s.payout.netPaise ?? s.payout.totalPaise)} <Badge tone={s.payout.status === "PAID" ? "success" : "neutral"}>{s.payout.status === "PAID" ? "paid" : "to be paid"}</Badge>
                    </>
                  ) : null}
                </span>
              </summary>
              <div className="mt-2 space-y-2 text-sm">
                <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                  {(
                    [
                      ["Shops registered", String(s.totals.registrations)],
                      ["Shops activated", String(s.totals.activated)],
                      ["Earned", rs(s.totals.earnedPaise)],
                      ["Awaiting approval", rs(s.totals.awaitingApprovalPaise)],
                      ["On hold", rs(s.totals.heldPaise)],
                      // Only on statements from before the per-shop cap was removed (5 Nov 2026).
                      ...(s.totals.aboveCapPaise > 0 ? ([["Above cap", rs(s.totals.aboveCapPaise)]] as const) : []),
                      ["Reversed", rs(s.totals.reversedPaise)],
                      ["Owed back (next payout)", rs(s.totals.carriedForwardPaise)],
                    ] as const
                  ).map(([label, value]) => (
                    <div key={label} className="rounded-xl bg-cream-50 p-2">
                      <dt className="text-xs text-ink-500">{label}</dt>
                      <dd className="font-semibold text-ink-900">{value}</dd>
                    </div>
                  ))}
                </dl>
                {s.lines && s.lines.some((l) => l.key !== "standard") ? (
                  <ul className="space-y-1" data-testid="statement-lines">
                    {s.lines.map((l) => (
                      <li key={l.key} className="flex justify-between gap-2">
                        <span className="text-ink-700">{l.label}</span>
                        <span className="font-semibold text-ink-900">{rs(l.amountPaise)}</span>
                      </li>
                    ))}
                  </ul>
                ) : null}
                {s.payout ? (
                  <dl className="grid grid-cols-3 gap-2" data-testid="statement-payout">
                    {(
                      [
                        ["Gross", rs(s.payout.totalPaise)],
                        ["TDS", rs(s.payout.tdsPaise ?? 0)],
                        ["Net to your bank", rs(s.payout.netPaise ?? s.payout.totalPaise)],
                      ] as const
                    ).map(([label, value]) => (
                      <div key={label} className="rounded-xl bg-cream-50 p-2">
                        <dt className="text-xs text-ink-500">{label}</dt>
                        <dd className="font-semibold text-ink-900">{value}</dd>
                      </div>
                    ))}
                  </dl>
                ) : null}
                {s.payout?.paymentReference ? (
                  <p className="text-ink-700">
                    Paid {s.payout.paidAt?.slice(0, 10)} · bank reference {s.payout.paymentReference}
                  </p>
                ) : null}
                {s.registrations.length ? (
                  <ul className="space-y-1 text-ink-700">
                    {s.registrations.map((r) => (
                      <li key={r.shopId}>
                        {r.registeredOn} · {r.shopName}
                        {r.registrationNumber ? ` (${r.registrationNumber})` : ""}
                        {r.employee ? ` · by ${r.employee}` : ""} · {r.attribution === "ACTIVE" ? r.shopStatus.toLowerCase().replace("_", " ") : "not counted (reversed)"}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-ink-500">No shops registered this month.</p>
                )}
                <a
                  href={`/api/dealer/commission/statement?month=${s.month}`}
                  className="inline-flex min-h-11 items-center rounded-lg border border-cream-200 px-3 font-medium text-ink-700 hover:bg-cream-100"
                >
                  Download {s.label} statement (CSV)
                </a>
              </div>
            </details>
          </li>
        ))}
      </ul>
    </Card>
  );
}
