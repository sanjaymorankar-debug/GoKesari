"use client";

import { useEffect, useRef, useState } from "react";

import { Button, inputClass } from "@/components/ui";

type Detector = { detect: (source: CanvasImageSource) => Promise<{ rawValue: string }[]> };
type DetectorClass = new (options: { formats: string[] }) => Detector;

const FORMATS = ["ean_13", "ean_8", "upc_a", "upc_e", "code_128"];

/**
 * Camera barcode scanner (onboarding Phase 2, WP2), shared by any screen that adds products by code.
 * The browser's own BarcodeDetector where it exists (Android Chrome and the Android app); ZXing,
 * loaded only when needed, where it does not (iPhone Safari and the iOS app); and always a box to
 * type the number printed under the bars. Calls `onCode` once with the code and stops the camera.
 */
export function BarcodeScanner({ onCode, onClose }: { onCode: (code: string) => void; onClose: () => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const [status, setStatus] = useState<"starting" | "scanning" | "no-camera">("starting");
  const [typed, setTyped] = useState("");
  const done = useRef(false);

  useEffect(() => {
    let stop: (() => void) | null = null;
    let cancelled = false;
    const finish = (code: string) => {
      if (done.current) return;
      done.current = true;
      stop?.();
      onCode(code);
    };
    void (async () => {
      const element = video.current;
      if (!element || !navigator.mediaDevices?.getUserMedia) return setStatus("no-camera");
      const Native = (window as unknown as { BarcodeDetector?: DetectorClass }).BarcodeDetector;
      try {
        if (Native) {
          const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
          if (cancelled) return stream.getTracks().forEach((t) => t.stop());
          element.srcObject = stream;
          await element.play();
          const detector = new Native({ formats: FORMATS });
          const timer = window.setInterval(async () => {
            const [hit] = await detector.detect(element).catch(() => []);
            if (hit?.rawValue) finish(hit.rawValue);
          }, 250);
          stop = () => {
            window.clearInterval(timer);
            stream.getTracks().forEach((t) => t.stop());
          };
        } else {
          const { BrowserMultiFormatReader } = await import("@zxing/browser");
          if (cancelled) return;
          const controls = await new BrowserMultiFormatReader().decodeFromConstraints({ video: { facingMode: "environment" } }, element, (result) => {
            if (result) finish(result.getText());
          });
          stop = () => controls.stop();
        }
        if (cancelled) stop();
        else setStatus("scanning");
      } catch {
        // Permission refused or no camera: the typed number still works.
        if (!cancelled) setStatus("no-camera");
      }
    })();
    return () => {
      cancelled = true;
      stop?.();
    };
  }, [onCode]);

  return (
    <div className="space-y-2 rounded-xl border border-[var(--gk-line)] bg-white p-3" data-testid="barcode-scanner">
      <div className="relative overflow-hidden rounded-lg bg-ink-900" hidden={status === "no-camera"}>
        <video ref={video} className="h-48 w-full object-cover" muted playsInline aria-label="Camera view for scanning a barcode" />
        <div className="pointer-events-none absolute inset-x-6 top-1/2 h-0.5 -translate-y-1/2 bg-red-500/80" aria-hidden />
      </div>
      <p className="text-sm text-ink-600" role="status">
        {status === "starting" ? "Starting the camera…" : status === "scanning" ? "Hold the barcode inside the box." : "The camera is not available here — type the number under the barcode."}
      </p>
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          const code = typed.replace(/\s/g, "");
          if (code.length >= 6 && !done.current) {
            done.current = true;
            onCode(code);
          }
        }}
      >
        <input
          className={`${inputClass} flex-1`}
          inputMode="numeric"
          placeholder="Or type the barcode number"
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          aria-label="Barcode number"
        />
        <Button type="submit" variant="secondary">
          Find
        </Button>
      </form>
      <Button type="button" variant="ghost" onClick={onClose}>
        Close
      </Button>
    </div>
  );
}
