/**
 * Fixed wording the agreement blocks use (Annexure A tables, licence schedule, signature blocks, the
 * Electronic Acceptance Certificate), in English, Marathi and Hindi (docs/seller-agreements-2026-11).
 * The agreement text itself lives in the templates; this is only the frame code builds around it.
 * Marathi and Hindi are drafts pending legal review, like the template translations.
 */
import type { LegalLanguage } from "@/server/db/legal-agreements-schema";

export const LANGUAGE_NAMES: Record<LegalLanguage, string> = { en: "English", mr: "मराठी", hi: "हिंदी" };

type Labels = {
  field: string;
  details: string;
  legalName: string;
  tradeName: string;
  constitution: string;
  owner: string;
  address: string;
  googleLocation: string;
  shopTypes: string;
  pan: string;
  gstin: string;
  shopAct: string;
  udyam: string;
  drugLicence: string;
  pharmacist: string;
  fssai: string;
  complaintContact: string;
  bank: string;
  bankLast4: (last4: string) => string;
  sellerId: string;
  mobileWhatsappEmail: string;
  licenceType: string;
  licenceNumber: string;
  issuingAuthority: string;
  validFrom: string;
  validUntil: string;
  verificationStatus: string;
  documentReference: string;
  noExpiry: string;
  notStated: string;
  licenceScheduleNote: (asOf: string) => string;
  noLicences: string;
  status: Record<"VERIFIED" | "SUBMITTED" | "PENDING", string>;
  forPlatform: string;
  forSeller: string;
  entity: string;
  signatoryName: string;
  designation: string;
  signature: string;
  seal: string;
  date: string;
  place: string;
  digitallySigned: string;
  toBeSigned: string;
  eSealAffixed: string;
  platformSigned: string;
  declarationSigned: (name: string, when: string) => string;
  declarationUnsigned: string;
  draftBanner: string;
  certificateTitle: string;
  certificateIntro: string;
  cert: Record<
    | "signer"
    | "designation"
    | "shop"
    | "sellerId"
    | "mobile"
    | "acceptedAt"
    | "ip"
    | "platform"
    | "otpRef"
    | "document"
    | "version"
    | "languages"
    | "licencesAsOf"
    | "snapshotHash"
    | "hashes"
    | "verify"
    | "registeredBy",
    string
  >;
  certificateFooter: string;
};

