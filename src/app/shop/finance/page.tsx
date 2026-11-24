import { redirect } from "next/navigation";

import { Card, EmptyState, Money, PageHeader, Section, StatusBadge } from "@/components/ui";
import { FillText } from "@/components/board/fill-text";
import { L, tr } from "@/lib/board/i18n";
import { getBoardLang } from "@/server/board-lang";
import { activeShop } from "@/server/active-shop";
import { getCurrentUser } from "@/server/authz/guards";
import { getRule } from "@/server/services/settings";
import { can, PERMISSIONS } from "@/server/authz/permissions";
import {
  getShopPendingPayable,
  listOrderFinancialsForShop,
  listShopSettlements,
  resolveCommissionRate,
} from "@/server/services/finance";
import { listShopsForOwner } from "@/server/services/shops";
import { listInvoicesForShop } from "@/server/services/invoices";
import { ShopPayoutStatements } from "@/components/shop-payout-statements";

export const metadata = { title: "Shop Finance" };
export const dynamic = "force-dynamic";

/** Module 6: Hindi / Marathi (English unchanged). `{x}` marks an amount or number. */
const T = {
  title: L("Finance", "फ़ाइनेंस", "फायनान्स"),
  description: L(
    "{shop} — commission {rate}% on goods; delivery fees go to the platform, which pays the rider.",
    "{shop} — सामान पर {rate}% कमीशन; डिलीवरी शुल्क प्लेटफ़ॉर्म को जाता है, जो राइडर को भुगतान करता है।",
    "{shop} — मालावर {rate}% कमिशन; डिलिव्हरी शुल्क प्लॅटफॉर्मकडे जाते, जो रायडरला पैसे देतो.",
  ),
  notSettled: L("Not yet settled", "अभी सेटल नहीं हुआ", "अजून सेटल झाले नाही"),
  deliveredOrders: L("{n} delivered orders", "{n} डिलीवर हुए ऑर्डर", "{n} पोहोचलेल्या ऑर्डर"),
  goodsValue: L("Goods value", "सामान का मूल्य", "मालाचे मूल्य"),
  commission: L("Commission", "कमीशन", "कमिशन"),
  refundsAdj: L("Refunds / adjustments", "रिफंड / समायोजन", "परतावे / समायोजन"),
  refundsOther: L("refunds {refunds} · other {other}", "रिफंड {refunds} · अन्य {other}", "परतावे {refunds} · इतर {other}"),
  settlements: L("Settlements", "सेटलमेंट", "सेटलमेंट"),
  prepared: L(
    "Prepared weekly for orders delivered at least {n} days earlier, then paid to your bank account.",
    "कम से कम {n} दिन पहले डिलीवर हुए ऑर्डर के लिए हर हफ़्ते तैयार होता है, फिर आपके बैंक खाते में भेजा जाता है।",
    "किमान {n} दिवसांपूर्वी पोहोचलेल्या ऑर्डरसाठी दर आठवड्याला तयार होते, मग तुमच्या बँक खात्यात पाठवले जाते.",
  ),
  noSettlements: L("No settlements yet.", "अभी कोई सेटलमेंट नहीं।", "अजून सेटलमेंट नाही."),
  weekFrom: L("Week from {date}", "{date} से शुरू हफ़्ता", "{date} पासूनचा आठवडा"),
  settleLine: L("{n} orders · goods {goods} − commission {commission}", "{n} ऑर्डर · सामान {goods} − कमीशन {commission}", "{n} ऑर्डर · माल {goods} − कमिशन {commission}"),
  refundsPart: L(" · refunds {amount}", " · रिफंड {amount}", " · परतावे {amount}"),
  adjPart: L(" · adjustments {amount}", " · समायोजन {amount}", " · समायोजन {amount}"),
  paidRef: L(" · paid, ref {ref}", " · भुगतान हुआ, रेफ़ {ref}", " · पैसे दिले, संदर्भ {ref}"),
  delivered: L("Delivered orders", "डिलीवर हुए ऑर्डर", "पोहोचलेल्या ऑर्डर"),
  noDelivered: L("No delivered orders yet.", "अभी कोई ऑर्डर डिलीवर नहीं हुआ।", "अजून कोणतीही ऑर्डर पोहोचलेली नाही."),
  orderLine: L("goods {goods} · {rate}% commission {commission}", "सामान {goods} · {rate}% कमीशन {commission}", "माल {goods} · {rate}% कमिशन {commission}"),
  fromWallet: L(" (paid from wallet)", " (वॉलेट से चुकाया)", " (वॉलेटमधून भरले)"),
  settlementStatus: L("settlement {status}", "सेटलमेंट {status}", "सेटलमेंट {status}"),
  notYetSettled: L("not yet settled", "अभी सेटल नहीं हुआ", "अजून सेटल झाले नाही"),
  invoices: L("Invoices ({n})", "इनवॉइस ({n})", "इनव्हॉइस ({n})"),
  taxInvoice: L("tax invoice", "टैक्स इनवॉइस", "टॅक्स इनव्हॉइस"),
  billOfSupply: L("bill of supply", "बिल ऑफ़ सप्लाई", "बिल ऑफ सप्लाय"),
} as const;

