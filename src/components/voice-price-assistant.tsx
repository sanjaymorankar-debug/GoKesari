"use client";
/**
 * Voice price & offer assistant (docs/smart-shopping-2026-11/FEATURE4_VOICE_PRICE_OFFERS.md).
 * Say or type the product and the change (or scan the barcode first) → GoKesari shows and reads back what
 * it understood → the owner taps "Yes, publish" or says "हो / हाँ / yes" → the price and/or offer go live.
 * Speech is recognised on the phone (app 1.13.0+) or in the browser (lib/voice-input); only the text is sent.
 */
import { useState, useSyncExternalStore } from "react";

import { BarcodeScanner } from "@/components/barcode-scanner";
import { Alert, Badge, Button, Card, inputClass } from "@/components/ui";
import type { Lang } from "@/lib/board/i18n";
import { formatPaiseCompact } from "@/lib/money";
import { yesOrNo } from "@/lib/voice-command-parse";
import { listenOnce, speak, voiceInputAvailable, type VoiceLang } from "@/lib/voice-input";
import type { ApplyResult, VoiceListing, VoiceProposal } from "@/server/services/voice-price-assistant";

const SPEECH_LANGS: { code: VoiceLang; label: string }[] = [
  { code: "mr-IN", label: "मराठी" },
  { code: "hi-IN", label: "हिंदी" },
  { code: "en-IN", label: "English" },
  { code: "gu-IN", label: "ગુજરાતી" },
  { code: "kn-IN", label: "ಕನ್ನಡ" },
  { code: "ta-IN", label: "தமிழ்" },
  { code: "te-IN", label: "తెలుగు" },
  { code: "bn-IN", label: "বাংলা" },
  { code: "ur-IN", label: "اردو" },
];
const READ_LANG: Record<Lang, VoiceLang> = { en: "en-IN", hi: "hi-IN", mr: "mr-IN" };

const T = {
  en: {
    speakIn: "I will speak in", speak: "🎤 Speak", listening: "Listening…", type: "Or type it here",
    example: "e.g. “Amul Taaza 1 litre price 58” or “sugar 10% off till Sunday”",
    understand: "Check", scan: "Scan barcode", scanned: "Barcode", clearCode: "Remove",
    understood: "What GoKesari understood", product: "Product", price: "Price", offer: "Offer", pays: "Customers pay",
    notSet: "not set", until: "until", publish: "Yes, publish", sayYes: "🎤 Say yes / no", change: "No, change it",
    next: "Next product", noVoice: "Voice input is not available here — please type.", choose: "Choose the product",
    mrp: "MRP", ai: "AI helped read this", working: "Working…", heard: "Heard",
  },
  hi: {
    speakIn: "मैं बोलूँगा", speak: "🎤 बोलें", listening: "सुन रहे हैं…", type: "या यहाँ लिखें",
    example: "जैसे “अमूल ताज़ा 1 लीटर कीमत 58” या “चीनी 10 प्रतिशत छूट रविवार तक”",
    understand: "जाँचें", scan: "बारकोड स्कैन करें", scanned: "बारकोड", clearCode: "हटाएँ",
    understood: "GoKesari ने यह समझा", product: "उत्पाद", price: "कीमत", offer: "ऑफ़र", pays: "ग्राहक देंगे",
    notSet: "तय नहीं", until: "तक", publish: "हाँ, प्रकाशित करें", sayYes: "🎤 हाँ / नहीं बोलें", change: "नहीं, बदलें",
    next: "अगला उत्पाद", noVoice: "यहाँ आवाज़ से इनपुट नहीं है — कृपया लिखें।", choose: "उत्पाद चुनें",
    mrp: "MRP", ai: "AI ने पढ़ने में मदद की", working: "काम चल रहा है…", heard: "सुना",
  },
  mr: {
    speakIn: "मी बोलणार", speak: "🎤 बोला", listening: "ऐकत आहे…", type: "किंवा इथे लिहा",
    example: "उदा. “अमूल ताजा 1 लिटर किंमत 58” किंवा “साखर 10 टक्के सूट रविवार पर्यंत”",
    understand: "तपासा", scan: "बारकोड स्कॅन करा", scanned: "बारकोड", clearCode: "काढा",
    understood: "GoKesari ला हे समजले", product: "उत्पादन", price: "किंमत", offer: "ऑफर", pays: "ग्राहक देतील",
    notSet: "ठरलेली नाही", until: "पर्यंत", publish: "हो, प्रसिद्ध करा", sayYes: "🎤 हो / नाही म्हणा", change: "नाही, बदला",
    next: "पुढचे उत्पादन", noVoice: "येथे आवाजाने इनपुट नाही — कृपया लिहा.", choose: "उत्पादन निवडा",
    mrp: "MRP", ai: "AI ने वाचायला मदत केली", working: "काम सुरू आहे…", heard: "ऐकले",
  },
} as const;

