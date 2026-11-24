"use client";

/**
 * F4.1.3 (batch-2026-10 WS-B): the rider scans the shop's pickup QR with the
 * phone camera (getUserMedia + jsQR — works in browsers and in the Android/iOS
 * app's WebView once camera permission is granted). The decoded text and the
 * rider's location go to the server, which checks the signature, that it is
 * this rider's order and that the QR is unused, and marks the parcel picked
 * up. Whatever goes wrong — no camera, a refused QR — the rider types the
 * shop's pickup code below instead.
 */
import jsQR from "jsqr";
import { useEffect, useEffectEvent, useRef, useState } from "react";

import { Alert, Button } from "@/components/ui";
import { errorText } from "@/lib/board/error-text";
import { L, tr, type Lang } from "@/lib/board/i18n";

/** Module 6 (docs/hindi-marathi-2026-11/). */
const T = {
  errQr: L(
    "That QR could not be used. Type the pickup code instead.",
    "यह QR इस्तेमाल नहीं हो सका। इसकी जगह पिकअप कोड डालें।",
    "हा QR वापरता आला नाही. त्याऐवजी पिकअप कोड टाका.",
  ),
  errServer: L(
    "Could not reach the server. Check your connection, or type the pickup code.",
    "सर्वर से संपर्क नहीं हो सका। इंटरनेट देखें, या पिकअप कोड डालें।",
    "सर्व्हरशी संपर्क झाला नाही. इंटरनेट तपासा, किंवा पिकअप कोड टाका.",
  ),
  noCamera: L(
    "This device's camera isn't available here. Type the pickup code from the shop instead.",
    "इस डिवाइस का कैमरा यहाँ उपलब्ध नहीं है। इसकी जगह दुकान से मिला पिकअप कोड डालें।",
    "या डिव्हाइसचा कॅमेरा इथे उपलब्ध नाही. त्याऐवजी दुकानाकडून मिळालेला पिकअप कोड टाका.",
  ),
  denied: L(
    "Camera permission was refused. Allow the camera for this site (or the app), or type the pickup code instead.",
    "कैमरे की अनुमति नहीं मिली। इस साइट (या ऐप) को कैमरे की अनुमति दें, या पिकअप कोड डालें।",
    "कॅमेऱ्याची परवानगी नाकारली. या साइटला (किंवा ॲपला) कॅमेऱ्याची परवानगी द्या, किंवा पिकअप कोड टाका.",
  ),
  noStart: L(
    "The camera could not be started. Type the pickup code from the shop instead.",
    "कैमरा शुरू नहीं हो सका। इसकी जगह दुकान से मिला पिकअप कोड डालें।",
    "कॅमेरा सुरू करता आला नाही. त्याऐवजी दुकानाकडून मिळालेला पिकअप कोड टाका.",
  ),
  confirmed: L("Pickup confirmed by QR ✓", "QR से पिकअप पक्का हुआ ✓", "QR ने पिकअप निश्चित झाले ✓"),
  point: L(
    "Point the camera at the QR on the order screen or packing slip.",
    "कैमरे को ऑर्डर स्क्रीन या पैकिंग स्लिप पर बने QR की ओर करें।",
    "कॅमेरा ऑर्डर स्क्रीन किंवा पॅकिंग स्लिपवरील QR कडे धरा.",
  ),
  cancel: L("Cancel scan", "स्कैन रद्द करें", "स्कॅन रद्द करा"),
  checking: L("Checking…", "जाँच हो रही है…", "तपासत आहे…"),
  scan: L("Scan pickup QR", "पिकअप QR स्कैन करें", "पिकअप QR स्कॅन करा"),
  useCode: L("Use the pickup code", "पिकअप कोड इस्तेमाल करें", "पिकअप कोड वापरा"),
  orType: L(
    "Or type the 4-digit pickup code the shop gives you.",
    "या दुकान से मिला 4 अंकों का पिकअप कोड डालें।",
    "किंवा दुकानाने दिलेला 4 अंकी पिकअप कोड टाका.",
  ),
} as const;

