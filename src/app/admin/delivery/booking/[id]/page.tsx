import { notFound, redirect } from "next/navigation";

import { ActionButton, ReasonAction, SimulateEvent } from "@/components/delivery-admin";
import { Card, PageHeader } from "@/components/ui";
import { deployedSiteKind } from "@/lib/env";
import { getCurrentUser } from "@/server/authz/guards";
import { TERMINAL_BOOKING_STATUSES } from "@/server/db/hdms-schema";
import { canSeeDelivery } from "@/server/delivery/access";
import { bookingDetail } from "@/server/delivery/admin";
import { BOOKING_STATUS_LABELS, PICKED_STATUSES } from "@/server/delivery/bookings";

import { DeliveryNav, istTime, paise } from "../../delivery-nav";

export const metadata = { title: "Delivery booking" };
export const dynamic = "force-dynamic";

/** One partner delivery: timeline, allocation decision and quotes, actions (docs/hdms-2026-11). */
export default async function DeliveryBookingPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");
  if (!canSeeDelivery(user.role)) redirect("/");
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const d = await bookingDetail(id).catch(() => null);
  if (!d) notFound();
  const b = d.booking;
  const live = !TERMINAL_BOOKING_STATUSES.includes(b.status);
  return (
    <div className="mx-auto max-w-5xl space-y-4">
      <PageHeader title={`Order ${d.orderNumber} · ${b.providerCode ?? b.channel}`} description={`${d.shopName ?? ""} · order ${d.orderStatus}`} />
      <DeliveryNav current={live ? "active" : b.status === "DELIVERED" ? "completed" : b.status === "CANCELLED" ? "cancelled" : "failed"} />
      <Card className="grid gap-2 p-4 text-sm sm:grid-cols-2">
        <p><b>Status:</b> {BOOKING_STATUS_LABELS[b.status]}</p>
        <p><b>Partner reference:</b> {b.externalRef ?? "—"}</p>
        <p><b>Rider:</b> {b.riderName ?? "—"} {b.riderPhoneMasked ?? ""}</p>
        <p><b>ETA:</b> {istTime(b.etaAt)}</p>
        <p><b>Distance:</b> {b.distanceM != null ? `${(b.distanceM / 1000).toFixed(1)} km` : "—"}</p>
        <p><b>Partner cost:</b> quoted {paise(b.quotedFeePaise)} · final {paise(b.finalFeePaise)}</p>
        {b.pricing ? (
          <p className="sm:col-span-2">
            <b>Fee split ({b.pricing.model.replaceAll("_", " ").toLowerCase()}):</b> total {paise(b.pricing.totalFeePaise)} · customer {paise(b.pricing.customerPaise)} · shop {paise(b.pricing.shopPaise)} · GoKesari {paise(b.pricing.gokesariPaise)}
          </p>
        ) : null}
        {b.cancelReason ? <p className="sm:col-span-2"><b>Cancelled{b.cancelledBy ? ` by ${b.cancelledBy.toLowerCase()}` : ""}:</b> {b.cancelReason}</p> : null}
        {b.failureReason ? <p className="sm:col-span-2"><b>Failure:</b> {b.failureReason}</p> : null}
      </Card>
      {live ? (
        <Card className="flex flex-wrap items-end gap-4 p-4">
          <ActionButton url={`/api/admin/delivery/bookings/${b.id}`} body={{ action: "refresh" }} label="Refresh from partner" />
          {!PICKED_STATUSES.includes(b.status) ? <ReasonAction url={`/api/admin/delivery/bookings/${b.id}`} action="cancel" label="Cancel with partner" /> : null}
          {b.providerCode === "MOCK" && deployedSiteKind() !== "production" ? <SimulateEvent bookingId={b.id} /> : null}
        </Card>
      ) : null}
      <Card className="p-4">
        <h2 className="mb-2 text-base font-semibold">Timeline</h2>
        <ol className="space-y-1 text-sm">
          {d.events.map((e) => (
            <li key={e.id}>
              {istTime(e.occurredAt)} · <b>{e.status}</b> ({e.source.toLowerCase()}){e.note ? ` — ${e.note}` : ""}
            </li>
          ))}
        </ol>
      </Card>
      <Card className="p-4">
        <h2 className="mb-2 text-base font-semibold">Allocation decisions</h2>
        {d.runs.map((r) => (
          <div key={r.id} className="mb-2 text-sm">
            <p>
              {istTime(r.createdAt)} · {r.trigger} → <b>{r.outcome}</b> {r.chosenProvider ?? r.chosenChannel ?? ""} — {r.detail}
            </p>
            <ul className="pl-4 text-xs text-ink-600">
              {d.quotes
                .filter((q) => q.runId === r.id)
                .map((q) => (
                  <li key={q.id}>
                    {q.providerCode ?? q.channel}: {q.serviceable ? `fee ${paise(q.feePaise)}, ETA ${q.etaMinutes ?? "—"} min, score ${q.score ?? "—"}` : `not used — ${q.rejectedReason ?? ""}`}
                  </li>
                ))}
            </ul>
          </div>
        ))}
      </Card>
    </div>
  );
}