/**
 * A shop owner's money view (NAV-010): what is owed for delivered orders not
 * yet settled, the commission rate that applies, per-order payable, and
 * weekly settlement statements with their bank references.
 */
export default async function ShopFinancePage() {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");
  if (!can(user.role, PERMISSIONS.SETTLEMENT_VIEW_OWN)) redirect("/");

  const shops = await listShopsForOwner(user.id);
  if (shops.length === 0) redirect("/shop");
  const shop = await activeShop(shops);
  // Item B: live settlement hold (rule settlement.holdDays).
  const settlementHoldDays = (await getRule("settlement")).holdDays;

  const [pending, rate, recent, settlements, invoices, lang] = await Promise.all([
    getShopPendingPayable(shop.id),
    resolveCommissionRate(shop),
    listOrderFinancialsForShop(shop.id, 30),
    listShopSettlements({ shopId: shop.id, limit: 30 }),
    listInvoicesForShop(shop.id, 50),
    getBoardLang(),
  ]);

  return (
    <>
      <PageHeader
        title={tr(T.title, lang)}
        description={tr(T.description, lang).replace("{shop}", shop.name).replace("{rate}", (rate.rateBp / 100).toFixed(2))}
      />

      <section className="mb-8 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Card className="p-4">
          <p className="text-xs text-ink-500">{tr(T.notSettled, lang)}</p>
          <p className="mt-1 text-xl font-bold text-ink-900"><Money paise={pending.netPaise} /></p>
          <p className="text-xs text-ink-500">{tr(T.deliveredOrders, lang).replace("{n}", String(pending.orders))}</p>
        </Card>
        <Card className="p-4">
          <p className="text-xs text-ink-500">{tr(T.goodsValue, lang)}</p>
          <p className="mt-1 text-xl font-bold text-ink-900"><Money paise={pending.goodsPaise} /></p>
        </Card>
        <Card className="p-4">
          <p className="text-xs text-ink-500">{tr(T.commission, lang)}</p>
          <p className="mt-1 text-xl font-bold text-ink-900"><Money paise={pending.commissionPaise} /></p>
        </Card>
        <Card className="p-4">
          <p className="text-xs text-ink-500">{tr(T.refundsAdj, lang)}</p>
          <p className="mt-1 text-xl font-bold text-ink-900">
            <Money paise={pending.refundsPaise + pending.adjustmentsPaise} />
          </p>
          <p className="text-xs text-ink-500">
            <FillText text={tr(T.refundsOther, lang)} parts={{ refunds: <Money paise={pending.refundsPaise} />, other: <Money paise={pending.adjustmentsPaise} /> }} />
          </p>
        </Card>
      </section>

      <Section id="settlements" title={tr(T.settlements, lang)}>
        <p className="mb-3 text-xs text-ink-500">
          {tr(T.prepared, lang).replace("{n}", String(settlementHoldDays))}
        </p>
        {settlements.length === 0 ? (
          <EmptyState title={tr(T.noSettlements, lang)} />
        ) : (
          <Card className="divide-y divide-cream-100">
            {settlements.map(({ settlement: s }) => (
              <div key={s.id} className="flex flex-wrap items-center justify-between gap-3 p-3 text-sm">
                <div>
                  <p className="font-medium text-ink-900">{tr(T.weekFrom, lang).replace("{date}", String(s.periodStart))}</p>
                  <p className="text-xs text-ink-500">
                    <FillText
                      text={tr(T.settleLine, lang).replace("{n}", String(s.orderCount))}
                      parts={{ goods: <Money paise={s.goodsPaise} />, commission: <Money paise={s.commissionPaise} /> }}
                    />
                    {s.refundsPaise !== 0 ? <FillText text={tr(T.refundsPart, lang)} parts={{ amount: <Money paise={s.refundsPaise} /> }} /> : null}
                    {s.adjustmentsPaise !== 0 ? <FillText text={tr(T.adjPart, lang)} parts={{ amount: <Money paise={s.adjustmentsPaise} /> }} /> : null}
                    {s.paymentReference ? tr(T.paidRef, lang).replace("{ref}", s.paymentReference) : ""}
                    {s.failureReason ? ` · ${s.failureReason}` : ""}
                  </p>
                </div>
                <div className="flex items-center gap-3">
                  <StatusBadge status={s.status} />
                  <span className="font-semibold"><Money paise={s.netPayablePaise} /></span>
                </div>
              </div>
            ))}
          </Card>
        )}
      </Section>

      {/* batch-2026-10 WS-E: automated payout statements and GoKesari's fee invoices. */}
      <ShopPayoutStatements shopId={shop.id} />

      <Section title={tr(T.delivered, lang)}>
        {recent.length === 0 ? (
          <EmptyState title={tr(T.noDelivered, lang)} />
        ) : (
          <Card className="divide-y divide-cream-100">
            {recent.map(({ financial: f, orderNumber, settlementStatus }) => (
              <div key={f.orderId} className="flex flex-wrap items-center justify-between gap-3 p-3 text-sm">
                <span>
                  {orderNumber}
                  <span className="ml-2 text-xs text-ink-500">
                    <FillText
                      text={tr(T.orderLine, lang).replace("{rate}", (f.commissionRateBp / 100).toFixed(2))}
                      parts={{ goods: <Money paise={f.goodsPaise} />, commission: <Money paise={f.commissionPaise} /> }}
                    />
                    {f.commissionCollection === "SHOP_WALLET" ? tr(T.fromWallet, lang) : ""}
                  </span>
                </span>
                <span className="flex items-center gap-2">
                  <span className="text-xs text-ink-500">
                    {settlementStatus ? tr(T.settlementStatus, lang).replace("{status}", settlementStatus.toLowerCase()) : tr(T.notYetSettled, lang)}
                  </span>
                  <span className="font-semibold"><Money paise={f.shopPayablePaise} /></span>
                </span>
              </div>
            ))}
          </Card>
        )}
      </Section>

      {/* NEW-007: the shop's invoices for delivered orders. */}
      {invoices.length > 0 ? (
        <Section id="invoices" title={tr(T.invoices, lang).replace("{n}", String(invoices.length))}>
          <Card className="divide-y divide-cream-200" data-testid="shop-invoices">
            {invoices.map((inv) => (
              <div key={inv.id} className="flex flex-wrap items-center justify-between gap-2 p-3 text-sm">
                <span>
                  <a href={`/invoices/${inv.id}`} className="font-medium text-kesari-700 hover:underline">
                    {inv.invoiceNumber}
                  </a>
                  <span className="text-ink-500">
                    {" "}
                    · {inv.kind === "TAX_INVOICE" ? tr(T.taxInvoice, lang) : tr(T.billOfSupply, lang)} ·{" "}
                    {inv.issuedAt.toLocaleDateString("en-IN", { dateStyle: "medium", timeZone: "Asia/Kolkata" })}
                  </span>
                </span>
                <span className="flex items-center gap-3">
                  <Money paise={inv.totalPaise} />
                  <a href={`/api/invoices/${inv.id}/pdf`} className="text-xs font-medium text-kesari-700 hover:underline">
                    PDF
                  </a>
                </span>
              </div>
            ))}
          </Card>
        </Section>
      ) : null}
    </>
  );
}
