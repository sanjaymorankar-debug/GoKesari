import { redirect } from "next/navigation";

import { DeliveryPartnerRegisterForm } from "@/components/delivery-partner-register-form";
import { PageHeader } from "@/components/ui";
import { L, tr } from "@/lib/board/i18n";
import { getCurrentUser } from "@/server/authz/guards";
import { getBoardLang } from "@/server/board-lang";
import { getMyDeliveryPartnerProfile } from "@/server/services/delivery-partners";
import { normaliseReferralCode } from "@/lib/rider-growth";
import { getRule } from "@/server/services/settings";
import { flowF11On } from "@/server/flows/wave5-flags";
import { emailFactorVerified } from "@/server/dual-auth/policy";
import { db } from "@/server/db";
import { users } from "@/server/db/schema";
import { eq } from "drizzle-orm";

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
  const [lang, referral, flowF11] = await Promise.all([getBoardLang(), getRule("riderReferral"), flowF11On()]);
  // docs/flows-v3/wave5.md (flag flow_f11): the account's verified mobile and e-mail fill (and lock) the form.
  let account: { verifiedMobile: string | null; verifiedEmail: string | null } | undefined;
  if (flowF11) {
    const [row] = await db.select().from(users).where(eq(users.id, user.id));
    account = {
      verifiedMobile: row?.phoneE164 && row.phoneVerifiedAt ? row.phoneE164.slice(3) : null,
      verifiedEmail: row && (await emailFactorVerified(row)) ? row.email : null,
    };
  }

  return (
    <div className="mx-auto max-w-2xl">
      <PageHeader
        title={tr(T.title, lang)}
        description={tr(T.description, lang)}
      />
      <DeliveryPartnerRegisterForm lang={lang} referral={referral.enabled ? { code: ref ?? "" } : undefined} account={account} />
    </div>
  );
}
