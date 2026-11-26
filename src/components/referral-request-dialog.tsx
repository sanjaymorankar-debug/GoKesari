"use client";

import { useEffect, useState } from "react";

import { Alert, Button, Field, inputClass } from "@/components/ui";
import { checkReferralRequest } from "@/lib/referral-requests";
import { useShopTypes } from "@/components/use-shop-types";
import { errorText } from "@/lib/board/error-text";
import { L, tr, type Lang } from "@/lib/board/i18n";

/** Module 6 (docs/hindi-marathi-2026-11): the referral-code request wording. */
const T = {
  sendFailed: L("Could not send the request.", "अनुरोध नहीं भेजा जा सका।", "विनंती पाठवता आली नाही."),
  title: L("Request a referral code", "रेफ़रल कोड का अनुरोध करें", "रेफरल कोडची विनंती करा"),
  close: L("Close", "बंद करें", "बंद करा"),
  received: L("Request received", "अनुरोध मिल गया", "विनंती मिळाली"),
  thanks: L(
    "Thank you! Your request {ref} has reached our referrals team. We will call or message you on {mobile} with your referral code, usually within one working day.",
    "धन्यवाद! आपका अनुरोध {ref} हमारी रेफ़रल टीम तक पहुँच गया है। हम आमतौर पर एक कामकाजी दिन में {mobile} पर फ़ोन या संदेश करके आपको रेफ़रल कोड देंगे।",
    "धन्यवाद! तुमची विनंती {ref} आमच्या रेफरल टीमपर्यंत पोहोचली आहे. साधारण एका कामकाजाच्या दिवसात आम्ही {mobile} वर फोन किंवा संदेश करून तुम्हाला रेफरल कोड देऊ.",
  ),
  notShared: L(
    "Your location was not shared, so we will use the address you gave.",
    "आपकी लोकेशन साझा नहीं हुई, इसलिए हम आपका दिया पता इस्तेमाल करेंगे।",
    "तुमचे ठिकाण शेअर झाले नाही, म्हणून आम्ही तुम्ही दिलेला पत्ता वापरू.",
  ),
  intro: L(
    "No referral code yet? Tell us about your shop and our team will send you one.",
    "अभी रेफ़रल कोड नहीं है? अपनी दुकान के बारे में बताएँ, हमारी टीम आपको कोड भेजेगी।",
    "अजून रेफरल कोड नाही? तुमच्या दुकानाबद्दल सांगा, आमची टीम तुम्हाला कोड पाठवेल.",
  ),
  asking: L(
    "Asking your browser for your location… allow it to help us find your shop.",
    "ब्राउज़र से आपकी लोकेशन माँग रहे हैं… दुकान ढूँढने में मदद के लिए अनुमति दें।",
    "ब्राउझरकडे तुमचे ठिकाण मागत आहोत… दुकान शोधण्यासाठी परवानगी द्या.",
  ),
  captured: L("Location captured", "लोकेशन मिल गई", "ठिकाण मिळाले"),
  seeOnMaps: L("See on Google Maps", "Google Maps पर देखें", "Google Maps वर पहा"),
  notSharedShort: L("Location not shared", "लोकेशन साझा नहीं हुई", "ठिकाण शेअर झाले नाही"),
  denied: L(" (permission denied)", " (अनुमति नहीं मिली)", " (परवानगी नाकारली)"),
  thatIsFine: L(
    " — that is fine, just enter your address below.",
    " — कोई बात नहीं, बस नीचे अपना पता डालें।",
    " — हरकत नाही, फक्त खाली तुमचा पत्ता टाका.",
  ),
  yourName: L("Your name", "आपका नाम", "तुमचे नाव"),
  mobile: L("Mobile number", "मोबाइल नंबर", "मोबाइल नंबर"),
  shopType: L("Type of shop", "दुकान का प्रकार", "दुकानाचा प्रकार"),
  selectType: L("Select a shop type", "दुकान का प्रकार चुनें", "दुकानाचा प्रकार निवडा"),
  areaLocality: L("Area / locality", "इलाका / मोहल्ला", "परिसर / भाग"),
  area: L("Area", "इलाका", "परिसर"),
  city: L("City", "शहर", "शहर"),
  pin: L("PIN code", "पिन कोड", "पिन कोड"),
  sixDigits: L("6 digits", "6 अंक", "6 अंक"),
  sending: L("Sending…", "भेज रहे हैं…", "पाठवत आहे…"),
  send: L("Send request", "अनुरोध भेजें", "विनंती पाठवा"),
  cancel: L("Cancel", "रद्द करें", "रद्द करा"),
} as const;

