"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import { Alert, Badge, Button, Card, Field, inputClass } from "@/components/ui";
import { errorText } from "@/lib/board/error-text";
import { L, tr, type Lang, type Text } from "@/lib/board/i18n";
import { RIDER_KYC_CONSENT_TEXT, RIDER_KYC_STATUS_LABELS, type RiderKycStatus } from "@/lib/gig/kyc";

const T = {
  notStarted: L("Not started", "शुरू नहीं हुआ", "सुरू झाले नाही"),
  genericError: L("Something went wrong. Try again.", "कुछ गड़बड़ हो गई। फिर कोशिश करें।", "काहीतरी चुकले. पुन्हा प्रयत्न करा."),
  offline: L(
    "Could not reach the server. Check your connection and try again.",
    "सर्वर से संपर्क नहीं हो सका। अपना कनेक्शन देखें और फिर कोशिश करें।",
    "सर्व्हरशी संपर्क झाला नाही. तुमचे कनेक्शन तपासा आणि पुन्हा प्रयत्न करा.",
  ),
  consent: L(
    RIDER_KYC_CONSENT_TEXT,
    "मैं सहमत हूँ कि GoKesari मेरा PAN अपने सत्यापन पार्टनर को भेज सकता है, जो इसे आयकर विभाग के रिकॉर्ड से जाँचता है, और मैं अपना Aadhaar अपने DigiLocker खाते से साझा करूँगा/करूँगी (मैं Aadhaar से जुड़े मोबाइल पर आए OTP से DigiLocker में साइन इन करके वहीं साझा करने की मंज़ूरी देता/देती हूँ), सिर्फ़ GoKesari डिलीवरी पार्टनर के रूप में अपनी पहचान सत्यापित करने के लिए। Aadhaar से GoKesari सिर्फ़ मेरा नाम और आख़िरी चार अंक रखता है; मेरा Aadhaar नंबर, फ़ोटो, जन्म तिथि या पता कभी नहीं रखता, और सिर्फ़ छिपे हुए नंबर दिखाता है। डिलीवरी बंद करने पर मैं यह डेटा हटाने के लिए कह सकता/सकती हूँ, कानूनी अवधि तक रखने की शर्त के साथ।",
    "मी सहमत आहे की GoKesari माझा PAN त्याच्या पडताळणी भागीदाराकडे पाठवू शकते, जो तो आयकर विभागाच्या नोंदींशी तपासतो, आणि मी माझा Aadhaar माझ्या DigiLocker खात्यातून शेअर करेन (Aadhaar शी जोडलेल्या मोबाइलवर आलेल्या OTP ने मी DigiLocker मध्ये साइन इन करतो/करते आणि तिथेच शेअर करण्यास मंजुरी देतो/देते), फक्त GoKesari डिलिव्हरी पार्टनर म्हणून माझी ओळख पडताळण्यासाठी. Aadhaar मधून GoKesari फक्त माझे नाव आणि शेवटचे चार अंक ठेवते; माझा Aadhaar क्रमांक, फोटो, जन्मतारीख किंवा पत्ता कधीही ठेवत नाही, आणि फक्त लपवलेले क्रमांक दाखवते. डिलिव्हरी बंद केल्यावर मी हा डेटा हटवण्याची विनंती करू शकतो/शकते, कायदेशीर कालावधीपर्यंत ठेवण्याच्या अटीसह.",
  ),
  panHint: L("10 characters, e.g. ABCDE1234F", "10 अक्षर, जैसे ABCDE1234F", "10 अक्षरे, उदा. ABCDE1234F"),
  verifying: L("Verifying…", "जाँच हो रही है…", "पडताळणी होत आहे…"),
  verifyPan: L("Verify PAN", "PAN सत्यापित करें", "PAN पडताळा"),
  digilockerIntro: L(
    "Share your Aadhaar from DigiLocker: sign in there with the OTP sent to your Aadhaar-linked mobile, then allow GoKesari to see your Aadhaar. GoKesari keeps only your name and the last four digits.",
    "DigiLocker से अपना Aadhaar साझा करें: Aadhaar से जुड़े मोबाइल पर आए OTP से वहाँ साइन इन करें, फिर GoKesari को अपना Aadhaar देखने की अनुमति दें। GoKesari सिर्फ़ आपका नाम और आख़िरी चार अंक रखता है।",
    "DigiLocker मधून तुमचा Aadhaar शेअर करा: Aadhaar शी जोडलेल्या मोबाइलवर आलेल्या OTP ने तिथे साइन इन करा, मग GoKesari ला तुमचा Aadhaar पाहण्याची परवानगी द्या. GoKesari फक्त तुमचे नाव आणि शेवटचे चार अंक ठेवते.",
  ),
  openingDigilocker: L("Opening DigiLocker…", "DigiLocker खुल रहा है…", "DigiLocker उघडत आहे…"),
  continueDigilocker: L("Continue in DigiLocker", "DigiLocker में आगे बढ़ें", "DigiLocker मध्ये पुढे जा"),
  verifyDigilocker: L("Verify with DigiLocker", "DigiLocker से सत्यापित करें", "DigiLocker ने पडताळा"),
  checking: L("Checking…", "जाँच रहे हैं…", "तपासत आहोत…"),
  checkStatus: L("Check status", "स्थिति देखें", "स्थिती तपासा"),
  tickConsent: L("Tick the consent box above first.", "पहले ऊपर सहमति वाले बॉक्स पर टिक करें।", "आधी वरच्या संमती बॉक्सवर टिक करा."),
  aadhaarNumber: L("Aadhaar number", "Aadhaar नंबर", "Aadhaar क्रमांक"),
  aadhaarHint: L(
    "We send an OTP to the mobile linked to your Aadhaar. GoKesari never stores the number.",
    "हम आपके Aadhaar से जुड़े मोबाइल पर OTP भेजते हैं। GoKesari यह नंबर कभी नहीं रखता।",
    "आम्ही तुमच्या Aadhaar शी जोडलेल्या मोबाइलवर OTP पाठवतो. GoKesari हा क्रमांक कधीही ठेवत नाही.",
  ),
  sendingOtp: L("Sending OTP…", "OTP भेज रहे हैं…", "OTP पाठवत आहोत…"),
  sendNewOtp: L("Send a new OTP", "नया OTP भेजें", "नवीन OTP पाठवा"),
  sendOtp: L("Send OTP", "OTP भेजें", "OTP पाठवा"),
  verifyAadhaar: L("Verify Aadhaar", "Aadhaar सत्यापित करें", "Aadhaar पडताळा"),
  kycComplete: L("KYC complete", "KYC पूरा हुआ", "KYC पूर्ण झाले"),
  nextUpload: L(
    "Next, upload your police verification form and character certificate from",
    "आगे, अपना पुलिस सत्यापन फ़ॉर्म और चरित्र प्रमाणपत्र यहाँ से अपलोड करें:",
    "पुढे, तुमचा पोलीस पडताळणी फॉर्म आणि चारित्र्य प्रमाणपत्र इथून अपलोड करा:",
  ),
  documents: L("Documents", "दस्तावेज़", "कागदपत्रे"),
} as const;

