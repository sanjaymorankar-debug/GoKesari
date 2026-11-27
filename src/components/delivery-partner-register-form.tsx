"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Alert, Button, Card, Field, inputClass } from "@/components/ui";
import { errorText } from "@/lib/board/error-text";
import { L, tr, type Lang, type Text } from "@/lib/board/i18n";
import { REGISTRATION_MESSAGES, RIDER_GENDERS, VEHICLES_WITHOUT_NUMBER } from "@/lib/gig/registration";
import { VEHICLE_TYPES, vehicleTypeText } from "@/lib/vehicle-types";

const T = {
  referralCode: L("Referral code (optional)", "रेफ़रल कोड (वैकल्पिक)", "रेफरल कोड (ऐच्छिक)"),
  referralHint: L(
    "From a GoKesari rider who invited you, e.g. GKR4K7P2Q.",
    "आपको बुलाने वाले GoKesari राइडर से, जैसे GKR4K7P2Q।",
    "तुम्हाला बोलावणाऱ्या GoKesari रायडरकडून, उदा. GKR4K7P2Q.",
  ),
  locationBlocked: L(
    "Location access is blocked. Allow location for GoKesari in your browser or phone settings, then tap \"Share my location\" again. Registration can't be completed without it.",
    "लोकेशन की अनुमति बंद है। ब्राउज़र या फ़ोन की सेटिंग में GoKesari के लिए लोकेशन चालू करें, फिर \"मेरी लोकेशन साझा करें\" दोबारा दबाएँ। इसके बिना पंजीकरण पूरा नहीं होगा।",
    "लोकेशनची परवानगी बंद आहे. ब्राउझर किंवा फोनच्या सेटिंगमध्ये GoKesari साठी लोकेशन सुरू करा, मग \"माझे लोकेशन शेअर करा\" पुन्हा दाबा. त्याशिवाय नोंदणी पूर्ण होणार नाही.",
  ),
  locationSlow: L(
    "Finding your location took too long. Move to an open spot and try again.",
    "लोकेशन ढूँढने में बहुत देर लगी। खुली जगह पर जाकर फिर कोशिश करें।",
    "लोकेशन शोधायला खूप वेळ लागला. मोकळ्या जागी जाऊन पुन्हा प्रयत्न करा.",
  ),
  locationUnread: L(
    "We couldn't read your location. Turn on location (GPS) and try again.",
    "आपकी लोकेशन नहीं मिल सकी। लोकेशन (GPS) चालू करके फिर कोशिश करें।",
    "तुमचे लोकेशन मिळाले नाही. लोकेशन (GPS) सुरू करून पुन्हा प्रयत्न करा.",
  ),
  noGeo: L(
    "This browser can't share a location. Open GoKesari in the app or in Chrome / Safari.",
    "यह ब्राउज़र लोकेशन साझा नहीं कर सकता। GoKesari ऐप में या Chrome / Safari में खोलें।",
    "हा ब्राउझर लोकेशन शेअर करू शकत नाही. GoKesari ॲपमध्ये किंवा Chrome / Safari मध्ये उघडा.",
  ),
  submitFailed: L("Could not submit your application.", "आपका आवेदन जमा नहीं हो सका।", "तुमचा अर्ज जमा करता आला नाही."),
  personal: L("Personal details", "निजी जानकारी", "वैयक्तिक माहिती"),
  fullName: L("Full name", "पूरा नाम", "पूर्ण नाव"),
  mobile: L("Mobile number", "मोबाइल नंबर", "मोबाइल नंबर"),
  mobileHint: L("10-digit Indian mobile number", "10 अंकों का भारतीय मोबाइल नंबर", "10 अंकी भारतीय मोबाइल नंबर"),
  email: L("Email", "ईमेल", "ईमेल"),
  dob: L("Date of birth", "जन्म तिथि", "जन्मतारीख"),
  dobHint: L("You must be 18 or older", "आपकी उम्र 18 साल या उससे ज़्यादा होनी चाहिए", "तुमचे वय 18 किंवा त्याहून जास्त असावे"),
  gender: L("Gender", "लिंग", "लिंग"),
  select: L("Select", "चुनें", "निवडा"),
  address: L("Address", "पता", "पत्ता"),
  addressLine: L("House, street and area", "मकान, गली और इलाका", "घर, रस्ता आणि परिसर"),
  city: L("City", "शहर", "शहर"),
  pin: L("PIN code", "पिन कोड", "पिन कोड"),
  vehicle: L("Vehicle", "वाहन", "वाहन"),
  vehicleType: L("Vehicle type", "वाहन का प्रकार", "वाहनाचा प्रकार"),
  selectVehicle: L("Select a vehicle type", "वाहन का प्रकार चुनें", "वाहनाचा प्रकार निवडा"),
  regNumber: L("Vehicle registration number", "वाहन रजिस्ट्रेशन नंबर", "वाहन नोंदणी क्रमांक"),
  regNumberOptional: L("Vehicle registration number (if any)", "वाहन रजिस्ट्रेशन नंबर (अगर हो)", "वाहन नोंदणी क्रमांक (असल्यास)"),
  regHint: L("e.g. MH12 AB 1234", "जैसे MH12 AB 1234", "उदा. MH12 AB 1234"),
  licence: L("Driving licence number (optional)", "ड्राइविंग लाइसेंस नंबर (वैकल्पिक)", "ड्रायव्हिंग लायसन्स क्रमांक (ऐच्छिक)"),
  emergency: L("Emergency contact", "आपातकालीन संपर्क", "आपत्कालीन संपर्क"),
  name: L("Name", "नाम", "नाव"),
  relation: L("Relation (optional)", "रिश्ता (वैकल्पिक)", "नाते (ऐच्छिक)"),
  relationHint: L("e.g. Father, Spouse", "जैसे पिता, पति/पत्नी", "उदा. वडील, पती/पत्नी"),
  bank: L(
    "Bank details (optional — can be added later)",
    "बैंक विवरण (वैकल्पिक — बाद में भी जोड़ सकते हैं)",
    "बँक तपशील (ऐच्छिक — नंतरही जोडता येईल)",
  ),
  holder: L("Account holder name", "खाताधारक का नाम", "खातेदाराचे नाव"),
  account: L("Account number", "खाता नंबर", "खाते क्रमांक"),
  yourLocation: L("Your location", "आपकी लोकेशन", "तुमचे लोकेशन"),
  locationWhy: L(
    "GoKesari needs your current location to finish registration and to find deliveries near you. Your phone or browser will ask for permission.",
    "पंजीकरण पूरा करने और आपके पास की डिलीवरी ढूँढने के लिए GoKesari को आपकी मौजूदा लोकेशन चाहिए। आपका फ़ोन या ब्राउज़र अनुमति माँगेगा।",
    "नोंदणी पूर्ण करण्यासाठी आणि तुमच्या जवळच्या डिलिव्हऱ्या शोधण्यासाठी GoKesari ला तुमचे सध्याचे लोकेशन हवे आहे. तुमचा फोन किंवा ब्राउझर परवानगी मागेल.",
  ),
  finding: L("Finding your location…", "आपकी लोकेशन ढूँढ रहे हैं…", "तुमचे लोकेशन शोधत आहोत…"),
  shareAgain: L("Share again", "फिर से साझा करें", "पुन्हा शेअर करा"),
  share: L("Share my location", "मेरी लोकेशन साझा करें", "माझे लोकेशन शेअर करा"),
  shared: L("Location shared", "लोकेशन साझा हुई", "लोकेशन शेअर झाले"),
  within: L(", within about {m} m", ", लगभग {m} m के अंदर", ", सुमारे {m} m च्या आत"),
  radius: L("Preferred operating radius (km)", "पसंदीदा काम का दायरा (km)", "पसंतीचा कामाचा परिघ (km)"),
  submitting: L("Submitting…", "जमा हो रहा है…", "जमा होत आहे…"),
  submit: L("Submit and continue to KYC", "जमा करें और KYC पर आगे बढ़ें", "जमा करा आणि KYC कडे पुढे जा"),
  shareToContinue: L("Share your location to continue", "आगे बढ़ने के लिए अपनी लोकेशन साझा करें", "पुढे जाण्यासाठी तुमचे लोकेशन शेअर करा"),
  // docs/flows-v3/wave5.md (flag flow_f11)
  photo: L("Your photo", "आपकी फ़ोटो", "तुमचा फोटो"),
  photoHint: L("A clear photo of your face. It goes on your rider ID card.", "आपके चेहरे की साफ़ फ़ोटो। यह आपके राइडर ID कार्ड पर आती है।", "तुमच्या चेहऱ्याचा स्पष्ट फोटो. तो तुमच्या रायडर ID कार्डवर येतो."),
  photoAdded: L("Photo added", "फ़ोटो जुड़ गई", "फोटो जोडला"),
  uploading: L("Uploading…", "अपलोड हो रहा है…", "अपलोड होत आहे…"),
  mobileFromAccount: L("Your account's verified mobile", "आपके खाते का सत्यापित मोबाइल", "तुमच्या खात्याचा पडताळलेला मोबाइल"),
  emailFromAccount: L("Your account's verified e-mail", "आपके खाते का सत्यापित ई-मेल", "तुमच्या खात्याचा पडताळलेला ई-मेल"),
  sendCode: L("Send code by SMS", "SMS से कोड भेजें", "SMS ने कोड पाठवा"),
  codeLabel: L("Code from the SMS", "SMS का कोड", "SMS मधील कोड"),
  verify: L("Verify", "सत्यापित करें", "पडताळा"),
  verifyEmailFirst: L("Verify your e-mail first", "पहले अपना ई-मेल सत्यापित करें", "आधी तुमचा ई-मेल पडताळा"),
} as const;

