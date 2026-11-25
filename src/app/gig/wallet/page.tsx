import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { BankAccountManager } from "@/components/bank-account-manager";
import { BankReauth } from "@/components/rider-wallet/bank-reauth";
import { TRANSFER_STATUS, kindText, transferStatusText } from "@/components/rider-wallet/labels";
import { WithdrawPanel } from "@/components/rider-wallet/withdraw-panel";
import { Alert, Badge, Card, EmptyState, LinkButton, PageHeader, Section } from "@/components/ui";
import { L, tr, type Text } from "@/lib/board/i18n";
import { formatPaise } from "@/lib/money";
import { getCurrentUser } from "@/server/authz/guards";
import { getBoardLang } from "@/server/board-lang";
import { getRiderWallet } from "@/server/rider-wallet/views";
import { bankCheckOffered } from "@/server/services/bank-account-check";
import { verificationGatewayMode } from "@/server/services/bank-accounts";

export const metadata = { title: "My wallet" };
export const dynamic = "force-dynamic";

const ordinal = (n: number) => `${n}${n % 10 === 1 && n !== 11 ? "st" : n % 10 === 2 && n !== 12 ? "nd" : n % 10 === 3 && n !== 13 ? "rd" : "th"}`;
const T = {
  title: L("My wallet", "मेरा वॉलेट", "माझे वॉलेट"),
  notPartner: L("You're not a delivery partner yet", "आप अभी डिलीवरी पार्टनर नहीं हैं", "तुम्ही अजून डिलिव्हरी पार्टनर नाही"),
  notPartnerText: L(
    "Apply to deliver with GoKesari; your earnings and payouts show up here.",
    "GoKesari के साथ डिलीवरी के लिए आवेदन करें; आपकी कमाई और पेआउट यहाँ दिखेंगे।",
    "GoKesari सोबत डिलिव्हरीसाठी अर्ज करा; तुमची कमाई आणि पेआउट इथे दिसतील.",
  ),
  become: L("Become a delivery partner", "डिलीवरी पार्टनर बनें", "डिलिव्हरी पार्टनर व्हा"),
  description: L(
    "Your unpaid delivery earnings and payments to your bank.",
    "आपकी बाकी डिलीवरी कमाई और आपके बैंक में भेजे गए भुगतान।",
    "तुमची न मिळालेली डिलिव्हरी कमाई आणि तुमच्या बँकेत पाठवलेले पैसे.",
  ),
  myProfile: L("← My profile", "← मेरी प्रोफ़ाइल", "← माझे प्रोफाइल"),
  unpaid: L("Unpaid earnings", "बाकी कमाई", "न मिळालेली कमाई"),
  onItsWay: L("On its way to your bank", "आपके बैंक की ओर रास्ते में", "तुमच्या बँकेकडे वाटेत"),
  paidTo: L("Paid to", "भुगतान यहाँ", "पैसे इथे जातात"),
  noBank: L("No bank account yet", "अभी कोई बैंक खाता नहीं", "अजून बँक खाते नाही"),
  verified: L("Verified", "सत्यापित", "पडताळलेले"),
  notVerified: L("Not verified", "सत्यापित नहीं", "पडताळलेले नाही"),
  youOwe: L(
    "You owe {amount} (cash collected on delivery). It is taken from your next earnings.",
    "आप पर {amount} बाकी है (डिलीवरी पर लिया गया कैश)। यह आपकी अगली कमाई से कटेगा।",
    "तुमच्याकडे {amount} बाकी आहेत (डिलिव्हरीवर घेतलेली रोकड). ते तुमच्या पुढच्या कमाईतून कापले जातील.",
  ),
  withdraw: L("Withdraw to bank", "बैंक में निकालें", "बँकेत काढा"),
  notApproved: L(
    "Withdrawals open once your delivery partner application is approved.",
    "डिलीवरी पार्टनर आवेदन मंज़ूर होने के बाद निकासी शुरू होगी।",
    "डिलिव्हरी पार्टनर अर्ज मंजूर झाल्यावर रक्कम काढता येईल.",
  ),
  verifyBank: L(
    "Add and verify your bank account below to withdraw.",
    "निकालने के लिए नीचे अपना बैंक खाता जोड़ें और सत्यापित करें।",
    "रक्कम काढण्यासाठी खाली तुमचे बँक खाते जोडा आणि पडताळा.",
  ),
  unavailable: L(
    "Withdrawals are not available right now. Please try again later.",
    "अभी निकासी उपलब्ध नहीं है। बाद में फिर कोशिश करें।",
    "सध्या रक्कम काढता येत नाही. नंतर पुन्हा प्रयत्न करा.",
  ),
  limits: L(
    "{min} to {max} per withdrawal, up to {daily} a day.",
    "हर निकासी में {min} से {max}, दिन में {daily} तक।",
    "प्रत्येक वेळी {min} ते {max}, दिवसाला {daily} पर्यंत.",
  ),
  fee: L("Fee {fee}.", "शुल्क {fee}।", "शुल्क {fee}."),
  noFee: L("No fee.", "कोई शुल्क नहीं।", "शुल्क नाही."),
  arrives: L(
    "Arrives {settlement}. Every withdrawal is confirmed with a code we email you.",
    "पहुँचने का समय: {settlement}। हर निकासी की पुष्टि ईमेल पर भेजे गए कोड से होती है।",
    "पोहोचण्याचा वेळ: {settlement}. प्रत्येक वेळी रक्कम काढताना ईमेलवर पाठवलेल्या कोडने खात्री केली जाते.",
  ),
  monthly: L("Monthly payout", "मासिक पेआउट", "मासिक पेआउट"),
  monthlyText: L(
    "On the {day} of every month (from {hour}:00) we pay what is still unpaid for the month before to your verified bank account — at least {min}; a smaller amount waits for the next month. It arrives {settlement}.",
    "हर महीने की {day} तारीख को ({hour}:00 से) पिछले महीने की बाकी रकम आपके सत्यापित बैंक खाते में भेजी जाती है — कम से कम {min}; इससे कम रकम अगले महीने तक रुकती है। पहुँचने का समय: {settlement}।",
    "दर महिन्याच्या {day} तारखेला ({hour}:00 पासून) मागील महिन्याची बाकी रक्कम तुमच्या पडताळलेल्या बँक खात्यात पाठवली जाते — किमान {min}; त्यापेक्षा कमी रक्कम पुढच्या महिन्यापर्यंत थांबते. पोहोचण्याचा वेळ: {settlement}.",
  ),
  bankAccount: L("Bank account", "बैंक खाता", "बँक खाते"),
  ownAccount: L(
    "This is your own bank account for GoKesari — the same one used for any refund to your bank. Only the last 4 digits are ever shown.",
    "यह GoKesari के लिए आपका अपना बैंक खाता है — बैंक में किसी भी रिफंड के लिए भी यही इस्तेमाल होता है। सिर्फ़ आख़िरी 4 अंक ही दिखाए जाते हैं।",
    "हे GoKesari साठी तुमचे स्वतःचे बँक खाते आहे — बँकेत कोणताही परतावा याच खात्यात येतो. फक्त शेवटचे 4 अंकच दाखवले जातात.",
  ),
  payments: L("Payments to your bank", "आपके बैंक में भुगतान", "तुमच्या बँकेत पाठवलेले पैसे"),
  noPayments: L("No payments yet.", "अभी कोई भुगतान नहीं।", "अजून पैसे पाठवलेले नाहीत."),
  weekly: L("Weekly payout", "साप्ताहिक पेआउट", "साप्ताहिक पेआउट"),
  paid: L("Paid", "भुगतान हुआ", "पैसे दिले"),
  withFinance: L("With finance", "फ़ाइनेंस टीम के पास", "फायनान्स टीमकडे"),
} as const satisfies Record<string, Text>;

