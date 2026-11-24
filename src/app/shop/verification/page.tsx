import Link from "next/link";
import { redirect } from "next/navigation";

import { SellerVerificationPanel, type PanelDocument } from "@/components/seller-verification-panel";
import { Alert, EmptyState, PageHeader } from "@/components/ui";
import { L, tr } from "@/lib/board/i18n";
import { getBoardLang } from "@/server/board-lang";
import { activeShop } from "@/server/active-shop";
import { getCurrentUser } from "@/server/authz/guards";
import { getShopVerificationSummary } from "@/server/services/seller-verification";
import { listShopsForOwner } from "@/server/services/shops";

export const metadata = { title: "Shop verification" };
export const dynamic = "force-dynamic";

/** Module 6: Hindi / Marathi (English unchanged). */
const T = {
  title: L("Shop verification", "दुकान सत्यापन", "दुकान पडताळणी"),
  noShop: L("You haven't registered a shop yet", "आपने अभी कोई दुकान रजिस्टर नहीं की है", "तुम्ही अजून दुकान नोंदवलेले नाही"),
  titleShop: L("Verification — {shop}", "सत्यापन — {shop}", "पडताळणी — {shop}"),
  description: L(
    "We check your business documents with the government records before your shop sells online. Numbers are stored encrypted; only the last few characters are ever shown.",
    "आपकी दुकान ऑनलाइन बेचना शुरू करे, उससे पहले हम आपके व्यवसाय के दस्तावेज़ सरकारी रिकॉर्ड से जाँचते हैं। नंबर एन्क्रिप्ट करके रखे जाते हैं; सिर्फ़ आख़िरी कुछ अक्षर दिखते हैं।",
    "तुमचे दुकान ऑनलाइन विक्री सुरू करण्यापूर्वी आम्ही तुमची व्यवसायाची कागदपत्रे सरकारी नोंदींशी तपासतो. क्रमांक एन्क्रिप्ट करून ठेवले जातात; फक्त शेवटची काही अक्षरे दिसतात.",
  ),
  dashboard: L("← Shop dashboard", "← दुकान डैशबोर्ड", "← दुकान डॅशबोर्ड"),
  yourShops: L("Your shops", "आपकी दुकानें", "तुमची दुकाने"),
  haveLicence: L(
    "Have a licence certificate to send — FSSAI, drug licence, trade licence or any other?",
    "कोई लाइसेंस प्रमाणपत्र भेजना है — FSSAI, ड्रग लाइसेंस, ट्रेड लाइसेंस या कोई और?",
    "एखादे परवाना प्रमाणपत्र पाठवायचे आहे — FSSAI, औषध परवाना, व्यापार परवाना किंवा इतर?",
  ),
  uploadLink: L("Upload a photo or PDF on Upload documents →", "दस्तावेज़ अपलोड पेज पर फ़ोटो या PDF अपलोड करें →", "कागदपत्रे अपलोड पानावर फोटो किंवा PDF अपलोड करा →"),
  allVerified: L("All required documents are verified.", "सभी ज़रूरी दस्तावेज़ सत्यापित हैं।", "सर्व आवश्यक कागदपत्रे पडताळली आहेत."),
  keepUpToDate: L(
    "Keep them up to date — we'll remind you 30 days before anything expires.",
    "इन्हें अपडेट रखें — किसी की अवधि खत्म होने से 30 दिन पहले हम याद दिलाएँगे।",
    "ती अद्ययावत ठेवा — कशाचीही मुदत संपण्यापूर्वी 30 दिवस आधी आम्ही आठवण करून देऊ.",
  ),
  stillNeeded: L("Still needed", "अभी बाकी", "अजून बाकी"),
  food: L(
    " Your shop sells food, so an FSSAI licence or registration is required.",
    " आपकी दुकान खाने का सामान बेचती है, इसलिए FSSAI लाइसेंस या पंजीकरण ज़रूरी है।",
    " तुमचे दुकान खाद्यपदार्थ विकते, म्हणून FSSAI परवाना किंवा नोंदणी आवश्यक आहे.",
  ),
} as const;

/** Seller onboarding: legal verification of the owner's own shop(s). */
export default async function ShopVerificationPage({ searchParams }: { searchParams: Promise<{ shop?: string }> }) {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");
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
  const summary = await getShopVerificationSummary(shop.id, user);

  const documents: PanelDocument[] = summary.documents.map((d) => ({
    id: d.id,
    docType: d.docType,
    label: d.label,
    requirement: d.requirement,
    status: d.status,
    numberMasked: d.numberMasked,
    verifiedName: d.verifiedName,
    validUntil: d.validUntil,
    lastErrorCode: d.lastErrorCode,
    reviewNote: d.reviewNote,
    declaredNotRegistered: d.details.declaredNotRegistered === true,
    files: d.files.map((f) => ({ id: f.id, contentType: f.contentType, createdAt: f.createdAt.toISOString() })),
  }));

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <PageHeader
        title={tr(T.titleShop, lang).replace("{shop}", shop.name)}
        description={tr(T.description, lang)}
        action={
          <Link href="/shop" className="text-sm font-medium text-kesari-600 hover:underline">
            {tr(T.dashboard, lang)}
          </Link>
        }
      />
      {shops.length > 1 ? (
        <nav className="flex flex-wrap gap-2 text-sm" aria-label={tr(T.yourShops, lang)}>
          {shops.map((s) => (
            <Link
              key={s.id}
              href={`/shop/verification?shop=${s.id}`}
              className={s.id === shop.id ? "rounded-full bg-kesari-600 px-3 py-1 text-white" : "rounded-full bg-cream-100 px-3 py-1 text-ink-700"}
            >
              {s.name}
            </Link>
          ))}
        </nav>
      ) : null}
      {/* The cards below take document numbers; a licence's copy (FSSAI and the rest) is uploaded on Upload documents. */}
      <p className="text-sm text-ink-700" data-testid="verification-upload-link">
        {tr(T.haveLicence, lang)}{" "}
        <Link href={`/shop/documents?shop=${shop.id}`} className="font-medium text-kesari-600 hover:underline">
          {tr(T.uploadLink, lang)}
        </Link>
      </p>
      {summary.complete ? (
        <Alert tone="success" title={tr(T.allVerified, lang)}>
          {tr(T.keepUpToDate, lang)}
        </Alert>
      ) : (
        <Alert tone="info" title={tr(T.stillNeeded, lang)}>
          {summary.missing.map((t) => summary.documents.find((d) => d.docType === t)?.label).join(", ")}.
          {summary.isFoodBusiness ? tr(T.food, lang) : ""}
        </Alert>
      )}
      <SellerVerificationPanel shopId={shop.id} documents={documents} />
    </div>
  );
}
