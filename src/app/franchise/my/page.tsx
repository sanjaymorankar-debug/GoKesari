import { headers } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";

import { FranchiseActions } from "@/components/franchise/franchise-actions";
import { Alert, Badge, Card, LinkButton, PageHeader } from "@/components/ui";
import { formatIst, rupees } from "@/lib/franchise";
import { getCurrentUser } from "@/server/authz/guards";
import { codeQrSvg, shareLinkFor, whatsappShareFor } from "@/server/dealers/codes";
import { originFromHeaders } from "@/server/dealers/http";
import { ownerDashboard } from "@/server/franchise/dashboard";

export const metadata = { title: "My franchise" };
export const dynamic = "force-dynamic";

const TONE: Record<string, "success" | "warning" | "danger" | "neutral"> = { ACTIVE: "success", SUSPENDED: "warning", EXPIRED: "danger", TERMINATED: "danger" };

/**
 * The franchise owner's page (brief §10): areas with dates, countdown and renewal; shops; this month's
 * commission estimate; year to date; next payout; codes with QR; responsibilities; violations. Only his own.
 */
export default async function MyFranchisePage({ searchParams }: { searchParams: Promise<{ booking?: string }> }) {
  const user = await getCurrentUser();
  if (!user) redirect("/signin?callbackUrl=/franchise/my");
  const d = await ownerDashboard(user.id);
  const sp = await searchParams;
  const origin = originFromHeaders(await headers());
  const ownerCode = d.codes.find((c) => !c.memberId && c.status === "ACTIVE")?.code ?? null;
  const qr = ownerCode ? await codeQrSvg(origin, ownerCode) : null;
  const justPaid = sp.booking ? d.bookings.find((b) => b.id === sp.booking) : null;
  const pending = d.bookings.filter((b) => b.status === "RESERVED" || b.status === "PAYMENT_PENDING");
  return (
    <div className="mx-auto max-w-5xl space-y-4 px-4 py-6" data-testid="franchise-my">
      <PageHeader title="My franchise" description={d.status.hasDealer ? `${"dealerName" in d.status ? d.status.dealerName : ""} · Pune Metropolitan Region` : "GoKesari Territory Franchise"} action={<LinkButton href="/franchise/book">Book areas</LinkButton>} />
      {!d.status.hasDealer ? (
        <Alert tone="info" title="Start with a free dealer account">
          Franchise areas are booked on a GoKesari dealer account (KYC, PAN and a verified bank account). <Link className="font-semibold underline" href="/dealer/apply">Apply free</Link>.
        </Alert>
      ) : null}
      {d.status.missing.length && d.status.hasDealer ? <Alert tone="warning">Before you can pay: {d.status.missing.join(", ")}.</Alert> : null}
      {justPaid ? (
        <Alert tone={justPaid.status === "PAID" ? "success" : justPaid.status === "PAYMENT_PENDING" ? "info" : "warning"} title={justPaid.status === "PAID" ? "Payment confirmed" : justPaid.status === "PAYMENT_PENDING" ? "Payment being verified" : "Booking not paid"}>
          {justPaid.status === "PAID" ? `Areas ${justPaid.zones.join(", ")} are active. ` : justPaid.status === "PAYMENT_PENDING" ? "We activate your areas as soon as the bank confirms the payment — refresh in a minute. " : `${justPaid.failureReason ?? "The reservation ended"}. You can book again. `}
          {justPaid.status === "PAID" ? <Link className="font-semibold underline" href={`/franchise/my/receipt/${justPaid.id}`}>Receipt</Link> : null}
        </Alert>
      ) : null}

      {d.money ? (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Card className="p-3">
            <p className="text-xs text-ink-500">Active areas</p>
            <p className="text-2xl font-bold text-ink-900">{d.areas.filter((a) => a.status === "ACTIVE").length}</p>
            <p className="text-xs text-ink-500">{d.areas.filter((a) => a.daysLeft != null && a.daysLeft <= 30 && a.status === "ACTIVE").length} expiring in 30 days</p>
          </Card>
          <Card className="p-3">
            <p className="text-xs text-ink-500">Shops</p>
            <p className="text-2xl font-bold text-ink-900">{d.shops.length}</p>
            <p className="text-xs text-ink-500">{d.shops.filter((s) => s.activatedAt).length} activated</p>
          </Card>
          <Card className="p-3">
            <p className="text-xs text-ink-500">This month so far (estimate)</p>
            <p className="text-2xl font-bold text-kesari-800" data-testid="franchise-month-estimate">{rupees(d.money.monthEstimatePaise)}</p>
            <p className="text-xs text-ink-500">
              {(d.money.shareBp + d.money.bonusBp) / 100}% of {rupees(d.money.monthGoKesariCommissionPaise)} GoKesari commission on {rupees(d.money.monthGmvPaise)} of orders
            </p>
          </Card>
          <Card className="p-3">
            <p className="text-xs text-ink-500">This financial year</p>
            <p className="text-2xl font-bold text-ink-900">{rupees(d.money.ytdOneTimePaise + d.money.ytdRecurringPaise)}</p>
            <p className="text-xs text-ink-500">Next payout {formatIst(new Date(`${d.money.nextPayoutDate}T10:00:00+05:30`), false)} · after TDS</p>
          </Card>
        </div>
      ) : null}

      <Card className="space-y-3 p-4" data-testid="franchise-territories">
        <h2 className="text-base font-bold text-ink-900">My territories</h2>
        {!d.areas.length ? <p className="text-sm text-ink-600">No areas yet. <Link className="font-semibold underline" href="/franchise/book">Choose your areas</Link>.</p> : null}
        {d.areas.map((a) => (
          <div key={a.id} id={`renew-${a.id}`} className="space-y-1 rounded-lg border border-cream-200 p-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="rounded bg-ink-900 px-2 py-0.5 text-sm font-bold text-white">{a.zoneId}</span>
              <span className="font-semibold text-ink-900">{a.zoneName}</span>
              <Badge tone={TONE[a.status] ?? "neutral"}>{a.statusLabel}</Badge>
              {a.launchOffer ? <Badge tone="info">Launch offer</Badge> : null}
            </div>
            <p className="text-sm text-ink-700">
              Slot {a.slotNo} · valid until <strong>{a.expiresAtIst}</strong>
              {a.status === "ACTIVE" && a.daysLeft != null ? ` · ${a.daysLeft} day${a.daysLeft === 1 ? "" : "s"} left` : ""} · {a.shops} shop{a.shops === 1 ? "" : "s"} · other active owners in this zone: {a.otherOwners}
            </p>
            <p className="text-xs text-ink-500">Recurring commission on shops you registered here continues until {a.tailEndAtIst}.</p>
            {a.renewalOpen ? <FranchiseActions kind="renew" id={a.id} label={`Renew for ${a.renewalFeePaise != null ? rupees(a.renewalFeePaise) : "—"} + GST`} /> : a.status === "ACTIVE" ? <p className="text-xs text-ink-500">Renewal opens 30 days before expiry.</p> : null}
            {a.status === "EXPIRED" ? <p className="text-xs text-red-700">Expired: renewal is closed and your code no longer adds shops here. Book it again if a slot is free.</p> : null}
          </div>
        ))}
      </Card>

      {pending.length ? (
        <Card className="space-y-2 p-4">
          <h2 className="text-base font-bold text-ink-900">Waiting for payment</h2>
          {pending.map((b) => (
            <div key={b.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-cream-200 p-2 text-sm">
              <span>
                {b.kind === "RENEWAL" ? "Renewal" : b.zones.join(", ")} · {rupees(b.totalPaise)} · held until {formatIst(b.holdExpiresAt)}
              </span>
              {b.status === "RESERVED" ? <FranchiseActions kind="pay" id={b.id} label="Pay now" cancel /> : <span className="text-ink-500">Payment being verified</span>}
            </div>
          ))}
        </Card>
      ) : null}

      {ownerCode ? (
        <Card className="grid gap-4 p-4 sm:grid-cols-[1fr_auto]">
          <div className="space-y-2">
            <h2 className="text-base font-bold text-ink-900">Your franchise code</h2>
            <p className="font-mono text-2xl font-bold text-kesari-800" data-testid="franchise-code">{ownerCode}</p>
            <p className="text-sm text-ink-700">Shops register with this code inside your active areas only (their map location decides). Your team leads and agents can have their own tracking codes — their shops count for you, and only you are paid.</p>
            <div className="flex flex-wrap gap-2 text-sm">
              <a className="font-semibold text-kesari-800 underline" href={shareLinkFor(origin, ownerCode)}>Registration link</a>
              <a className="font-semibold text-kesari-800 underline" href={whatsappShareFor(origin, ownerCode, d.status.hasDealer && "dealerName" in d.status ? d.status.dealerName ?? "GoKesari" : "GoKesari")}>Share on WhatsApp</a>
            </div>
            {d.codes.filter((c) => c.memberId).length ? (
              <ul className="text-sm text-ink-700">
                {d.codes.filter((c) => c.memberId).map((c) => (
                  <li key={c.code}>
                    {c.memberName}: <span className="font-mono">{c.code}</span> ({c.status.toLowerCase()})
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
          {qr ? <div className="h-40 w-40" aria-label={`QR code for ${ownerCode}`} dangerouslySetInnerHTML={{ __html: qr }} /> : null}
        </Card>
      ) : null}

      {d.rating ? (
        <Card className="space-y-1 p-4">
          <h2 className="text-base font-bold text-ink-900">Performance bonus ({d.rating.month})</h2>
          <p className="text-sm text-ink-700">{d.rating.explanation}</p>
        </Card>
      ) : null}

      <Card className="space-y-2 p-4">
        <h2 className="text-base font-bold text-ink-900">My shops</h2>
        {!d.shops.length ? <p className="text-sm text-ink-600">No shops registered with your franchise code yet.</p> : null}
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <tbody>
              {d.shops.map((s) => (
                <tr key={s.id} className="border-b border-cream-100">
                  <td className="py-1 pr-2">{s.name}</td>
                  <td className="py-1 pr-2">{s.zoneId}</td>
                  <td className="py-1 pr-2">{s.activatedAt ? "Activated" : s.status === "APPROVED" ? "Approved" : "Pending"}</td>
                  <td className="py-1 pr-2 text-ink-500">{s.attribution === "ACTIVE" ? "" : s.attribution.toLowerCase()}</td>
                  <td className="py-1 text-ink-500">{s.registeredAtIst}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <Card className="space-y-2 p-4">
        <h2 className="text-base font-bold text-ink-900">Earnings and statements</h2>
        <p className="text-sm text-ink-700">Your franchise commission appears with your dealer statements (lines: franchise one-time, franchise monthly share, performance bonus), with TDS and the payout reference.</p>
        <Link className="text-sm font-semibold text-kesari-800 underline" href="/dealer#statements">Open my statements</Link>
        {d.violations.length ? (
          <Alert tone="warning" title="Notes on your account">
            {d.violations.map((v) => `${v.atIst}: ${v.level.toLowerCase()} — ${v.note}`).join(" · ")}
          </Alert>
        ) : null}
      </Card>

      {d.bookings.filter((b) => b.status === "PAID").length ? (
        <Card className="space-y-1 p-4">
          <h2 className="text-base font-bold text-ink-900">Receipts</h2>
          {d.bookings.filter((b) => b.status === "PAID").map((b) => (
            <Link key={b.id} className="block text-sm text-kesari-800 underline" href={`/franchise/my/receipt/${b.id}`}>
              {b.paidAtIst} · {b.kind === "RENEWAL" ? "Renewal" : b.zones.join(", ")} · {rupees(b.totalPaise)}
            </Link>
          ))}
        </Card>
      ) : null}
      <p className="text-center text-xs text-ink-500">All times are IST. Support: WhatsApp or call +91 91751 93009.</p>
    </div>
  );
}
