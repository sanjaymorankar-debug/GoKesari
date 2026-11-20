"use client";

/**
 * One booking (docs/consult-booking-2026-11), for whoever may see it: the
 * customer (code to show, pay, move, cancel, rate, dispute, files), the
 * consultant (accept / decline, arrived, complete with the code, no-show,
 * paid at the counter, private note, meeting link, move, reassign) and staff.
 */
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

import { CONSULT_PAYMENT_STATUS_LABELS, CONSULT_REFUND_STATUS_LABELS, type ConsultPaymentStatus } from "@/lib/consult/constants";
import { formatIst, formatSlot } from "@/lib/consult/time";
import { Alert, Button, Field, inputClass } from "@/components/ui";
import { amount, api, MODE_ICON, modeLabel, Panel, PinMap, rupees, StatusPill } from "./common";

interface Detail {
  viewer: "CUSTOMER" | "FIRM" | "STAFF";
  card: {
    id: string;
    bookingNumber: string;
    status: string;
    rescheduleCount: number;
    startsAt: string;
    endsAt: string;
    mode: string;
    bookingKind: string;
    serviceName: string;
    visitorName: string;
    attendees: number;
    firmName: string;
    firmSlug: string;
    members: { id: string; name: string; color: string }[];
    feePaise: number;
    paidOnlinePaise: number;
    paidOfflinePaise: number;
    refundPaise: number;
    paymentStatus: string;
    paymentMode: string;
    arrived: boolean;
  };
  booking: {
    visitorPhone: string | null;
    visitorEmail: string | null;
    visitorAge: number | null;
    customerNote: string | null;
    privateNote: string | null;
    visitAddress: string | null;
    meetingUrl: string | null;
    feeType: string;
    onlineDuePaise: number;
    duePaise: number;
    receiptNumber: string | null;
    cancelReason: string | null;
    cancelledBy: string | null;
    rating: number | null;
    review: string | null;
    ticketId: string | null;
    holdExpiresAt: string | null;
    policy: string[];
    commissionPaise: number;
    serviceId: string;
  };
  firm: { name: string; slug: string; address: string; latitude: number | null; longitude: number | null; phone: string | null };
  completionCode: string | null;
  completionNeedsCode: boolean;
  refund: { status: string; requestedPaise: number; settledPaise: number };
  files: { id: string; fileName: string; size: number; side: string; createdAt: string }[];
  events: { kind: string; from: string | null; to: string | null; note: string | null; at: string; by: string | null }[];
  can: Record<"cancel" | "reschedule" | "payBalance" | "payNow" | "rate" | "dispute" | "accept" | "arrive" | "complete" | "noShow" | "markPaid" | "note" | "upload" | "reassign", boolean>;
  team: { id: string; name: string }[];
}

interface Slot {
  start: string;
  memberIds: string[];
}