async function api<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error?.message ?? "Something went wrong.");
  return data as T;
}

const noSubscribe = () => () => {};

export function VoicePriceAssistant({ shopId, lang, defaultSpeechLang }: { shopId: string; lang: Lang; defaultSpeechLang: VoiceLang }) {
  const t = T[lang];
  const base = `/api/shops/${shopId}/voice-price`;
  const canSpeak = useSyncExternalStore(noSubscribe, voiceInputAvailable, () => false);
  const [speechLang, setSpeechLang] = useState<VoiceLang>(defaultSpeechLang);
  const [text, setText] = useState("");
  const [barcode, setBarcode] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [proposal, setProposal] = useState<VoiceProposal | null>(null);
  const [done, setDone] = useState<ApplyResult | null>(null);
  const [busy, setBusy] = useState<null | "listen" | "check" | "publish" | "confirm">(null);
  const [error, setError] = useState<string | null>(null);

  async function check(spoken: string, pick?: VoiceListing) {
    if (!spoken.trim()) return;
    setBusy("check");
    setError(null);
    setDone(null);
    try {
      const p = await api<VoiceProposal>(`${base}/interpret`, {
        text: spoken,
        shopProductId: pick?.shopProductId ?? null,
        barcode: pick ? null : barcode,
      });
      setProposal(p);
      speak(p.issues.find((i) => i.blocking)?.message[lang] ?? p.readBack[lang], READ_LANG[lang]);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function listen() {
    setError(null);
    setBusy("listen");
    try {
      const heard = await listenOnce(speechLang);
      setText(heard);
      setBusy(null);
      // "हो" / "yes" while a publishable proposal is on screen confirms it.
      if (proposal?.canPublish && yesOrNo(heard) === "YES") return await publish();
      if (proposal && yesOrNo(heard) === "NO") return reset(false);
      await check(heard);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function publish() {
    const p = proposal;
    if (!p?.chosen || !p.canPublish) return;
    setBusy("publish");
    setError(null);
    try {
      const r = await api<ApplyResult>(`${base}/apply`, {
        shopProductId: p.chosen.shopProductId,
        newPricePaise: p.newPricePaise,
        offer: p.offer ? { discountType: p.offer.discountType, percent: p.offer.percent, flatPaise: p.offer.flatPaise, endsAt: p.offer.endsAt } : null,
        expectedPricePaise: p.chosen.pricePaise,
        text: p.text,
      });
      setDone(r);
      setProposal(null);
      setText("");
      setBarcode(null);
      speak(r.summary[lang], READ_LANG[lang]);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  function reset(keepDone: boolean) {
    setProposal(null);
    setText("");
    setBarcode(null);
    setError(null);
    if (!keepDone) setDone(null);
  }

  const offerLine = (p: VoiceProposal) => {
    if (!p.offer) return null;
    const amount = p.offer.discountType === "PERCENT" ? `${p.offer.percent}%` : formatPaiseCompact(p.offer.flatPaise ?? 0);
    const until = new Date(p.offer.endsAt).toLocaleDateString(lang === "en" ? "en-IN" : lang === "hi" ? "hi-IN" : "mr-IN", {
      weekday: "short", day: "numeric", month: "short", timeZone: "Asia/Kolkata",
    });
    return lang === "en" ? `${amount} off ${t.until} ${until}` : `${amount} · ${until} ${t.until}`;
  };

  return (
    <div className="space-y-4" data-testid="voice-price-assistant">
      {done ? (
        <Alert tone="success">
          <div data-testid="voice-price-done">{done.summary[lang]}</div>
        </Alert>
      ) : null}
      {error ? <Alert tone="danger">{error}</Alert> : null}

      <Card className="space-y-3 p-4">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="text-ink-600">{t.speakIn}</span>
          <select className={`${inputClass} w-auto`} value={speechLang} onChange={(e) => setSpeechLang(e.target.value as VoiceLang)} aria-label={t.speakIn}>
            {SPEECH_LANGS.map((l) => (
              <option key={l.code} value={l.code}>
                {l.label}
              </option>
            ))}
          </select>
        </div>
        {canSpeak ? (
          <Button size="lg" className="w-full text-lg" onClick={listen} disabled={busy !== null} data-testid="voice-price-mic">
            {busy === "listen" ? t.listening : t.speak}
          </Button>
        ) : (
          <p className="text-xs text-ink-500">{t.noVoice}</p>
        )}
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void check(text);
          }}
        >
          <input
            className={inputClass}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={t.type}
            aria-label={t.type}
            data-testid="voice-price-text"
          />
          <Button type="submit" variant="secondary" disabled={busy !== null || !text.trim()}>
            {busy === "check" ? t.working : t.understand}
          </Button>
        </form>
        <p className="text-xs text-ink-500">{t.example}</p>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="secondary" size="sm" onClick={() => setScanning(true)} disabled={busy !== null}>
            {t.scan}
          </Button>
          {barcode ? (
            <span className="text-sm">
              {t.scanned}: <b>{barcode}</b>{" "}
              <button type="button" className="text-xs underline" onClick={() => setBarcode(null)}>
                {t.clearCode}
              </button>
            </span>
          ) : null}
        </div>
        {scanning ? (
          <BarcodeScanner
            onCode={(code) => {
              setScanning(false);
              setBarcode(code);
              if (text.trim()) void check(text);
            }}
            onClose={() => setScanning(false)}
          />
        ) : null}
      </Card>

      {proposal ? (
        <Card className="space-y-3 p-4" data-testid="voice-price-proposal">
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-lg font-bold">{t.understood}</h2>
            {proposal.aiUsed ? <Badge tone="info">{t.ai}</Badge> : null}
          </div>
          <p className="text-xs text-ink-500">
            {t.heard}: “{proposal.text}”
          </p>

          {proposal.chosen ? (
            <div className="flex items-center gap-3">
              {proposal.chosen.imageUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={proposal.chosen.imageUrl} alt="" className="h-14 w-14 rounded-lg object-cover" />
              ) : null}
              <div>
                <div className="font-semibold" data-testid="voice-price-product">{proposal.chosen.label}</div>
                {proposal.chosen.mrpPaise != null ? (
                  <div className="text-xs text-ink-500">
                    {t.mrp} {formatPaiseCompact(proposal.chosen.mrpPaise)}
                  </div>
                ) : null}
              </div>
            </div>
          ) : proposal.candidates.length ? (
            <div>
              <div className="mb-1 text-sm font-semibold">{t.choose}</div>
              <div className="grid gap-2 sm:grid-cols-2">
                {proposal.candidates.map((c) => (
                  <button
                    key={c.shopProductId}
                    type="button"
                    className="rounded-xl border bg-white p-3 text-left text-sm hover:shadow"
                    onClick={() => void check(proposal.text, c)}
                    data-testid="voice-price-candidate"
                  >
                    <div className="font-semibold">{c.label}</div>
                    <div className="text-xs text-ink-500">
                      {t.price}: {c.pricePaise != null ? formatPaiseCompact(c.pricePaise) : t.notSet}
                    </div>
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          <dl className="grid grid-cols-[auto,1fr] gap-x-3 gap-y-1 text-sm">
            {proposal.newPricePaise !== null ? (
              <>
                <dt className="text-ink-500">{t.price}</dt>
                <dd data-testid="voice-price-new-price">
                  {proposal.chosen?.pricePaise != null ? <s className="mr-1 text-ink-400">{formatPaiseCompact(proposal.chosen.pricePaise)}</s> : null}
                  <b>{formatPaiseCompact(proposal.newPricePaise)}</b>
                </dd>
              </>
            ) : null}
            {proposal.offer ? (
              <>
                <dt className="text-ink-500">{t.offer}</dt>
                <dd data-testid="voice-price-offer">{offerLine(proposal)}</dd>
              </>
            ) : null}
            {proposal.offer && proposal.finalPricePaise !== null ? (
              <>
                <dt className="text-ink-500">{t.pays}</dt>
                <dd>
                  <b>{formatPaiseCompact(proposal.finalPricePaise)}</b>
                </dd>
              </>
            ) : null}
          </dl>

          {proposal.issues.map((i) => (
            <Alert key={i.code} tone={i.blocking ? "warning" : "info"}>
              {i.message[lang]}
            </Alert>
          ))}

          <div className="flex flex-wrap gap-2">
            <Button onClick={publish} disabled={!proposal.canPublish || busy !== null} data-testid="voice-price-publish">
              {busy === "publish" ? t.working : t.publish}
            </Button>
            {canSpeak && proposal.canPublish ? (
              <Button variant="secondary" onClick={listen} disabled={busy !== null}>
                {busy === "listen" ? t.listening : t.sayYes}
              </Button>
            ) : null}
            <Button variant="ghost" onClick={() => reset(true)} disabled={busy !== null}>
              {t.change}
            </Button>
          </div>
        </Card>
      ) : null}

      {done && !proposal ? (
        <Button variant="secondary" onClick={() => reset(false)}>
          {t.next}
        </Button>
      ) : null}
    </div>
  );
}
