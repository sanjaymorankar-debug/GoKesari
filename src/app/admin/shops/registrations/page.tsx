import Link from "next/link";
import { redirect } from "next/navigation";

import { ShopRegistrationsTable, type RegistrationTableRow } from "@/components/admin/shop-registrations-table";
import { EmptyState, PageHeader } from "@/components/ui";
import { formatPaise } from "@/lib/money";
import { SHOP_TYPES } from "@/lib/shop-types";
import { getCurrentUser } from "@/server/authz/guards";
import { can, PERMISSIONS } from "@/server/authz/permissions";
import { getRule } from "@/server/services/settings";
import {
  istDay,
  istTime,
  latestMigrationReport,
  listShopRegistrations,
  REGISTRATION_FILTERS,
  type RegistrationFilter,
} from "@/server/services/shop-registration-subscription";

export const metadata = { title: "Unpaid & expiring registrations" };
export const dynamic = "force-dynamic";

const FILTER_LABEL: Record<RegistrationFilter, string> = {
  ALL: "All",
  UNPAID: "Unpaid",
  EXPIRING_30: "Expiring in 30 days",
  EXPIRING_15: "15 days",
  EXPIRING_7: "7 days",
  GRACE: "Grace",
  EXPIRED: "Expired",
  ACTIVE: "Active",
  EXEMPT: "Exempt",
};

/**
 * Admin / operator: shops whose registration fee is unpaid, expiring, in grace or expired (0205; owner brief
 * 25-Nov-2026), with reminders, payment links, expiry changes and offline Mark as paid. All times IST.
 */
