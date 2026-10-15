"use client";

/**
 * Add a supplier bill (docs/inventory-accounting-2026-10, Parts 4–5): scan a
 * paper bill with the camera (edges found, cropped, straightened, cleaned,
 * several pages), or upload the soft copy (PDF, photo, Excel, e-invoice
 * JSON), or type it in. Uploads show progress for slow networks; the bill is
 * then read in the background and opens on the review screen.
 */
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";

import { Alert, Button, Card } from "@/components/ui";
import type { Lang } from "@/lib/board/i18n";

import { accountsApi, uploadWithProgress, ApiError } from "./api";
import { BillScanner, type BillScannerLabelKey, type ScannedPage } from "./bill-scanner";

const SCANNER_LABELS: Record<Exclude<Lang, "en">, Partial<Record<BillScannerLabelKey, string>>> = {
  hi: {
    take: "फ़ोटो लें",
    addPage: "पेज जोड़ें",
    retake: "फिर से लें",
    done: "हो गया",
    adjust: "कोने ठीक करें",
    modeColor: "रंगीन",
    modeGray: "ग्रे",
    modeBw: "काला-सफ़ेद",
    blurred: "फ़ोटो धुंधली है — फिर से लें?",
    noEdges: "किनारे नहीं मिले — पूरी फ़ोटो ली जाएगी; ज़रूरत हो तो कोने ठीक करें",
    pageOf: "पेज {n} / {total}",
    remove: "हटाएँ",
    moveUp: "ऊपर",
    moveDown: "नीचे",
    fromGallery: "गैलरी / फ़ाइल से चुनें",
    cancel: "रद्द करें",
    apply: "ये कोने लें",
  },
  mr: {
    take: "फोटो घ्या",
    addPage: "पान जोडा",
    retake: "पुन्हा घ्या",
    done: "झाले",
    adjust: "कोपरे दुरुस्त करा",
    modeColor: "रंगीत",
    modeGray: "ग्रे",
    modeBw: "काळा-पांढरा",
    blurred: "फोटो अस्पष्ट आहे — पुन्हा घ्यायचा?",
    noEdges: "कडा सापडल्या नाहीत — पूर्ण फोटो वापरला जाईल; हवे तर कोपरे दुरुस्त करा",
    pageOf: "पान {n} / {total}",
    remove: "काढा",
    moveUp: "वर",
    moveDown: "खाली",
    fromGallery: "गॅलरी / फाइलमधून निवडा",
    cancel: "रद्द",
    apply: "हे कोपरे वापरा",
  },
};

const ACCEPT = ".pdf,.json,.xlsx,.xls,.csv,image/jpeg,image/png,image/webp,application/pdf,application/json";

export function BillCapture({ shopId, lang, startWithScanner, shopQuery = "" }: { shopId: string; lang: Lang; startWithScanner: boolean; shopQuery?: string }) {
  const router = useRouter();
  const [mode, setMode] = useState<"choose" | "scan">(startWithScanner ? "scan" : "choose");
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [files, setFiles] = useState<File[]>([]);
  const fileInput = useRef<HTMLInputElement>(null);

  async function send(parts: { blob: Blob; name: string }[], kind: "SOFT" | "HARD", source: "UPLOAD" | "CAMERA") {
    setError(null);
    setProgress(0);
    const form = new FormData();
    form.set("kind", kind);
    form.set("source", source);
    for (const p of parts) form.append("file", p.blob, p.name);
    try {
      const capture = await uploadWithProgress<{ id: string }>(`/api/shops/${shopId}/accounts/bills`, form, setProgress);
      router.push(`/shop/accounts/bills/${capture.id}${shopQuery}`);
    } catch (e) {
      setProgress(null);
      setError(e instanceof ApiError ? e.message : "Upload failed. Try again.");
    }
  }

  async function onScanned(pages: ScannedPage[]) {
    await send(pages.map((p, i) => ({ blob: p.blob, name: `page-${i + 1}.jpg` })), "HARD", "CAMERA");
  }

  async function typeByHand() {
    setError(null);
    try {
      const capture = await accountsApi<{ id: string }>(shopId, "bills/manual", { method: "POST", body: {} });
      router.push(`/shop/accounts/bills/${capture.id}${shopQuery}`);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Could not start a new bill.");
    }
  }

  const busy = progress !== null;

  return (
    <div className="space-y-3">
      {error ? (
        <div aria-live="assertive">
          <Alert tone="danger">{error}</Alert>
        </div>
      ) : null}
      {busy ? (
        <Card className="p-4" aria-live="polite">
          <p className="mb-2 text-sm font-semibold text-ink-900">{progress! < 100 ? `Uploading… ${progress}%` : "Uploaded — reading the bill…"}</p>
          <div className="h-3 w-full overflow-hidden rounded-full bg-cream-200">
            <div className="h-full bg-kesari-600 transition-[width]" style={{ width: `${progress}%` }} />
          </div>
          <p className="mt-2 text-xs text-ink-600">You can leave this page: you will be notified when the bill is ready to check.</p>
        </Card>
      ) : null}

      {mode === "scan" ? (
        <Card className="p-3">
          <BillScanner onDone={onScanned} onCancel={() => setMode("choose")} busy={busy} labels={lang === "en" ? undefined : SCANNER_LABELS[lang]} />
        </Card>
      ) : (
        <div className="grid gap-2 sm:grid-cols-3">
          <button
            type="button"
            onClick={() => setMode("scan")}
            disabled={busy}
            className="flex min-h-28 flex-col items-start justify-center gap-1 rounded-2xl bg-kesari-100 p-4 text-left hover:brightness-95"
            data-testid="capture-scan"
          >
            <span className="text-lg font-bold text-ink-900">Scan paper bill</span>
            <span className="text-sm text-ink-700">Phone camera · auto crop &amp; straighten · several pages</span>
          </button>
          <div className="flex min-h-28 flex-col justify-center gap-2 rounded-2xl bg-teal-100 p-4">
            <span className="text-lg font-bold text-ink-900">Upload soft copy</span>
            <span className="text-sm text-ink-700">PDF, photo, Excel or e-invoice JSON (up to 10 files)</span>
            <input
              ref={fileInput}
              type="file"
              multiple
              accept={ACCEPT}
              className="sr-only"
              data-testid="capture-file"
              onChange={(e) => setFiles(Array.from(e.target.files ?? []).slice(0, 10))}
            />
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="secondary" onClick={() => fileInput.current?.click()} disabled={busy}>
                Choose files
              </Button>
              {files.length > 0 ? (
                <Button size="sm" onClick={() => void send(files.map((f) => ({ blob: f, name: f.name })), "SOFT", "UPLOAD")} disabled={busy} data-testid="capture-upload">
                  Upload {files.length} file{files.length === 1 ? "" : "s"}
                </Button>
              ) : null}
            </div>
            {files.length > 0 ? <p className="truncate text-xs text-ink-700">{files.map((f) => f.name).join(", ")}</p> : null}
          </div>
          <button
            type="button"
            onClick={() => void typeByHand()}
            disabled={busy}
            className="flex min-h-28 flex-col items-start justify-center gap-1 rounded-2xl bg-blue-100 p-4 text-left hover:brightness-95"
            data-testid="capture-manual"
          >
            <span className="text-lg font-bold text-ink-900">Type the bill</span>
            <span className="text-sm text-ink-700">No photo — enter the items yourself</span>
          </button>
        </div>
      )}
      <p className="text-xs text-ink-600">
        Nothing is added to your stock until you check the bill and press Confirm. E-invoices are read from their signed QR code or JSON — the most reliable way.
      </p>
    </div>
  );
}