const GENDER_TEXT: Record<string, Text> = {
  FEMALE: L("Female", "महिला", "स्त्री"),
  MALE: L("Male", "पुरुष", "पुरुष"),
  OTHER: L("Other", "अन्य", "इतर"),
  PREFER_NOT_TO_SAY: L("Prefer not to say", "बताना नहीं चाहते", "सांगू इच्छित नाही"),
};

/** The form's own field messages (lib/gig/registration.ts), by their English wording. */
const FIELD_MESSAGE_TEXT: Record<string, Text> = {
  [REGISTRATION_MESSAGES.mobile]: L(REGISTRATION_MESSAGES.mobile, "सही 10 अंकों का भारतीय मोबाइल नंबर डालें।", "योग्य 10 अंकी भारतीय मोबाइल नंबर टाका."),
  [REGISTRATION_MESSAGES.email]: L(REGISTRATION_MESSAGES.email, "सही ईमेल पता डालें।", "योग्य ईमेल पत्ता टाका."),
  [REGISTRATION_MESSAGES.dateOfBirth]: L(REGISTRATION_MESSAGES.dateOfBirth, "अपनी जन्म तिथि डालें।", "तुमची जन्मतारीख टाका."),
  [REGISTRATION_MESSAGES.underAge]: L(
    REGISTRATION_MESSAGES.underAge,
    "GoKesari के साथ डिलीवरी के लिए आपकी उम्र कम से कम 18 साल होनी चाहिए।",
    "GoKesari सोबत डिलिव्हरी करण्यासाठी तुमचे वय किमान 18 वर्षे असावे.",
  ),
  [REGISTRATION_MESSAGES.futureDate]: L(REGISTRATION_MESSAGES.futureDate, "जन्म तिथि भविष्य की नहीं हो सकती।", "जन्मतारीख भविष्यातील असू शकत नाही."),
  [REGISTRATION_MESSAGES.gender]: L(REGISTRATION_MESSAGES.gender, "अपना लिंग चुनें।", "तुमचे लिंग निवडा."),
  [REGISTRATION_MESSAGES.addressLine]: L(REGISTRATION_MESSAGES.addressLine, "अपना मकान, गली और इलाका डालें।", "तुमचे घर, रस्ता आणि परिसर टाका."),
  [REGISTRATION_MESSAGES.addressCity]: L(REGISTRATION_MESSAGES.addressCity, "अपना शहर डालें।", "तुमचे शहर टाका."),
  [REGISTRATION_MESSAGES.addressPincode]: L(REGISTRATION_MESSAGES.addressPincode, "अपना 6 अंकों का पिन कोड डालें।", "तुमचा 6 अंकी पिन कोड टाका."),
  [REGISTRATION_MESSAGES.vehicleNumber]: L(REGISTRATION_MESSAGES.vehicleNumber, "अपने वाहन का रजिस्ट्रेशन नंबर डालें।", "तुमच्या वाहनाचा नोंदणी क्रमांक टाका."),
  [REGISTRATION_MESSAGES.emergencyName]: L(
    REGISTRATION_MESSAGES.emergencyName,
    "किसी ऐसे व्यक्ति का नाम डालें जिसे आपात स्थिति में हम फ़ोन कर सकें।",
    "आपत्कालीन वेळी आम्ही फोन करू शकू अशा व्यक्तीचे नाव टाका.",
  ),
  [REGISTRATION_MESSAGES.emergencyMobile]: L(
    REGISTRATION_MESSAGES.emergencyMobile,
    "आपातकालीन संपर्क का 10 अंकों का मोबाइल नंबर डालें।",
    "आपत्कालीन संपर्काचा 10 अंकी मोबाइल नंबर टाका.",
  ),
  [REGISTRATION_MESSAGES.emergencySame]: L(
    REGISTRATION_MESSAGES.emergencySame,
    "आपातकालीन संपर्क का मोबाइल नंबर आपके नंबर से अलग होना चाहिए।",
    "आपत्कालीन संपर्काचा मोबाइल नंबर तुमच्या नंबरपेक्षा वेगळा असावा.",
  ),
  [REGISTRATION_MESSAGES.location]: L(
    REGISTRATION_MESSAGES.location,
    "पंजीकरण पूरा करने के लिए अपनी मौजूदा लोकेशन साझा करें। GoKesari को लोकेशन की अनुमति दें, फिर \"मेरी लोकेशन साझा करें\" दबाएँ।",
    "नोंदणी पूर्ण करण्यासाठी तुमचे सध्याचे लोकेशन शेअर करा. GoKesari ला लोकेशनची परवानगी द्या, मग \"माझे लोकेशन शेअर करा\" दाबा.",
  ),
  [REGISTRATION_MESSAGES.duplicateMobile]: L(
    REGISTRATION_MESSAGES.duplicateMobile,
    "इस मोबाइल नंबर से एक डिलीवरी पार्टनर पहले से पंजीकृत है। उस खाते से साइन इन करें, या दूसरा नंबर इस्तेमाल करें।",
    "या मोबाइल नंबरने एक डिलिव्हरी पार्टनर आधीच नोंदणीकृत आहे. त्या खात्याने साइन इन करा, किंवा दुसरा नंबर वापरा.",
  ),
};