const en: Labels = {
  field: "Field",
  details: "Details",
  legalName: "Legal name of shop / firm",
  tradeName: "Shop / trade name",
  constitution: "Constitution",
  owner: "Owner / authorised person",
  address: "Shop address and PIN code",
  googleLocation: "Google location",
  shopTypes: "Shop type(s)",
  pan: "PAN",
  gstin: "GSTIN",
  shopAct: "Shop Act / Gumasta registration",
  udyam: "Udyam registration",
  drugLicence: "Drug licence numbers (Form 20 / Form 21) and expiry",
  pharmacist: "Registered pharmacist name and registration number",
  fssai: "FSSAI number",
  complaintContact: "Complaint contact: name, phone, email",
  bank: "Bank account (verified on gokesari.com)",
  bankLast4: (last4) => `Ending ${last4} (last 4 digits only)`,
  sellerId: "gokesari.com Seller ID",
  mobileWhatsappEmail: "Mobile / WhatsApp / Email",
  licenceType: "Licence type",
  licenceNumber: "Licence number",
  issuingAuthority: "Issuing authority",
  validFrom: "Valid from",
  validUntil: "Valid until",
  verificationStatus: "Verification status",
  documentReference: "Document reference",
  noExpiry: "No expiry stated",
  notStated: "As on the licence copy",
  licenceScheduleNote: (asOf) => `Built from the licences and registrations on file with gokesari.com as of ${asOf}.`,
  noLicences: "No licence or registration is on file for this shop.",
  status: { VERIFIED: "Verified", SUBMITTED: "Submitted, under review", PENDING: "Pending" },
  forPlatform: "For the Platform",
  forSeller: "For the Seller",
  entity: "Entity",
  signatoryName: "Signatory name",
  designation: "Designation",
  signature: "Signature",
  seal: "Seal / stamp",
  date: "Date",
  place: "Place",
  digitallySigned: "Digitally signed and accepted via OTP",
  toBeSigned: "To be signed electronically with OTP",
  eSealAffixed: "Company e-seal",
  platformSigned: "Signed for the Platform",
  declarationSigned: (name, when) => `Digitally signed and accepted via OTP by ${name} on ${when}.`,
  declarationUnsigned: "To be signed electronically with OTP.",
  draftBanner: "PREVIEW – not signed. This is the document prepared for your shop; it becomes binding only when you sign it with the OTP.",
  certificateTitle: "Electronic Acceptance Certificate",
  certificateIntro:
    "This certificate records the electronic acceptance of the document above under the Information Technology Act, 2000. The seller's identity was confirmed by a one-time password (OTP) sent to the registered mobile number.",
  cert: {
    signer: "Signed by",
    designation: "Designation",
    shop: "Shop / firm",
    sellerId: "gokesari.com Seller ID",
    mobile: "Registered mobile (masked)",
    acceptedAt: "Date and time of acceptance (IST)",
    ip: "IP address",
    platform: "Platform",
    otpRef: "OTP verification reference",
    document: "Document",
    version: "Version",
    languages: "Language versions signed",
    licencesAsOf: "Licence schedule as of",
    snapshotHash: "SHA-256 of the data snapshot",
    hashes: "SHA-256 of each signed PDF",
    verify: "Verify at",
    registeredBy: "Registration entered by",
  },
  certificateFooter: "In case of any difference between language versions, the English version shall prevail.",
};

