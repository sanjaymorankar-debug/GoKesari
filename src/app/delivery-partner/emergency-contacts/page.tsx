import { redirect } from "next/navigation";

import { LinkButton, PageHeader } from "@/components/ui";
import { L, tr } from "@/lib/board/i18n";
import { getCurrentUser } from "@/server/authz/guards";
import { getBoardLang } from "@/server/board-lang";
import { getMyEmergencyContact } from "@/server/services/rider-sos";
import { EmergencyContactForm } from "./emergency-contact-form";

export const metadata = { title: "Emergency contact" };
export const dynamic = "force-dynamic";

const T = {
  title: L("Emergency contact", "आपातकालीन संपर्क", "आपत्कालीन संपर्क"),
  description: L(
    "The person we call if something happens to you on a delivery. Our team sees this when you press SOS.",
    "डिलीवरी के दौरान आपके साथ कुछ हो जाए तो हम इन्हें कॉल करेंगे। SOS दबाने पर हमारी टीम को यह दिखता है।",
    "डिलिव्हरीदरम्यान तुमच्यासोबत काही झाल्यास आम्ही यांना कॉल करू. तुम्ही SOS दाबल्यावर आमच्या टीमला हे दिसते.",
  ),
  back: L("Back", "वापस", "परत"),
} as const;

/** Rider App v2: the rider keeps their emergency contact up to date. */
export default async function RiderEmergencyContactPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/signin?callbackUrl=/delivery-partner/emergency-contacts");
  const [contact, lang] = await Promise.all([getMyEmergencyContact(user.id), getBoardLang()]);
  if (!contact) redirect("/delivery-partner/register");
  return (
    <div className="mx-auto max-w-lg">
      <PageHeader title={tr(T.title, lang)} description={tr(T.description, lang)} />
      <EmergencyContactForm initial={{ name: contact.name ?? "", mobile: contact.mobile ?? "", relation: contact.relation ?? "" }} lang={lang} />
      <div className="mt-6">
        <LinkButton href="/delivery-partner" variant="secondary">
          {tr(T.back, lang)}
        </LinkButton>
      </div>
    </div>
  );
}
