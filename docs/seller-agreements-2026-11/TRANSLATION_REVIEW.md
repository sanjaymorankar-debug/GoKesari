# Marathi and Hindi agreement drafts – points for the lawyer (26-Nov-2026)

The Marathi and Hindi versions of the Seller SLA v1.0 and the Medical Shop Onboarding Agreement v1.0 are
**machine-assisted drafts, status "Pending legal review"**. They are stored as DRAFT rows and cannot be
published until an admin marks them reviewed (Admin → Agreements). The English version prevails; every
translated copy says so at the top.

Mechanical check (both languages, both documents): every merge field, every HTML tag and attribute, and every
number in the English text are present unchanged. No Devanagari digits are used.

Files: `src/server/legal-agreements/templates/{seller-sla,medical-onboarding}/v1.0.{mr,hi}.html`.

## Marathi (मराठी)

Defined terms: Platform = प्लॅटफॉर्म; Seller = विक्रेता; Customer = ग्राहक; Merchant = व्यापारी; Company = कंपनी;
Agreement = करार; Party = पक्षकार; Order = ऑर्डर; Products = उत्पादने; Prescription Drugs = प्रिस्क्रिप्शन औषधे;
Prohibited Products = प्रतिबंधित उत्पादने; Effective Date = प्रभावी दिनांक; Annexure = परिशिष्ट; return = मालवापसी
(refund = परतावा); force majeure = अपरिहार्य परिस्थिती.

Please check:
1. Indemnity → क्षतिपूर्ती, "indemnify and keep indemnified" → "क्षतिपूर्ती करेल व सदैव क्षतिपूर्तित ठेवेल" (alternative: हानिरक्षा).
2. "permitted assigns" → अनुमत अभिहस्तांकिती; Assignment → अभिहस्तांकन.
3. Official Marathi titles of: Drugs and Magic Remedies (Objectionable Advertisements) Act, 1954 ("औषधे व चमत्कारिक उपाय (आक्षेपार्ह जाहिराती) अधिनियम"); NDPS Act, 1985 ("गुंगीकारक औषधिद्रव्ये व मनःप्रभावी पदार्थ अधिनियम"); Pharmacy Act, 1948 (फार्मसी अधिनियम); Legal Metrology Act (वैध मापनशास्त्र अधिनियम).
4. "seller of record" → अभिलेखातील विक्रेता; "intermediary" / "marketplace e-commerce entity" → मध्यस्थ / बाजारपेठ ई-कॉमर्स संस्था.
5. "of the FIRST / SECOND PART" → प्रथम / द्वितीय पक्षकार; "which expression shall, unless repugnant to the context, include…" → "ज्या संज्ञेत, संदर्भाशी विसंगत नसल्यास, … समावेश असेल".
6. "IN WITNESS WHEREOF" → याच्या साक्षीदाखल; "NOW, THEREFORE" → त्याअर्थी, आता.
7. "non-judicial stamp paper" → न्यायिकेतर मुद्रांक पत्र; "material breach" → महत्त्वपूर्ण उल्लंघन; "consequential loss" → परिणामस्वरूप नुकसान; "Governing law" → नियामक कायदा.
8. SLA 3.3 "the prescription's approval" (vague in English too) → "प्रिस्क्रिप्शनची मान्यता".
9. SLA 5: the English does not say whether "showing the order number" belongs to the tape, the sticker or both; the draft attaches it to the tamper-evident sticker.
10. Style: "section" and "clause" both → कलम; "Onboarding" → समावेशन (ऑनबोर्डिंग); app labels तयार (Ready), ऑनलाइन/ऑफलाइन; "M/s." → मे.

## Hindi (हिंदी)

Defined terms: Platform = प्लेटफ़ॉर्म; Seller = विक्रेता; Customer = ग्राहक; Merchant = व्यापारी; Company = कंपनी;
Agreement = करार; Effective Date = प्रभावी तिथि; Party = पक्षकार; Products = उत्पाद; Prescription Drugs = नुस्खे वाली औषधियाँ;
Prohibited Products = प्रतिषिद्ध उत्पाद; Order = ऑर्डर; Annexure = उपाबंध; licence = अनुज्ञप्ति; pharmacist = भेषजज्ञ;
indemnity = क्षतिपूर्ति; force majeure = अप्रत्याशित घटना.

Please check:
1. "Order" kept as ऑर्डर (not आदेश, which is used for a government order in medical 8.4).
2. "Prescription Drugs" → "नुस्खे वाली औषधियाँ" (alternative: पर्ची).
3. "seller of record" → "अभिलिखित विक्रेता".
4. SLA 8: "escalation ladder" → "उत्क्रमण सोपान", "miss" → "अपूर्ति", "breach" → "भंग" — plainer words may be preferred.
5. "debited" → "विकलित"; "deducted" → "काटे जाते हैं".
6. Agreement's own "section N" → "धारा N" (also means a section of an Act; "भाग"/"अनुच्छेद" may be better); "clause N" → "खंड N".
7. "expired" → "कालातीत"; "expiry date" → "अवसान (एक्सपायरी) तिथि".
8. "misbranded" → "मिथ्याछाप", "spurious" → "नकली", "adulterated" → "अपमिश्रित" — check against the official Hindi Drugs and Cosmetics Act.
9. Act names: Pharmacy Act → "भेषजी अधिनियम, 1948"; Drugs and Magic Remedies Act → "औषधि और चमत्कारिक उपचार (आक्षेपणीय विज्ञापन) अधिनियम, 1954"; Legal Metrology Act → "विधिक माप विज्ञान अधिनियम, 2009"; NDPS → "स्वापक औषधि और मनःप्रभावी पदार्थ अधिनियम, 1985".
10. Income-tax Act in SLA 9.3 cited without a year (as in English).
11. "BETWEEN" → "द्वारा और के बीच"; "of the FIRST PART" → "प्रथम पक्षकार".
12. Medical 12.2 "seat and venue" → "स्थान और आयोजन स्थल".
13. Sub-item letters (a)/(b)/(c) and recitals A./B./C. kept in Latin to match English cross-references (Hindi deeds usually use (क)/(ख)/(ग)).
14. SLA 8.1 "step 0" → "चरण 0" (the English ladder only lists steps 1–5).
15. App labels given as Hindi + English in brackets; "GoKesari Trusted Shop" kept in English.

## Also for the lawyer (English master)

- **Medical agreement clause 13 "Stamp duty"** says the agreement is executed on non-judicial stamp paper, while
  the platform accepts it electronically with an OTP (owner decision 26-Nov-2026: keep the text, flag it). The
  admin must confirm a lawyer has reviewed it before the medical agreement can be published, and must set who
  bears the stamp duty (rule `sellerAgreements.stampDutyBorneBy`).
- **Commission:** the Seller SLA says 2 %, the medical agreement 3 %. Publishing is blocked until the admin
  resolves this (see README, "Publishing checks"); the system never picks one.
- **Settlement days:** the SLA says 3 business days; the configured settlement hold is `settlement.holdDays`.
  Shown to the admin as a warning when they differ.
