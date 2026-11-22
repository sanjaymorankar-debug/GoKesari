/**
 * Speech to text for a page, one utterance (docs/smart-shopping-2026-11): the GoKesari app's own
 * recogniser when the page runs inside app 1.13.0+ (capability "speech-recognition", mobile/src/speech.ts —
 * Android's WebView has no Web Speech API), else the browser's Web Speech API (Chrome, Edge, Safari).
 * Languages: mr-IN, hi-IN, en-IN (and other Indian locales the recogniser supports). Browser only.
 */

export type VoiceLang = "mr-IN" | "hi-IN" | "en-IN" | "gu-IN";

interface AppSpeechBridge {
  capabilities?: string[];
  listen?: (o: { lang: string; maxSeconds?: number }) => Promise<{ transcript: string; confidence: number | null }>;
  stopListening?: () => Promise<unknown>;
}

type SpeechRecognitionCtor = new () => {
  lang: string;
  interimResults: boolean;
  maxAlternatives: number;
  continuous: boolean;
  onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string; confidence: number }>> }) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
};

function appBridge(): AppSpeechBridge | null {
  const app = (window as unknown as { __gokesariApp?: AppSpeechBridge }).__gokesariApp;
  return app?.capabilities?.includes("speech-recognition") && app.listen ? app : null;
}

function browserRecognition(): SpeechRecognitionCtor | null {
  const w = window as unknown as { SpeechRecognition?: SpeechRecognitionCtor; webkitSpeechRecognition?: SpeechRecognitionCtor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

/** Can this page take voice input at all? (Show the microphone only when true.) */
export function voiceInputAvailable(): boolean {
  if (typeof window === "undefined") return false;
  return Boolean(appBridge() || browserRecognition());
}

/** Listens for one utterance and returns the text ("" when nothing was heard). Rejects when not allowed / not available. */
export async function listenOnce(lang: VoiceLang, maxSeconds = 12): Promise<string> {
  const app = appBridge();
  if (app?.listen) return (await app.listen({ lang, maxSeconds })).transcript;
  const Ctor = browserRecognition();
  if (!Ctor) throw new Error("Voice input is not available in this browser. Please type instead.");
  return new Promise((resolve, reject) => {
    const rec = new Ctor();
    rec.lang = lang;
    rec.interimResults = false;
    rec.maxAlternatives = 1;
    rec.continuous = false;
    let text = "";
    const timer = setTimeout(() => rec.stop(), maxSeconds * 1000);
    rec.onresult = (e) => {
      text = Array.from(e.results)
        .map((r) => r[0]?.transcript ?? "")
        .join(" ")
        .trim();
    };
    rec.onerror = (e) => {
      clearTimeout(timer);
      if (e.error === "no-speech" || e.error === "aborted") resolve("");
      else reject(new Error(e.error === "not-allowed" ? "Microphone permission was not given." : `Voice input failed (${e.error}).`));
    };
    rec.onend = () => {
      clearTimeout(timer);
      resolve(text);
    };
    rec.start();
  });
}

/** Reads text aloud (the parsed price and stock, for the owner to confirm). Silently does nothing without speech synthesis. */
export function speak(text: string, lang: VoiceLang): void {
  try {
    const synth = window.speechSynthesis;
    if (!synth) return;
    const u = new SpeechSynthesisUtterance(text);
    u.lang = lang;
    synth.cancel();
    synth.speak(u);
  } catch {
    /* no speech output */
  }
}