type LocationState =
  | { status: "asking" }
  | { status: "shared"; latitude: number; longitude: number; accuracyM: number | null }
  | { status: "denied" }
  | { status: "unavailable" };

export interface ReferralRequestPrefill {
  name?: string;
  mobile?: string;
  shopType?: string;
  area?: string;
  city?: string;
  pincode?: string;
}

/**
 * "Request a referral code" (docs/four-features-2026-10, feature 4). Asks the
 * browser (or app) for the person's location first — latitude, longitude and
 * a Google Maps link — and works just as well when they say no: the request
 * then carries only the address they type, marked "location not shared".
 */
export function ReferralRequestDialog({
  prefill,
  onClose,
  lang = "en",
}: {
  prefill: ReferralRequestPrefill;
  onClose: () => void;
  lang?: Lang;
}) {
  const shopTypes = useShopTypes();
  const [location, setLocation] = useState<LocationState>({ status: "asking" });
  const [values, setValues] = useState({
    name: prefill.name ?? "",
    mobile: prefill.mobile ?? "",
    shopType: prefill.shopType ?? "",
    area: prefill.area ?? "",
    city: prefill.city ?? "",
    pincode: prefill.pincode ?? "",
  });
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ reference: string; mobileMasked: string; locationShared: boolean } | null>(null);

  useEffect(() => {
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      // No geolocation in this browser: the request goes without it.
      queueMicrotask(() => setLocation({ status: "unavailable" }));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (position) =>
        setLocation({
          status: "shared",
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
          accuracyM: Number.isFinite(position.coords.accuracy) ? Math.round(position.coords.accuracy) : null,
        }),
      (failure) => setLocation({ status: failure.code === failure.PERMISSION_DENIED ? "denied" : "unavailable" }),
      { enableHighAccuracy: true, timeout: 15_000, maximumAge: 60_000 },
    );
  }, []);

  const set = (key: keyof typeof values) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setValues((v) => ({ ...v, [key]: key === "mobile" || key === "pincode" ? e.target.value.replace(/\D/g, "").slice(0, key === "mobile" ? 10 : 6) : e.target.value }));

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const coords = location.status === "shared" ? { latitude: location.latitude, longitude: location.longitude, accuracyM: location.accuracyM } : {};
    const local = checkReferralRequest({ ...values, ...coords });
    if (!local.ok) {
      setFieldErrors(local.fields);
      return;
    }
    setFieldErrors({});
    setBusy(true);
    try {
      const response = await fetch("/api/referral-requests", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...values, ...coords }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        setFieldErrors(payload?.error?.details?.fields ?? {});
        throw new Error(payload?.error?.message != null ? errorText(payload.error.message, lang, payload.error.code) : tr(T.sendFailed, lang));
      }
      setDone(payload);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : tr(T.sendFailed, lang));
    } finally {
      setBusy(false);
    }
  }

  const mapsUrl = location.status === "shared" ? `https://www.google.com/maps?q=${location.latitude.toFixed(6)},${location.longitude.toFixed(6)}` : null;

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-0 sm:items-center sm:p-4" role="dialog" aria-modal="true" aria-label={tr(T.title, lang)}>
      <div className="max-h-[92vh] w-full overflow-y-auto rounded-t-2xl bg-white p-5 shadow-xl sm:max-w-lg sm:rounded-2xl" data-testid="referral-request-dialog">
        <div className="flex items-start justify-between gap-2">
          <h2 className="text-lg font-semibold text-ink-900">{tr(T.title, lang)}</h2>
          <button type="button" onClick={onClose} className="rounded-lg px-2 py-1 text-ink-500 hover:bg-cream-100" aria-label={tr(T.close, lang)}>
            ✕
          </button>
        </div>

        {done ? (
          <div className="mt-4 space-y-3" data-testid="referral-request-done">
            <Alert tone="success" title={tr(T.received, lang)}>
              {tr(T.thanks, lang).replace("{ref}", done.reference).replace("{mobile}", done.mobileMasked)}
            </Alert>
            {!done.locationShared ? <p className="text-xs text-ink-500">{tr(T.notShared, lang)}</p> : null}
            <Button onClick={onClose}>{tr(T.close, lang)}</Button>
          </div>
        ) : (
          <>
            <p className="mt-1 text-sm text-ink-600">{tr(T.intro, lang)}</p>
            <div className="mt-3 rounded-lg bg-cream-50 px-3 py-2 text-sm" data-testid="referral-request-location">
              {location.status === "asking" ? (
                <span className="text-ink-600">{tr(T.asking, lang)}</span>
              ) : location.status === "shared" ? (
                <span className="text-leaf-700">
                  {tr(T.captured, lang)} ({location.latitude.toFixed(5)}, {location.longitude.toFixed(5)}).{" "}
                  <a href={mapsUrl!} target="_blank" rel="noreferrer" className="underline">
                    {tr(T.seeOnMaps, lang)}
                  </a>
                </span>
              ) : (
                <span className="text-amber-800">
                  {tr(T.notSharedShort, lang)}
                  {location.status === "denied" ? tr(T.denied, lang) : ""}
                  {tr(T.thatIsFine, lang)}
                </span>
              )}
            </div>
            <form className="mt-4 grid gap-3 sm:grid-cols-2" onSubmit={submit} noValidate>
              <Field label={tr(T.yourName, lang)} error={fieldErrors.name}>
                <input className={inputClass} value={values.name} onChange={set("name")} autoComplete="name" aria-label={tr(T.yourName, lang)} />
              </Field>
              <Field label={tr(T.mobile, lang)} error={fieldErrors.mobile}>
                <input className={inputClass} value={values.mobile} onChange={set("mobile")} inputMode="numeric" autoComplete="tel-national" aria-label={tr(T.mobile, lang)} />
              </Field>
              <div className="sm:col-span-2">
                <Field label={tr(T.shopType, lang)} error={fieldErrors.shopType}>
                  <select className={inputClass} value={values.shopType} onChange={set("shopType")} aria-label={tr(T.shopType, lang)}>
                    <option value="" disabled>
                      {tr(T.selectType, lang)}
                    </option>
                    {shopTypes.map((t) => (
                      <option key={t.key} value={t.key}>
                        {t.label}
                      </option>
                    ))}
                  </select>
                </Field>
              </div>
              <Field label={tr(T.areaLocality, lang)} error={fieldErrors.area}>
                <input className={inputClass} value={values.area} onChange={set("area")} aria-label={tr(T.area, lang)} />
              </Field>
              <Field label={tr(T.city, lang)} error={fieldErrors.city}>
                <input className={inputClass} value={values.city} onChange={set("city")} aria-label={tr(T.city, lang)} />
              </Field>
              <Field label={tr(T.pin, lang)} hint={tr(T.sixDigits, lang)} error={fieldErrors.pincode}>
                <input className={inputClass} value={values.pincode} onChange={set("pincode")} inputMode="numeric" aria-label={tr(T.pin, lang)} />
              </Field>
              {fieldErrors.location ? <p className="text-xs text-red-600 sm:col-span-2">{fieldErrors.location}</p> : null}
              {error ? (
                <div className="sm:col-span-2">
                  <Alert tone="danger">{error}</Alert>
                </div>
              ) : null}
              <div className="flex gap-2 sm:col-span-2">
                {/* Never blocked on the location prompt: still waiting means it is sent without one. */}
                <Button type="submit" disabled={busy}>
                  {busy ? tr(T.sending, lang) : tr(T.send, lang)}
                </Button>
                <Button variant="ghost" onClick={onClose} disabled={busy}>
                  {tr(T.cancel, lang)}
                </Button>
              </div>
            </form>
          </>
        )}
      </div>
    </div>
  );
}
