import { redirect } from "next/navigation";

import { DeliveryPartnerRegisterForm } from "@/components/delivery-partner-register-form";
import { PageHeader } from "@/components/ui";
import { L, tr } from "@/lib/board/i18n";
import { getCurrentUser } from "@/server/authz/guards";
import { getBoardLang } from "@/server/board-lang";
import { getMyDeliveryPartnerProfile } from "@/server/services/delivery-partners";
import { normaliseReferralCode } from "@/lib/rider-growth";
import { getRule } from "@/server/services/settings";

export const metadata = { title: "Delivery Partner Registration" };
export const dynamic = "force-dynamic";

const T = {
  title: L("Delivery Partner Registration", "डिलीवरी पार्टनर पंजीकरण", "डिलिव्हरी पार्टनर नोंदणी"),
  description: L(
    "Step 1 of 3: your details, vehicle, emergency contact and current location. Next: PAN and Aadhaar verification, then your police verification documents.",
    "चरण 3 में से 1: आपकी जानकारी, वाहन, आपातकालीन संपर्क और मौजूदा लोकेशन। आगे: PAN और Aadhaar सत्यापन, फिर पुलिस सत्यापन दस्तावेज़।",
    "पायरी 3 पैकी 1: तुमची माहिती, वाहन, आपत्कालीन संपर्क आणि सध्याचे ठिकाण. पुढे: PAN आणि Aadhaar पडताळणी, नंतर पोलीस पडताळणी कागदपत्रे.",
  ),
} as const;

export default async function DeliveryPartnerRegisterPage({ searchParams }: { searchParams: Promise<{ ref?: string | string[] }> }) {
  // Rider App v2 (rule riderReferral): a shared link /delivery-partner/register?ref=CODE fills the code.
  const rawRef = (await searchParams).ref;
  const ref = normaliseReferralCode(Array.isArray(rawRef) ? rawRef[0] : rawRef);
  const user = await getCurrentUser();
  if (!user) redirect(ref ? `/signin?callbackUrl=${encodeURIComponent(`/delivery-partner/register?ref=${ref}`)}` : "/signin");

  const existing = await getMyDeliveryPartnerProfile(user.id);
  if (existing) redirect("/delivery-partner");
  const [lang, referral] = await Promise.all([getBoardLang(), getRule("riderReferral")]);

  return (
    <div className="mx-auto max-w-2xl">
      <PageHeader
        title={tr(T.title, lang)}
        description={tr(T.description, lang)}
      />
      <DeliveryPartnerRegisterForm lang={lang} referral={referral.enabled ? { code: ref ?? "" } : undefined} />
    </div>
  );
}
