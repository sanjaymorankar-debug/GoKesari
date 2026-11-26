import { redirect } from "next/navigation";

import { Card, EmptyState, PageHeader } from "@/components/ui";
import { formatIst } from "@/lib/franchise";
import { CHANNEL_LABEL, isShareChannel, SHARE_CHANNELS } from "@/lib/referral-share";
import { getCurrentUser } from "@/server/authz/guards";
import { can, PERMISSIONS } from "@/server/authz/permissions";
import { REFERRAL_LINK_KINDS, type ReferralLinkKind } from "@/server/db/schema";
import { referralReport } from "@/server/services/referral-links";

export const metadata = { title: "Referral sharing report" };
export const dynamic = "force-dynamic";

const one = (v: string | string[] | undefined) => (typeof v === "string" ? v.trim() : "");
const KIND_LABEL: Record<ReferralLinkKind, string> = {
  CUSTOMER: "Customer",
  SHOP: "Shop owner",
  DEALER: "Dealer / team lead / agent",
  FRANCHISE: "Franchise",
  GOKESARI: "GoKesari code",
  UNKNOWN: "Unknown code",
};

/**
 * docs/referral-sharing-2026-11: shares, link opens, app first-opens and deferred claims per referral
 * code, filterable by referrer (code, name or e-mail), role, channel and IST date. Sign-ups, rewards and
 * commission stay on their own pages (Customer referrals, Shop-refers-shop, Dealers). Admin and operators.
 */
export default async function ReferralLinksReportPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");
  if (!can(user.role, PERMISSIONS.REPORT_VIEW_OPERATIONAL) && user.role !== "ADMIN") redirect("/");
  const p = await searchParams;
  const kind = (REFERRAL_LINK_KINDS as readonly string[]).includes(one(p.kind)) ? (one(p.kind) as ReferralLinkKind) : null;
  const channel = isShareChannel(one(p.channel)) ? one(p.channel) : null;
  const filter = { referrer: one(p.referrer) || null, kind, channel, from: one(p.from) || null, to: one(p.to) || null };
  const { rows, recent } = await referralReport(filter);
  const totals = rows.reduce((a, r) => ({ shares: a.shares + r.shares, clicks: a.clicks + r.clicks, claims: a.claims + r.claims }), { shares: 0, clicks: 0, claims: 0 });
  const input = "rounded-lg border border-cream-300 px-2 py-1 text-sm";
  return (
    <div className="mx-auto max-w-6xl space-y-4">
      <PageHeader title="Referral sharing report" description="Every share button press and referral link opened, by referrer, role, channel and date (IST)." />
      <Card className="p-3">
        <form className="flex flex-wrap items-end gap-2 text-sm" data-testid="referral-report-filter">
          <label className="flex flex-col">
            Referrer (code, name, e-mail)
            <input name="referrer" defaultValue={filter.referrer ?? ""} className={input} />
          </label>
          <label className="flex flex-col">
            Role
            <select name="kind" defaultValue={kind ?? ""} className={input}>
              <option value="">All</option>
              {REFERRAL_LINK_KINDS.map((k) => (
                <option key={k} value={k}>
                  {KIND_LABEL[k]}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col">
            Channel
            <select name="channel" defaultValue={channel ?? ""} className={input}>
              <option value="">All</option>
              {SHARE_CHANNELS.map((c) => (
                <option key={c} value={c}>
                  {CHANNEL_LABEL[c]}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col">
            From (IST)
            <input type="date" name="from" defaultValue={filter.from ?? ""} className={input} />
          </label>
          <label className="flex flex-col">
            To (IST)
            <input type="date" name="to" defaultValue={filter.to ?? ""} className={input} />
          </label>
          <button className="rounded-lg bg-kesari-700 px-3 py-1.5 font-semibold text-white">Show</button>
        </form>
      </Card>
      <p className="text-sm text-ink-700" data-testid="referral-report-totals">
        {rows.length} codes · {totals.shares} shares · {totals.clicks} link opens · {totals.claims} app installs matched
      </p>
      {rows.length === 0 ? (
        <EmptyState title="No shares or link opens for this filter." />
      ) : (
        <Card className="overflow-x-auto p-0">
          <table className="w-full text-sm" data-testid="referral-report-table">
            <thead className="bg-cream-50 text-left text-ink-500">
              <tr>
                <th className="p-2">Code</th>
                <th className="p-2">Role</th>
                <th className="p-2">Referrer</th>
                <th className="p-2 text-right">Shares</th>
                <th className="p-2 text-right">Opens</th>
                <th className="p-2 text-right">Blocked opens</th>
                <th className="p-2 text-right">App first-opens</th>
                <th className="p-2 text-right">Installs matched</th>
                <th className="p-2">Last (IST)</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={`${r.code}-${r.referrerUserId ?? ""}`} className="border-t border-cream-200" data-testid="referral-report-row" data-code={r.code}>
                  <td className="p-2 font-mono">{r.code}</td>
                  <td className="p-2">{KIND_LABEL[r.kind]}</td>
                  <td className="p-2">{r.referrerName ?? "—"}</td>
                  <td className="p-2 text-right">{r.shares}</td>
                  <td className="p-2 text-right">{r.clicks}</td>
                  <td className="p-2 text-right">{r.blocked}</td>
                  <td className="p-2 text-right">{r.appOpens}</td>
                  <td className="p-2 text-right">{r.claims}</td>
                  <td className="p-2">{formatIst(r.last)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
      {recent.length ? (
        <Card className="overflow-x-auto p-0">
          <h2 className="p-2 text-base font-bold text-ink-900">Latest events</h2>
          <table className="w-full text-sm" data-testid="referral-report-events">
            <thead className="bg-cream-50 text-left text-ink-500">
              <tr>
                <th className="p-2">Time (IST)</th>
                <th className="p-2">Event</th>
                <th className="p-2">Code</th>
                <th className="p-2">Channel</th>
                <th className="p-2">Outcome</th>
                <th className="p-2">In app</th>
              </tr>
            </thead>
            <tbody>
              {recent.map(({ e }) => (
                <tr key={e.id} className="border-t border-cream-200">
                  <td className="p-2">{formatIst(e.createdAt)}</td>
                  <td className="p-2">{e.event}</td>
                  <td className="p-2 font-mono">{e.code}</td>
                  <td className="p-2">{e.channel && isShareChannel(e.channel) ? CHANNEL_LABEL[e.channel] : "—"}</td>
                  <td className="p-2">{e.outcome}</td>
                  <td className="p-2">{e.inApp ? "Yes" : "No"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      ) : null}
    </div>
  );
}
