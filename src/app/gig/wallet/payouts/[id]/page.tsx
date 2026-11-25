import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { KIND_LABEL, TRANSFER_STATUS, kindText, transferStatusText } from "@/components/rider-wallet/labels";
import { Badge, Card, PageHeader } from "@/components/ui";
import { L, tr, type Text } from "@/lib/board/i18n";
import { formatPaise } from "@/lib/money";
import { getCurrentUser } from "@/server/authz/guards";
import { getBoardLang } from "@/server/board-lang";
import { isUuid } from "@/server/payouts/http";
import { getTransferStatement } from "@/server/rider-wallet/views";

export const metadata = { title: "Payout statement" };
export const dynamic = "force-dynamic";

const T = {
  earnings: L("Earnings in this payment", "इस भुगतान में कमाई", "या पेमेंटमधील कमाई"),
  deliveries: L("{n} deliveries", "{n} डिलीवरी", "{n} डिलिव्हऱ्या"),
  adjustments: L("Adjustments and carried forward", "समायोजन और आगे ले जाई गई रकम", "समायोजन आणि पुढे नेलेली रक्कम"),
  amount: L("Amount", "रकम", "रक्कम"),
  none: L("None", "कोई नहीं", "काही नाही"),
  fee: L("Fee", "शुल्क", "शुल्क"),
  paid: L("Paid to your bank", "आपके बैंक में भेजा गया", "तुमच्या बँकेत पाठवले"),
  statement: L("{kind} statement", "{kind} विवरण", "{kind} विवरण"),
  myWallet: L("← My wallet", "← मेरा वॉलेट", "← माझे वॉलेट"),
  account: L("Account", "खाता", "खाते"),
  sentBy: L("Sent by", "भेजने का तरीका", "पाठवण्याची पद्धत"),
  utr: L("Bank reference (UTR)", "बैंक संदर्भ (UTR)", "बँक संदर्भ (UTR)"),
  period: L("Earnings period", "कमाई की अवधि", "कमाईचा कालावधी"),
  keep: L(
    "Keep this for your records. TDS deducted is deposited against your PAN and shows in your Form 26AS.",
    "इसे अपने रिकॉर्ड के लिए रखें। काटा गया TDS आपके PAN पर जमा होता है और आपके Form 26AS में दिखता है।",
    "हे तुमच्या नोंदीसाठी ठेवा. कापलेला TDS तुमच्या PAN वर जमा होतो आणि तुमच्या Form 26AS मध्ये दिसतो.",
  ),
} as const satisfies Record<string, Text>;

/** One payment's summary for the rider who received it (docs/gig-bank-payouts-2026-10). */
export default async function RiderPayoutStatementPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");
  const { id } = await params;
  if (!isUuid(id)) notFound();
  const [statement, lang] = await Promise.all([getTransferStatement(id, user.id).catch(() => null), getBoardLang()]);
  const tx = (text: Text) => tr(text, lang);
  if (!statement) notFound();
  const { transfer: t, payout } = statement;
  const status = TRANSFER_STATUS[t.status];
  const rows: [string, string][] = [
    [
      tx(T.earnings),
      payout
        ? `${formatPaise(payout.earningsPaise)} (${tx(T.deliveries).replace("{n}", String(payout.earningsCount))})`
        : "—",
    ],
    [tx(T.adjustments), payout ? formatPaise(payout.adjustmentsPaise) : "—"],
    [tx(T.amount), formatPaise(t.grossPaise)],
    [`TDS${t.tdsRateBp ? ` (${t.tdsRateBp / 100}%, s.194C)` : ""}`, t.tdsPaise ? `− ${formatPaise(t.tdsPaise)}` : tx(T.none)],
    [tx(T.fee), t.feePaise ? `− ${formatPaise(t.feePaise)}` : tx(T.none)],
    [tx(T.paid), formatPaise(t.netPaise)],
  ];
  return (
    <div className="mx-auto max-w-2xl pb-10">
      <PageHeader
        title={lang === "en" ? `${KIND_LABEL[t.kind]} statement` : tx(T.statement).replace("{kind}", kindText(t.kind, lang))}
        description={new Date(t.createdAt).toLocaleString("en-IN", { dateStyle: "long", timeStyle: "short", timeZone: "Asia/Kolkata" })}
        action={
          <Link href="/gig/wallet" className="text-sm font-medium text-kesari-600 hover:underline">
            {tx(T.myWallet)}
          </Link>
        }
      />
      <Card className="space-y-4 p-5">
        <div className="flex items-center justify-between">
          <p className="text-sm text-ink-600">{statement.partnerName}</p>
          <Badge tone={status.tone}>{transferStatusText(t.status, lang)}</Badge>
        </div>
        <dl className="grid grid-cols-2 gap-y-2 text-sm">
          {rows.map(([label, value]) => (
            <div key={label} className="contents">
              <dt className="text-ink-500">{label}</dt>
              <dd className="text-right text-ink-900">{value}</dd>
            </div>
          ))}
        </dl>
        <dl className="grid grid-cols-2 gap-y-2 border-t border-cream-200 pt-4 text-sm">
          <dt className="text-ink-500">{tx(T.account)}</dt>
          <dd className="text-right">{t.account}</dd>
          <dt className="text-ink-500">{tx(T.sentBy)}</dt>
          <dd className="text-right">{t.mode}</dd>
          <dt className="text-ink-500">{tx(T.utr)}</dt>
          <dd className="text-right font-mono">{t.utr ?? "—"}</dd>
          {payout ? (
            <>
              <dt className="text-ink-500">{tx(T.period)}</dt>
              <dd className="text-right">
                {payout.periodStart} – {payout.periodEnd}
              </dd>
            </>
          ) : null}
        </dl>
        {t.failureReason && t.status !== "SUCCESS" ? <p className="text-sm text-red-700">{t.failureReason}</p> : null}
        <p className="text-xs text-ink-500">{tx(T.keep)}</p>
      </Card>
    </div>
  );
}
