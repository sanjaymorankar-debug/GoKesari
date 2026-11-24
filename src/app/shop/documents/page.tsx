import Link from "next/link";
import { L, tr } from "@/lib/board/i18n";
import { getBoardLang } from "@/server/board-lang";
import { FillText } from "@/components/board/fill-text";
import { redirect } from "next/navigation";

import { DocumentUploadPanel } from "@/components/document-upload-panel";
import { Alert, EmptyState, PageHeader } from "@/components/ui";
import { toPanelItems } from "@/lib/document-panel-items";
import { activeShop } from "@/server/active-shop";
import { getCurrentUser } from "@/server/authz/guards";
import { browserReadEnabled } from "@/server/kyc/document-reader";
import { getDocumentChecklist } from "@/server/services/document-uploads";
import { listShopsForOwner } from "@/server/services/shops";

export const metadata = { title: "Upload your documents" };
export const dynamic = "force-dynamic";

const T = {
  title: L("Upload your documents", "अपने दस्तावेज़ अपलोड करें", "तुमची कागदपत्रे अपलोड करा"),
  noShop: L("You haven't registered a shop yet", "आपने अभी कोई दुकान रजिस्टर नहीं की है", "तुम्ही अजून दुकान नोंदवलेले नाही"),
  titleShop: L("Upload your documents — {shop}", "अपने दस्तावेज़ अपलोड करें — {shop}", "तुमची कागदपत्रे अपलोड करा — {shop}"),
  description: L(
    "Scan any document, or upload a file or take a photo on its card. We read the number, name, address and validity for you — you only check them and click Verify & Approve. Files are stored encrypted; only our verification team can open them.",
    "कोई भी दस्तावेज़ स्कैन करें, या उसके कार्ड पर फ़ाइल अपलोड करें या फ़ोटो लें। नंबर, नाम, पता और वैधता हम पढ़ लेते हैं — आप बस जाँचें और Verify & Approve दबाएँ। फ़ाइलें एन्क्रिप्ट करके रखी जाती हैं; सिर्फ़ हमारी सत्यापन टीम उन्हें खोल सकती है।",
    "कोणतेही कागदपत्र स्कॅन करा, किंवा त्याच्या कार्डवर फाइल अपलोड करा किंवा फोटो काढा. नंबर, नाव, पत्ता आणि वैधता आम्ही वाचतो — तुम्ही फक्त तपासा आणि Verify & Approve दाबा. फाइल्स एन्क्रिप्ट करून ठेवल्या जातात; फक्त आमची पडताळणी टीम त्या उघडू शकते.",
  ),
  status: L("Verification status →", "सत्यापन की स्थिति →", "पडताळणीची स्थिती →"),
  yourShops: L("Your shops", "आपकी दुकानें", "तुमची दुकाने"),
  off: L("Document upload is switched off", "दस्तावेज़ अपलोड बंद है", "कागदपत्र अपलोड बंद आहे"),
  offText: L("Enter your document numbers on the {link} page instead.", "इसके बजाय {link} पेज पर अपने दस्तावेज़ नंबर लिखें।", "त्याऐवजी {link} पानावर तुमचे कागदपत्र क्रमांक लिहा."),
  verification: L("Verification", "सत्यापन", "पडताळणी"),
  allDone: L("All required documents are uploaded.", "सभी ज़रूरी दस्तावेज़ अपलोड हो गए हैं।", "सर्व आवश्यक कागदपत्रे अपलोड झाली आहेत."),
  remind: L("We'll remind you before anything expires.", "किसी की अवधि खत्म होने से पहले हम याद दिलाएँगे।", "कशाचीही मुदत संपण्यापूर्वी आम्ही आठवण करून देऊ."),
  stillNeeded: L("Still needed", "अभी बाकी", "अजून बाकी"),
  fssai: L("FSSAI licence required", "FSSAI लाइसेंस ज़रूरी", "FSSAI परवाना आवश्यक"),
  fssaiText: L(
    "Your shop sells food, so a valid FSSAI licence or registration is required by law. Registration can't be completed without it, and an expired licence is not accepted.",
    "आपकी दुकान खाने का सामान बेचती है, इसलिए कानून के अनुसार वैध FSSAI लाइसेंस या पंजीकरण ज़रूरी है। इसके बिना पंजीकरण पूरा नहीं हो सकता, और अवधि खत्म हुआ लाइसेंस नहीं माना जाता।",
    "तुमचे दुकान खाद्यपदार्थ विकते, म्हणून कायद्याने वैध FSSAI परवाना किंवा नोंदणी आवश्यक आहे. त्याशिवाय नोंदणी पूर्ण होऊ शकत नाही, आणि मुदत संपलेला परवाना स्वीकारला जात नाही.",
  ),
} as const;

