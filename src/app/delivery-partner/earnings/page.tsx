import Link from "next/link";
import { redirect } from "next/navigation";
import clsx from "clsx";

import { IncentiveLadderCard } from "@/components/rider-shell/home-sections";
import { Card, Money, PageHeader, StatusBadge } from "@/components/ui";
import { L, LANG_TAG, tr, type Lang, type Text } from "@/lib/board/i18n";
import type { LedgerComponent } from "@/lib/rider-week";
import { getCurrentUser } from "@/server/authz/guards";
import { getBoardLang } from "@/server/board-lang";
import { getMyDeliveryPartnerProfile } from "@/server/services/delivery-partners";
import { getRiderEarningsWeek } from "@/server/services/rider-earnings-week";
import { incentiveLadders } from "@/server/services/rider-home";
import { getRule } from "@/server/services/settings";

export const metadata = { title: "My earnings" };
export const dynamic = "force-dynamic";

const T = {
  title: L("Earnings", "कमाई", "कमाई"),
  prev: L("Previous week", "पिछला हफ़्ता", "मागचा आठवडा"),
  next: L("Next week", "अगला हफ़्ता", "पुढचा आठवडा"),
  thisWeek: L("This week", "इस हफ़्ते", "हा आठवडा"),
  weekTotal: L("Week total", "हफ़्ते की कुल कमाई", "आठवड्याची एकूण कमाई"),
  trips: L("{n} trips", "{n} ट्रिप", "{n} ट्रिप"),
  byDay: L("Earnings by day", "दिन के हिसाब से कमाई", "दिवसानुसार कमाई"),
  tripPay: L("Trip earnings", "ट्रिप कमाई", "ट्रिप कमाई"),
  incentives: L("Incentives", "इंसेंटिव", "इन्सेंटिव्ह"),
  tips: L("Tips", "टिप", "टिप"),
  deductions: L("Deductions", "कटौती", "कपात"),
  cashTitle: L("Cash in hand (COD to deposit)", "हाथ में नकद (जमा करने वाला COD)", "हातातील रोकड (जमा करायची COD)"),
  cashNote: L(
    "Cash you collected on delivery and have not deposited yet. It is not part of your earnings.",
    "डिलीवरी पर लिया गया नकद जो अभी जमा नहीं हुआ। यह आपकी कमाई का हिस्सा नहीं है।",
    "डिलिव्हरीवर घेतलेली आणि अजून जमा न केलेली रोकड. ही तुमच्या कमाईचा भाग नाही.",
  ),
  cashOrders: L("from {n} orders", "{n} ऑर्डर से", "{n} ऑर्डरमधून"),
  noCash: L("No cash to deposit.", "जमा करने के लिए कोई नकद नहीं।", "जमा करायची रोकड नाही."),
  offers: L("Offers & incentives", "ऑफ़र और इंसेंटिव", "ऑफर आणि इन्सेंटिव्ह"),
  noOffers: L("No incentive targets are running right now.", "अभी कोई इंसेंटिव लक्ष्य नहीं चल रहा।", "सध्या कोणतेही इन्सेंटिव्ह लक्ष्य सुरू नाही."),
  orders: L("Orders this week", "इस हफ़्ते के ऑर्डर", "या आठवड्यातील ऑर्डर"),
  noOrders: L("No earnings this week.", "इस हफ़्ते कोई कमाई नहीं।", "या आठवड्यात कमाई नाही."),
  returnPickup: L("Return pickup", "रिटर्न पिकअप", "रिटर्न पिकअप"),
  quoteFinal: L("Quote {q} · Final {f}", "कोट {q} · अंतिम {f}", "कोट {q} · अंतिम {f}"),
  payouts: L("Payouts", "पेआउट", "पेआउट"),
  noPayouts: L("Earnings are paid out weekly — nothing batched yet.", "कमाई हर हफ़्ते दी जाती है — अभी कुछ जमा नहीं हुआ।", "कमाई दर आठवड्याला दिली जाते — अजून काही जमा झालेले नाही."),
  utr: L("UTR {r}", "UTR {r}", "UTR {r}"),
  payoutWeek: L("{from} – {to} · {n} deliveries", "{from} – {to} · {n} डिलीवरी", "{from} – {to} · {n} डिलिव्हऱ्या"),
  wallet: L("Early cashout — My wallet", "जल्दी निकासी — मेरा वॉलेट", "लवकर पैसे काढा — माझे वॉलेट"),
  notRider: L("Earnings show here once you are an approved delivery partner.", "मंज़ूर डिलीवरी पार्टनर बनने के बाद कमाई यहाँ दिखेगी।", "मंजूर डिलिव्हरी पार्टनर झाल्यावर कमाई इथे दिसेल."),
} as const;

const DAY: Text[] = [
  L("Mon", "सोम", "सोम"),
  L("Tue", "मंगल", "मंगळ"),
  L("Wed", "बुध", "बुध"),
  L("Thu", "गुरु", "गुरु"),
  L("Fri", "शुक्र", "शुक्र"),
  L("Sat", "शनि", "शनि"),
  L("Sun", "रवि", "रवि"),
];

