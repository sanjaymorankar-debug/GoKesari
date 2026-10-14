/**
 * Reads a document photo in the owner's own browser (phone, computer, or the
 * Android/iPhone app's web view), docs/document-upload-2026-10 "Reading in the
 * browser". The server's own OCR worker does not start on the shared host
 * (defect D-18), so the device does the reading and sends the text with the
 * photo; the server parses and checks it exactly as it would its own read.
 *
 * Same engine and model as the server reader (tesseract.js, LSTM, English
 * "best_int"), loaded from our own site (/api/ocr-assets). Nothing is sent
 * anywhere else. The model (~3 MB) is kept in the browser's storage after the
 * first read.
 *
 * Any failure — an old browser, no WebAssembly, too little memory, too slow —
 * returns null and the upload goes ahead without it, as before.
 */
import { OCR_ASSET_BASE } from "@/lib/kyc/browser-ocr-assets";

export interface BrowserRead {
  text: string;
  /** 0–100. */
  confidence: number;
}

/** A first read downloads ~5 MB once; slow phones on 4G need the time. Later reads take a few seconds. */
const BROWSER_READ_TIMEOUT_MS = 60_000;

type OcrWorker = Awaited<ReturnType<typeof import("tesseract.js")["createWorker"]>>;

let workerPromise: Promise<OcrWorker> | null = null;

function browserWorker(): Promise<OcrWorker> {
  if (!workerPromise) {
    workerPromise = import("tesseract.js")
      .then(({ createWorker }) =>
        createWorker("eng", 1, {
          workerPath: `${OCR_ASSET_BASE}/worker.min.js`,
          // A folder: the worker picks the relaxed-SIMD, SIMD or plain build the device supports.
          corePath: `${OCR_ASSET_BASE}/core`,
          langPath: `${OCR_ASSET_BASE}/lang`,
          gzip: true,
          // Load the worker from our own origin; a blob: worker would be refused by the site's CSP.
          workerBlobURL: false,
        }),
      )
      .catch((error) => {
        workerPromise = null;
        throw error;
      });
  }
  return workerPromise;
}

function dropWorker() {
  const pending = workerPromise;
  workerPromise = null;
  void pending?.then((w) => w.terminate()).catch(() => undefined);
}

/** Sizes the photo like the server reader does (long side 1600–2600 px) and makes it grey. */
async function preparedCanvas(file: Blob): Promise<HTMLCanvasElement> {
  const bitmap = await createImageBitmap(file);
  const longSide = Math.max(bitmap.width, bitmap.height);
  const target = longSide < 1600 ? 1600 : longSide > 2600 ? 2600 : longSide;
  const scale = target / longSide;
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("no canvas");
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close?.();
  const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const px = image.data;
  for (let i = 0; i < px.length; i += 4) {
    const grey = Math.round(0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2]);
    px[i] = px[i + 1] = px[i + 2] = grey;
  }
  ctx.putImageData(image, 0, 0);
  return canvas;
}

/** Can this browser try at all? (WebAssembly, workers, image decoding.) */
export function browserCanRead(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof WebAssembly === "object" &&
    typeof Worker === "function" &&
    typeof createImageBitmap === "function"
  );
}

export async function readInBrowser(file: Blob): Promise<BrowserRead | null> {
  if (!file.type.startsWith("image/") || !browserCanRead()) return null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const run = (async () => {
      const canvas = await preparedCanvas(file);
      const worker = await browserWorker();
      const { data } = await worker.recognize(canvas);
      return { text: (data.text ?? "").slice(0, 20_000), confidence: Math.max(0, Math.min(100, Math.round(data.confidence ?? 0))) };
    })();
    return await Promise.race([
      run,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => {
          dropWorker();
          resolve(null);
        }, BROWSER_READ_TIMEOUT_MS);
      }),
    ]);
  } catch {
    dropWorker();
    return null;
  } finally {
    clearTimeout(timer);
  }
}