const STATUS_TEXT: Record<RiderKycStatus, Text> = {
  PENDING: L("Pending", "बाकी", "प्रलंबित"),
  VERIFIED: L("Verified", "सत्यापित", "पडताळलेले"),
  FAILED: L("Failed", "असफल", "अयशस्वी"),
};

export interface KycCheckProps {
  status: RiderKycStatus;
  numberMasked: string;
  reason: string | null;
  awaitingOtp: boolean;
  /** Aadhaar by DigiLocker: a link is open and can still be used. */
  digilockerOpen?: boolean;
}

/** The GoKesari app's page bridge (mobile/src/bridge-script.ts), when the page runs inside the app. */
interface AppBridge {
  scheme?: string;
  openDigiLocker?: (url: string) => Promise<unknown>;
}

function appBridge(): AppBridge | null {
  return typeof window === "undefined" ? null : ((window as unknown as { __gokesariApp?: AppBridge }).__gokesariApp ?? null);
}

/** How many times the page re-asks after DigiLocker sent the partner back while the result is not in yet. */
const RETURN_POLLS = 6;
const RETURN_POLL_MS = 5000;

const TONE: Record<RiderKycStatus, "success" | "warning" | "danger"> = { VERIFIED: "success", PENDING: "warning", FAILED: "danger" };

function StatusLine({ check, lang = "en" }: { check: KycCheckProps | null; lang?: Lang }) {
  if (!check) return <Badge>{tr(T.notStarted, lang)}</Badge>;
  return (
    <div className="space-y-1" data-testid="kyc-status">
      <div className="flex items-center gap-2">
        <Badge tone={TONE[check.status]}>{lang === "en" ? RIDER_KYC_STATUS_LABELS[check.status] : tr(STATUS_TEXT[check.status], lang)}</Badge>
        <span className="font-mono text-sm text-ink-700">{check.numberMasked}</span>
      </div>
      {check.reason ? <p className="text-xs text-ink-500">{errorText(check.reason, lang)}</p> : null}
    </div>
  );
}

