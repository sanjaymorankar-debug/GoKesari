/**
 * The refund timeline on the order page (F6.2.3, batch-2026-10 WS-C):
 * each refund with its method, the itemised deductions and every status it
 * went through. Renders what the refunds service returned; computes nothing.
 */
import { Badge, Card } from "@/components/ui";
import { formatPaise } from "@/lib/money";

export interface RefundTimelineItem {
  id: string | null;
  method: "WALLET" | "ORIGINAL";
  status: "REQUESTED" | "PROCESSING" | "SUCCESS" | "FAILED";
  amountPaise: number;
  paidPaise: number;
  deductionsPaise: number;
  deductions: { code: string; label: string; amountPaise: number; note?: string }[];
  fellBackToWallet: boolean;
  createdAt: string;
  timeline: { at: string; status: "REQUESTED" | "PROCESSING" | "SUCCESS" | "FAILED"; note: string | null }[];
}

const STATUS_TEXT = { REQUESTED: "Requested", PROCESSING: "Processing", SUCCESS: "Completed", FAILED: "Failed" } as const;
const STATUS_TONE = { REQUESTED: "info", PROCESSING: "warning", SUCCESS: "success", FAILED: "danger" } as const;

const when = (iso: string) =>
  new Date(iso).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata" });

export function RefundTimeline({ refunds }: { refunds: RefundTimelineItem[] }) {
  if (refunds.length === 0) return null;
  return (
    <div className="space-y-3" data-testid="refund-timeline">
      {refunds.map((r, index) => (
        <Card key={r.id ?? `ledger-${index}`} className="p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm font-semibold text-ink-900">
              {formatPaise(r.amountPaise)} to your {r.method === "WALLET" ? "GoKesari wallet" : "original payment method"}
            </p>
            <Badge tone={STATUS_TONE[r.status]}>{STATUS_TEXT[r.status]}</Badge>
          </div>
          {r.deductionsPaise > 0 ? (
            <dl className="mt-2 space-y-1 text-sm">
              <div className="flex justify-between gap-3 text-ink-600">
                <dt>You paid</dt>
                <dd className="tabular-nums">{formatPaise(r.paidPaise)}</dd>
              </div>
              {r.deductions.map((d) => (
                <div key={d.code} className="flex justify-between gap-3 text-ink-600">
                  <dt>{d.label}</dt>
                  <dd className="tabular-nums">−{formatPaise(d.amountPaise)}</dd>
                </div>
              ))}
              <div className="flex justify-between gap-3 font-medium text-ink-900">
                <dt>Refunded</dt>
                <dd className="tabular-nums">{formatPaise(r.amountPaise)}</dd>
              </div>
            </dl>
          ) : null}
          {r.fellBackToWallet ? (
            <p className="mt-2 text-xs text-ink-500">The payment gateway could not complete the refund, so it went to your wallet instead.</p>
          ) : null}
          <ol className="mt-3 space-y-2 border-l-2 border-cream-200 pl-4">
            {r.timeline.map((step, i) => (
              <li key={i} className="text-sm">
                <span className="font-medium text-ink-900">{STATUS_TEXT[step.status]}</span>
                <span className="text-xs text-ink-500"> · {when(step.at)}</span>
                {step.note ? <p className="text-ink-600">{step.note}</p> : null}
              </li>
            ))}
          </ol>
        </Card>
      ))}
    </div>
  );
}
