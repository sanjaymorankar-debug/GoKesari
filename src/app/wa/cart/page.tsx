import { notFound, redirect } from "next/navigation";

import { Alert, Card, LinkButton, PageHeader } from "@/components/ui";
import { L, tr } from "@/lib/board/i18n";
import { AppError } from "@/lib/errors";
import { formatPaise } from "@/lib/money";
import { getBoardLang } from "@/server/board-lang";
import { getCurrentUser } from "@/server/authz/guards";
import { isFeatureEnabled } from "@/server/services/feature-flags";
import { CART_LINK_PATH, claimCartLink, loadCartLink } from "@/server/whatsapp/customer/cart-link";
import { CUSTOMER_WHATSAPP_FLAG } from "@/server/whatsapp/customer/config";
import { cartTotalPaise } from "@/server/whatsapp/customer/conversation";

export const metadata = { title: "Your WhatsApp cart" };
export const dynamic = "force-dynamic";

const T = {
  title: L("Your WhatsApp cart", "आपकी WhatsApp कार्ट", "तुमची WhatsApp कार्ट"),
  intro: L(
    "These items were picked on WhatsApp. Prices and stock are checked again when they go into your cart.",
    "ये सामान WhatsApp पर चुने गए थे। कार्ट में जोड़ते समय दाम और स्टॉक फिर से जाँचे जाते हैं।",
    "या वस्तू WhatsApp वर निवडल्या होत्या. कार्टमध्ये टाकताना किंमत आणि स्टॉक पुन्हा तपासले जातात.",
  ),
  add: L("Add to my cart", "मेरी कार्ट में जोड़ें", "माझ्या कार्टमध्ये टाका"),
  signIn: L("Sign in to add these to your cart", "इन्हें कार्ट में जोड़ने के लिए साइन इन करें", "हे कार्टमध्ये टाकण्यासाठी साइन इन करा"),
  signInHint: L(
    "Sign in with the mobile number you chatted from. You will come back to this page.",
    "जिस मोबाइल नंबर से चैट की थी, उसी से साइन इन करें। आप इसी पेज पर लौटेंगे।",
    "ज्या मोबाईल नंबरवरून चॅट केले, त्यानेच साइन इन करा. तुम्ही याच पानावर परत याल.",
  ),
  total: L("Total before delivery fees", "डिलीवरी शुल्क से पहले कुल", "डिलिव्हरी शुल्कापूर्वी एकूण"),
  invalid: L("This link is not valid.", "यह लिंक मान्य नहीं है।", "ही लिंक वैध नाही."),
  expired: L(
    "This link has expired. Send \"checkout\" on WhatsApp for a new one.",
    "यह लिंक समाप्त हो गया। नए लिंक के लिए WhatsApp पर \"checkout\" भेजें।",
    "ही लिंक कालबाह्य झाली. नवीन लिंकसाठी WhatsApp वर \"checkout\" पाठवा.",
  ),
  used: L("This link was already used.", "यह लिंक पहले ही इस्तेमाल हो चुका है।", "ही लिंक आधीच वापरली आहे."),
  openCart: L("Open my cart", "मेरी कार्ट खोलें", "माझी कार्ट उघडा"),
};

/**
 * docs/customer-whatsapp-2026-11: the signed checkout link from the WhatsApp
 * chat. Anyone with the link sees the lines; "Add to my cart" (signed in) puts
 * them into the customer's cart once. Flag whatsapp_customer_enabled off: 404.
 */
export default async function WhatsAppCartPage({ searchParams }: { searchParams: Promise<{ t?: string; error?: string }> }) {
  if (!(await isFeatureEnabled(CUSTOMER_WHATSAPP_FLAG))) notFound();
  const { t, error } = await searchParams;
  const [lang, user, { link, problem }] = await Promise.all([getBoardLang(), getCurrentUser(), loadCartLink(t)]);

  async function addAction() {
    "use server";
    const signedIn = await getCurrentUser();
    if (!signedIn) redirect("/signin");
    let failure: string | null = null;
    let summary = "";
    try {
      const result = await claimCartLink(t ?? "", signedIn);
      summary = `${result.added.length}-${result.skipped.length}`;
    } catch (caught) {
      failure = caught instanceof AppError ? caught.message : "The items could not be added.";
    }
    if (failure) redirect(`${CART_LINK_PATH}?t=${encodeURIComponent(t ?? "")}&error=${encodeURIComponent(failure)}`);
    redirect(`/cart?from=whatsapp&added=${summary}`);
  }

  if (!link || problem) {
    const message = problem === "EXPIRED" ? T.expired : problem === "USED" ? T.used : T.invalid;
    return (
      <div className="mx-auto max-w-xl space-y-4">
        <PageHeader title={tr(T.title, lang)} />
        <Alert tone="warning">{tr(message, lang)}</Alert>
        {problem === "USED" ? <LinkButton href="/cart">{tr(T.openCart, lang)}</LinkButton> : null}
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-xl space-y-4">
      <PageHeader title={tr(T.title, lang)} description={tr(T.intro, lang)} />
      {error ? <Alert tone="danger">{error.slice(0, 300)}</Alert> : null}
      <Card className="divide-y divide-cream-200" data-testid="wa-cart-lines">
        {link.lines.map((line) => (
          <div key={line.shopProductId} className="flex items-start justify-between gap-3 p-3 text-sm">
            <div>
              <p className="font-medium text-ink-900">{line.name}</p>
              <p className="text-xs text-ink-500">
                {line.shopName} · {line.quantity} × {formatPaise(line.unitPricePaise)}
              </p>
            </div>
            <p className="font-semibold text-ink-900">{formatPaise(line.unitPricePaise * line.quantity)}</p>
          </div>
        ))}
        <div className="flex justify-between p-3 text-sm font-semibold">
          <span>{tr(T.total, lang)}</span>
          <span>{formatPaise(cartTotalPaise(link.lines))}</span>
        </div>
      </Card>
      {user ? (
        <form action={addAction}>
          <button type="submit" className="min-h-11 w-full rounded-lg bg-kesari-600 px-4 py-2 text-sm font-medium text-white hover:bg-kesari-800" data-testid="wa-cart-add">
            {tr(T.add, lang)}
          </button>
        </form>
      ) : (
        <div className="space-y-2">
          <LinkButton href="/signin" className="w-full">
            {tr(T.signIn, lang)}
          </LinkButton>
          <p className="text-xs text-ink-500">{tr(T.signInHint, lang)}</p>
        </div>
      )}
    </div>
  );
}
