/**
 * 1.13.0 (docs/smart-shopping-2026-11 at the repository root): speech to text for website pages, through
 * the phone's own recogniser (expo-speech-recognition: Android's SpeechRecognizer, iOS SFSpeechRecognizer).
 * Android's WebView has no Web Speech API, so "say the price and stock" (Add product by photo) and voice
 * search ask the app instead: the page sends "speech.listen" with a language (mr-IN, hi-IN, en-IN) and gets
 * back the final transcript. Listening stops on silence or after `maxSeconds`. Nothing is recorded or kept.
 */
import { ExpoSpeechRecognitionModule } from "expo-speech-recognition";

import type { BridgeError, BridgeMessage } from "./bridge";

const LANGS = new Set(["mr-IN", "hi-IN", "en-IN", "gu-IN", "kn-IN", "ta-IN", "te-IN", "bn-IN", "ur-IN"]);

export function speechLang(raw: unknown): string {
  return typeof raw === "string" && LANGS.has(raw) ? raw : "en-IN";
}

let busy = false;

export async function listen(message: BridgeMessage): Promise<{ transcript: string; confidence: number | null }> {
  if (busy) throw { name: "InvalidStateError", message: "Already listening." } satisfies BridgeError;
  const permission = await ExpoSpeechRecognitionModule.requestPermissionsAsync();
  if (!permission.granted) throw { name: "NotAllowedError", message: "Microphone permission was not given." } satisfies BridgeError;
  if (!ExpoSpeechRecognitionModule.isRecognitionAvailable()) {
    throw { name: "NotSupportedError", message: "Speech recognition is not available on this phone." } satisfies BridgeError;
  }
  const maxSeconds = Math.min(30, Math.max(3, Number(message.maxSeconds) || 12));
  busy = true;
  return new Promise((resolve, reject) => {
    let best: { transcript: string; confidence: number | null } = { transcript: "", confidence: null };
    const subs = [
      ExpoSpeechRecognitionModule.addListener("result", (event) => {
        const top = event.results[0];
        if (top) best = { transcript: top.transcript, confidence: top.confidence >= 0 ? top.confidence : null };
      }),
      ExpoSpeechRecognitionModule.addListener("error", (event) => {
        finish();
        if (event.error === "no-speech" || event.error === "speech-timeout") resolve({ transcript: "", confidence: null });
        else reject({ name: "SpeechError", message: event.message || event.error } satisfies BridgeError);
      }),
      ExpoSpeechRecognitionModule.addListener("end", () => {
        finish();
        resolve(best);
      }),
    ];
    const timer = setTimeout(() => ExpoSpeechRecognitionModule.stop(), maxSeconds * 1000);
    function finish() {
      clearTimeout(timer);
      subs.forEach((s) => s.remove());
      busy = false;
    }
    try {
      ExpoSpeechRecognitionModule.start({ lang: speechLang(message.lang), interimResults: false, continuous: false, maxAlternatives: 1 });
    } catch (error) {
      finish();
      reject({ name: "SpeechError", message: error instanceof Error ? error.message : "Could not start listening." } satisfies BridgeError);
    }
  });
}

export function stopListening(): void {
  if (busy) ExpoSpeechRecognitionModule.stop();
}
