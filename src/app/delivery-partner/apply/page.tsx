import Link from "next/link";

import { Card, PageHeader } from "@/components/ui";
import { L, tr } from "@/lib/board/i18n";
import { getCurrentUser } from "@/server/authz/guards";
import { getBoardLang } from "@/server/board-lang";
import { getMyDeliveryPartnerProfile } from "@/server/services/delivery-partners";

export const metadata = { title: "Become a Delivery Partner" };
export const dynamic = "force-dynamic";

const T = {
  title: L("Become a GoKesari Delivery Partner", "GoKesari डिलीवरी पार्टनर बनें", "GoKesari डिलिव्हरी पार्टनर व्हा"),
  description: L(
    "Join GoKesari as an independent delivery partner.",
    "स्वतंत्र डिलीवरी पार्टनर के रूप में GoKesari से जुड़ें।",
    "स्वतंत्र डिलिव्हरी पार्टनर म्हणून GoKesari मध्ये सामील व्हा.",
  ),
  flexible: L("Flexible working", "अपने समय पर काम", "तुमच्या वेळेनुसार काम"),
  flexibleText: L(
    " — choose when you go online and when you don't. There are no fixed shifts.",
    " — कब ऑनलाइन होना है और कब नहीं, आप तय करें। कोई तय शिफ़्ट नहीं।",
    " — कधी ऑनलाइन व्हायचे आणि कधी नाही, ते तुम्ही ठरवा. ठरलेल्या शिफ्ट नाहीत.",
  ),
  perDelivery: L("Earn per delivery", "हर डिलीवरी पर कमाई", "प्रत्येक डिलिव्हरीवर कमाई"),
  perDeliveryText: L(
    " — a transparent, delivery-wise earnings statement so you can see exactly what you earned and why.",
    " — हर डिलीवरी का साफ़ हिसाब, ताकि आप देख सकें कि कितना कमाया और क्यों।",
    " — प्रत्येक डिलिव्हरीचा स्पष्ट हिशोब, म्हणजे किती कमावले आणि का ते तुम्हाला दिसेल.",
  ),
  incentives: L("Additional incentives", "अतिरिक्त इनसेंटिव", "अतिरिक्त प्रोत्साहन"),
  incentivesText: L(
    " — from efficient routes and peak-time demand, where available.",
    " — जहाँ उपलब्ध हो, अच्छे रूट और व्यस्त समय की माँग से।",
    " — जिथे उपलब्ध असेल तिथे, चांगले मार्ग आणि गर्दीच्या वेळेच्या मागणीतून.",
  ),
  track: L("Track everything from one place", "सब कुछ एक जगह देखें", "सर्व काही एकाच ठिकाणी पहा"),
  trackText: L(
    " — your applications, deliveries and earnings, all in your account.",
    " — आपका आवेदन, डिलीवरी और कमाई, सब आपके खाते में।",
    " — तुमचा अर्ज, डिलिव्हऱ्या आणि कमाई, सर्व तुमच्या खात्यात.",
  ),
  registration: L(
    "Registration takes a few minutes. After you submit, our team reviews your details and documents before approval — you'll be notified either way.",
    "पंजीकरण में कुछ ही मिनट लगते हैं। जमा करने के बाद हमारी टीम मंज़ूरी से पहले आपकी जानकारी और दस्तावेज़ जाँचती है — दोनों ही स्थिति में आपको सूचना मिलेगी।",
    "नोंदणीला काही मिनिटेच लागतात. जमा केल्यानंतर आमची टीम मंजुरीपूर्वी तुमची माहिती आणि कागदपत्रे तपासते — दोन्हीपैकी काहीही झाले तरी तुम्हाला कळवले जाईल.",
  ),
  viewStatus: L("View my application status →", "मेरे आवेदन की स्थिति देखें →", "माझ्या अर्जाची स्थिती पहा →"),
  start: L("Start my application →", "मेरा आवेदन शुरू करें →", "माझा अर्ज सुरू करा →"),
  signIn: L("Sign in to apply →", "आवेदन के लिए साइन इन करें →", "अर्ज करण्यासाठी साइन इन करा →"),
} as const;

/**
 * Promotional landing page. Deliberately avoids employment language per the
 * brief — a delivery partner is an independent partner, not staff.
 */
export default async function BecomeDeliveryPartnerPage() {
  const user = await getCurrentUser();
  const existing = user ? await getMyDeliveryPartnerProfile(user.id) : null;
  const lang = await getBoardLang();

  return (
    <div className="mx-auto max-w-2xl">
      <PageHeader
        title={tr(T.title, lang)}
        description={tr(T.description, lang)}
      />

      <Card className="mb-6 p-6">
        <ul className="space-y-3 text-sm text-ink-700">
          <li>
            <strong>{tr(T.flexible, lang)}</strong>
            {tr(T.flexibleText, lang)}
          </li>
          <li>
            <strong>{tr(T.perDelivery, lang)}</strong>
            {tr(T.perDeliveryText, lang)}
          </li>
          <li>
            <strong>{tr(T.incentives, lang)}</strong>
            {tr(T.incentivesText, lang)}
          </li>
          <li>
            <strong>{tr(T.track, lang)}</strong>
            {tr(T.trackText, lang)}
          </li>
        </ul>
      </Card>

      <Card className="p-6 text-sm text-ink-600">
        <p className="mb-4">{tr(T.registration, lang)}</p>

        {existing ? (
          <Link
            href="/delivery-partner"
            className="inline-block rounded-lg bg-kesari-600 px-5 py-2.5 text-sm font-medium text-white hover:bg-kesari-800"
          >
            {tr(T.viewStatus, lang)}
          </Link>
        ) : user ? (
          <Link
            href="/delivery-partner/register"
            className="inline-block rounded-lg bg-kesari-600 px-5 py-2.5 text-sm font-medium text-white hover:bg-kesari-800"
          >
            {tr(T.start, lang)}
          </Link>
        ) : (
          <Link
            href="/signin"
            className="inline-block rounded-lg bg-kesari-600 px-5 py-2.5 text-sm font-medium text-white hover:bg-kesari-800"
          >
            {tr(T.signIn, lang)}
          </Link>
        )}
      </Card>
    </div>
  );
}