const mr: Labels = {
  field: "तपशील",
  details: "माहिती",
  legalName: "दुकान / फर्मचे कायदेशीर नाव",
  tradeName: "दुकानाचे / व्यापारी नाव",
  constitution: "व्यवसायाचे स्वरूप",
  owner: "मालक / अधिकृत व्यक्ती",
  address: "दुकानाचा पत्ता आणि पिन कोड",
  googleLocation: "Google स्थान",
  shopTypes: "दुकानाचा प्रकार",
  pan: "पॅन (PAN)",
  gstin: "जीएसटीआयएन (GSTIN)",
  shopAct: "शॉप ॲक्ट / गुमास्ता नोंदणी",
  udyam: "उद्यम नोंदणी",
  drugLicence: "औषध परवाना क्रमांक (फॉर्म 20 / फॉर्म 21) आणि मुदत",
  pharmacist: "नोंदणीकृत फार्मासिस्टचे नाव आणि नोंदणी क्रमांक",
  fssai: "FSSAI क्रमांक",
  complaintContact: "तक्रारीसाठी संपर्क: नाव, फोन, ईमेल",
  bank: "बँक खाते (gokesari.com वर पडताळलेले)",
  bankLast4: (last4) => `शेवटचे 4 अंक ${last4} (फक्त शेवटचे 4 अंक)`,
  sellerId: "gokesari.com विक्रेता आयडी",
  mobileWhatsappEmail: "मोबाईल / व्हॉट्सॲप / ईमेल",
  licenceType: "परवान्याचा प्रकार",
  licenceNumber: "परवाना क्रमांक",
  issuingAuthority: "परवाना देणारे प्राधिकरण",
  validFrom: "पासून वैध",
  validUntil: "पर्यंत वैध",
  verificationStatus: "पडताळणी स्थिती",
  documentReference: "दस्तऐवज संदर्भ",
  noExpiry: "मुदत नमूद नाही",
  notStated: "परवान्याच्या प्रतीनुसार",
  licenceScheduleNote: (asOf) => `gokesari.com कडे ${asOf} रोजी नोंद असलेल्या परवाने व नोंदण्यांवरून तयार केलेली अनुसूची.`,
  noLicences: "या दुकानाचा कोणताही परवाना किंवा नोंदणी नोंदवलेली नाही.",
  status: { VERIFIED: "पडताळलेले", SUBMITTED: "सादर, तपासणी सुरू", PENDING: "प्रलंबित" },
  forPlatform: "प्लॅटफॉर्मच्या वतीने",
  forSeller: "विक्रेत्याच्या वतीने",
  entity: "संस्था",
  signatoryName: "स्वाक्षरीकर्त्याचे नाव",
  designation: "पदनाम",
  signature: "स्वाक्षरी",
  seal: "शिक्का",
  date: "दिनांक",
  place: "ठिकाण",
  digitallySigned: "OTP द्वारे डिजिटल स्वाक्षरी करून स्वीकारले",
  toBeSigned: "OTP द्वारे इलेक्ट्रॉनिक स्वाक्षरी करावयाची",
  eSealAffixed: "कंपनीचा ई-शिक्का",
  platformSigned: "प्लॅटफॉर्मच्या वतीने स्वाक्षरी",
  declarationSigned: (name, when) => `${name} यांनी ${when} रोजी OTP द्वारे डिजिटल स्वाक्षरी करून स्वीकारले.`,
  declarationUnsigned: "OTP द्वारे इलेक्ट्रॉनिक स्वाक्षरी करावयाची.",
  draftBanner: "पूर्वावलोकन – स्वाक्षरी केलेली नाही. हा आपल्या दुकानासाठी तयार केलेला दस्तऐवज आहे; OTP द्वारे स्वाक्षरी केल्यानंतरच तो बंधनकारक होईल.",
  certificateTitle: "इलेक्ट्रॉनिक स्वीकृती प्रमाणपत्र",
  certificateIntro:
    "हे प्रमाणपत्र माहिती तंत्रज्ञान अधिनियम, 2000 अंतर्गत वरील दस्तऐवजाच्या इलेक्ट्रॉनिक स्वीकृतीची नोंद करते. नोंदणीकृत मोबाईल क्रमांकावर पाठवलेल्या एकवेळ पासवर्डद्वारे (OTP) विक्रेत्याची ओळख निश्चित केली गेली.",
  cert: {
    signer: "स्वाक्षरीकर्ता",
    designation: "पदनाम",
    shop: "दुकान / फर्म",
    sellerId: "gokesari.com विक्रेता आयडी",
    mobile: "नोंदणीकृत मोबाईल (अंशतः लपवलेला)",
    acceptedAt: "स्वीकृतीचा दिनांक व वेळ (IST)",
    ip: "IP पत्ता",
    platform: "प्लॅटफॉर्म",
    otpRef: "OTP पडताळणी संदर्भ",
    document: "दस्तऐवज",
    version: "आवृत्ती",
    languages: "स्वाक्षरी केलेल्या भाषा आवृत्त्या",
    licencesAsOf: "परवाना अनुसूची दिनांक",
    snapshotHash: "डेटा स्नॅपशॉटचा SHA-256",
    hashes: "प्रत्येक स्वाक्षरी केलेल्या PDF चा SHA-256",
    verify: "येथे पडताळा",
    registeredBy: "नोंदणी करणारे",
  },
  certificateFooter: "विविध भाषांतील आवृत्त्यांमध्ये कोणताही फरक आढळल्यास इंग्रजी आवृत्ती ग्राह्य धरली जाईल.",
};

