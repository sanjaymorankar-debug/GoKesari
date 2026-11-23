"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { AddressForm } from "@/components/address-manager";
import { Alert, Button, Card, Field, inputClass } from "@/components/ui";
import { INDIAN_MOBILE_HINT, mobileFieldDigits, parseIndianMobile } from "@/lib/contact";
import { errorText } from "@/lib/board/error-text";
import { L, tr, type Lang, type Text } from "@/lib/board/i18n";

export type GenderValue = "MALE" | "FEMALE" | "OTHER";

const GENDER_OPTIONS: { value: GenderValue | ""; label: Text }[] = [
  { value: "FEMALE", label: L("Female", "महिला", "स्त्री") },
  { value: "MALE", label: L("Male", "पुरुष", "पुरुष") },
  { value: "OTHER", label: L("Other", "अन्य", "इतर") },
  { value: "", label: L("Prefer not to say", "नहीं बताना चाहते", "सांगायचे नाही") },
];

/** Module 6 (docs/hindi-marathi-2026-11): first-time set-up and the profile fields. */
const T = {
  saveFailed: L(
    "Could not save your details. Please try again.",
    "आपकी जानकारी सहेजी नहीं जा सकी। फिर कोशिश करें।",
    "तुमची माहिती जतन करता आली नाही. पुन्हा प्रयत्न करा.",
  ),
  fullName: L("Full name", "पूरा नाम", "पूर्ण नाव"),
  gender: L("Gender", "लिंग", "लिंग"),
  mobile: L("Mobile number", "मोबाइल नंबर", "मोबाइल नंबर"),
  mobilePlaceholder: L("10-digit mobile number", "10 अंकों का मोबाइल नंबर", "10 अंकी मोबाइल नंबर"),
  mobileHint: L(
    "Enter a 10-digit Indian mobile number starting with 6, 7, 8 or 9.",
    "6, 7, 8 या 9 से शुरू होने वाला 10 अंकों का भारतीय मोबाइल नंबर डालें।",
    "6, 7, 8 किंवा 9 ने सुरू होणारा 10 अंकी भारतीय मोबाइल नंबर टाका.",
  ),
  step: L("Step {n} of {total}", "चरण {n} / {total}", "पायरी {n} / {total}"),
  aboutYou: L("Tell us about you", "अपने बारे में बताएँ", "तुमच्याबद्दल सांगा"),
  aboutYouText: L(
    "Helps shops and delivery partners serve you. You can change these anytime in My Profile.",
    "इससे दुकानें और डिलीवरी पार्टनर आपकी बेहतर सेवा कर पाते हैं। इसे कभी भी मेरी प्रोफ़ाइल में बदल सकते हैं।",
    "यामुळे दुकाने आणि डिलिव्हरी पार्टनर तुमची चांगली सेवा करू शकतात. हे कधीही माझे प्रोफाइलमध्ये बदलू शकता.",
  ),
  email: L("Email", "ईमेल", "ईमेल"),
  setupMobileHint: L(
    "Needed before your first order — the delivery partner calls this number. You can also log in with it.",
    "पहले ऑर्डर से पहले ज़रूरी — डिलीवरी पार्टनर इसी नंबर पर फ़ोन करेगा। इससे लॉग इन भी कर सकते हैं।",
    "पहिल्या ऑर्डरपूर्वी आवश्यक — डिलिव्हरी पार्टनर याच नंबरवर फोन करेल. याने लॉग इनही करू शकता.",
  ),
  referralCode: L("Referral code", "रेफ़रल कोड", "रेफरल कोड"),
  referralOptional: L("Referral code (optional)", "रेफ़रल कोड (वैकल्पिक)", "रेफरल कोड (ऐच्छिक)"),
  referralRequiredHint: L(
    "Needed before your first order — from GoKesari, a GoKesari partner or a friend who invited you. No code? Leave it empty and ask us for one next.",
    "पहले ऑर्डर से पहले ज़रूरी — GoKesari, GoKesari पार्टनर या आपको बुलाने वाले दोस्त से मिला कोड। कोड नहीं है? खाली छोड़ें और अगले चरण में हमसे माँगें।",
    "पहिल्या ऑर्डरपूर्वी आवश्यक — GoKesari, GoKesari पार्टनर किंवा तुम्हाला बोलावणाऱ्या मित्राकडून मिळालेला कोड. कोड नाही? रिकामे ठेवा आणि पुढे आमच्याकडे मागा.",
  ),
  referralHint: L(
    "From GoKesari, a GoKesari partner or a friend who invited you.",
    "GoKesari, GoKesari पार्टनर या आपको बुलाने वाले दोस्त से मिला कोड।",
    "GoKesari, GoKesari पार्टनर किंवा तुम्हाला बोलावणाऱ्या मित्राकडून मिळालेला कोड.",
  ),
  referralInvalid: L("This referral code is not valid.", "यह रेफ़रल कोड सही नहीं है।", "हा रेफरल कोड योग्य नाही."),
  saving: L("Saving…", "सहेज रहे हैं…", "जतन करत आहे…"),
  saveContinue: L("Save and continue", "सहेजें और आगे बढ़ें", "जतन करा आणि पुढे जा"),
  fillLater: L("Fill in later", "बाद में भरें", "नंतर भरा"),
  deliveryAddress: L("Delivery address", "डिलीवरी का पता", "डिलिव्हरीचा पत्ता"),
  deliveryAddressText: L(
    "Pin the exact spot on the map or use your current location so the delivery partner finds you. You will be asked for an address at checkout if you skip this.",
    "नक्शे पर सही जगह लगाएँ या अपनी अभी की लोकेशन लें ताकि डिलीवरी पार्टनर आप तक पहुँचे। इसे छोड़ने पर ऑर्डर के समय पता पूछा जाएगा।",
    "नकाशावर नेमकी जागा दाखवा किंवा तुमचे सध्याचे ठिकाण वापरा, म्हणजे डिलिव्हरी पार्टनर तुमच्यापर्यंत पोहोचेल. हे वगळल्यास ऑर्डर देताना पत्ता विचारला जाईल.",
  ),
  numberFailed: L(
    "Could not save the number. Please try again.",
    "नंबर सहेजा नहीं जा सका। फिर कोशिश करें।",
    "नंबर जतन करता आला नाही. पुन्हा प्रयत्न करा.",
  ),
  addMobile: L("Add your mobile number", "अपना मोबाइल नंबर जोड़ें", "तुमचा मोबाइल नंबर जोडा"),
  addMobileText: L(
    "For faster login next time — and the delivery partner will need it when you order.",
    "अगली बार जल्दी लॉग इन के लिए — और ऑर्डर पर डिलीवरी पार्टनर को इसकी ज़रूरत होगी।",
    "पुढच्या वेळी लवकर लॉग इनसाठी — आणि ऑर्डर दिल्यावर डिलिव्हरी पार्टनरला याची गरज लागेल.",
  ),
  save: L("Save", "सहेजें", "जतन करा"),
  notNow: L("Not now", "अभी नहीं", "आता नको"),
} as const;