const LINE: Record<LedgerComponent, Text> = {
  BASE: L("Base pay", "बेस भुगतान", "मूळ रक्कम"),
  DISTANCE: L("Distance", "दूरी", "अंतर"),
  ORDER_COMPONENT: L("Order pay", "ऑर्डर भुगतान", "ऑर्डर रक्कम"),
  SLOT_INCENTIVE: L("Slot bonus", "स्लॉट बोनस", "स्लॉट बोनस"),
  MIN_TOP_UP: L("Minimum pay top-up", "न्यूनतम भुगतान टॉप-अप", "किमान रक्कम टॉप-अप"),
  ORDER_INCENTIVE: L("Order incentive", "ऑर्डर इंसेंटिव", "ऑर्डर इन्सेंटिव्ह"),
  OTHER_INCENTIVE: L("Incentive", "इंसेंटिव", "इन्सेंटिव्ह"),
  DEDUCTION: L("Deduction", "कटौती", "कपात"),
};

/** "23 Nov" for a YYYY-MM-DD key, in the board language. */
function shortDate(key: string, lang: Lang): string {
  const [y, m, d] = key.split("-").map(Number);
  return new Intl.DateTimeFormat(LANG_TAG[lang], { day: "numeric", month: "short", timeZone: "UTC" }).format(new Date(Date.UTC(y, m - 1, d)));
}