const hi: Labels = {
  field: "विवरण",
  details: "जानकारी",
  legalName: "दुकान / फ़र्म का विधिक नाम",
  tradeName: "दुकान / व्यापारिक नाम",
  constitution: "व्यवसाय का गठन",
  owner: "स्वामी / प्राधिकृत व्यक्ति",
  address: "दुकान का पता और पिन कोड",
  googleLocation: "Google स्थान",
  shopTypes: "दुकान का प्रकार",
  pan: "पैन (PAN)",
  gstin: "जीएसटीआईएन (GSTIN)",
  shopAct: "शॉप एक्ट / गुमास्ता पंजीकरण",
  udyam: "उद्यम पंजीकरण",
  drugLicence: "औषधि अनुज्ञप्ति संख्या (फ़ॉर्म 20 / फ़ॉर्म 21) और समाप्ति",
  pharmacist: "पंजीकृत भेषजज्ञ का नाम और पंजीकरण संख्या",
  fssai: "FSSAI संख्या",
  complaintContact: "शिकायत संपर्क: नाम, फ़ोन, ईमेल",
  bank: "बैंक खाता (gokesari.com पर सत्यापित)",
  bankLast4: (last4) => `अंतिम 4 अंक ${last4} (केवल अंतिम 4 अंक)`,
  sellerId: "gokesari.com विक्रेता आईडी",
  mobileWhatsappEmail: "मोबाइल / व्हाट्सऐप / ईमेल",
  licenceType: "अनुज्ञप्ति का प्रकार",
  licenceNumber: "अनुज्ञप्ति संख्या",
  issuingAuthority: "जारीकर्ता प्राधिकारी",
  validFrom: "से वैध",
  validUntil: "तक वैध",
  verificationStatus: "सत्यापन स्थिति",
  documentReference: "दस्तावेज़ संदर्भ",
  noExpiry: "समाप्ति तिथि उल्लिखित नहीं",
  notStated: "अनुज्ञप्ति की प्रति के अनुसार",
  licenceScheduleNote: (asOf) => `gokesari.com के पास ${asOf} को दर्ज अनुज्ञप्तियों और पंजीकरणों से तैयार अनुसूची।`,
  noLicences: "इस दुकान की कोई अनुज्ञप्ति या पंजीकरण दर्ज नहीं है।",
  status: { VERIFIED: "सत्यापित", SUBMITTED: "प्रस्तुत, जाँच जारी", PENDING: "लंबित" },
  forPlatform: "प्लेटफ़ॉर्म की ओर से",
  forSeller: "विक्रेता की ओर से",
  entity: "संस्था",
  signatoryName: "हस्ताक्षरकर्ता का नाम",
  designation: "पदनाम",
  signature: "हस्ताक्षर",
  seal: "मुहर",
  date: "दिनांक",
  place: "स्थान",
  digitallySigned: "OTP द्वारा डिजिटल हस्ताक्षर कर स्वीकार किया गया",
  toBeSigned: "OTP द्वारा इलेक्ट्रॉनिक हस्ताक्षर किए जाने हैं",
  eSealAffixed: "कंपनी की ई-मुहर",
  platformSigned: "प्लेटफ़ॉर्म की ओर से हस्ताक्षरित",
  declarationSigned: (name, when) => `${name} द्वारा ${when} को OTP से डिजिटल हस्ताक्षर कर स्वीकार किया गया।`,
  declarationUnsigned: "OTP द्वारा इलेक्ट्रॉनिक हस्ताक्षर किए जाने हैं।",
  draftBanner: "पूर्वावलोकन – हस्ताक्षरित नहीं। यह आपकी दुकान के लिए तैयार किया गया दस्तावेज़ है; OTP से हस्ताक्षर करने पर ही यह बाध्यकारी होगा।",
  certificateTitle: "इलेक्ट्रॉनिक स्वीकृति प्रमाणपत्र",
  certificateIntro:
    "यह प्रमाणपत्र सूचना प्रौद्योगिकी अधिनियम, 2000 के अंतर्गत उपर्युक्त दस्तावेज़ की इलेक्ट्रॉनिक स्वीकृति का अभिलेख है। पंजीकृत मोबाइल नंबर पर भेजे गए वन-टाइम पासवर्ड (OTP) से विक्रेता की पहचान की पुष्टि की गई।",
  cert: {
    signer: "हस्ताक्षरकर्ता",
    designation: "पदनाम",
    shop: "दुकान / फ़र्म",
    sellerId: "gokesari.com विक्रेता आईडी",
    mobile: "पंजीकृत मोबाइल (आंशिक रूप से छिपा)",
    acceptedAt: "स्वीकृति की तिथि और समय (IST)",
    ip: "IP पता",
    platform: "प्लेटफ़ॉर्म",
    otpRef: "OTP सत्यापन संदर्भ",
    document: "दस्तावेज़",
    version: "संस्करण",
    languages: "हस्ताक्षरित भाषा संस्करण",
    licencesAsOf: "अनुज्ञप्ति अनुसूची की तिथि",
    snapshotHash: "डेटा स्नैपशॉट का SHA-256",
    hashes: "प्रत्येक हस्ताक्षरित PDF का SHA-256",
    verify: "यहाँ सत्यापित करें",
    registeredBy: "पंजीकरण दर्ज करने वाले",
  },
  certificateFooter: "विभिन्न भाषा संस्करणों के बीच किसी भी अंतर की दशा में अंग्रेज़ी संस्करण अभिभावी होगा।",
};

