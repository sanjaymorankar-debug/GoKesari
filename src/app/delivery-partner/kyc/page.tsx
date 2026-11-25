import { redirect } from "next/navigation";

import { RiderKycForm } from "@/components/rider-kyc-form";
import { LinkButton, PageHeader } from "@/components/ui";
import { L, tr } from "@/lib/board/i18n";
import { getCurrentUser } from "@/server/authz/guards";
import { getBoardLang } from "@/server/board-lang";
import { getMyDeliveryPartnerProfile } from "@/server/services/delivery-partners";
import { getMyRiderKyc } from "@/server/services/rider-kyc";
import { getRule } from "@/server/services/settings";

export const metadata = { title: "PAN and Aadhaar verification" };
export const dynamic = "force-dynamic";

const T = {
  title: L("PAN and Aadhaar verification", "PAN और Aadhaar सत्यापन", "PAN आणि Aadhaar पडताळणी"),
  description: L(
    "Step 2 of 3. We check your PAN with the government records through our verification partner, and you share your Aadhaar from DigiLocker — with your consent.",
    "चरण 3 में से 2। हम अपने सत्यापन पार्टनर के ज़रिए आपका PAN सरकारी रिकॉर्ड से जाँचते हैं, और आप अपनी सहमति से DigiLocker से अपना Aadhaar साझा करते हैं।",
    "पायरी 3 पैकी 2. आम्ही आमच्या पडताळणी भागीदारामार्फत तुमचा PAN सरकारी नोंदींशी तपासतो, आणि तुम्ही तुमच्या संमतीने DigiLocker मधून तुमचा Aadhaar शेअर करता.",
  ),
  next: L("Next: police verification documents", "आगे: पुलिस सत्यापन दस्तावेज़", "पुढे: पोलीस पडताळणी कागदपत्रे"),
  back: L("Back to my application", "मेरे आवेदन पर वापस", "माझ्या अर्जावर परत"),
} as const;

/** Gig worker flow (feature 2): step 2 of registration. */
export default async function RiderKycPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");
  const partner = await getMyDeliveryPartnerProfile(user.id);
  if (!partner) redirect("/delivery-partner/register");
  const [kyc, rule, lang] = await Promise.all([getMyRiderKyc(user.id), getRule("riderVerification"), getBoardLang()]);
  const view = (c: typeof kyc.pan) =>
    c ? { status: c.status, numberMasked: c.numberMasked, reason: c.reason, awaitingOtp: c.awaitingOtp, digilockerOpen: c.digilockerOpen } : null;

  return (
    <div className="mx-auto max-w-2xl">
      <PageHeader
        title={tr(T.title, lang)}
        description={tr(T.description, lang)}
      />
      <RiderKycForm pan={view(kyc.pan)} aadhaar={view(kyc.aadhaar)} aadhaarMethod={rule.aadhaarMethod} lang={lang} />
      <div className="mt-6 flex flex-wrap gap-2">
        <LinkButton href="/delivery-partner/documents">{tr(T.next, lang)}</LinkButton>
        <LinkButton href="/delivery-partner" variant="secondary">
          {tr(T.back, lang)}
        </LinkButton>
      </div>
    </div>
  );
}