/**
 * Shop registration, documents step (docs/document-upload-2026-10): upload a
 * file or take a photo of each mandatory document; the details are read
 * automatically and the owner reviews them before submitting.
 */
export default async function ShopDocumentsPage({ searchParams }: { searchParams: Promise<{ shop?: string }> }) {
  const user = await getCurrentUser();
  if (!user) redirect("/signin?callbackUrl=/shop/documents");
  const params = await searchParams;
  const [shops, lang] = await Promise.all([listShopsForOwner(user.id), getBoardLang()]);
  if (shops.length === 0) {
    return (
      <>
        <PageHeader title={tr(T.title, lang)} />
        <EmptyState title={tr(T.noShop, lang)} />
      </>
    );
  }
  const shop = await activeShop(shops, params.shop);
  const checklist = await getDocumentChecklist(shop.id, user);

  const items = toPanelItems(checklist);
  const missingLabels = checklist.items.filter((i) => checklist.missing.includes(i.docType)).map((i) => i.label);

  return (
    <div className="mx-auto max-w-3xl space-y-6" data-testid="shop-documents-page">
      <PageHeader
        title={tr(T.titleShop, lang).replace("{shop}", shop.name)}
        description={tr(T.description, lang)}
        action={
          <Link href="/shop/verification" className="text-sm font-medium text-kesari-600 hover:underline">
            {tr(T.status, lang)}
          </Link>
        }
      />
      {shops.length > 1 ? (
        <nav className="flex flex-wrap gap-2 text-sm" aria-label={tr(T.yourShops, lang)}>
          {shops.map((s) => (
            <Link
              key={s.id}
              href={`/shop/documents?shop=${s.id}`}
              className={s.id === shop.id ? "rounded-full bg-kesari-600 px-3 py-1 text-white" : "rounded-full bg-cream-100 px-3 py-1 text-ink-700"}
            >
              {s.name}
            </Link>
          ))}
        </nav>
      ) : null}
      {!checklist.enabled ? (
        <Alert tone="info" title={tr(T.off, lang)}>
          <FillText text={tr(T.offText, lang)} parts={{ link: <Link className="underline" href="/shop/verification">{tr(T.verification, lang)}</Link> }} />
        </Alert>
      ) : checklist.missing.length === 0 ? (
        <Alert tone="success" title={tr(T.allDone, lang)}>
          {tr(T.remind, lang)}
        </Alert>
      ) : (
        <Alert tone="info" title={tr(T.stillNeeded, lang)}>
          {missingLabels.join(", ")}.
        </Alert>
      )}
      {checklist.fssaiRequired && !checklist.fssaiOnFile ? (
        <div data-testid="fssai-required">
        <Alert tone="warning" title={tr(T.fssai, lang)}>
          {tr(T.fssaiText, lang)}
        </Alert>
        </div>
      ) : null}
      {checklist.enabled ? <DocumentUploadPanel shopId={shop.id} items={items} browserOcr={browserReadEnabled()} /> : null}
    </div>
  );
}