export default async function RiderEarningsWeekPage({ searchParams }: { searchParams: Promise<{ start?: string }> }) {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");
  // Rider App v2 screen: with the rule off the rider keeps the earnings on the dashboard as before.
  if (!(await getRule("riderAppV2")).enabled) redirect("/delivery-partner");
  const lang = await getBoardLang();
  const t = (text: Text) => tr(text, lang);
  const partner = await getMyDeliveryPartnerProfile(user.id);
  if (!partner) redirect("/delivery-partner/apply");
  if (partner.status !== "APPROVED") {
    return (
      <div className="mx-auto max-w-2xl">
        <PageHeader title={t(T.title)} />
        <p className="text-sm text-ink-600">{t(T.notRider)}</p>
      </div>
    );
  }

  const { start } = await searchParams;
  const [week, ladders] = await Promise.all([getRiderEarningsWeek(partner.id, start ?? null), incentiveLadders(partner.id).catch(() => [])]);
  const maxDay = Math.max(1, ...week.days.map((d) => d.totalPaise));
  const chips: { label: Text; paise: number; tone: string }[] = [
    { label: T.tripPay, paise: week.chips.tripPaise, tone: "bg-kesari-50 text-kesari-900" },
    { label: T.incentives, paise: week.chips.incentivesPaise, tone: "bg-green-50 text-green-900" },
    { label: T.tips, paise: week.chips.tipsPaise, tone: "bg-blue-50 text-blue-900" },
    { label: T.deductions, paise: week.chips.deductionsPaise, tone: "bg-red-50 text-red-900" },
  ];

  return (
    <div className="mx-auto max-w-2xl space-y-4" data-testid="rider-earnings-week">
      <PageHeader title={t(T.title)} />

      <nav className="flex items-center justify-between gap-2" aria-label={t(T.title)}>
        <Link
          href={`/delivery-partner/earnings?start=${week.week.prevStart}`}
          className="inline-flex min-h-11 items-center rounded-lg border border-cream-200 bg-white px-3 text-sm font-medium text-ink-800"
          aria-label={t(T.prev)}
          data-testid="week-prev"
        >
          ‹ <span className="ml-1 hidden min-[400px]:inline">{t(T.prev)}</span>
        </Link>
        <p className="text-center text-sm font-semibold text-ink-900" data-testid="week-label">
          {week.week.isCurrent ? `${t(T.thisWeek)} · ` : ""}
          {shortDate(week.week.start, lang)} – {shortDate(week.week.end, lang)}
        </p>
        {week.week.nextStart ? (
          <Link
            href={`/delivery-partner/earnings?start=${week.week.nextStart}`}
            className="inline-flex min-h-11 items-center rounded-lg border border-cream-200 bg-white px-3 text-sm font-medium text-ink-800"
            aria-label={t(T.next)}
            data-testid="week-next"
          >
            <span className="mr-1 hidden min-[400px]:inline">{t(T.next)}</span> ›
          </Link>
        ) : (
          <span className="min-w-11" aria-hidden />
        )}
      </nav>

      <Card className="p-5">
        <p className="text-xs font-semibold uppercase tracking-wide text-ink-500">{t(T.weekTotal)}</p>
        <p className="mt-1 text-3xl font-bold text-ink-900" data-testid="week-total">
          <Money paise={week.totalPaise} />
        </p>
        <p className="text-sm text-ink-600">{t(T.trips).replace("{n}", String(week.trips))}</p>

        <figure className="mt-4" aria-label={t(T.byDay)}>
          <div className="flex h-32 items-end gap-1.5" role="list">
            {week.days.map((day) => (
              <div key={day.date} role="listitem" className="flex h-full min-w-0 flex-1 flex-col items-center justify-end gap-1">
                <span className="text-[0.625rem] font-semibold tabular-nums text-ink-700">
                  {day.totalPaise > 0 ? `₹${Math.round(day.totalPaise / 100)}` : ""}
                </span>
                <div
                  className={clsx("w-full rounded-t-md", day.totalPaise > 0 ? "bg-kesari-600" : "bg-cream-200")}
                  style={{ height: `${Math.max(4, Math.round((day.totalPaise / maxDay) * 100))}%` }}
                  title={`${shortDate(day.date, lang)}: ₹${(day.totalPaise / 100).toFixed(2)}`}
                />
                <span className="text-xs text-ink-600">{t(DAY[day.index])}</span>
              </div>
            ))}
          </div>
        </figure>

        <ul className="mt-4 grid grid-cols-2 gap-2">
          {chips.map((chip) => (
            <li key={chip.label.en} className={clsx("rounded-lg px-3 py-2", chip.tone)}>
              <span className="block text-xs font-medium">{t(chip.label)}</span>
              <span className="text-base font-bold">
                <Money paise={chip.paise} />
              </span>
            </li>
          ))}
        </ul>
      </Card>

      <section className="rounded-xl border border-amber-200 bg-amber-50 p-4 shadow-sm" data-testid="cash-in-hand">
        <p className="text-sm font-semibold text-amber-900">{t(T.cashTitle)}</p>
        {week.cashInHand.heldPaise > 0 ? (
          <p className="mt-1 text-2xl font-bold text-amber-900">
            <Money paise={week.cashInHand.heldPaise} />{" "}
            <span className="text-sm font-normal">{t(T.cashOrders).replace("{n}", String(week.cashInHand.orders))}</span>
          </p>
        ) : (
          <p className="mt-1 text-sm text-amber-900">{t(T.noCash)}</p>
        )}
        <p className="mt-1 text-xs text-amber-900">{t(T.cashNote)}</p>
      </section>

      <section id="incentives" className="scroll-mt-24 space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-500">{t(T.offers)}</h2>
        {ladders.length === 0 ? <p className="text-sm text-ink-600">{t(T.noOffers)}</p> : null}
        {ladders.map((ladder) => (
          <IncentiveLadderCard key={ladder.period} ladder={ladder} lang={lang} />
        ))}
      </section>

      <Card className="p-4">
        <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-ink-500">{t(T.orders)}</h2>
        {week.orders.length === 0 ? (
          <p className="text-sm text-ink-600">{t(T.noOrders)}</p>
        ) : (
          <ul className="divide-y divide-cream-100" data-testid="week-orders">
            {week.orders.map((o) => (
              <li key={o.earningId} className="py-2">
                <details>
                  <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-2">
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-medium text-ink-900">{o.isReturnPickup ? t(T.returnPickup) : (o.orderNumber ?? "—")}</span>
                      <span className="block text-xs text-ink-500">
                        {shortDate(o.date, lang)}
                        {o.quotePaise != null ? (
                          <>
                            {" · "}
                            {t(T.quoteFinal)
                              .replace("{q}", `₹${(o.quotePaise / 100).toFixed(2)}`)
                              .replace("{f}", `₹${(o.totalPaise / 100).toFixed(2)}`)}
                          </>
                        ) : null}
                      </span>
                    </span>
                    <span className="flex shrink-0 items-center gap-2">
                      <StatusBadge status={o.payoutStatus} />
                      <span className="font-semibold">
                        <Money paise={o.totalPaise} />
                      </span>
                    </span>
                  </summary>
                  <dl className="mt-1 space-y-1 rounded-lg bg-cream-50 p-2 text-sm">
                    {o.lines.map((line, i) => (
                      <div key={`${line.component}-${i}`} className="flex justify-between gap-2">
                        <dt className="min-w-0 text-ink-600">
                          {t(LINE[line.component])}
                          {line.description ? <span className="block truncate text-xs text-ink-500">{line.description}</span> : null}
                        </dt>
                        <dd className={clsx("shrink-0 font-medium", line.amountPaise < 0 ? "text-red-700" : "text-ink-900")}>
                          <Money paise={line.amountPaise} />
                        </dd>
                      </div>
                    ))}
                  </dl>
                </details>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card className="p-4" data-testid="rider-payouts">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-500">{t(T.payouts)}</h2>
          <Link href="/gig/wallet" className="text-sm font-medium text-kesari-700 underline">
            {t(T.wallet)}
          </Link>
        </div>
        {week.payouts.length === 0 ? (
          <p className="text-sm text-ink-600">{t(T.noPayouts)}</p>
        ) : (
          <ul className="divide-y divide-cream-100 text-sm">
            {week.payouts.map((p) => (
              <li key={p.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <span>
                  {t(T.payoutWeek)
                    .replace("{from}", shortDate(p.periodStart, lang))
                    .replace("{to}", shortDate(p.periodEnd, lang))
                    .replace("{n}", String(p.deliveries))}
                  {p.utr ? <span className="block text-xs text-ink-500">{t(T.utr).replace("{r}", p.utr)}</span> : null}
                </span>
                <span className="flex items-center gap-2">
                  <StatusBadge status={p.status} />
                  <Money paise={p.amountPaise} />
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
