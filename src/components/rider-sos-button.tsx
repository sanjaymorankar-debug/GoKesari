"use client";

/**
 * Rider SOS (Rider App v2, rule riderSos). A big red button → confirm → alert GoKesari with the
 * phone's position (5 s at most; goes ahead without it) → dial the emergency number.
 *
 * Works in the Expo WebView app: the dial is a plain `tel:` navigation, which the app hands to
 * the phone's dialler. Fits a 360 px screen. The page decides whether to show it (rule on).
 */
import { useEffect, useRef, useState } from "react";

import { L, tr, type Lang } from "@/lib/board/i18n";

const T = {
  sos: L("SOS", "SOS", "SOS"),
  sosLabel: L("SOS — emergency help", "SOS — आपातकालीन मदद", "SOS — आपत्कालीन मदत"),
  confirmTitle: L("Call {n} and alert GoKesari?", "{n} पर कॉल करें और GoKesari को सूचित करें?", "{n} वर कॉल करायचा आणि GoKesari ला कळवायचे?"),
  confirmBody: L(
    "Our team will see your location, phone number and current order at once.",
    "हमारी टीम को आपकी लोकेशन, फ़ोन नंबर और मौजूदा ऑर्डर तुरंत दिखेगा।",
    "आमच्या टीमला तुमचे लोकेशन, फोन नंबर आणि सध्याची ऑर्डर लगेच दिसेल.",
  ),
  yes: L("Yes, call {n}", "हाँ, {n} पर कॉल करें", "हो, {n} वर कॉल करा"),
  cancel: L("Cancel", "रद्द करें", "रद्द करा"),
  sending: L("Alerting GoKesari…", "GoKesari को सूचित कर रहे हैं…", "GoKesari ला कळवत आहोत…"),
  sent: L("GoKesari has been alerted.", "GoKesari को सूचित कर दिया गया है।", "GoKesari ला कळवले आहे."),
  helpOnWay: L("Help is on the way — our team is contacting you.", "मदद आ रही है — हमारी टीम आपसे संपर्क कर रही है।", "मदत येत आहे — आमची टीम तुमच्याशी संपर्क साधत आहे."),
  failed: L(
    "Could not alert GoKesari. Calling {n} now.",
    "GoKesari को सूचित नहीं कर सके। अब {n} पर कॉल कर रहे हैं।",
    "GoKesari ला कळवता आले नाही. आता {n} वर कॉल करत आहोत.",
  ),
  close: L("Close", "बंद करें", "बंद करा"),
  callAgain: L("Call {n}", "{n} पर कॉल करें", "{n} वर कॉल करा"),
} as const;

type Position = { latitude: number; longitude: number; accuracyM: number } | null;

function currentPosition(timeoutMs = 5000): Promise<Position> {
  return new Promise((resolve) => {
    if (typeof navigator === "undefined" || !navigator.geolocation) return resolve(null);
    let done = false;
    const finish = (value: Position) => {
      if (done) return;
      done = true;
      resolve(value);
    };
    // Some WebViews never call back when permission is pending; never wait longer than timeoutMs.
    const timer = setTimeout(() => finish(null), timeoutMs);
    try {
      navigator.geolocation.getCurrentPosition(
        (p) => {
          clearTimeout(timer);
          finish({ latitude: p.coords.latitude, longitude: p.coords.longitude, accuracyM: Math.round(p.coords.accuracy) });
        },
        () => {
          clearTimeout(timer);
          finish(null);
        },
        { enableHighAccuracy: true, timeout: timeoutMs, maximumAge: 30_000 },
      );
    } catch {
      clearTimeout(timer);
      finish(null);
    }
  });
}

type Stage = "idle" | "confirm" | "sending" | "sent" | "failed";