const SCAN_INTERVAL_MS = 250;
const GPS_TIMEOUT_MS = 8_000;

function currentPosition(): Promise<{ latitude: number; longitude: number; accuracyM: number } | null> {
  return new Promise((resolve) => {
    if (!("geolocation" in navigator)) return resolve(null);
    try {
      navigator.geolocation.getCurrentPosition(
        (p) => resolve({ latitude: p.coords.latitude, longitude: p.coords.longitude, accuracyM: p.coords.accuracy }),
        () => resolve(null),
        { enableHighAccuracy: true, timeout: GPS_TIMEOUT_MS, maximumAge: 30_000 },
      );
    } catch {
      resolve(null);
    }
  });
}

export function PickupQrScanner({
  deliveryOrderId,
  onPickedUp,
  lang = "en",
}: {
  deliveryOrderId: string;
  onPickedUp: () => void;
  lang?: Lang;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const pickedUp = useEffectEvent(() => onPickedUp());

  useEffect(() => {
    if (!open) return;
    let stream: MediaStream | null = null;
    let timer: ReturnType<typeof setInterval> | null = null;
    let disposed = false;
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d", { willReadFrequently: true });

    async function submit(payload: string) {
      setBusy(true);
      const position = await currentPosition();
      try {
        const res = await fetch(`/api/delivery-orders/${deliveryOrderId}/pickup-scan`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ payload, ...(position ?? {}) }),
        });
        if (res.ok) {
          setDone(true);
          setOpen(false);
          pickedUp();
          return;
        }
        const body = await res.json().catch(() => null);
        setError(errorText(body?.error?.message ?? tr(T.errQr, lang), lang, body?.error?.code));
        setOpen(false);
      } catch {
        setError(tr(T.errServer, lang));
        setOpen(false);
      } finally {
        setBusy(false);
      }
    }

    async function start() {
      if (!navigator.mediaDevices?.getUserMedia) {
        setError(tr(T.noCamera, lang));
        setOpen(false);
        return;
      }
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio: false });
      } catch (err) {
        const denied = err instanceof DOMException && (err.name === "NotAllowedError" || err.name === "SecurityError");
        setError(
          denied ? tr(T.denied, lang) : tr(T.noStart, lang),
        );
        setOpen(false);
        return;
      }
      if (disposed) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      const video = videoRef.current;
      if (!video) return;
      video.srcObject = stream;
      video.setAttribute("playsinline", "true");
      await video.play().catch(() => {});
      timer = setInterval(() => {
        if (!ctx || video.readyState < 2 || !video.videoWidth) return;
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const code = jsQR(image.data, image.width, image.height, { inversionAttempts: "dontInvert" });
        if (code?.data) {
          if (timer) clearInterval(timer);
          timer = null;
          stream?.getTracks().forEach((t) => t.stop());
          void submit(code.data);
        }
      }, SCAN_INTERVAL_MS);
    }

    void start();
    return () => {
      disposed = true;
      if (timer) clearInterval(timer);
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, [open, deliveryOrderId, lang]);

  if (done) return <p className="w-full text-sm text-leaf-800">{tr(T.confirmed, lang)}</p>;

  return (
    <div className="w-full space-y-2" data-testid="pickup-qr-scanner">
      {open ? (
        <div className="space-y-2">
          <video ref={videoRef} className="aspect-square w-full max-w-xs rounded-lg bg-ink-900 object-cover" muted />
          <p className="text-xs text-ink-500">{tr(T.point, lang)}</p>
          <Button size="sm" variant="secondary" onClick={() => setOpen(false)}>
            {tr(T.cancel, lang)}
          </Button>
        </div>
      ) : (
        <Button
          size="sm"
          disabled={busy}
          onClick={() => {
            setError(null);
            setOpen(true);
          }}
        >
          {tr(busy ? T.checking : T.scan, lang)}
        </Button>
      )}
      {error ? (
        <Alert tone="warning" title={tr(T.useCode, lang)}>
          {error}
        </Alert>
      ) : (
        <p className="text-xs text-ink-500">{tr(T.orType, lang)}</p>
      )}
    </div>
  );
}