export const LABELS: Record<LegalLanguage, Labels> = { en, mr, hi };

/** Licence / registration kinds in the schedule, per language. */
export const LICENCE_KIND_LABELS: Record<string, Record<LegalLanguage, string>> = {
  DRUG_LICENCE_RETAIL: { en: "Retail drug licence (Form 20 / 21)", mr: "किरकोळ औषध परवाना (फॉर्म 20 / 21)", hi: "खुदरा औषधि अनुज्ञप्ति (फ़ॉर्म 20 / 21)" },
  DRUG_LICENCE: { en: "Drug licence", mr: "औषध परवाना", hi: "औषधि अनुज्ञप्ति" },
  DRUG_LICENCE_WHOLESALE: { en: "Wholesale drug licence (Form 20B / 21B)", mr: "घाऊक औषध परवाना (फॉर्म 20B / 21B)", hi: "थोक औषधि अनुज्ञप्ति (फ़ॉर्म 20B / 21B)" },
  FSSAI: { en: "FSSAI registration / licence", mr: "FSSAI नोंदणी / परवाना", hi: "FSSAI पंजीकरण / अनुज्ञप्ति" },
  GSTIN: { en: "GST registration", mr: "जीएसटी नोंदणी", hi: "जीएसटी पंजीकरण" },
  PAN: { en: "PAN", mr: "पॅन", hi: "पैन" },
  SHOP_ACT: { en: "Shop Act / Gumasta licence", mr: "शॉप ॲक्ट / गुमास्ता परवाना", hi: "शॉप एक्ट / गुमास्ता अनुज्ञप्ति" },
  UDYAM: { en: "Udyam registration", mr: "उद्यम नोंदणी", hi: "उद्यम पंजीकरण" },
  PHARMACIST: { en: "Registered pharmacist", mr: "नोंदणीकृत फार्मासिस्ट", hi: "पंजीकृत भेषजज्ञ" },
  MEDICAL_REGISTRATION: { en: "Medical / professional registration", mr: "वैद्यकीय / व्यावसायिक नोंदणी", hi: "चिकित्सा / व्यावसायिक पंजीकरण" },
  TRADE_LICENCE: { en: "Trade licence (municipal)", mr: "व्यापार परवाना (महानगरपालिका)", hi: "व्यापार अनुज्ञप्ति (नगर निकाय)" },
  LEGAL_METROLOGY: { en: "Legal metrology certificate", mr: "वैध मापन प्रमाणपत्र", hi: "विधिक माप विज्ञान प्रमाणपत्र" },
  FIRE_NOC: { en: "Fire NOC", mr: "अग्निशमन ना-हरकत प्रमाणपत्र", hi: "अग्निशमन अनापत्ति प्रमाणपत्र" },
  AGRI_INPUT_LICENCE: { en: "Seeds / fertiliser / pesticide licence", mr: "बियाणे / खते / कीटकनाशक परवाना", hi: "बीज / उर्वरक / कीटनाशक अनुज्ञप्ति" },
  OTHER_LICENCE: { en: "Other licence", mr: "इतर परवाना", hi: "अन्य अनुज्ञप्ति" },
};

