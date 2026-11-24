import Link from "next/link";
import { redirect } from "next/navigation";

import { DocumentsPromiseForm } from "@/components/documents-promise-form";
import { RegistrationFeePayButton } from "@/components/registration-fee-pay-button";
import { Alert, Badge, Card, LinkButton, Money, PageHeader } from "@/components/ui";
import { SELLER_DOC_LABELS } from "@/lib/kyc/doc-formats";
import { formatGstRate, formatRupeesIndian } from "@/lib/registration-fee";
import { L, tr } from "@/lib/board/i18n";
import { getBoardLang } from "@/server/board-lang";
import { getCurrentUser } from "@/server/authz/guards";
import {
  checkRegistrationFeePayment,
  latestRegistrationFeeAttempt,
  registrationFeeDue,
} from "@/server/services/registration-fee-payment";
import { getRule } from "@/server/services/settings";
import { shopDocumentGate } from "@/server/services/shop-document-gate";
import { listShopsForOwner } from "@/server/services/shops";
import { wizardContinuePath } from "@/server/services/shop-registration-wizard";
import { isWizardRegisteredShop } from "@/server/services/shop-onboarding";

export const metadata = { title: "Registration fee" };
export const dynamic = "force-dynamic";

/** Module 6: Hindi / Marathi (English unchanged). */
const T = {
  title: L("Registration fee", "पंजीकरण शुल्क", "नोंदणी शुल्क"),
  description: L(
    "A yearly fee to sell on GoKesari: it covers {n} months and renews after that. Pay it online and your shop goes live as soon as its checks pass.",
    "GoKesari पर बेचने का सालाना शुल्क: यह {n} महीनों के लिए है और उसके बाद रिन्यू होता है। ऑनलाइन भुगतान करें, जाँच पूरी होते ही आपकी दुकान लाइव हो जाएगी।",
    "GoKesari वर विक्रीसाठी वार्षिक शुल्क: ते {n} महिन्यांसाठी आहे आणि त्यानंतर नूतनीकरण होते. ऑनलाइन भरा, तपासणी पूर्ण होताच तुमचे दुकान लाइव्ह होईल.",
  ),
  stepsAria: L("Registration steps", "पंजीकरण के चरण", "नोंदणीचे टप्पे"),
  shopDetails: L("✓ Shop details", "✓ दुकान का विवरण", "✓ दुकानाचा तपशील"),
  documents: L("Documents", "दस्तावेज़", "कागदपत्रे"),
  feeStep: L("3. Registration fee", "3. पंजीकरण शुल्क", "3. नोंदणी शुल्क"),
  turnover: L("Declared annual turnover: {amount}", "बताया गया सालाना टर्नओवर: {amount}", "जाहीर केलेली वार्षिक उलाढाल: {amount}"),
  waivedBadge: L("Fee waived", "शुल्क माफ़", "शुल्क माफ"),
  noFee: L("No fee", "कोई शुल्क नहीं", "शुल्क नाही"),
  paid: L("Paid", "भुगतान हुआ", "भरले"),
  partlyPaid: L("Partly paid", "आंशिक भुगतान", "अंशतः भरले"),
  pending: L("Payment pending", "भुगतान बाकी", "पेमेंट बाकी"),
  fee: L("Registration fee", "पंजीकरण शुल्क", "नोंदणी शुल्क"),
  coupon: L("Coupon {code}", "कूपन {code}", "कूपन {code}"),
  waivedLine: L("Waived by GoKesari", "GoKesari द्वारा माफ़", "GoKesari कडून माफ"),
  feeMonths: L("Registration fee, {n} months", "पंजीकरण शुल्क, {n} महीने", "नोंदणी शुल्क, {n} महिने"),
  total: L(" (total)", " (कुल)", " (एकूण)"),
  toPay: L("To pay now", "अभी भुगतान करें", "आता भरायचे"),
  waivedTitle: L("Your registration fee was waived", "आपका पंजीकरण शुल्क माफ़ कर दिया गया", "तुमचे नोंदणी शुल्क माफ केले"),
  nothingToPay: L("Nothing to pay", "कुछ भुगतान नहीं करना है", "काहीही भरायचे नाही"),
  received: L("Payment received", "भुगतान मिल गया", "पेमेंट मिळाले"),
  live: L("Your shop is approved and live.", "आपकी दुकान मंज़ूर होकर लाइव है।", "तुमचे दुकान मंजूर होऊन लाइव्ह आहे."),
  review: L(
    "Your registration is with our team for review. Next, upload your documents.",
    "आपका पंजीकरण हमारी टीम के पास जाँच के लिए है। अब अपने दस्तावेज़ अपलोड करें।",
    "तुमची नोंदणी आमच्या टीमकडे तपासणीसाठी आहे. आता तुमची कागदपत्रे अपलोड करा.",
  ),
  goShop: L("Go to my shop", "मेरी दुकान पर जाएँ", "माझ्या दुकानावर जा"),
  nextUpload: L("Next: upload documents", "आगे: दस्तावेज़ अपलोड करें", "पुढे: कागदपत्रे अपलोड करा"),
  lastFailed: L("Your last payment did not go through", "आपका पिछला भुगतान पूरा नहीं हुआ", "तुमचे मागील पेमेंट पूर्ण झाले नाही"),
  lastFailedText: L("No money was taken for it. You can try again below.", "इसके लिए कोई पैसा नहीं कटा। आप नीचे फिर कोशिश कर सकते हैं।", "त्यासाठी पैसे कापले गेले नाहीत. तुम्ही खाली पुन्हा प्रयत्न करू शकता."),
  checking: L("Checking your payment…", "आपका भुगतान जाँच रहे हैं…", "तुमचे पेमेंट तपासत आहोत…"),
  checkingText: L("If you completed the payment, it shows here within a minute.", "अगर आपने भुगतान पूरा किया है, तो वह एक मिनट में यहाँ दिखेगा।", "तुम्ही पेमेंट पूर्ण केले असल्यास ते एका मिनिटात इथे दिसेल."),
  refresh: L("Refresh", "रीफ़्रेश करें", "रीफ्रेश करा"),
  promisedBy: L("Documents promised by {date}", "{date} तक दस्तावेज़ देने का वादा", "{date} पर्यंत कागदपत्रे देण्याचे वचन"),
  stillProvide: L(
    "Still to provide: {docs}. Your shop goes live once GoKesari's team approves it.",
    "अभी देने हैं: {docs}। GoKesari की टीम की मंज़ूरी के बाद आपकी दुकान लाइव होगी।",
    "अजून द्यायची: {docs}. GoKesari टीमच्या मंजुरीनंतर तुमचे दुकान लाइव्ह होईल.",
  ),
  docsFirst: L("Documents first", "पहले दस्तावेज़", "आधी कागदपत्रे"),
  atLeastOne: L(
    "Get at least one of your documents verified (for example your PAN) before paying the registration fee.",
    "पंजीकरण शुल्क देने से पहले कम से कम एक दस्तावेज़ सत्यापित करवाएँ (जैसे आपका PAN)।",
    "नोंदणी शुल्क भरण्यापूर्वी किमान एक कागदपत्र पडताळून घ्या (उदा. तुमचा PAN).",
  ),
  notVerified: L(
    "Not verified yet: {docs}. Verify them, or promise to provide them, before paying.",
    "अभी सत्यापित नहीं: {docs}। भुगतान से पहले इन्हें सत्यापित करें या देने का वादा करें।",
    "अजून पडताळलेले नाही: {docs}. पैसे भरण्यापूर्वी ते पडताळा किंवा देण्याचे वचन द्या.",
  ),
  verified: L("Verified: {docs}", "सत्यापित: {docs}", "पडताळलेले: {docs}"),
  verifyDocs: L("Verify my documents", "मेरे दस्तावेज़ सत्यापित करें", "माझी कागदपत्रे पडताळा"),
  uploadCopies: L("Upload document copies", "दस्तावेज़ों की कॉपी अपलोड करें", "कागदपत्रांच्या प्रती अपलोड करा"),
} as const;