const when = (iso: string) => new Date(iso).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata" });

/**
 * The delivery partner's wallet (docs/gig-bank-payouts-2026-10): unpaid
 * earnings, withdraw to bank, the bank account, payments and the monthly payout.
 */
export default async function GigWalletPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");
  const [wallet, lang] = await Promise.all([getRiderWallet(user.id), getBoardLang()]);
  const t = (text: Text) => tr(text, lang);
  if (!wallet.flags.bankAccount) notFound();
  if (!wallet.partner) {
    return (
      <div className="mx-auto max-w-2xl">
        <PageHeader title={t(T.title)} />
        <EmptyState
          title={t(T.notPartner)}
          description={t(T.notPartnerText)}
          action={<LinkButton href="/delivery-partner/apply">{t(T.become)}</LinkButton>}
        />
      </div>
    );
  }
  const balance = wallet.balance!;
  const verified = wallet.account?.status === "VERIFIED";
  const canWithdraw = wallet.flags.withdrawal && wallet.partner.approved && verified && wallet.available;

  return (
    <div className="mx-auto max-w-3xl pb-10">
      <PageHeader
        title={t(T.title)}
        description={t(T.description)}
        action={
          <Link href="/gig/profile" className="text-sm font-medium text-kesari-600 hover:underline">
            {t(T.myProfile)}
          </Link>
        }
      />

      <Card className="mb-8 grid gap-4 p-5 sm:grid-cols-3">
        <div>
          <p className="text-sm text-ink-500">{t(T.unpaid)}</p>
          <p className="text-2xl font-semibold text-ink-900">{formatPaise(Math.max(balance.availablePaise, 0))}</p>
        </div>
        <div>
          <p className="text-sm text-ink-500">{t(T.onItsWay)}</p>
          <p className="text-2xl font-semibold text-ink-900">{formatPaise(balance.inFlightPaise)}</p>
        </div>
        <div>
          <p className="text-sm text-ink-500">{t(T.paidTo)}</p>
          <p className="text-sm font-medium text-ink-900">
            {wallet.account
              ? wallet.account.method === "UPI"
                ? `UPI ${wallet.account.upiIdMasked}`
                : `${wallet.account.accountNumberMasked} · ${wallet.account.ifsc}`
              : t(T.noBank)}
          </p>
          {wallet.account ? <Badge tone={verified ? "success" : "warning"}>{verified ? t(T.verified) : t(T.notVerified)}</Badge> : null}
        </div>
      </Card>

      {balance.availablePaise < 0 ? (
        <div className="mb-6">
          <Alert tone="warning">{t(T.youOwe).replace("{amount}", formatPaise(-balance.availablePaise))}</Alert>
        </div>
      ) : null}

      {wallet.flags.withdrawal ? (
        <Section title={t(T.withdraw)}>
          {canWithdraw ? (
            <WithdrawPanel availablePaise={balance.availablePaise} minPaise={wallet.limits.minPaise} maxPaise={wallet.limits.maxPaise} leftTodayPaise={wallet.limits.leftTodayPaise} lang={lang} />
          ) : (
            <Alert tone="info">
              {!wallet.partner.approved
                ? t(T.notApproved)
                : !verified
                  ? t(T.verifyBank)
                  : t(T.unavailable)}
            </Alert>
          )}
          <p className="mt-2 text-xs text-ink-500">
            {t(T.limits)
              .replace("{min}", formatPaise(wallet.limits.minPaise))
              .replace("{max}", formatPaise(wallet.limits.maxPaise))
              .replace("{daily}", formatPaise(wallet.limits.dailyMaxPaise))}{" "}
            {wallet.limits.feePaise > 0 ? t(T.fee).replace("{fee}", formatPaise(wallet.limits.feePaise)) : t(T.noFee)}{" "}
            {t(T.arrives).replace("{settlement}", wallet.limits.settlement)}
          </p>
        </Section>
      ) : null}

      {wallet.flags.monthly ? (
        <Section title={t(T.monthly)}>
          <Card className="p-5 text-sm text-ink-600">
            {t(T.monthlyText)
              .replace("{day}", lang === "en" ? ordinal(wallet.monthly.day) : String(wallet.monthly.day))
              .replace("{hour}", String(wallet.monthly.hourIst).padStart(2, "0"))
              .replace("{min}", formatPaise(wallet.monthly.minPaise))
              .replace("{settlement}", wallet.monthly.settlement)}
          </Card>
        </Section>
      ) : null}

      <Section title={t(T.bankAccount)}>
        <div className="space-y-4">
          {verified ? <BankReauth canRemove lang={lang} /> : null}
          <BankAccountManager account={wallet.account} saveUrl="/api/bank-account" gateway={verificationGatewayMode()} purpose="payouts" bankCheck={await bankCheckOffered()} />
          <p className="text-xs text-ink-500">{t(T.ownAccount)}</p>
        </div>
      </Section>

      <Section title={t(T.payments)}>
        {wallet.transfers.length === 0 && wallet.weekly.length === 0 ? (
          <Card className="p-5 text-sm text-ink-500">{t(T.noPayments)}</Card>
        ) : (
          <Card className="divide-y divide-cream-200">
            {wallet.transfers.map((transfer) => (
              <Link key={transfer.id} href={`/gig/wallet/payouts/${transfer.id}`} className="flex flex-wrap items-center justify-between gap-2 p-4 hover:bg-cream-50">
                <div>
                  <p className="text-sm font-medium text-ink-900">
                    {kindText(transfer.kind, lang)} · {formatPaise(transfer.netPaise)}
                  </p>
                  <p className="text-xs text-ink-500">
                    {when(transfer.createdAt)} · {transfer.account}
                    {transfer.utr ? ` · UTR ${transfer.utr}` : ""}
                  </p>
                </div>
                <Badge tone={TRANSFER_STATUS[transfer.status].tone}>{transferStatusText(transfer.status, lang)}</Badge>
              </Link>
            ))}
            {wallet.weekly.map((p) => (
              <div key={p.id} className="flex flex-wrap items-center justify-between gap-2 p-4">
                <div>
                  <p className="text-sm font-medium text-ink-900">{t(T.weekly)} · {formatPaise(p.amountPaise)}</p>
                  <p className="text-xs text-ink-500">
                    {p.periodStart} – {p.periodEnd}
                    {p.reference ? ` · UTR ${p.reference}` : ""}
                  </p>
                </div>
                <Badge tone={p.status === "PAID" ? "success" : "neutral"}>{p.status === "PAID" ? t(T.paid) : t(T.withFinance)}</Badge>
              </div>
            ))}
          </Card>
        )}
      </Section>
    </div>
  );
}