/** A field or form message in the partner's language; unknown wording stays as received. */
function messageText(message: string | undefined, lang: Lang): string | undefined {
  if (message === undefined || lang === "en") return message;
  const known = FIELD_MESSAGE_TEXT[message];
  return known ? tr(known, lang) : errorText(message, lang);
}

type LocationState =
  | { kind: "none" }
  | { kind: "asking" }
  | { kind: "shared"; latitude: number; longitude: number; accuracyM: number | null }
  | { kind: "denied"; message: string };

/** Why the browser or phone gave no position, in words the partner can act on. */
function locationErrorMessage(error: GeolocationPositionError | null, lang: Lang = "en"): string {
  if (error?.code === 1) {
    return tr(T.locationBlocked, lang);
  }
  if (error?.code === 3) return tr(T.locationSlow, lang);
  return tr(T.locationUnread, lang);
}

/**
 * Gig worker flow, features 1 and 4: personal details, address, vehicle and
 * emergency contact, and the device's current location — the form can't be
 * submitted until location is shared. PAN and Aadhaar are verified on the
 * next step (/delivery-partner/kyc), never typed here.
 */
export function DeliveryPartnerRegisterForm({
  lang = "en",
  referral,
  account,
}: {
  lang?: Lang;
  /** Rider App v2 (rule riderReferral on): show the optional referral code, prefilled from ?ref=. */
  referral?: { code: string };
  /**
   * docs/flows-v3/wave5.md (flag flow_f11 on): the account's verified mobile (10 digits) and e-mail. The form then
   * uses them (locked), verifies the mobile by SMS code when the account has none, and asks for a photo.
   */
  account?: { verifiedMobile: string | null; verifiedEmail: string | null };
} = {}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [vehicleType, setVehicleType] = useState("");
  const [location, setLocation] = useState<LocationState>({ kind: "none" });
  // docs/flows-v3/wave5.md (flag flow_f11)
  const [verifiedMobile, setVerifiedMobile] = useState<string | null>(account?.verifiedMobile ?? null);
  const [mobileDraft, setMobileDraft] = useState("");
  const [mobileCodeSent, setMobileCodeSent] = useState(false);
  const [mobileCode, setMobileCode] = useState("");
  const [photoUrl, setPhotoUrl] = useState<string | null>(null);
  const [photoBusy, setPhotoBusy] = useState(false);

  async function dualVerify(body: Record<string, unknown>): Promise<boolean> {
    setError(null);
    const response = await fetch("/api/dual-auth/verify", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      setError(payload?.error?.message ? errorText(payload.error.message, lang, payload?.error?.code) : tr(T.submitFailed, lang));
      return false;
    }
    return true;
  }

  async function uploadPhoto(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    setPhotoBusy(true);
    setError(null);
    const data = new FormData();
    data.set("file", file);
    data.set("purpose", "PROFILE_PHOTO");
    const response = await fetch("/api/images", { method: "POST", body: data });
    const payload = await response.json().catch(() => null);
    setPhotoBusy(false);
    if (!response.ok) return setError(payload?.error?.message ?? tr(T.submitFailed, lang));
    setPhotoUrl(String(payload.url));
  }

  function shareLocation() {
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      setLocation({ kind: "denied", message: tr(T.noGeo, lang) });
      return;
    }
    setLocation({ kind: "asking" });
    navigator.geolocation.getCurrentPosition(
      (position) =>
        setLocation({
          kind: "shared",
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
          accuracyM: Number.isFinite(position.coords.accuracy) ? Math.round(position.coords.accuracy) : null,
        }),
      (geoError) => setLocation({ kind: "denied", message: locationErrorMessage(geoError, lang) }),
      { enableHighAccuracy: true, timeout: 20_000, maximumAge: 0 },
    );
  }

  // A submit handler, not <form action>: React resets a form after its action runs, which would
  // wipe everything the partner typed whenever the server refuses a field.
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    setError(null);
    setFieldErrors({});
    if (location.kind !== "shared") {
      setError(messageText(REGISTRATION_MESSAGES.location, lang) ?? REGISTRATION_MESSAGES.location);
      setFieldErrors({ location: REGISTRATION_MESSAGES.location });
      return;
    }
    setBusy(true);

    const get = (key: string) => String(formData.get(key) ?? "").trim();
    const radius = get("operatingRadiusKm");

    const response = await fetch("/api/delivery-partner", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        fullName: get("fullName"),
        mobile: account ? (verifiedMobile ?? "") : get("mobile"),
        email: account ? account.verifiedEmail : get("email") || null,
        ...(account ? { profilePhotoUrl: photoUrl } : {}),
        dateOfBirth: get("dateOfBirth") || null,
        gender: get("gender") || null,
        addressLine: get("addressLine") || null,
        addressCity: get("addressCity") || null,
        addressPincode: get("addressPincode") || null,
        emergencyContactName: get("emergencyContactName") || null,
        emergencyContactMobile: get("emergencyContactMobile") || null,
        emergencyContactRelation: get("emergencyContactRelation") || null,
        bankAccountHolderName: get("bankAccountHolderName") || null,
        bankAccountNumber: get("bankAccountNumber") || null,
        bankIfsc: get("bankIfsc") || null,
        vehicleType: get("vehicleType"),
        vehicleRegistrationNumber: get("vehicleRegistrationNumber") || null,
        drivingLicenceNumber: get("drivingLicenceNumber") || null,
        latitude: location.latitude,
        longitude: location.longitude,
        operatingRadiusKm: radius ? Number(radius) : undefined,
        ...(referral ? { referralCode: get("referralCode") || null } : {}),
      }),
    });

    const payload = await response.json().catch(() => null);
    setBusy(false);

    if (!response.ok) {
      const fields = payload?.error?.details?.fields;
      if (fields && typeof fields === "object") setFieldErrors(fields);
      setError(
        payload?.error?.message
          ? errorText(messageText(payload.error.message, lang), lang, payload?.error?.code)
          : tr(T.submitFailed, lang),
      );
      return;
    }
    // Next step: PAN and Aadhaar verification.
    router.push("/delivery-partner/kyc");
    router.refresh();
  }

  const needsNumber = vehicleType !== "" && !VEHICLES_WITHOUT_NUMBER.includes(vehicleType);
  const t = (text: Text) => tr(text, lang);
  const fe = (key: string) => messageText(fieldErrors[key], lang);

  return (
    <Card className="p-6">
      <form onSubmit={submit} className="grid gap-4 sm:grid-cols-2" noValidate>
        <div className="sm:col-span-2">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-500">{t(T.personal)}</h2>
        </div>

        <Field label={t(T.fullName)} error={fe("fullName")}>
          <input name="fullName" required autoComplete="name" className={inputClass} />
        </Field>
        {account ? (
          <Field label={t(T.mobileFromAccount)} error={fe("mobile")}>
            {verifiedMobile ? (
              <input value={verifiedMobile} readOnly aria-readonly className={`${inputClass} bg-cream-50`} data-testid="rider-mobile-locked" />
            ) : (
              <div className="grid gap-2">
                <div className="flex gap-2">
                  <input
                    value={mobileDraft}
                    onChange={(e) => setMobileDraft(e.target.value.replace(/\D/g, "").slice(0, 10))}
                    inputMode="numeric"
                    autoComplete="tel-national"
                    maxLength={10}
                    className={inputClass}
                    aria-label={t(T.mobile)}
                  />
                  <Button
                    type="button"
                    variant="secondary"
                    disabled={!/^[6-9]\d{9}$/.test(mobileDraft)}
                    onClick={async () => setMobileCodeSent(await dualVerify({ action: "mobile-code", mobile: mobileDraft }))}
                  >
                    {t(T.sendCode)}
                  </Button>
                </div>
                {mobileCodeSent ? (
                  <div className="flex gap-2">
                    <input
                      value={mobileCode}
                      onChange={(e) => setMobileCode(e.target.value.replace(/\D/g, "").slice(0, 8))}
                      inputMode="numeric"
                      autoComplete="one-time-code"
                      className={inputClass}
                      aria-label={t(T.codeLabel)}
                      placeholder={t(T.codeLabel)}
                    />
                    <Button
                      type="button"
                      disabled={!mobileCode}
                      onClick={async () => {
                        if (await dualVerify({ action: "mobile-verify", mobile: mobileDraft, code: mobileCode })) setVerifiedMobile(mobileDraft);
                      }}
                    >
                      {t(T.verify)}
                    </Button>
                  </div>
                ) : null}
              </div>
            )}
          </Field>
        ) : (
          <Field label={t(T.mobile)} hint={t(T.mobileHint)} error={fe("mobile")}>
            <input name="mobile" required inputMode="numeric" autoComplete="tel-national" pattern="[6-9][0-9]{9}" maxLength={10} className={inputClass} />
          </Field>
        )}
        {account ? (
          <Field label={t(T.emailFromAccount)} error={fe("email")}>
            {account.verifiedEmail ? (
              <input value={account.verifiedEmail} readOnly aria-readonly className={`${inputClass} bg-cream-50`} data-testid="rider-email-locked" />
            ) : (
              <a href="/account/verify?return=/delivery-partner/register" className="text-sm text-kesari-700 underline">
                {t(T.verifyEmailFirst)}
              </a>
            )}
          </Field>
        ) : (
          <Field label={t(T.email)} error={fe("email")}>
            <input name="email" type="email" required autoComplete="email" className={inputClass} />
          </Field>
        )}
        {account ? (
          <Field label={t(T.photo)} hint={photoUrl ? t(T.photoAdded) : t(T.photoHint)} error={fe("profilePhotoUrl")}>
            <input type="file" accept="image/jpeg,image/png,image/webp" capture="user" onChange={uploadPhoto} disabled={photoBusy} className="block w-full text-sm" data-testid="rider-photo-file" />
          </Field>
        ) : null}
        <Field label={t(T.dob)} hint={t(T.dobHint)} error={fe("dateOfBirth")}>
          <input name="dateOfBirth" type="date" required autoComplete="bday" className={inputClass} />
        </Field>
        <Field label={t(T.gender)} error={fe("gender")}>
          <select name="gender" required defaultValue="" className={inputClass}>
            <option value="" disabled>
              {t(T.select)}
            </option>
            {RIDER_GENDERS.map((g) => (
              <option key={g.key} value={g.key}>
                {lang === "en" ? g.label : t(GENDER_TEXT[g.key] ?? L(g.label, g.label, g.label))}
              </option>
            ))}
          </select>
        </Field>
        <div />

        <div className="sm:col-span-2 border-t border-cream-200 pt-4">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-500">{t(T.address)}</h2>
        </div>
        <div className="sm:col-span-2">
          <Field label={t(T.addressLine)} error={fe("addressLine")}>
            <input name="addressLine" required autoComplete="street-address" className={inputClass} />
          </Field>
        </div>
        <Field label={t(T.city)} error={fe("addressCity")}>
          <input name="addressCity" required autoComplete="address-level2" className={inputClass} />
        </Field>
        <Field label={t(T.pin)} error={fe("addressPincode")}>
          <input name="addressPincode" required inputMode="numeric" autoComplete="postal-code" maxLength={6} className={inputClass} />
        </Field>

        <div className="sm:col-span-2 border-t border-cream-200 pt-4">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-500">{t(T.vehicle)}</h2>
        </div>
        <Field label={t(T.vehicleType)} error={fe("vehicleType")}>
          <select name="vehicleType" required value={vehicleType} onChange={(e) => setVehicleType(e.target.value)} className={inputClass}>
            <option value="" disabled>
              {t(T.selectVehicle)}
            </option>
            {VEHICLE_TYPES.map((v) => (
              <option key={v.key} value={v.key}>
                {lang === "en" ? v.label : vehicleTypeText(v.key, lang)}
              </option>
            ))}
          </select>
        </Field>
        <Field
          label={needsNumber ? t(T.regNumber) : t(T.regNumberOptional)}
          hint={t(T.regHint)}
          error={fe("vehicleRegistrationNumber")}
        >
          <input name="vehicleRegistrationNumber" required={needsNumber} autoCapitalize="characters" className={inputClass} />
        </Field>
        <Field label={t(T.licence)}>
          <input name="drivingLicenceNumber" className={inputClass} />
        </Field>
        <div />

        <div className="sm:col-span-2 border-t border-cream-200 pt-4">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-500">{t(T.emergency)}</h2>
        </div>
        <Field label={t(T.name)} error={fe("emergencyContactName")}>
          <input name="emergencyContactName" required className={inputClass} />
        </Field>
        <Field label={t(T.mobile)} error={fe("emergencyContactMobile")}>
          <input name="emergencyContactMobile" required inputMode="numeric" maxLength={10} className={inputClass} />
        </Field>
        <Field label={t(T.relation)} hint={t(T.relationHint)}>
          <input name="emergencyContactRelation" className={inputClass} />
        </Field>
        <div />

        <div className="sm:col-span-2 border-t border-cream-200 pt-4">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-500">{t(T.bank)}</h2>
        </div>
        <Field label={t(T.holder)}>
          <input name="bankAccountHolderName" className={inputClass} />
        </Field>
        <Field label={t(T.account)} error={fe("bankAccountNumber")}>
          <input name="bankAccountNumber" inputMode="numeric" className={inputClass} />
        </Field>
        <Field label="IFSC" error={fe("bankIfsc")}>
          <input name="bankIfsc" autoCapitalize="characters" className={inputClass} />
        </Field>
        <div />

        <div className="sm:col-span-2 border-t border-cream-200 pt-4">
          <h2 className="mb-1 text-sm font-semibold uppercase tracking-wide text-ink-500">{t(T.yourLocation)}</h2>
          <p className="mb-3 text-sm text-ink-500">{t(T.locationWhy)}</p>
          <Button type="button" variant="secondary" onClick={shareLocation} disabled={location.kind === "asking"}>
            {location.kind === "asking" ? t(T.finding) : location.kind === "shared" ? t(T.shareAgain) : t(T.share)}
          </Button>
          {location.kind === "shared" ? (
            <p className="mt-2 text-sm text-leaf-700" data-testid="location-shared">
              {t(T.shared)} ({location.latitude.toFixed(5)}, {location.longitude.toFixed(5)}
              {location.accuracyM != null ? t(T.within).replace("{m}", String(location.accuracyM)) : ""}).
            </p>
          ) : null}
          {location.kind === "denied" ? (
            <div className="mt-2">
              <Alert tone="danger">{location.message}</Alert>
            </div>
          ) : null}
          {fieldErrors.location && location.kind !== "denied" && location.kind !== "shared" ? (
            <p className="mt-2 text-sm text-red-700">{fe("location")}</p>
          ) : null}
        </div>

        <Field label={t(T.radius)}>
          <input name="operatingRadiusKm" type="number" min={1} max={50} defaultValue={5} className={inputClass} />
        </Field>

        {referral ? (
          <Field label={t(T.referralCode)} hint={t(T.referralHint)} error={fe("referralCode")}>
            <input
              name="referralCode"
              defaultValue={referral.code}
              autoCapitalize="characters"
              autoComplete="off"
              maxLength={20}
              className={inputClass}
              data-testid="rider-referral-code-input"
            />
          </Field>
        ) : null}

        {error ? (
          <div className="sm:col-span-2">
            <Alert tone="danger">{error}</Alert>
          </div>
        ) : null}

        <div className="sm:col-span-2">
          <Button
            type="submit"
            size="lg"
            disabled={busy || location.kind !== "shared" || (account !== undefined && (!photoUrl || !verifiedMobile || !account.verifiedEmail || photoBusy))}
            className="w-full"
          >
            {busy ? t(T.submitting) : location.kind === "shared" ? t(T.submit) : t(T.shareToContinue)}
          </Button>
        </div>
      </form>
    </Card>
  );
}
