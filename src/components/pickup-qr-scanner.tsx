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

export function PickupQrScanner({ deliveryOrderId, onPickedUp }: { deliveryOrderId: string; onPickedUp: () => void }) {
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
        setError(body?.error?.message ?? "That QR could not be used. Type the pickup code instead.");
        setOpen(false);
      } catch {
        setError("Could not reach the server. Check your connection, or type the pickup code.");
        setOpen(false);
      } finally {
        setBusy(false);
      }
    }

    async function start() {
      if (!navigator.mediaDevices?.getUserMedia) {
        setError("This device's camera isn't available here. Type the pickup code from the shop instead.");
        setOpen(false);
        return;
      }
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio: false });
      } catch (err) {
        const denied = err instanceof DOMException && (err.name === "NotAllowedError" || err.name === "SecurityError");
        setError(
          denied
            ? "Camera permission was refused. Allow the camera for this site (or the app), or type the pickup code instead."
            : "The camera could not be started. Type the pickup code from the shop instead.",
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
  }, [open, deliveryOrderId]);

  if (done) return <p className="w-full text-sm text-leaf-800">Pickup confirmed by QR ✓</p>;

  return (
    <div className="w-full space-y-2" data-testid="pickup-qr-scanner">
      {open ? (
        <div className="space-y-2">
          <video ref={videoRef} className="aspect-square w-full max-w-xs rounded-lg bg-ink-900 object-cover" muted />
          <p className="text-xs text-ink-500">Point the camera at the QR on the order screen or packing slip.</p>
          <Button size="sm" variant="secondary" onClick={() => setOpen(false)}>
            Cancel scan
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
          {busy ? "Checking…" : "Scan pickup QR"}
        </Button>
      )}
      {error ? (
        <Alert tone="warning" title="Use the pickup code">
          {error}
        </Alert>
      ) : (
        <p className="text-xs text-ink-500">Or type the 4-digit pickup code the shop gives you.</p>
      )}
    </div>
  );
}