export default async function ShopRegistrationsPage({
  searchParams,
}: {
  searchParams: Promise<{ filter?: string; shopType?: string; area?: string; dealerCode?: string; q?: string }>;
}) {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");
  if (!can(user.role, PERMISSIONS.SHOP_REGISTRATION_SUBSCRIPTION_MANAGE)) redirect("/");
  const p = await searchParams;
  const filter: RegistrationFilter = (REGISTRATION_FILTERS as readonly string[]).includes(p.filter ?? "") ? (p.filter as RegistrationFilter) : "UNPAID";
  const clean = (v?: string, n = 80) => (v ?? "").slice(0, n).trim();
  const params = { shopType: clean(p.shopType, 60), area: clean(p.area), dealerCode: clean(p.dealerCode, 40), q: clean(p.q) };
  const [{ rows, counts }, membership, sub, report] = await Promise.all([
    listShopRegistrations({ filter, shopType: params.shopType || undefined, area: params.area || undefined, dealerCode: params.dealerCode || undefined, q: params.q || undefined }),
    getRule("shopMembership"),
    getRule("shopRegistrationSubscription"),
    latestMigrationReport().catch(() => null),
  ]);
  const qs = (extra: Record<string, string>) => {
    const sp = new URLSearchParams();
    for (const [k, v] of Object.entries({ filter, ...params, ...extra })) if (v) sp.set(k, v);
    return sp.toString();
  };
  const count = (f: RegistrationFilter) =>
    f === "ALL" ? null : f === "EXPIRING_30" ? counts.EXPIRING_30 : f === "EXPIRING_15" ? counts.EXPIRING_15 : f === "EXPIRING_7" ? counts.EXPIRING_7 : counts[f];
  const tableRows: RegistrationTableRow[] = rows.map((r) => ({
    shopId: r.shopId,
    shopName: r.shopName,
    registrationNumber: r.registrationNumber,
    ownerName: r.ownerName,
    phone: r.phone,
    email: r.email,
    shopTypeLabel: r.shopTypeLabel,
    dealerCode: r.dealerCode,
    area: r.area,
    city: r.city,
    registeredOn: istDay(r.registeredAt),
    expiryOn: r.expiryDate ? istDay(r.expiryDate) : r.status === "UNPAID" ? "payment pending" : "no end date",
    expiryIso: r.expiryDate ? r.expiryDate.toISOString() : null,
    daysLeft: r.daysLeft,
    status: r.status,
    amountDue: formatPaise(r.amountDuePaise),
    amountDuePaise: r.amountDuePaise,
    dueKind: r.dueKind,
    lastReminder: r.lastReminderAt ? istTime(r.lastReminderAt) : "never",
    link: r.link ? { status: r.link.status, amount: formatPaise(r.link.amountPaise), until: istTime(r.link.expiresAt), url: r.link.url } : null,
    remindersEnabled: r.remindersEnabled,
  }));

  return (
    <div className="mx-auto max-w-7xl">
      <Link href="/admin/menu/shops" className="mb-2 inline-flex min-h-11 items-center text-sm font-semibold text-kesari-800 hover:underline">
        ← Shops
      </Link>
      <PageHeader
        title="Unpaid & expiring registrations"
        description={`Registration is valid ${membership.periodMonths} months from payment, then ${membership.graceDays} grace days. Reminders: ${membership.remindersEnabled ? `on, daily from ${String(sub.reminderHourIst).padStart(2, "0")}.00 IST` : "off"}. Online renewal: ${membership.renewalCheckoutEnabled ? "open" : "off"}. Expired shops ${membership.enabled ? "are hidden from customers" : "are not closed (enforcement off)"}. All times IST.`}
      />
      <div className="mb-3 flex flex-wrap gap-3 text-sm">
        {user.role === "ADMIN" ? (
          <Link href="/admin/shops/registrations/settings" className="font-semibold text-kesari-800 underline">
            Settings
          </Link>
        ) : null}
        <a href={`/api/admin/registration-subscription?${qs({ format: "csv" })}`} className="font-semibold text-kesari-800 underline">
          Download CSV
        </a>
        {report ? (
          <span className="text-ink-600">
            Migration {istTime(report.ranAt)}: {Object.entries(report.counts).map(([k, v]) => `${k.replace(/_/g, " ").toLowerCase()} ${v}`).join(" · ")}
          </span>
        ) : null}
      </div>
      <nav className="mb-3 flex flex-wrap gap-2" aria-label="Filter by registration status">
        {REGISTRATION_FILTERS.map((key) => (
          <Link
            key={key}
            href={`/admin/shops/registrations?${qs({ filter: key })}`}
            aria-current={key === filter ? "page" : undefined}
            className={`inline-flex min-h-11 items-center rounded-full border px-4 text-sm font-medium ${key === filter ? "border-kesari-600 bg-kesari-50 text-kesari-800" : "border-cream-300 text-ink-700"}`}
          >
            {FILTER_LABEL[key]}
            {count(key) != null ? ` (${count(key)})` : ""}
          </Link>
        ))}
      </nav>
      <form className="mb-4 flex flex-wrap items-end gap-2" action="/admin/shops/registrations">
        <input type="hidden" name="filter" value={filter} />
        <label className="text-sm text-ink-700">
          Shop type
          <select name="shopType" defaultValue={params.shopType} className="ml-2 min-h-11 rounded border border-cream-300 px-2">
            <option value="">All</option>
            {SHOP_TYPES.map((t) => (
              <option key={t.key} value={t.key}>
                {t.label}
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm text-ink-700">
          Area / city / PIN
          <input name="area" defaultValue={params.area} className="ml-2 min-h-11 rounded border border-cream-300 px-2" />
        </label>
        <label className="text-sm text-ink-700">
          Dealer code
          <input name="dealerCode" defaultValue={params.dealerCode} className="ml-2 min-h-11 w-32 rounded border border-cream-300 px-2" />
        </label>
        <label className="text-sm text-ink-700">
          Search
          <input name="q" defaultValue={params.q} placeholder="Shop, owner, mobile" className="ml-2 min-h-11 rounded border border-cream-300 px-2" />
        </label>
        <button type="submit" className="min-h-11 rounded bg-kesari-600 px-4 text-sm font-semibold text-white">
          Filter
        </button>
      </form>
      {tableRows.length === 0 ? <EmptyState title="No shops match." /> : <ShopRegistrationsTable rows={tableRows} linkValidityDays={sub.paymentLinkValidityDays} />}
    </div>
  );
}