/** The mobile-number hint (lib/contact.ts) in the visitor's language. */
const mobileHintText = (lang: Lang) => (lang === "en" ? INDIAN_MOBILE_HINT : tr(T.mobileHint, lang));

async function patchProfile(body: Record<string, unknown>, lang: Lang = "en"): Promise<string | null> {
  const res = await fetch("/api/profile", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (res.ok) return null;
  const payload = await res.json().catch(() => null);
  return payload?.error?.message != null ? errorText(payload.error.message, lang, payload.error.code) : tr(T.saveFailed, lang);
}

/** Shared name / gender / mobile fields, used by first-time setup and My Profile. */
export function PersonalDetailsFields({
  name,
  setName,
  gender,
  setGender,
  mobile,
  setMobile,
  mobileHint,
  lang = "en",
}: {
  name: string;
  setName: (v: string) => void;
  gender: GenderValue | "";
  setGender: (v: GenderValue | "") => void;
  mobile?: string;
  setMobile?: (v: string) => void;
  mobileHint?: string;
  lang?: Lang;
}) {
  return (
    <>
      <Field label={tr(T.fullName, lang)}>
        <input className={inputClass} value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" maxLength={100} />
      </Field>
      <div>
        <span className="mb-1 block text-sm font-medium text-ink-700">{tr(T.gender, lang)}</span>
        <div className="flex flex-wrap gap-2" role="radiogroup" aria-label={tr(T.gender, lang)}>
          {GENDER_OPTIONS.map((opt) => (
            <button
              key={opt.label.en}
              type="button"
              role="radio"
              aria-checked={gender === opt.value}
              onClick={() => setGender(opt.value)}
              className={`rounded-lg border px-3 py-1.5 text-sm ${
                gender === opt.value ? "border-kesari-600 bg-kesari-50 font-medium text-kesari-700" : "border-cream-200 text-ink-700"
              }`}
            >
              {tr(opt.label, lang)}
            </button>
          ))}
        </div>
      </div>
      {setMobile ? (
        <Field label={tr(T.mobile, lang)} hint={mobileHint}>
          <div className="flex items-center gap-2">
            <span className="rounded-lg border border-cream-200 bg-cream-50 px-3 py-2 text-sm text-ink-600">+91</span>
            <input
              className={inputClass}
              value={mobile ?? ""}
              onChange={(e) => setMobile(mobileFieldDigits(e.target.value))}
              inputMode="numeric"
              autoComplete="tel-national"
              placeholder={tr(T.mobilePlaceholder, lang)}
              aria-label={tr(T.mobile, lang)}
            />
          </div>
        </Field>
      ) : null}
    </>
  );
}

/**
 * First sign-in: personal details, then a delivery address with its geo-tag.
 * Every field is optional and "Fill in later" skips the rest; the details form
 * comes back on the next sign-in until it has been saved once.
 */
export function ProfileSetupWizard({
  initial,
  hasDefaultAddress,
  referral = null,
  returnTo = "/",
  lang = "en",
}: {
  /** Module 6: the screen's language. */
  lang?: Lang;
  /** Where to go when done (D-23: the page the person was on). */
  returnTo?: string;
  initial: { name: string; gender: GenderValue | ""; mobile: string; email: string };
  hasDefaultAddress: boolean;
  /** Rule customerSignupReferral: ask a new customer for a referral code (prefilled from a /r/ link). */
  referral?: { prefill: string; required?: boolean } | null;
}) {
  const router = useRouter();
  const [step, setStep] = useState<"details" | "address">("details");
  const [name, setName] = useState(initial.name);
  const [gender, setGender] = useState<GenderValue | "">(initial.gender);
  const [mobile, setMobile] = useState(initial.mobile);
  const [referralCode, setReferralCode] = useState(referral?.prefill ?? "");
  const [referralError, setReferralError] = useState<string | null>(null);
  // Mandatory code (customerSignupReferral.required): without one, setup ends on My referral code.
  const [referralGiven, setReferralGiven] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const finish = () => {
    router.replace(returnTo);
    router.refresh();
  };
  const finishSetup = () => {
    if (!referral?.required || referralGiven) return finish();
    router.replace("/referral");
    router.refresh();
  };

  async function saveDetails(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    if (mobile && !parseIndianMobile(mobile).ok) return setError(mobileHintText(lang));
    setBusy(true);
    // The referral code is checked first, so a wrong one can be corrected here.
    if (referral && referralCode.trim()) {
      const res = await fetch("/api/me/signup-referral", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: referralCode }),
      });
      if (!res.ok) {
        const payload = await res.json().catch(() => null);
        setBusy(false);
        return setReferralError(
          payload?.error?.details?.fields?.referralCode ??
            (payload?.error?.message != null ? errorText(payload.error.message, lang, payload.error.code) : tr(T.referralInvalid, lang)),
        );
      }
      setReferralGiven(true);
    }
    const failure = await patchProfile({
      name: name.trim() || null,
      gender: gender || null,
      ...(mobile ? { mobile } : {}),
      markComplete: true,
    }, lang);
    setBusy(false);
    if (failure) return setError(failure);
    if (hasDefaultAddress) finishSetup();
    else setStep("address");
  }

  return (
    <Card className="p-6 sm:p-8" data-testid="profile-setup">
      <p className="text-xs font-semibold uppercase tracking-wide text-kesari-700">
        {tr(T.step, lang).replace("{n}", String(step === "details" ? 1 : 2)).replace("{total}", String(hasDefaultAddress ? 1 : 2))}
      </p>
      {step === "details" ? (
        <form onSubmit={saveDetails} className="mt-2 grid gap-4">
          <div>
            <h1 className="text-2xl font-semibold text-ink-900">{tr(T.aboutYou, lang)}</h1>
            <p className="mt-1 text-sm text-ink-500">
              {tr(T.aboutYouText, lang)}
            </p>
          </div>
          {error ? <Alert tone="danger">{error}</Alert> : null}
          <Field label={tr(T.email, lang)}>
            <input className={`${inputClass} bg-cream-50`} value={initial.email} readOnly aria-readonly />
          </Field>
          <PersonalDetailsFields
            name={name}
            setName={setName}
            gender={gender}
            setGender={setGender}
            mobile={mobile}
            setMobile={setMobile}
            mobileHint={tr(T.setupMobileHint, lang)}
            lang={lang}
          />
          {referral ? (
            <Field
              label={referral.required ? tr(T.referralCode, lang) : tr(T.referralOptional, lang)}
              hint={referral.required ? tr(T.referralRequiredHint, lang) : tr(T.referralHint, lang)}
              error={referralError ?? undefined}
            >
              <input
                className={inputClass}
                name="referralCode"
                value={referralCode}
                autoCapitalize="characters"
                autoComplete="off"
                maxLength={40}
                onChange={(e) => {
                  setReferralCode(e.target.value.toUpperCase());
                  setReferralError(null);
                }}
                data-testid="signup-referral-code"
              />
            </Field>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button type="submit" disabled={busy}>
              {busy ? tr(T.saving, lang) : tr(T.saveContinue, lang)}
            </Button>
            <Button type="button" variant="secondary" onClick={finish} disabled={busy}>
              {tr(T.fillLater, lang)}
            </Button>
          </div>
        </form>
      ) : (
        <div className="mt-2 grid gap-4">
          <div>
            <h1 className="text-2xl font-semibold text-ink-900">{tr(T.deliveryAddress, lang)}</h1>
            <p className="mt-1 text-sm text-ink-500">
              {tr(T.deliveryAddressText, lang)}
            </p>
          </div>
          <AddressForm defaultIsDefault cancelLabel={tr(T.fillLater, lang)} onSaved={finishSetup} onCancel={finishSetup} lang={lang} />
        </div>
      )}
    </Card>
  );
}

/** After an email sign-in with no mobile on file. "Not now" brings it back on the next sign-in. */
export function MobilePromptDialog({ returnTo = "/", lang = "en" }: { returnTo?: string; lang?: Lang } = {}) {
  const router = useRouter();
  const [mobile, setMobile] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const close = () => {
    router.replace(returnTo);
    router.refresh();
  };

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    if (!parseIndianMobile(mobile).ok) return setError(mobileHintText(lang));
    setBusy(true);
    const res = await fetch("/api/me/phone", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mobile }),
    });
    setBusy(false);
    if (!res.ok) {
      const payload = await res.json().catch(() => null);
      return setError(payload?.error?.message != null ? errorText(payload.error.message, lang, payload.error.code) : tr(T.numberFailed, lang));
    }
    close();
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink-900/40 p-4" role="dialog" aria-modal="true" aria-labelledby="mobile-prompt-title">
      <Card className="w-full max-w-sm p-6" data-testid="mobile-prompt">
        <h2 id="mobile-prompt-title" className="text-lg font-semibold text-ink-900">
          {tr(T.addMobile, lang)}
        </h2>
        <p className="mt-1 text-sm text-ink-500">
          {tr(T.addMobileText, lang)}
        </p>
        <form onSubmit={save} className="mt-4 grid gap-3">
          {error ? <Alert tone="danger">{error}</Alert> : null}
          <div className="flex items-center gap-2">
            <span className="rounded-lg border border-cream-200 bg-cream-50 px-3 py-2 text-sm text-ink-600">+91</span>
            <input
              className={inputClass}
              value={mobile}
              onChange={(e) => setMobile(mobileFieldDigits(e.target.value))}
              inputMode="numeric"
              autoComplete="tel-national"
              placeholder={tr(T.mobilePlaceholder, lang)}
              aria-label={tr(T.mobile, lang)}
              autoFocus
            />
          </div>
          <div className="flex gap-2">
            <Button type="submit" disabled={busy}>
              {busy ? tr(T.saving, lang) : tr(T.save, lang)}
            </Button>
            <Button type="button" variant="secondary" onClick={close} disabled={busy}>
              {tr(T.notNow, lang)}
            </Button>
          </div>
        </form>
      </Card>
    </div>
  );
}