export function RiderSosButton({ emergencyNumber, lang, className }: { emergencyNumber: string; lang: Lang; className?: string }) {
  const [stage, setStage] = useState<Stage>("idle");
  const [acknowledged, setAcknowledged] = useState(false);
  const number = emergencyNumber.replace(/[^\d+]/g, "") || "112";
  const t = (text: (typeof T)[keyof typeof T]) => tr(text, lang).replace("{n}", number);
  const dialogRef = useRef<HTMLDivElement>(null);

  // After an alert, check now and then whether operations acknowledged it.
  useEffect(() => {
    if (stage !== "sent" || acknowledged) return;
    let stop = false;
    const check = async () => {
      try {
        const res = await fetch("/api/delivery-partner/sos", { cache: "no-store" });
        const data = await res.json().catch(() => null);
        if (!stop && data?.event?.status === "ACKNOWLEDGED") setAcknowledged(true);
      } catch {
        /* offline: try again on the next tick */
      }
    };
    const id = setInterval(check, 15_000);
    void check();
    return () => {
      stop = true;
      clearInterval(id);
    };
  }, [stage, acknowledged]);

  useEffect(() => {
    if (stage === "confirm") dialogRef.current?.querySelector<HTMLButtonElement>("[data-sos-confirm]")?.focus();
  }, [stage]);

  const dial = () => {
    window.location.href = `tel:${number}`;
  };

  async function confirm() {
    setStage("sending");
    let okay = false;
    try {
      const position = await currentPosition(5000);
      const res = await fetch("/api/delivery-partner/sos", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(position ?? {}),
      });
      okay = res.ok;
    } catch {
      okay = false;
    }
    setStage(okay ? "sent" : "failed");
    // Dial whatever happened to the alert: the call matters most.
    dial();
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setStage("confirm")}
        aria-label={tr(T.sosLabel, lang)}
        data-testid="rider-sos-button"
        className={
          className ??
          "inline-flex min-h-11 min-w-11 items-center justify-center rounded-full bg-red-600 px-4 text-base font-extrabold tracking-wider text-white shadow-md ring-2 ring-red-200 hover:bg-red-700 focus:outline-none focus-visible:ring-4 focus-visible:ring-red-300"
        }
      >
        {tr(T.sos, lang)}
      </button>

      {stage !== "idle" ? (
        <div className="fixed inset-0 z-[100] flex items-end justify-center bg-black/50 p-4 sm:items-center" role="presentation">
          <div
            ref={dialogRef}
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="rider-sos-title"
            className="w-full max-w-sm rounded-2xl bg-white p-5 shadow-xl"
            data-testid="rider-sos-dialog"
          >
            {stage === "confirm" ? (
              <>
                <h2 id="rider-sos-title" className="text-lg font-bold text-red-700">
                  {t(T.confirmTitle)}
                </h2>
                <p className="mt-2 text-sm text-ink-700">{t(T.confirmBody)}</p>
                <div className="mt-5 flex flex-col gap-2">
                  <button
                    type="button"
                    data-sos-confirm
                    onClick={confirm}
                    className="min-h-14 w-full rounded-xl bg-red-600 px-4 text-lg font-bold text-white hover:bg-red-700"
                  >
                    {t(T.yes)}
                  </button>
                  <button
                    type="button"
                    onClick={() => setStage("idle")}
                    className="min-h-11 w-full rounded-xl border border-cream-200 bg-white px-4 text-sm font-medium text-ink-700 hover:bg-cream-100"
                  >
                    {t(T.cancel)}
                  </button>
                </div>
              </>
            ) : (
              <>
                <h2 id="rider-sos-title" className="text-lg font-bold text-red-700" role="status">
                  {stage === "sending" ? t(T.sending) : stage === "failed" ? t(T.failed) : acknowledged ? t(T.helpOnWay) : t(T.sent)}
                </h2>
                {stage !== "sending" ? (
                  <div className="mt-5 flex flex-col gap-2">
                    <a href={`tel:${number}`} className="flex min-h-14 w-full items-center justify-center rounded-xl bg-red-600 px-4 text-lg font-bold text-white hover:bg-red-700">
                      {t(T.callAgain)}
                    </a>
                    <button
                      type="button"
                      onClick={() => setStage("idle")}
                      className="min-h-11 w-full rounded-xl border border-cream-200 bg-white px-4 text-sm font-medium text-ink-700 hover:bg-cream-100"
                    >
                      {t(T.close)}
                    </button>
                  </div>
                ) : null}
              </>
            )}
          </div>
        </div>
      ) : null}
    </>
  );
}