/**
 * Add my shop → the registration fee (yearly: it starts a 12-month membership), paid online. Reached straight
 * after Submit, from the "pay the fee" link while the registration waits, and
 * back from the gateway (`?intent=`), when the payment is checked. Owner
 * decision 29 Oct 2026: the documents come first — the fee is paid once they
 * are verified (at least one), or once the owner promises the rest within 30 days.
 */
export default async function RegistrationFeePage({
  searchParams,
}: {
  searchParams: Promise<{ shop?: string; intent?: string }>;
}) {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");
  const params = await searchParams;
  const lang = await getBoardLang();

  let shopId = typeof params.shop === "string" && /^[0-9a-f-]{36}$/i.test(params.shop) ? params.shop : null;
  if (!shopId) {
    // No shop named: the owner's registration that still owes its fee, if any.
    const owing = (await listShopsForOwner(user.id)).find((s) => registrationFeeDue(s) > 0);
    if (!owing) redirect("/shop");
    shopId = owing.id;
  }

  const shop = await checkRegistrationFeePayment(shopId, params.intent ?? null, user.id).catch(() => null);
  if (!shop) redirect("/shop");
  const due = registrationFeeDue(shop);
  // Paid (or nothing due) on a wizard registration: carry on in the wizard (Phase B, G13).
  if (due === 0) {
    const next = await wizardContinuePath(user.id, shop.id);
    if (next) redirect(next);
  }
  const fee = shop.registrationFeePaise ?? 0;
  // An admin waiver sets the fee to 0 but keeps the quote's base / GST snapshot: show the waiver as a line (D-107).
  const quoted =
    shop.registrationFeeBasePaise !== null && shop.registrationFeeGstRateBp !== null
      ? shop.registrationFeeBasePaise - (shop.registrationFeeDiscountPaise ?? 0) + (shop.registrationFeeGstPaise ?? 0)
      : 0;
  const waived = fee === 0 && quoted > 0;
  const attempt = due > 0 ? await latestRegistrationFeeAttempt(shop.id, user.id) : null;
  const returned = typeof params.intent === "string";
  const documentsHref = `/shop/documents?shop=${shop.id}`;
  const [gate, followUp, membership] = await Promise.all([shopDocumentGate(shop), getRule("shopDocumentFollowUp"), getRule("shopMembership")]);
  // DF-08: a wizard shop whose documents still hold the fee (FSSAI, or the promise) finishes them on the wizard's documents screen.
  if (due > 0 && !gate.canPay && shop.status === "PENDING_APPROVAL" && (await isWizardRegisteredShop(shop.id))) redirect("/shop/register");
  const dateIn = (d: Date) => d.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Kolkata" });

  return (
    <div className="mx-auto max-w-xl">
      <PageHeader
        title={tr(T.title, lang)}
        description={tr(T.description, lang).replace("{n}", String(membership.periodMonths))}
      />

      <ol className="mb-4 flex flex-wrap gap-x-4 gap-y-1 text-sm" aria-label={tr(T.stepsAria, lang)}>
        <li className="text-ink-500">{tr(T.shopDetails, lang)}</li>
        <li className={gate.canPay ? "text-ink-500" : "font-semibold"}>{gate.canPay ? "✓" : "2."} {tr(T.documents, lang)}</li>
        <li className={gate.canPay ? "font-semibold" : "text-ink-500"}>{tr(T.feeStep, lang)}</li>
      </ol>

      <Card className="space-y-4 p-5">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="truncate font-semibold text-ink-900">{shop.name}</p>
            {shop.annualTurnoverRupees !== null ? (
              <p className="text-sm text-ink-500">
                {tr(T.turnover, lang).replace("{amount}", formatRupeesIndian(shop.annualTurnoverRupees))}
              </p>
            ) : null}
          </div>
          {due === 0 ? (
            <Badge tone="success">{waived ? tr(T.waivedBadge, lang) : fee === 0 ? tr(T.noFee, lang) : tr(T.paid, lang)}</Badge>
          ) : (
            <Badge tone="warning">{shop.feePaymentStatus === "PARTIALLY_PAID" ? tr(T.partlyPaid, lang) : tr(T.pending, lang)}</Badge>
          )}
        </div>

        <dl className="grid grid-cols-2 gap-y-1 text-sm">
          {shop.registrationFeeBasePaise !== null && shop.registrationFeeGstRateBp !== null ? (
            <>
              {/* Owner, 27 Oct 2026: base fee, less a coupon, plus GST. */}
              <dt className="text-ink-500">{tr(T.fee, lang)}</dt>
              <dd className="text-right text-ink-900">
                <Money paise={shop.registrationFeeBasePaise} />
              </dd>
              {(shop.registrationFeeDiscountPaise ?? 0) > 0 ? (
                <>
                  <dt className="text-green-700">{tr(T.coupon, lang).replace("{code}", shop.registrationFeeCouponCode ?? "")}</dt>
                  <dd className="text-right text-green-700">
                    − <Money paise={shop.registrationFeeDiscountPaise ?? 0} />
                  </dd>
                </>
              ) : null}
              <dt className="text-ink-500">GST ({formatGstRate(shop.registrationFeeGstRateBp)})</dt>
              <dd className="text-right text-ink-900">
                <Money paise={shop.registrationFeeGstPaise ?? 0} />
              </dd>
              {waived ? (
                <>
                  <dt className="text-green-700">{tr(T.waivedLine, lang)}</dt>
                  <dd className="text-right text-green-700" data-testid="fee-waived-line">
                    − <Money paise={quoted} />
                  </dd>
                </>
              ) : null}
            </>
          ) : null}
          <dt className="text-ink-500">{tr(T.feeMonths, lang).replace("{n}", String(membership.periodMonths))}{shop.registrationFeeGstRateBp !== null ? tr(T.total, lang) : ""}</dt>
          <dd className="text-right font-medium text-ink-900">
            <Money paise={fee} />
          </dd>
          {shop.amountPaidPaise > 0 ? (
            <>
              <dt className="text-ink-500">{tr(T.paid, lang)}</dt>
              <dd className="text-right text-ink-900">
                <Money paise={shop.amountPaidPaise} />
              </dd>
            </>
          ) : null}
          {due > 0 ? (
            <>
              <dt className="font-semibold text-ink-700">{tr(T.toPay, lang)}</dt>
              <dd className="text-right text-lg font-semibold text-ink-900">
                <Money paise={due} />
              </dd>
            </>
          ) : null}
        </dl>

        {due === 0 ? (
          <>
            <Alert tone="success" title={waived ? tr(T.waivedTitle, lang) : fee === 0 ? tr(T.nothingToPay, lang) : tr(T.received, lang)}>
              {shop.status === "APPROVED"
                ? tr(T.live, lang)
                : tr(T.review, lang)}
            </Alert>
            <LinkButton href={shop.status === "APPROVED" ? "/shop" : documentsHref} className="w-full">
              {shop.status === "APPROVED" ? tr(T.goShop, lang) : tr(T.nextUpload, lang)}
            </LinkButton>
          </>
        ) : (
          <>
            {attempt && (attempt.status === "FAILED" || attempt.status === "EXPIRED") ? (
              <Alert tone="danger" title={tr(T.lastFailed, lang)}>
                {tr(T.lastFailedText, lang)}
              </Alert>
            ) : null}
            {returned && attempt?.live ? (
              <Alert tone="info" title={tr(T.checking, lang)}>
                {tr(T.checkingText, lang)}{" "}
                <Link href={`/shop/registration-fee?shop=${shop.id}`} className="underline">
                  {tr(T.refresh, lang)}
                </Link>
              </Alert>
            ) : null}
            {gate.canPay ? (
              <>
                {gate.promisedAt && gate.dueAt && gate.missing.length > 0 ? (
                  <Alert tone="info" title={tr(T.promisedBy, lang).replace("{date}", dateIn(gate.dueAt))}>
                    {tr(T.stillProvide, lang).replace("{docs}", gate.missing.map((d) => SELLER_DOC_LABELS[d]).join(", "))}
                  </Alert>
                ) : null}
                <RegistrationFeePayButton shopId={shop.id} amountPaise={due} />
              </>
            ) : (
              <div className="space-y-3" data-testid="documents-before-fee">
                <Alert tone="warning" title={tr(T.docsFirst, lang)}>
                  {gate.verified.length === 0
                    ? tr(T.atLeastOne, lang)
                    : tr(T.notVerified, lang).replace("{docs}", gate.missing.map((d) => SELLER_DOC_LABELS[d]).join(", "))}
                </Alert>
                {gate.verified.length > 0 ? (
                  <p className="text-sm text-ink-600">{tr(T.verified, lang).replace("{docs}", gate.verified.map((d) => SELLER_DOC_LABELS[d]).join(", "))}</p>
                ) : null}
                <LinkButton href={`/shop/verification?shop=${shop.id}`} className="w-full">
                  {tr(T.verifyDocs, lang)}
                </LinkButton>
                <p className="text-center text-sm text-ink-500">
                  <Link href={documentsHref} className="underline">
                    {tr(T.uploadCopies, lang)}
                  </Link>
                </p>
                {gate.canPromise ? <DocumentsPromiseForm shopId={shop.id} promiseDays={followUp.promiseDays} /> : null}
              </div>
            )}
          </>
        )}
      </Card>
    </div>
  );
}
