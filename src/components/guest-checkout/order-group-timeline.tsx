/**
 * docs/guest-checkout-2026-11: the combined timeline of a multi-shop purchase — overall progress,
 * each step with how many shop orders reached it, then every status change named by shop. Used on
 * /orders/group/[reference] (signed in) and /track/[token] (no sign-in). Presentational only.
 */
import { Card } from "@/components/ui";
import type { GroupTimeline } from "@/server/guest-checkout/timeline";

const when = (d: Date) => d.toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata" });

export function OrderGroupTimeline({ timeline }: { timeline: GroupTimeline }) {
  const multi = timeline.shops.length > 1;
  return (
    <Card className="p-4" data-testid="group-timeline">
      <p className="text-xs font-semibold uppercase tracking-wide text-ink-500">Overall</p>
      <p className="text-lg font-bold text-ink-900" data-testid="group-timeline-overall">
        {timeline.overall.label}
      </p>
      {timeline.overall.stopped > 0 && timeline.overall.stage !== "STOPPED" ? (
        <p className="text-xs text-ink-600">
          {timeline.overall.stopped} shop order{timeline.overall.stopped === 1 ? "" : "s"} cancelled or refunded.
        </p>
      ) : null}
      {timeline.overall.stage !== "STOPPED" ? (
        <ol className="mt-3 grid grid-cols-5 gap-1 text-center text-[11px] leading-tight" aria-label="Progress">
          {timeline.stages.map((s) => {
            const done = s.of > 0 && s.reached === s.of;
            const part = s.reached > 0 && !done;
            return (
              <li key={s.stage} className="flex flex-col items-center gap-1">
                <span
                  className={`h-2 w-full rounded-full ${done ? "bg-leaf-600" : part ? "bg-kesari-300" : "bg-cream-200"}`}
                  aria-hidden
                />
                <span className={done ? "font-semibold text-ink-900" : "text-ink-600"}>{s.label}</span>
                {multi && part ? (
                  <span className="text-ink-500">
                    {s.reached}/{s.of}
                  </span>
                ) : null}
              </li>
            );
          })}
        </ol>
      ) : null}

      {multi ? (
        <ul className="mt-4 divide-y divide-cream-200 text-sm" data-testid="group-timeline-shops">
          {timeline.shops.map((s) => (
            <li key={s.orderId} className="flex justify-between gap-3 py-2">
              <span className="text-ink-900">{s.shopName}</span>
              <span className={s.stopped ? "text-red-700" : "text-ink-700"}>{s.statusLabel}</span>
            </li>
          ))}
        </ul>
      ) : null}

      {timeline.events.length > 0 ? (
        <details className="mt-3 text-sm">
          <summary className="cursor-pointer font-medium text-kesari-700">All updates ({timeline.events.length})</summary>
          <ol className="mt-2 space-y-1">
            {timeline.events.map((e, i) => (
              <li key={`${e.orderId}-${i}`} className="flex justify-between gap-3">
                <span className="text-ink-800">
                  {multi ? `${e.shopName}: ` : ""}
                  {e.statusLabel}
                </span>
                <span className="shrink-0 text-xs text-ink-500">{when(e.at)}</span>
              </li>
            ))}
          </ol>
        </details>
      ) : null}
    </Card>
  );
}
