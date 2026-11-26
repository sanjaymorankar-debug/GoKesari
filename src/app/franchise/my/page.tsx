import { headers } from "next/headers";
import { ReferralShareButtons } from "@/components/referral-sharing/share-buttons";
import { referralSharingOn } from "@/server/services/referral-links";
import Link from "next/link";
import { redirect } from "next/navigation";
import { dualVerifyRedirect } from "@/server/dual-auth/policy";

import { AreaMap, type AreaShape } from "@/components/franchise/area-map";
import { FranchiseActions } from "@/components/franchise/franchise-actions";
import { Alert, Badge, Card, LinkButton, PageHeader } from "@/components/ui";
import { formatIst, rupees } from "@/lib/franchise";
import { getCurrentUser } from "@/server/authz/guards";
import { codeQrSvg, shareLinkFor, whatsappShareFor } from "@/server/dealers/codes";
import { originFromHeaders } from "@/server/dealers/http";
import { pendingPlanBookings } from "@/server/franchise/booking";
import { ownerDashboard } from "@/server/franchise/dashboard";
import { onboardingV2Enabled } from "@/server/onboarding-v2/roles";

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
  // docs/dual-auth-2026-11: team / franchise features need both factors verified (flag dual_auth).
  const verifyAt = await dualVerifyRedirect(user.id, "/franchise/my").catch(() => null);
  if (verifyAt) redirect(verifyAt);
  // QA D-169: the buyer's own v2 checkouts left open past "held until" are released before they are listed.
  if (await onboardingV2Enabled()) await pendingPlanBookings(user.id).catch((error: unknown) => console.error("[franchise/my] pending bookings", error));
  const d = await ownerDashboard(user.id);
  const sp = await searchParams;
  const origin = originFromHeaders(await headers());
  // docs/referral-sharing-2026-11: the /r/<code> Share buttons while rule referralSharing is on.
  const sharing = await referralSharingOn();
  // Onboarding v2: "My team" (/dealer/team) from the franchise dashboard; new zones through Become a franchisee.
  const ov2 = await onboardingV2Enabled();
  const areaCodes = d.codes;
  const qrs = new Map(await Promise.all(areaCodes.filter((c) => c.status === "ACTIVE").map(async (c) => [c.code, await codeQrSvg(origin, c.code)] as const)));
  const maps = ("maps" in d ? d.maps : []) as AreaShape[];
  const justPaid = sp.booking ? d.bookings.find((b) => b.id === sp.booking) : null;
  const pending = d.bookings.filter((b) => b.status === "RESERVED" || b.status === "PAYMENT_PENDING");
  return (
    <div className="mx-auto max-w-5xl space-y-4 px-4 py-6" data-testid="franchise-my">
      <PageHeader title="My franchise" description={d.status.hasDealer ? `${"dealerName" in d.status ? d.status.dealerName : ""} · Pune franchise zones` : "GoKesari Territory Franchise"} action={
          <div className="flex flex-wrap gap-2">
            {ov2 && d.status.hasDealer ? (
              <LinkButton href="/dealer/team" variant="secondary">
                My team
              </LinkButton>
            ) : null}
            <LinkButton href={ov2 ? "/franchise/start?model=paid" : "/franchise/book"}>Book zones</LinkButton>
          </div>
        } />
      {!d.status.hasDealer ? (
        <Alert tone="info" title="Start with a free dealer account">
          Franchise areas are booked on a GoKesari dealer account (KYC, PAN and a verified bank account). <Link className="font-semibold underline" href={ov2 ? "/franchise/start" : "/dealer/apply"}>{ov2 ? "Become a franchisee" : "Apply free"}</Link>.
        </Alert>
      ) : null}
      {d.status.missing.length && d.status.hasDealer ? <Alert tone="warning">Before you can pay: {d.status.missing.join(", ")}.</Alert> : null}
      {d.areas.some((a) => a.kycDueAtIst) ? (
        <Alert tone="warning" title="Finish your KYC to go live" data-testid="franchise-kyc-due">
          {d.areas
            .filter((a) => a.kycDueAtIst)
            .map((a) => a.zoneId)
            .join(", ")}{" "}
          {d.areas.filter((a) => a.kycDueAtIst).length === 1 ? "is" : "are"} paid and booked for you. Still needed: {d.status.kycMissing.join(", ") || "GoKesari's approval"} — by {d.areas.find((a) => a.kycDueAtIst)?.kycDueAtIst}. Your franchise code, team shops and commission start once approved.{" "}
          <Link className="font-semibold underline" href="/dealer/apply">
            Finish KYC
          </Link>
        </Alert>
      ) : null}
      {justPaid ? (
        <Alert tone={justPaid.status === "PAID" ? "success" : justPaid.status === "PAYMENT_PENDING" ? "info" : "warning"} title={justPaid.status === "PAID" ? "Payment confirmed" : justPaid.status === "PAYMENT_PENDING" ? "Payment being verified" : "Booking not paid"}>
          {justPaid.status === "PAID" ? (d.areas.some((a) => a.kycDueAtIst && justPaid.zones.includes(a.zoneId)) ? `Areas ${justPaid.zones.join(", ")} are booked for you — finish your KYC to go live. ` : `Areas ${justPaid.zones.join(", ")} are active. `) : justPaid.status === "PAYMENT_PENDING" ? "We activate your areas as soon as the bank confirms the payment — refresh in a minute. " : `${justPaid.failureReason ?? "The reservation ended"}. You can book again. `}
          {justPaid.status === "PAID" ? <Link className="font-semibold underline" href={`/franchise/my/receipt/${justPaid.id}`}>Receipt</Link> : null}
        </Alert>
      ) : null}

      {d.money ? (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Card className="p-3">
            <p className="text-xs text-ink-500">Active zones</p>
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
        {!d.areas.length ? <p className="text-sm text-ink-600">No zones yet. <Link className="font-semibold underline" href="/franchise/book">Choose your zones</Link>.</p> : null}
        {d.areas.map((a) => (
          <div key={a.id} id={`renew-${a.id}`} className="space-y-1 rounded-lg border border-cream-200 p-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="rounded bg-ink-900 px-2 py-0.5 text-sm font-bold text-white">{a.zoneId}</span>
              <span className="font-semibold text-ink-900">{a.zoneName}</span>
              {a.kycDueAtIst ? <Badge tone="warning">Booked · awaiting KYC</Badge> : <Badge tone={TONE[a.status] ?? "neutral"}>{a.statusLabel}</Badge>}
              <Badge tone="neutral">{a.tier.charAt(0) + a.tier.slice(1).toLowerCase()}</Badge>
              {a.launchOffer ? <Badge tone="info">Launch offer</Badge> : null}
            </div>
            <p className="text-sm text-ink-700">
              Slot {a.slotNo} · fee {rupees(a.feePaise)} a year + GST (locked for this term) · valid until <strong>{a.expiresAtIst}</strong>
              {a.status === "ACTIVE" && a.daysLeft != null ? ` · ${a.daysLeft} day${a.daysLeft === 1 ? "" : "s"} left` : ""} · {a.shops} shop{a.shops === 1 ? "" : "s"} · other active owners in this zone: {a.otherOwners}
            </p>
            <p className="text-xs text-ink-500">Recurring commission on shops your own team registered here continues until {a.tailEndAtIst}.</p>
            {a.renewalOpen ? (
              <FranchiseActions kind="renew" id={a.id} coupon label={`Renew for ${a.renewalFeePaise != null ? rupees(a.renewalFeePaise) : "—"} + GST`} />
            ) : a.status === "ACTIVE" ? (
              <p className="text-xs text-ink-500">Renewal opens 30 days before expiry, at the zone&apos;s published fee then.</p>
            ) : null}
            {a.renewalOpen && a.renewalFeePaise != null && a.renewalFeePaise !== a.feePaise ? <p className="text-xs text-ink-600">The zone&apos;s fee was updated from new business data: renewal is {rupees(a.renewalFeePaise)} (this term {rupees(a.feePaise)}).</p> : null}
            {a.status === "EXPIRED" ? <p className="text-xs text-red-700">Expired: renewal is closed and your franchise code no longer adds shops. Book the zone again if a slot is free.</p> : null}
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
              {b.status === "RESERVED" ? (
                <FranchiseActions kind="pay" id={b.id} label="Pay now" cancel />
              ) : b.plan ? (
                // QA D-169 (onboarding v2): an open checkout can be continued or given up.
                <FranchiseActions kind="pay" id={b.id} label="Continue payment" cancel />
              ) : (
                <span className="text-ink-500">Payment being verified</span>
              )}
            </div>
          ))}
        </Card>
      ) : null}

      {d.live.length ? (
        <Card className="space-y-3 p-4" data-testid="franchise-live">
          <h2 className="text-base font-bold text-ink-900">This month so far</h2>
          {d.totals ? (
            <p className="text-sm text-ink-700">
              All your areas: {d.totals.newShops} new shops · {d.totals.openingShops} opening shops · {rupees(d.totals.allBusinessPaise)} delivered · projected payout <strong>{rupees(d.totals.projectedPayoutPaise)}</strong>
            </p>
          ) : null}
          <div className="grid gap-3 md:grid-cols-2">
            {d.live.map((l) => (
              <div key={l.allocationId} className="space-y-1 rounded-lg border border-cream-200 p-3 text-sm text-ink-700">
                <p className="font-semibold text-ink-900">
                  {l.zoneId} · {l.zoneName} · <span className="font-mono">{l.code ?? "—"}</span>
                </p>
                <p>
                  New shops <strong>{l.newShops}</strong> of target {l.target} · business of opening shops {rupees(l.actualBusinessPaise)} vs baseline {rupees(l.baselinePaise)} ({l.openingShops} shops)
                </p>
                <p>
                  Base points so far <strong>{l.totalPoints}</strong> → bonus {(l.bonusBp / 100).toFixed(1)}% → rate <strong>{(l.rateBp / 100).toFixed(1)}%</strong> · rating {l.rating.toFixed(2)}
                  {l.bonusEligible ? "" : " (franchise not active: no bonus)"}
                </p>
                <p>
                  Projected payout <strong>{rupees(l.projectedPayoutPaise)}</strong> (on {rupees(l.allBusinessPaise)} delivered so far)
                </p>
              </div>
            ))}
          </div>
          <p className="text-xs text-ink-500">Shops registered this month join your baseline next month. Final figures are worked out after the month ends; statements arrive on the 4th, payout on the 5th.</p>
        </Card>
      ) : null}

      {areaCodes.length ? (
        <Card className="space-y-3 p-4">
          <h2 className="text-base font-bold text-ink-900">Your franchise codes (one per zone)</h2>
          {maps.length ? <AreaMap shapes={maps} /> : null}
          <div className="grid gap-3 sm:grid-cols-2">
            {areaCodes.map((c) => (
              <div key={c.code} className="flex items-start justify-between gap-3 rounded-lg border border-cream-200 p-3">
                <div className="space-y-1 text-sm">
                  <p className="font-mono text-xl font-bold text-kesari-800" data-testid="franchise-code">{c.code}</p>
                  <p className="text-ink-700">
                    <Link className="underline" href={`/franchise/zones/${encodeURIComponent(c.zoneId)}`}>Zone {c.zoneId}</Link> · {c.status === "ACTIVE" ? "open for new shops" : "closed for new shops"}
                  </p>
                  <p className="text-ink-700">{d.shops.filter((x) => x.zoneId === c.zoneId).length} shops tagged</p>
                  {c.status === "ACTIVE" && sharing ? (
                    <ReferralShareButtons code={c.code} who={"dealerName" in d.status ? (d.status.dealerName ?? "GoKesari") : "GoKesari"} audience="shop-owner" origin={origin} subject="Register your shop on GoKesari" />
                  ) : c.status === "ACTIVE" ? (
                    <div className="flex flex-wrap gap-2">
                      <a className="font-semibold text-kesari-800 underline" href={shareLinkFor(origin, c.code)}>Registration link</a>
                      <a className="font-semibold text-kesari-800 underline" href={whatsappShareFor(origin, c.code, "dealerName" in d.status ? (d.status.dealerName ?? "GoKesari") : "GoKesari")}>WhatsApp</a>
                    </div>
                  ) : null}
                </div>
                {qrs.get(c.code) ? <div className="h-28 w-28 shrink-0" aria-label={`QR code for ${c.code}`} dangerouslySetInnerHTML={{ __html: qrs.get(c.code)! }} /> : null}
              </div>
            ))}
          </div>
          <p className="text-xs text-ink-500">This code works like your own dealer code: a shop you register with it counts as yours. A shop&apos;s zone comes from the area chosen at registration. Your team leads and agents use their own codes and GoKesari pays them directly.</p>
        </Card>
      ) : null}

      {d.statements.length ? (
        <Card className="space-y-2 p-4" data-testid="franchise-statements">
          <h2 className="text-base font-bold text-ink-900">Monthly statements</h2>
          <table className="min-w-full text-sm">
            <tbody>
              {d.statements.map((st) => (
                <tr key={st.id} className="border-b border-cream-100">
                  <td className="py-1 pr-2">{st.month}</td>
                  <td className="py-1 pr-2">{st.zoneId} · <span className="font-mono">{st.code ?? "—"}</span></td>
                  <td className="py-1 pr-2">rate {(st.rateBp / 100).toFixed(1)}% · rating {st.rating.toFixed(1)}</td>
                  <td className="py-1 pr-2 text-right">{rupees(st.totalPayoutPaise)}</td>
                  <td className="py-1 pr-2">{st.status === "LOCKED" ? "Final" : "Draft"}</td>
                  <td className="py-1">
                    <a className="font-semibold text-kesari-800 underline" href={`/api/franchise/statements/${st.id}`}>PDF</a> · <a className="text-kesari-800 underline" href={`/api/franchise/statements/${st.id}?format=csv`}>CSV</a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      ) : null}

      {d.rating ? (
        <Card className="space-y-1 p-4">
          <h2 className="text-base font-bold text-ink-900">Your rating</h2>
          <p className="text-sm text-ink-700">
            {d.rating.month}: rating <strong>{d.rating.rating.toFixed(1)}</strong> (5.0 + your bonus %), commission rate {(d.rating.rateBp / 100).toFixed(1)}%. It is worked out every month and can go up or down.
          </p>
        </Card>
      ) : null}

      <Card className="space-y-2 p-4">
        <h2 className="text-base font-bold text-ink-900">My shops</h2>
        {!d.shops.length ? <p className="text-sm text-ink-600">No shops attached to your franchise yet.</p> : null}
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
        <p className="text-sm text-ink-700">Your franchise commission appears with your dealer statements (lines: one-time commission on your team&apos;s shops, franchise monthly share, performance bonus), with TDS and the payout reference.</p>
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
