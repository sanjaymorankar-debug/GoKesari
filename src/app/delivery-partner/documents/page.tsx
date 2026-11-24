import { redirect } from "next/navigation";

import { RiderBackgroundDocsForm } from "@/components/rider-background-docs-form";
import { LinkButton, PageHeader } from "@/components/ui";
import { L, tr } from "@/lib/board/i18n";
import { getCurrentUser } from "@/server/authz/guards";
import { getBoardLang } from "@/server/board-lang";
import { getMyDeliveryPartnerProfile } from "@/server/services/delivery-partners";
import { BACKGROUND_DOC_LABELS, listMyBackgroundDocs } from "@/server/services/rider-background-docs";
import { getRule } from "@/server/services/settings";

export const metadata = { title: "Police verification documents" };
export const dynamic = "force-dynamic";

const T = {
  title: L("Police verification documents", "पुलिस सत्यापन दस्तावेज़", "पोलीस पडताळणी कागदपत्रे"),
  description: L(
    "Step 3 of 3. Upload your police verification form and character certificate. They are stored privately and only GoKesari's verification team can open them.",
    "चरण 3 में से 3। अपना पुलिस सत्यापन फ़ॉर्म और चरित्र प्रमाणपत्र अपलोड करें। ये सुरक्षित रखे जाते हैं और सिर्फ़ GoKesari की सत्यापन टीम इन्हें खोल सकती है।",
    "पायरी 3 पैकी 3. तुमचा पोलीस पडताळणी फॉर्म आणि चारित्र्य प्रमाणपत्र अपलोड करा. ते खाजगी ठेवले जातात आणि फक्त GoKesari ची पडताळणी टीम ते उघडू शकते.",
  ),
  police: L("Police verification form", "पुलिस सत्यापन फ़ॉर्म", "पोलीस पडताळणी फॉर्म"),
  character: L("Character certificate", "चरित्र प्रमाणपत्र", "चारित्र्य प्रमाणपत्र"),
  back: L("Back to my application", "मेरे आवेदन पर वापस", "माझ्या अर्जावर परत"),
  kyc: L("PAN and Aadhaar", "PAN और Aadhaar", "PAN आणि Aadhaar"),
} as const;

/** Gig worker flow (feature 3): step 3 of registration. */
export default async function RiderBackgroundDocsPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");
  const partner = await getMyDeliveryPartnerProfile(user.id);
  if (!partner) redirect("/delivery-partner/register");
  const [documents, rule, lang] = await Promise.all([listMyBackgroundDocs(user.id), getRule("riderVerification"), getBoardLang()]);
  // English keeps the service's own labels; Hindi / Marathi use the table above.
  const docLabel = (docType: "POLICE_VERIFICATION" | "CHARACTER_CERTIFICATE") =>
    lang === "en" ? BACKGROUND_DOC_LABELS[docType] : tr(docType === "POLICE_VERIFICATION" ? T.police : T.character, lang);

  return (
    <div className="mx-auto max-w-2xl">
      <PageHeader
        title={tr(T.title, lang)}
        description={tr(T.description, lang)}
      />
      <RiderBackgroundDocsForm
        documents={documents.map((d) => ({ ...d, createdAt: d.createdAt.toISOString() }))}
        slots={[
          { docType: "POLICE_VERIFICATION", label: docLabel("POLICE_VERIFICATION"), required: true },
          { docType: "CHARACTER_CERTIFICATE", label: docLabel("CHARACTER_CERTIFICATE"), required: rule.requireCharacterCertificate },
        ]}
        maxBytes={rule.maxDocumentBytes}
        lang={lang}
      />
      <div className="mt-6 flex flex-wrap gap-2">
        <LinkButton href="/delivery-partner">{tr(T.back, lang)}</LinkButton>
        <LinkButton href="/delivery-partner/kyc" variant="secondary">
          {tr(T.kyc, lang)}
        </LinkButton>
      </div>
    </div>
  );
}