export const CONSTITUTIONS = ["PROPRIETORSHIP", "PARTNERSHIP", "LLP", "COMPANY"] as const;
export type Constitution = (typeof CONSTITUTIONS)[number];
export const CONSTITUTION_LABELS: Record<Constitution, Record<LegalLanguage, string>> = {
  PROPRIETORSHIP: { en: "sole proprietorship", mr: "एकल मालकी", hi: "एकल स्वामित्व" },
  PARTNERSHIP: { en: "partnership firm", mr: "भागीदारी फर्म", hi: "भागीदारी फ़र्म" },
  LLP: { en: "limited liability partnership (LLP)", mr: "मर्यादित दायित्व भागीदारी (LLP)", hi: "सीमित दायित्व भागीदारी (LLP)" },
  COMPANY: { en: "company", mr: "कंपनी", hi: "कंपनी" },
};

export const DESIGNATIONS = ["PROPRIETOR", "PARTNER", "DIRECTOR"] as const;
export type Designation = (typeof DESIGNATIONS)[number];
export const DESIGNATION_LABELS: Record<Designation, Record<LegalLanguage, string>> = {
  PROPRIETOR: { en: "Proprietor", mr: "मालक (प्रोप्रायटर)", hi: "स्वामी (प्रोप्राइटर)" },
  PARTNER: { en: "Partner", mr: "भागीदार", hi: "साझेदार" },
  DIRECTOR: { en: "Director", mr: "संचालक", hi: "निदेशक" },
};

/** The designation that fits a constitution (used to pre-select; the signer confirms). */
export function designationFor(constitution: Constitution | null): Designation {
  if (constitution === "PARTNERSHIP" || constitution === "LLP") return "PARTNER";
  if (constitution === "COMPANY") return "DIRECTOR";
  return "PROPRIETOR";
}

const MONTHS: Record<LegalLanguage, string[]> = {
  en: ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"],
  mr: ["जानेवारी", "फेब्रुवारी", "मार्च", "एप्रिल", "मे", "जून", "जुलै", "ऑगस्ट", "सप्टेंबर", "ऑक्टोबर", "नोव्हेंबर", "डिसेंबर"],
  hi: ["जनवरी", "फ़रवरी", "मार्च", "अप्रैल", "मई", "जून", "जुलाई", "अगस्त", "सितंबर", "अक्टूबर", "नवंबर", "दिसंबर"],
};
const SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** The IST calendar parts of an instant. */
export function istParts(at: Date): { y: number; m: number; d: number; hh: number; mm: number } {
  const ist = new Date(at.getTime() + 330 * 60_000);
  return { y: ist.getUTCFullYear(), m: ist.getUTCMonth(), d: ist.getUTCDate(), hh: ist.getUTCHours(), mm: ist.getUTCMinutes() };
}

/** "26 November 2026" / "26 नोव्हेंबर 2026" (IST). */
export function longDate(at: Date, lang: LegalLanguage): string {
  const p = istParts(at);
  return `${p.d} ${MONTHS[lang][p.m]} ${p.y}`;
}

/** "26-Nov-2026" (IST) — the project's report format. */
export function shortDate(at: Date): string {
  const p = istParts(at);
  return `${String(p.d).padStart(2, "0")}-${SHORT[p.m]}-${p.y}`;
}

/** "26-Nov-2026, 14.35 IST". */
export function dateTimeIst(at: Date): string {
  const p = istParts(at);
  return `${shortDate(at)}, ${String(p.hh).padStart(2, "0")}.${String(p.mm).padStart(2, "0")} IST`;
}

/** A YYYY-MM-DD calendar date as "31-Dec-2027". */
export function calendarDate(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  if (!y || !m || !d) return iso;
  return `${String(d).padStart(2, "0")}-${SHORT[m - 1]}-${y}`;
}