async function post(
  url: string,
  body: unknown,
  lang: Lang = "en",
): Promise<{ ok: boolean; message: string | null; fields: Record<string, string>; data?: Record<string, unknown> }> {
  try {
    const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const payload = await response.json().catch(() => null);
    if (response.ok) return { ok: true, message: null, fields: {}, data: payload ?? {} };
    return {
      ok: false,
      message: payload?.error?.message ? errorText(payload.error.message, lang, payload?.error?.code) : tr(T.genericError, lang),
      fields: payload?.error?.details?.fields ?? {},
    };
  } catch {
    return { ok: false, message: tr(T.offline, lang), fields: {} };
  }
}

/**
 * Gig worker flow (feature 2): consent, then PAN and Aadhaar. Aadhaar is shared
 * from DigiLocker (aadhaarMethod "digilocker": the partner signs in there with
 * an Aadhaar OTP and consents; DigiLocker sends them back here), or — legacy —
 * checked by OTP to the Aadhaar-linked mobile. Shows Verified / Pending /
 * Failed with the masked number only; full numbers never come back.
 */
export function RiderKycForm({
  pan,
  aadhaar,
  aadhaarMethod = "digilocker",
  lang = "en",
}: {
  pan: KycCheckProps | null;
  aadhaar: KycCheckProps | null;
  aadhaarMethod?: "digilocker" | "okyc_legacy";
  lang?: Lang;
}) {
  const t = (text: Text) => tr(text, lang);
  const router = useRouter();
  const searchParams = useSearchParams();
  const returned = searchParams.get("digilocker");
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState<null | "pan" | "otp" | "verify" | "digilocker" | "sync">(null);
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [panInput, setPanInput] = useState("");
  const [aadhaarInput, setAadhaarInput] = useState("");
  const [otp, setOtp] = useState("");

  async function run(kind: "pan" | "otp" | "verify" | "sync", url: string, body: unknown, after?: () => void) {
    setBusy(kind);
    setError(null);
    setFields({});
    const result = await post(url, body, lang);
    setBusy(null);
    if (!result.ok) {
      setError(result.message);
      setFields(result.fields);
      return;
    }
    after?.();
    router.refresh();
  }

  const panDone = pan?.status === "VERIFIED";
  const aadhaarDone = aadhaar?.status === "VERIFIED";

  async function verifyWithDigilocker() {
    setBusy("digilocker");
    setError(null);
    setFields({});
    const bridge = appBridge();
    const inApp = typeof bridge?.openDigiLocker === "function";
    const result = await post("/api/delivery-partner/me/kyc/aadhaar/digilocker", { consent, app: inApp ? (bridge?.scheme ?? null) : null }, lang);
    const url = typeof result.data?.url === "string" ? result.data.url : null;
    if (!result.ok || !url) {
      setBusy(null);
      if (!result.ok) {
        setError(result.message);
        setFields(result.fields);
      }
      router.refresh();
      return;
    }
    if (inApp) {
      // The app opens DigiLocker in its in-app browser and comes back here when it closes.
      await bridge!.openDigiLocker!(url).catch(() => null);
      setBusy(null);
      await post("/api/delivery-partner/me/kyc/aadhaar/digilocker/sync", {});
      router.refresh();
      return;
    }
    window.location.assign(url);
  }

  // Back from DigiLocker before the result is in: ask again a few times.
  const polls = useRef(0);
  const waiting = aadhaarMethod === "digilocker" && aadhaar?.status === "PENDING" && Boolean(returned) && returned !== "verified";
  useEffect(() => {
    if (!waiting || polls.current >= RETURN_POLLS) return;
    const timer = setTimeout(async () => {
      polls.current += 1;
      await post("/api/delivery-partner/me/kyc/aadhaar/digilocker/sync", {});
      router.refresh();
    }, RETURN_POLL_MS);
    return () => clearTimeout(timer);
  }, [waiting, aadhaar, router]);

  return (
    <div className="space-y-4">
      {!(panDone && aadhaarDone) ? (
        <Card className="p-5">
          <label className="flex items-start gap-3 text-sm text-ink-700">
            <input
              type="checkbox"
              className="mt-1 h-4 w-4"
              checked={consent}
              onChange={(e) => setConsent(e.target.checked)}
              data-testid="kyc-consent"
            />
            <span>{t(T.consent)}</span>
          </label>
          {fields.consent ? <p className="mt-1 text-xs text-red-600">{errorText(fields.consent, lang)}</p> : null}
        </Card>
      ) : null}

      <Card className="space-y-3 p-5">
        <div className="flex items-center justify-between gap-2">
          <h2 className="font-semibold text-ink-900">PAN</h2>
          <StatusLine check={pan} lang={lang} />
        </div>
        {!panDone ? (
          <form
            className="flex flex-wrap items-end gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void run("pan", "/api/delivery-partner/me/kyc/pan", { pan: panInput, consent }, () => setPanInput(""));
            }}
          >
            <div className="min-w-48 flex-1">
              <Field label="PAN" hint={t(T.panHint)} error={errorText(fields.pan, lang) || undefined}>
                <input
                  value={panInput}
                  onChange={(e) => setPanInput(e.target.value.toUpperCase())}
                  maxLength={10}
                  autoCapitalize="characters"
                  autoComplete="off"
                  className={inputClass}
                  data-testid="kyc-pan"
                />
              </Field>
            </div>
            <Button type="submit" disabled={busy !== null || !consent || panInput.trim().length !== 10}>
              {busy === "pan" ? t(T.verifying) : t(T.verifyPan)}
            </Button>
          </form>
        ) : null}
      </Card>

      <Card className="space-y-3 p-5">
        <div className="flex items-center justify-between gap-2">
          <h2 className="font-semibold text-ink-900">Aadhaar</h2>
          <StatusLine check={aadhaar} lang={lang} />
        </div>
        {!aadhaarDone && aadhaarMethod === "digilocker" ? (
          <div className="space-y-2">
            <p className="text-sm text-ink-700">{t(T.digilockerIntro)}</p>
            <div className="flex flex-wrap gap-2">
              <Button type="button" disabled={busy !== null || !consent} onClick={() => void verifyWithDigilocker()} data-testid="kyc-digilocker">
                {busy === "digilocker" ? t(T.openingDigilocker) : aadhaar?.digilockerOpen ? t(T.continueDigilocker) : t(T.verifyDigilocker)}
              </Button>
              {aadhaar?.status === "PENDING" ? (
                <Button
                  type="button"
                  variant="secondary"
                  disabled={busy !== null}
                  onClick={() => void run("sync", "/api/delivery-partner/me/kyc/aadhaar/digilocker/sync", {})}
                  data-testid="kyc-digilocker-check"
                >
                  {busy === "sync" ? t(T.checking) : t(T.checkStatus)}
                </Button>
              ) : null}
            </div>
            {!consent ? <p className="text-xs text-ink-500">{t(T.tickConsent)}</p> : null}
          </div>
        ) : null}
        {!aadhaarDone && aadhaarMethod === "okyc_legacy" ? (
          <>
            <form
              className="flex flex-wrap items-end gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                void run("otp", "/api/delivery-partner/me/kyc/aadhaar/otp", { aadhaar: aadhaarInput, consent }, () => setAadhaarInput(""));
              }}
            >
              <div className="min-w-48 flex-1">
                <Field
                  label={t(T.aadhaarNumber)}
                  hint={t(T.aadhaarHint)}
                  error={errorText(fields.aadhaar, lang) || undefined}
                >
                  <input
                    value={aadhaarInput}
                    onChange={(e) => setAadhaarInput(e.target.value.replace(/[^\d ]/g, ""))}
                    inputMode="numeric"
                    maxLength={14}
                    autoComplete="off"
                    className={inputClass}
                    data-testid="kyc-aadhaar"
                  />
                </Field>
              </div>
              <Button type="submit" variant="secondary" disabled={busy !== null || !consent || aadhaarInput.replace(/\D/g, "").length !== 12}>
                {busy === "otp" ? t(T.sendingOtp) : aadhaar?.awaitingOtp ? t(T.sendNewOtp) : t(T.sendOtp)}
              </Button>
            </form>
            {aadhaar?.awaitingOtp ? (
              <form
                className="flex flex-wrap items-end gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  void run("verify", "/api/delivery-partner/me/kyc/aadhaar/verify", { otp }, () => setOtp(""));
                }}
              >
                <div className="min-w-40">
                  <Field label="OTP" error={errorText(fields.otp, lang) || undefined}>
                    <input
                      value={otp}
                      onChange={(e) => setOtp(e.target.value.replace(/\D/g, ""))}
                      inputMode="numeric"
                      maxLength={6}
                      autoComplete="one-time-code"
                      className={inputClass}
                      data-testid="kyc-otp"
                    />
                  </Field>
                </div>
                <Button type="submit" disabled={busy !== null || otp.length !== 6}>
                  {busy === "verify" ? t(T.checking) : t(T.verifyAadhaar)}
                </Button>
              </form>
            ) : null}
          </>
        ) : null}
      </Card>

      {error ? <Alert tone="danger">{error}</Alert> : null}
      {panDone && aadhaarDone ? (
        <Alert tone="success" title={t(T.kycComplete)}>
          {t(T.nextUpload)}{" "}
          <a className="font-medium underline" href="/delivery-partner/documents">
            {t(T.documents)}
          </a>
          .
        </Alert>
      ) : null}
    </div>
  );
}