export function ConsultBookingView({ bookingId, onChanged, compact = false }: { bookingId: string; onChanged?: () => void; compact?: boolean }) {
  const [d, setD] = useState<Detail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<null | "cancel" | "reschedule" | "complete" | "paid" | "reject" | "rate" | "dispute">(null);
  const [text, setText] = useState("");
  const [code, setCode] = useState("");
  const [method, setMethod] = useState("CASH");
  const [rating, setRating] = useState(5);
  const [note, setNote] = useState("");
  const [meeting, setMeeting] = useState("");
  const [slots, setSlots] = useState<Record<string, Slot[]>>({});
  const [newStart, setNewStart] = useState("");
  const [files, setFiles] = useState<{ id: string; fileName: string; url: string }[]>([]);

  const load = useCallback(async () => {
    try {
      const r = await api<Detail>(`/api/consult/bookings/${bookingId}`);
      setD(r);
      setNote(r.booking.privateNote ?? "");
      setMeeting(r.booking.meetingUrl ?? "");
      if (r.files.length) setFiles((await api<{ files: { id: string; fileName: string; url: string }[] }>(`/api/consult/bookings/${bookingId}/files`)).files);
      else setFiles([]);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load the booking.");
    }
  }, [bookingId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- loads server data (an external system) when the view's inputs change
    void load();
  }, [load]);

  const act = async (action: string, extra: Record<string, unknown> = {}, done?: string) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const r = await api<{ checkoutUrl?: string | null }>(`/api/consult/bookings/${bookingId}`, { json: { action, ...extra } });
      if (r.checkoutUrl) {
        window.location.href = r.checkoutUrl;
        return;
      }
      setOpen(null);
      setText("");
      setCode("");
      if (done) setNotice(done);
      await load();
      onChanged?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : "That did not work.");
    } finally {
      setBusy(false);
    }
  };

  const loadSlots = async () => {
    if (!d) return;
    const p = new URLSearchParams({ serviceId: d.booking.serviceId, days: "7", attendees: String(d.card.attendees) });
    const r = await api<{ days: Record<string, Slot[]> }>(`/api/consult/availability?${p.toString()}`);
    setSlots(r.days);
  };

  const upload = async (file: File) => {
    setBusy(true);
    setError(null);
    try {
      const form = new FormData();
      form.set("file", file);
      await api(`/api/consult/bookings/${bookingId}/files`, { method: "POST", body: form });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Upload failed.");
    } finally {
      setBusy(false);
    }
  };

  if (error && !d) return <Alert tone="danger">{error}</Alert>;
  if (!d) return <p className="text-sm text-ink-600">Loading…</p>;
  const c = d.card;
  const firmSide = d.viewer !== "CUSTOMER" || d.can.accept || d.can.complete || d.can.markPaid;
  const gcal = `https://calendar.google.com/calendar/render?action=TEMPLATE&text=${encodeURIComponent(`${c.serviceName} — ${d.firm.name}`)}&dates=${c.startsAt.replace(/[-:]|\.\d{3}/g, "")}/${c.endsAt.replace(/[-:]|\.\d{3}/g, "")}&details=${encodeURIComponent(`Booking ${c.bookingNumber}`)}&location=${encodeURIComponent(c.mode === "IN_PERSON" ? d.firm.address : modeLabel(c.mode))}`;

  return (
    <div className="flex flex-col gap-3" data-testid="consult-booking-view">
      <div className="flex flex-wrap items-start justify-between gap-2 rounded-2xl border-2 border-[var(--gk-line)] bg-white p-4">
        <div>
          <p className="text-xs font-bold text-ink-600">
            {c.bookingNumber} · {c.bookingKind === "GROUP" ? `Group session · ${c.attendees} ${c.attendees === 1 ? "person" : "people"}` : c.bookingKind === "TEAM" ? "Team appointment" : "Appointment"}
          </p>
          <h2 className="text-lg font-extrabold text-ink-900">{formatSlot(c.startsAt)}</h2>
          <p className="text-sm text-ink-800">
            {MODE_ICON[c.mode]} {c.serviceName} · {modeLabel(c.mode)} · {Math.round((new Date(c.endsAt).getTime() - new Date(c.startsAt).getTime()) / 60000)} min
          </p>
          <p className="text-sm text-ink-700">
            {firmSide ? `Visitor: ${c.visitorName}` : `With ${c.members.map((m) => m.name).join(", ") || d.firm.name}`} {firmSide ? "" : `· ${d.firm.name}`}
          </p>
        </div>
        <div className="flex flex-col items-end gap-1">
          <StatusPill status={c.status} rescheduled={c.rescheduleCount > 0} />
          {c.arrived ? <span className="text-xs font-bold text-teal-700">Arrived</span> : null}
        </div>
      </div>

      {notice ? <Alert tone="success">{notice}</Alert> : null}
      {error ? <Alert tone="danger">{error}</Alert> : null}

      {d.completionCode ? (
        <div className="rounded-2xl border-2 border-teal-400 bg-teal-50 p-4 text-center" data-testid="consult-completion-code">
          <p className="text-sm font-bold text-teal-900">Your appointment code</p>
          <p className="text-4xl font-extrabold tracking-[0.3em] text-teal-950">{d.completionCode}</p>
          <p className="text-xs text-teal-900">Tell this code to the consultant when your appointment is over. Do not share it before.</p>
        </div>
      ) : null}

      {c.status === "PENDING_PAYMENT" && d.booking.holdExpiresAt ? (
        <Alert tone="warning" title="Payment pending">
          The time is held for you until {formatIst(d.booking.holdExpiresAt)}. {d.can.payNow ? "" : "The hold has ended; please book again."}
        </Alert>
      ) : null}

      <div className="grid gap-3 md:grid-cols-2">
        <Panel title="Payment">
          <dl className="grid grid-cols-2 gap-1 text-sm">
            <dt className="text-ink-600">Fee</dt>
            <dd className="text-right font-bold">{rupees(c.feePaise)}</dd>
            <dt className="text-ink-600">Paid online</dt>
            <dd className="text-right">{amount(c.paidOnlinePaise)}</dd>
            <dt className="text-ink-600">Paid at visit</dt>
            <dd className="text-right">{amount(c.paidOfflinePaise)}</dd>
            {d.booking.duePaise > 0 && !["CANCELLED", "REJECTED", "EXPIRED"].includes(c.status) ? (
              <>
                <dt className="text-ink-600">Due</dt>
                <dd className="text-right font-bold text-amber-800">{amount(d.booking.duePaise)}</dd>
              </>
            ) : null}
            {c.refundPaise > 0 ? (
              <>
                <dt className="text-ink-600">Refund</dt>
                <dd className="text-right font-bold text-teal-800" data-testid="consult-refund">
                  {amount(c.refundPaise)} · {CONSULT_REFUND_STATUS_LABELS[d.refund.status as keyof typeof CONSULT_REFUND_STATUS_LABELS] ?? d.refund.status}
                </dd>
              </>
            ) : null}
            <dt className="text-ink-600">Status</dt>
            <dd className="text-right">{CONSULT_PAYMENT_STATUS_LABELS[c.paymentStatus as ConsultPaymentStatus] ?? c.paymentStatus}</dd>
            {firmSide && d.booking.commissionPaise > 0 ? (
              <>
                <dt className="text-ink-600">GoKesari commission</dt>
                <dd className="text-right">{amount(d.booking.commissionPaise)}</dd>
              </>
            ) : null}
          </dl>
          <div className="mt-2 flex flex-wrap gap-2">
            {d.can.payNow ? (
              <Button onClick={() => act("pay", { part: "ADVANCE" })} disabled={busy} data-testid="consult-pay-now">
                Pay {amount(d.booking.onlineDuePaise)}
              </Button>
            ) : null}
            {d.can.payBalance ? (
              <Button variant="secondary" onClick={() => act("pay", { part: "BALANCE" })} disabled={busy}>
                Pay balance online
              </Button>
            ) : null}
            {d.booking.receiptNumber ? (
              <Link href={`/consult/bookings/${c.id}/receipt`} className="inline-flex min-h-11 items-center rounded-lg border border-cream-200 bg-white px-4 text-sm font-medium text-ink-700 hover:bg-cream-100">
                Receipt {d.booking.receiptNumber}
              </Link>
            ) : null}
            {d.can.markPaid ? (
              <Button variant="secondary" onClick={() => setOpen(open === "paid" ? null : "paid")} data-testid="consult-mark-paid">
                Mark paid at counter
              </Button>
            ) : null}
          </div>
          {open === "paid" ? (
            <div className="mt-2 flex flex-wrap items-end gap-2">
              <Field label="Received by">
                <select className={inputClass} value={method} onChange={(e) => setMethod(e.target.value)}>
                  {["CASH", "UPI", "CARD", "OTHER"].map((m) => (
                    <option key={m}>{m}</option>
                  ))}
                </select>
              </Field>
              <Button onClick={() => act("paid", { method }, "Payment recorded and receipt issued.")} disabled={busy}>
                Record {amount(d.booking.duePaise)}
              </Button>
            </div>
          ) : null}
        </Panel>

        <Panel title={c.mode === "VIDEO" ? "Video call" : c.mode === "PHONE" ? "Phone call" : c.mode === "HOME_VISIT" ? "Home visit" : "Where"}>
          {c.mode === "VIDEO" ? (
            d.booking.meetingUrl ? (
              <a href={d.booking.meetingUrl} target="_blank" rel="noreferrer" className="inline-flex min-h-11 items-center rounded-lg bg-teal-700 px-4 text-sm font-bold text-white" data-testid="consult-join">
                Join video call
              </a>
            ) : (
              <p className="text-sm text-ink-700">The link appears here once the booking is confirmed.</p>
            )
          ) : c.mode === "PHONE" ? (
            <p className="text-sm text-ink-700">{firmSide ? `Call ${c.visitorName} on ${d.booking.visitorPhone ?? "their number"}.` : "The consultant will call you at the booked time."}</p>
          ) : c.mode === "HOME_VISIT" ? (
            <p className="text-sm text-ink-700">{d.booking.visitAddress}</p>
          ) : (
            <>
              <p className="text-sm text-ink-800">{d.firm.address}</p>
              {d.firm.latitude != null && d.firm.longitude != null ? (
                <>
                  <div className="mt-2">
                    <PinMap latitude={d.firm.latitude} longitude={d.firm.longitude} label={d.firm.name} />
                  </div>
                  <a href={`https://www.google.com/maps/dir/?api=1&destination=${d.firm.latitude},${d.firm.longitude}`} target="_blank" rel="noreferrer" className="mt-2 inline-flex min-h-11 items-center rounded-lg border border-cream-200 px-4 text-sm font-medium text-ink-700">
                    Directions
                  </a>
                </>
              ) : null}
            </>
          )}
          {firmSide && c.mode === "VIDEO" ? (
            <div className="mt-2 flex gap-2">
              <input className={inputClass} value={meeting} onChange={(e) => setMeeting(e.target.value)} aria-label="Meeting link" />
              <Button variant="secondary" onClick={() => act("meeting", { url: meeting }, "Meeting link saved and sent.")} disabled={busy}>
                Save
              </Button>
            </div>
          ) : null}
          <div className="mt-2 flex flex-wrap gap-2 text-sm">
            <a href={`/api/consult/bookings/${c.id}/ics`} className="font-bold text-kesari-800 underline">
              Add to calendar (.ics)
            </a>
            <a href={gcal} target="_blank" rel="noreferrer" className="font-bold text-kesari-800 underline">
              Google Calendar
            </a>
          </div>
        </Panel>
      </div>

      {firmSide ? (
        <Panel title="Visitor">
          <dl className="grid grid-cols-[8rem_1fr] gap-1 text-sm">
            <dt className="text-ink-600">Name</dt>
            <dd>{c.visitorName}</dd>
            <dt className="text-ink-600">Mobile</dt>
            <dd>{d.booking.visitorPhone ? <a href={`tel:${d.booking.visitorPhone}`}>{d.booking.visitorPhone}</a> : "—"}</dd>
            <dt className="text-ink-600">E-mail</dt>
            <dd>{d.booking.visitorEmail ?? "—"}</dd>
            {d.booking.visitorAge != null ? (
              <>
                <dt className="text-ink-600">Age</dt>
                <dd>{d.booking.visitorAge}</dd>
              </>
            ) : null}
            <dt className="text-ink-600">With</dt>
            <dd>{c.members.map((m) => m.name).join(", ")}</dd>
            <dt className="text-ink-600">Their notes</dt>
            <dd className="whitespace-pre-wrap">{d.booking.customerNote ?? "—"}</dd>
          </dl>
          {d.can.note ? (
            <div className="mt-2 flex flex-col gap-1">
              <Field label="Private note (never shown to the customer)">
                <textarea className={inputClass} rows={2} value={note} onChange={(e) => setNote(e.target.value)} data-testid="consult-private-note" />
              </Field>
              <div>
                <Button variant="secondary" size="sm" onClick={() => act("note", { text: note }, "Note saved.")} disabled={busy}>
                  Save note
                </Button>
              </div>
            </div>
          ) : null}
        </Panel>
      ) : d.booking.customerNote ? (
        <Panel title="Your notes">
          <p className="whitespace-pre-wrap text-sm">{d.booking.customerNote}</p>
        </Panel>
      ) : null}

      <Panel
        title="Files (private)"
        action={
          d.can.upload ? (
            <label className="inline-flex min-h-10 cursor-pointer items-center rounded-lg border border-cream-200 bg-white px-3 text-sm font-medium text-ink-700 hover:bg-cream-100">
              Attach
              <input type="file" className="sr-only" accept="application/pdf,image/jpeg,image/png,image/webp" onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])} data-testid="consult-attach" />
            </label>
          ) : null
        }
      >
        {files.length ? (
          <ul className="flex flex-col gap-1 text-sm">
            {files.map((f) => (
              <li key={f.id}>
                <a href={f.url} target="_blank" rel="noreferrer" className="font-bold text-kesari-800 underline">
                  {f.fileName}
                </a>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-ink-600">Prescriptions, reports or case papers. Only you, the consultant and GoKesari support can open them.</p>
        )}
      </Panel>

      <div className="flex flex-wrap gap-2" data-testid="consult-actions">
        {d.can.accept ? (
          <>
            <Button onClick={() => act("accept", {}, "Accepted. The customer has been told.")} disabled={busy} data-testid="consult-accept">
              Accept
            </Button>
            <Button variant="secondary" onClick={() => setOpen("reject")}>
              Decline
            </Button>
          </>
        ) : null}
        {d.can.arrive && !c.arrived ? (
          <Button variant="secondary" onClick={() => act("arrive", {}, "Marked arrived.")} disabled={busy} data-testid="consult-arrived">
            Mark arrived
          </Button>
        ) : null}
        {d.can.complete ? (
          <Button onClick={() => (d.completionNeedsCode ? setOpen("complete") : act("complete", {}, "Completed."))} disabled={busy} data-testid="consult-complete">
            Complete
          </Button>
        ) : null}
        {d.can.noShow ? (
          <Button variant="secondary" onClick={() => act("no-show", {}, "Marked as a no-show.")} disabled={busy}>
            No-show
          </Button>
        ) : null}
        {d.can.reschedule ? (
          <Button
            variant="secondary"
            onClick={() => {
              setOpen("reschedule");
              void loadSlots();
            }}
            data-testid="consult-reschedule"
          >
            Change time
          </Button>
        ) : null}
        {d.can.cancel ? (
          <Button variant="danger" onClick={() => setOpen("cancel")} data-testid="consult-cancel">
            Cancel booking
          </Button>
        ) : null}
        {d.can.rate ? (
          <Button onClick={() => setOpen("rate")} data-testid="consult-rate">
            Rate
          </Button>
        ) : null}
        {d.can.dispute ? (
          <Button variant="ghost" onClick={() => setOpen("dispute")} data-testid="consult-dispute">
            Report a problem
          </Button>
        ) : null}
        {d.booking.ticketId ? (
          <Link href={`/support/${d.booking.ticketId}`} className="inline-flex min-h-11 items-center rounded-lg px-3 text-sm font-bold text-kesari-800 underline">
            Dispute ticket
          </Link>
        ) : null}
      </div>

      {open === "cancel" || open === "reject" || open === "dispute" ? (
        <div className="flex flex-col gap-2 rounded-2xl border-2 border-red-200 bg-red-50 p-3">
          <Field label={open === "dispute" ? "What went wrong?" : firmSide ? "Reason (sent to the customer)" : "Reason (optional)"}>
            <textarea className={inputClass} rows={2} value={text} onChange={(e) => setText(e.target.value)} data-testid="consult-reason" />
          </Field>
          {open === "cancel" && !firmSide ? (
            <ul className="list-disc pl-5 text-xs text-ink-700">
              {d.booking.policy.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          ) : null}
          <div className="flex gap-2">
            <Button
              variant={open === "dispute" ? "primary" : "danger"}
              disabled={busy}
              onClick={() =>
                open === "cancel"
                  ? act("cancel", { reason: text }, "Cancelled. Any refund due is on its way.")
                  : open === "reject"
                    ? act("reject", { reason: text }, "Declined. The customer is refunded in full.")
                    : act("dispute", { reason: text }, "Thank you. Our support team will contact you.")
              }
              data-testid="consult-confirm-action"
            >
              {open === "cancel" ? "Cancel booking" : open === "reject" ? "Decline booking" : "Send"}
            </Button>
            <Button variant="ghost" onClick={() => setOpen(null)}>
              Back
            </Button>
          </div>
        </div>
      ) : null}

      {open === "complete" ? (
        <div className="flex flex-wrap items-end gap-2 rounded-2xl border-2 border-teal-300 bg-teal-50 p-3">
          <Field label="Customer's 4-digit code">
            <input className={`${inputClass} w-32 text-center text-lg tracking-widest`} inputMode="numeric" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 4))} data-testid="consult-otp" />
          </Field>
          <Button onClick={() => act("complete", { code }, "Completed.")} disabled={busy || code.length !== 4}>
            Confirm completion
          </Button>
        </div>
      ) : null}

      {open === "rate" ? (
        <div className="flex flex-col gap-2 rounded-2xl border-2 border-amber-300 bg-amber-50 p-3">
          <div className="flex gap-1" role="radiogroup" aria-label="Rating">
            {[1, 2, 3, 4, 5].map((n) => (
              <button key={n} type="button" onClick={() => setRating(n)} aria-pressed={rating >= n} className={`text-3xl ${rating >= n ? "text-amber-500" : "text-ink-300"}`} aria-label={`${n} stars`}>
                ★
              </button>
            ))}
          </div>
          <textarea className={inputClass} rows={2} value={text} onChange={(e) => setText(e.target.value)} placeholder="A few words (optional)" />
          <div>
            <Button onClick={() => act("rate", { rating, review: text || null }, "Thank you for rating.")} disabled={busy}>
              Submit rating
            </Button>
          </div>
        </div>
      ) : null}

      {open === "reschedule" ? (
        <div className="flex flex-col gap-2 rounded-2xl border-2 border-violet-300 bg-violet-50 p-3">
          <p className="text-sm font-bold">Choose a new time</p>
          <select className={inputClass} value={newStart} onChange={(e) => setNewStart(e.target.value)} data-testid="consult-new-time">
            <option value="">Free times…</option>
            {Object.keys(slots)
              .sort()
              .flatMap((day) => slots[day].map((s) => s.start))
              .filter((s) => s !== c.startsAt)
              .map((s) => (
                <option key={s} value={s}>
                  {formatSlot(s)}
                </option>
              ))}
          </select>
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => act("reschedule", { start: newStart }, "Moved. Everyone has been told.")} disabled={busy || !newStart}>
              Move booking
            </Button>
            {d.can.reassign && d.team.length > 1 ? (
              <select className={`${inputClass} w-auto`} onChange={(e) => e.target.value && act("reassign", { memberId: e.target.value }, "Reassigned.")} defaultValue="">
                <option value="">…or same time, another consultant</option>
                {d.team
                  .filter((m) => !c.members.some((x) => x.id === m.id))
                  .map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                    </option>
                  ))}
              </select>
            ) : null}
            <Button variant="ghost" onClick={() => setOpen(null)}>
              Back
            </Button>
          </div>
        </div>
      ) : null}

      {c.status === "CANCELLED" || c.status === "REJECTED" ? (
        <Alert tone="info">
          {c.status === "REJECTED" ? "Declined by the consultant" : `Cancelled by ${d.booking.cancelledBy === "CUSTOMER" ? "the customer" : d.booking.cancelledBy === "ADMIN" ? "GoKesari" : "the consultant"}`}
          {d.booking.cancelReason ? `: ${d.booking.cancelReason}` : "."}
        </Alert>
      ) : null}

      {!compact ? (
        <Panel title="Cancellation policy">
          <ul className="list-disc pl-5 text-sm text-ink-700">
            {d.booking.policy.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </Panel>
      ) : null}

      <details className="rounded-2xl border-2 border-[var(--gk-line)] bg-white p-3 text-sm">
        <summary className="cursor-pointer font-bold">History</summary>
        <ol className="mt-2 flex flex-col gap-1">
          {d.events.map((e, i) => (
            <li key={i} className="text-ink-700">
              <span className="tabular-nums text-ink-500">{formatIst(e.at)}</span> — {e.kind.replace(/_/g, " ").toLowerCase()}
              {e.to && e.from !== e.to ? ` → ${e.to.replace(/_/g, " ").toLowerCase()}` : ""}
              {e.note ? `: ${e.note}` : ""}
            </li>
          ))}
        </ol>
      </details>
    </div>
  );
}
