import { L, type Text } from "@/lib/board/i18n";
import { isFoodBusinessShopType } from "@/lib/shop-types";

/**
 * Licences a shop type must hold (owner, 08-Nov-2026). None of them stops a shop going live: the
 * owner is told when choosing the shop type and by e-mail, is reminded every 15 days, and the shop
 * is suspended automatically if it is still missing after the grace period (rule shopDocumentFollowUp).
 */
export interface MandatoryLicence {
  docType: "FSSAI" | "DRUG_LICENCE" | "MEDICAL_REGISTRATION";
  label: Text;
}

const FSSAI: MandatoryLicence = { docType: "FSSAI", label: L("FSSAI licence", "FSSAI लाइसेंस", "FSSAI परवाना") };
const DRUG: MandatoryLicence = { docType: "DRUG_LICENCE", label: L("Drug licence", "ड्रग लाइसेंस", "औषध परवाना") };
const MEDICAL: MandatoryLicence = { docType: "MEDICAL_REGISTRATION", label: L("Medical registration", "मेडिकल पंजीकरण", "वैद्यकीय नोंदणी") };
const PROFESSIONAL: MandatoryLicence = {
  docType: "MEDICAL_REGISTRATION",
  label: L("Professional registration (Bar Council, ICAI or ICSI)", "पेशेवर पंजीकरण (बार काउंसिल, ICAI या ICSI)", "व्यावसायिक नोंदणी (बार कौन्सिल, ICAI किंवा ICSI)"),
};

export function mandatoryLicenceFor(shopType: string): MandatoryLicence | null {
  if (isFoodBusinessShopType(shopType)) return FSSAI;
  if (shopType === "PHARMACY") return DRUG;
  if (shopType === "DOCTOR_CLINIC" || shopType === "SUPER_SPECIALITY_CLINIC") return MEDICAL;
  if (shopType === "PROFESSIONAL_OFFICE") return PROFESSIONAL;
  return null;
}

/** The same words on the shop-type screen and in the e-mail. */
export function licenceGraceMessage(licence: string, graceDays: number): Text {
  return L(
    `${licence} is mandatory for this type of shop. Your shop can go live now, and you have a grace period of ${graceDays} days to upload it. Otherwise, your shop will be suspended.`,
    `इस प्रकार की दुकान के लिए ${licence} अनिवार्य है। आपकी दुकान अभी लाइव हो सकती है, और इसे अपलोड करने के लिए आपके पास ${graceDays} दिनों की छूट अवधि है। अन्यथा आपकी दुकान निलंबित कर दी जाएगी।`,
    `या प्रकारच्या दुकानासाठी ${licence} अनिवार्य आहे. तुमचे दुकान आता लाइव्ह होऊ शकते, आणि ते अपलोड करण्यासाठी तुमच्याकडे ${graceDays} दिवसांचा अवधी आहे. अन्यथा तुमचे दुकान निलंबित केले जाईल.`,
  );
}
