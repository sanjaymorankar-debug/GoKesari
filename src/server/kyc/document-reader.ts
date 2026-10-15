/**
 * Reads the text off an uploaded shop document (Task 2,
 * docs/document-upload-2026-10/README.md). Three engines:
 *
 *   pdf-text   a PDF with its own text layer (most e-certificates: GST REG-06,
 *              Udyam, FSSAI from FoSCoS) is read directly — exact, instant;
 *   tesseract  photos and scans, read on this server with tesseract.js and the
 *              English model shipped in node_modules (no outside service, no
 *              key, nothing leaves the server);
 *   claude     optional, only with DOCUMENT_OCR_PROVIDER=claude and an
 *              ANTHROPIC_API_KEY: Claude reads the image or PDF. It sends the
 *              document to Anthropic, so it is off unless the owner turns it on.
 *
 * Whatever an engine returns is only a suggestion the seller reviews; the
 * server re-validates what they confirm.
 */
import path from "node:path";

import type { ExtractedFields, UploadDocType } from "@/lib/kyc/document-extract";
import { UPLOAD_DOC_LABELS } from "@/lib/kyc/document-extract";

export type ReaderEngine = "pdf-text" | "tesseract" | "claude" | "none";

export interface ReadResult {
  text: string;
  engine: ReaderEngine;
  /** 0–100 for OCR; null when the text came from a PDF's text layer. */
  confidence: number | null;
  /** Smallest side of the image in pixels; null for PDFs. */
  imageMinSide: number | null;
  /** Fields read directly by an engine that understands documents (claude); merged over the text parse. */
  fields?: Partial<ExtractedFields>;
  /** Why nothing could be read, for the log (never shown with document content). */
  note?: string;
  /** The reader itself failed or timed out (not the document): ask the owner to type the details. */
  readerFailed?: boolean;
}

export type ReaderProvider = "tesseract" | "claude" | "off";

export function readerProvider(): ReaderProvider {
  const value = (process.env.DOCUMENT_OCR_PROVIDER ?? "tesseract").trim().toLowerCase();
  if (value === "off" || value === "none") return "off";
  if (value === "claude" && process.env.ANTHROPIC_API_KEY) return "claude";
  return "tesseract";
}

/** How long a read may take before the owner is asked to type the details (DOCUMENT_OCR_TIMEOUT_MS). */
export function readTimeoutMs(): number {
  const v = Number(process.env.DOCUMENT_OCR_TIMEOUT_MS);
  return Number.isFinite(v) && v >= 1000 ? v : 25_000;
}

export class ReadTimeoutError extends Error {
  constructor(stage: string) {
    super(`document reading took too long (${stage})`);
    this.name = "ReadTimeoutError";
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, stage: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new ReadTimeoutError(stage)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/** Drops a worker that hung, so the next read starts a fresh one. */
function resetOcrWorker(): void {
  const pending = globalOcr.__gkOcrWorker;
  globalOcr.__gkOcrWorker = null;
  globalOcr.__gkOcrQueue = Promise.resolve();
  void pending?.then((w) => w.terminate()).catch(() => undefined);
}

/* ---------------------------------------------------------------- pdf */

async function readPdfText(data: Buffer): Promise<string> {
  const { extractText, getDocumentProxy } = await import("unpdf");
  const pdf = await getDocumentProxy(new Uint8Array(data));
  // Certificates are one or two pages; more than five is not a certificate.
  const { text } = await extractText(pdf, { mergePages: true });
  return (Array.isArray(text) ? text.join("\n") : text).slice(0, 20_000);
}

/* ---------------------------------------------------------------- tesseract */

type TesseractWorker = Awaited<ReturnType<typeof import("tesseract.js")["createWorker"]>>;

const globalOcr = globalThis as unknown as {
  __gkOcrWorker?: Promise<TesseractWorker> | null;
  __gkOcrQueue?: Promise<unknown>;
  __gkOcrIdle?: ReturnType<typeof setTimeout> | null;
};

/** One worker for the process, freed after a minute idle (it holds ~100 MB). */
function ocrWorker(): Promise<TesseractWorker> {
  if (!globalOcr.__gkOcrWorker) {
    globalOcr.__gkOcrWorker = (async () => {
      const { createWorker } = await import("tesseract.js");
      const langPath =
        process.env.DOCUMENT_OCR_LANG_PATH ?? path.join(process.cwd(), "node_modules", "@tesseract.js-data", "eng", "4.0.0_best_int");
      return createWorker("eng", 1, { langPath, cacheMethod: "none", gzip: true });
    })().catch((error) => {
      globalOcr.__gkOcrWorker = null;
      throw error;
    });
  }
  return globalOcr.__gkOcrWorker;
}

function scheduleIdleShutdown() {
  if (globalOcr.__gkOcrIdle) clearTimeout(globalOcr.__gkOcrIdle);
  globalOcr.__gkOcrIdle = setTimeout(() => {
    const pending = globalOcr.__gkOcrWorker;
    globalOcr.__gkOcrWorker = null;
    globalOcr.__gkOcrIdle = null;
    void pending?.then((w) => w.terminate()).catch(() => undefined);
  }, 60_000);
  globalOcr.__gkOcrIdle.unref?.();
}

/** Straightens, sizes and cleans a phone photo so the OCR reads it well. */
async function prepareImage(data: Buffer): Promise<{ png: Buffer; minSide: number }> {
  const sharp = (await import("sharp")).default;
  const rotated = sharp(data, { failOn: "none" }).rotate();
  const meta = await rotated.metadata();
  const width = meta.autoOrient?.width ?? meta.width ?? 0;
  const height = meta.autoOrient?.height ?? meta.height ?? 0;
  const minSide = Math.min(width, height);
  const longSide = Math.max(width, height);
  // Small pictures are enlarged (OCR wants ~30px letters); huge ones shrunk to keep memory and time in check.
  const target = longSide < 1600 ? 1600 : longSide > 2600 ? 2600 : longSide;
  const png = await rotated
    .resize({ width: width >= height ? target : undefined, height: height > width ? target : undefined, fit: "inside" })
    .grayscale()
    .normalize()
    .sharpen()
    .png()
    .toBuffer();
  return { png, minSide };
}

async function readImageText(data: Buffer): Promise<{ text: string; confidence: number; minSide: number }> {
  const { png, minSide } = await prepareImage(data);
  // One recognition at a time: tesseract.js workers are single-threaded.
  const run = async () => {
    const worker = await ocrWorker();
    const result = await worker.recognize(png);
    scheduleIdleShutdown();
    return { text: result.data.text ?? "", confidence: Math.round(result.data.confidence ?? 0), minSide };
  };
  const previous = globalOcr.__gkOcrQueue ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(run);
  globalOcr.__gkOcrQueue = next.catch(() => undefined);
  try {
    return await withTimeout(next, readTimeoutMs(), "ocr");
  } catch (error) {
    if (error instanceof ReadTimeoutError) resetOcrWorker();
    throw error;
  }
}

/**
 * The same local OCR for other callers (supplier bills, docs/inventory-accounting-2026-10):
 * one shared worker and queue, the same time limit.
 */
export async function ocrImageText(data: Buffer): Promise<{ text: string; confidence: number }> {
  const { text, confidence } = await readImageText(data);
  return { text, confidence };
}

/** PDF text layer, for other callers (empty for a scanned PDF). */
export async function pdfText(data: Buffer): Promise<string> {
  return withTimeout(readPdfText(data), readTimeoutMs(), "pdf");
}

/* ---------------------------------------------------------------- claude */

async function readWithClaude(
  data: Buffer,
  contentType: string,
  docType: UploadDocType,
): Promise<ReadResult | null> {
  const [{ default: Anthropic }, { zodOutputFormat }, { z }] = await Promise.all([
    import("@anthropic-ai/sdk"),
    import("@anthropic-ai/sdk/helpers/zod"),
    import("zod"),
  ]);
  const schema = z.object({
    document_type: z.enum(["PAN", "GSTIN", "UDYAM", "FSSAI", "SHOP_ACT", "DRUG_LICENCE", "MEDICAL_REGISTRATION", "OTHER", "UNREADABLE"]),
    number: z.string().nullable(),
    name: z.string().nullable(),
    address: z.string().nullable(),
    valid_from: z.string().nullable(),
    valid_until: z.string().nullable(),
    full_text: z.string(),
  });
  const client = new Anthropic();
  const source =
    contentType === "application/pdf"
      ? ({ type: "document", source: { type: "base64", media_type: "application/pdf", data: data.toString("base64") } } as const)
      : ({
          type: "image",
          source: { type: "base64", media_type: contentType as "image/jpeg" | "image/png" | "image/webp", data: data.toString("base64") },
        } as const);
  const response = await client.messages.parse({
    model: process.env.DOCUMENT_OCR_CLAUDE_MODEL ?? "claude-opus-5-5",
    max_tokens: 4000,
    output_config: { effort: "low", format: zodOutputFormat(schema) },
    messages: [
      {
        role: "user",
        content: [
          source,
          {
            type: "text",
            text:
              `This should be an Indian shop's ${UPLOAD_DOC_LABELS[docType]}. Read it and fill the fields exactly as printed. ` +
              "Dates as YYYY-MM-DD. valid_until is the expiry / 'valid up to' date. name is the licensee, proprietor or business name the document is issued to. " +
              "Use null for anything not on the document. Never copy an Aadhaar number into any field. " +
              "If the image is too blurred or cut off to read, set document_type to UNREADABLE.",
          },
        ],
      },
    ],
  });
  if (response.stop_reason === "refusal" || !response.parsed_output) return null;
  const out = response.parsed_output;
  const known = out.document_type !== "OTHER" && out.document_type !== "UNREADABLE" ? out.document_type : null;
  return {
    text: out.document_type === "UNREADABLE" ? "" : out.full_text,
    engine: "claude",
    confidence: out.document_type === "UNREADABLE" ? 0 : 90,
    imageMinSide: null,
    fields: {
      detectedType: known,
      number: out.number,
      name: out.name,
      address: out.address,
      validFrom: out.valid_from,
      validUntil: out.valid_until,
    },
  };
}

/* ---------------------------------------------------------------- entry */

type ReaderOverride = (data: Buffer, contentType: string, docType: UploadDocType) => Promise<ReadResult>;
let readerOverride: ReaderOverride | null = null;

/** Tests only: replace the engines with a fixed reader (null restores them). */
export function setDocumentReaderForTests(reader: ReaderOverride | null): void {
  readerOverride = reader;
}

export async function readDocument(data: Buffer, contentType: string, docType: UploadDocType): Promise<ReadResult> {
  if (readerOverride) return readerOverride(data, contentType, docType);
  const provider = readerProvider();
  if (provider === "off") return { text: "", engine: "none", confidence: null, imageMinSide: null, note: "reader off" };

  if (provider === "claude") {
    try {
      const result = await readWithClaude(data, contentType, docType);
      if (result) return result;
    } catch (error) {
      console.warn(`[document-reader] claude failed, falling back to local OCR: ${(error as Error).name}`);
    }
  }

  if (contentType === "application/pdf") {
    try {
      const text = await withTimeout(readPdfText(data), readTimeoutMs(), "pdf");
      return { text, engine: "pdf-text", confidence: null, imageMinSide: null, note: text.trim() ? undefined : "pdf without text layer" };
    } catch (error) {
      return { text: "", engine: "pdf-text", confidence: null, imageMinSide: null, note: `pdf unreadable: ${(error as Error).name}` };
    }
  }
  try {
    const { text, confidence, minSide } = await readImageText(data);
    return { text, engine: "tesseract", confidence, imageMinSide: minSide };
  } catch (error) {
    console.warn(`[document-reader] ${(error as Error).name}: ${(error as Error).message}`);
    // The reader failing is not the document's fault: the owner types the details instead.
    return { text: "", engine: "tesseract", confidence: null, imageMinSide: null, note: "reader unavailable", readerFailed: true };
  }
}

/**
 * Admin diagnostics (GET /api/admin/document-reader): reads a small generated
 * image and reports how long each stage took, or where it stopped. No
 * document content is involved.
 */
export async function readerHealth(): Promise<{ provider: ReaderProvider; ok: boolean; stages: { stage: string; ms: number; ok: boolean; error?: string }[]; text?: string }> {
  const stages: { stage: string; ms: number; ok: boolean; error?: string }[] = [];
  const timed = async <T>(stage: string, fn: () => Promise<T>, ms: number): Promise<T | null> => {
    const started = Date.now();
    try {
      const value = await withTimeout(fn(), ms, stage);
      stages.push({ stage, ms: Date.now() - started, ok: true });
      return value;
    } catch (error) {
      stages.push({ stage, ms: Date.now() - started, ok: false, error: `${(error as Error).name}: ${(error as Error).message}`.slice(0, 300) });
      return null;
    }
  };
  const sharp = await timed("load sharp", async () => (await import("sharp")).default, 15_000);
  const png = sharp
    ? await timed(
        "render test image",
        () =>
          sharp({ create: { width: 900, height: 160, channels: 3, background: "#ffffff" } })
            .composite([{ input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="900" height="160"><text x="20" y="100" font-size="56" font-family="sans-serif">LICENSE 11521998000123</text></svg>`) }])
            .png()
            .toBuffer(),
        15_000,
      )
    : null;
  const langPath = process.env.DOCUMENT_OCR_LANG_PATH ?? path.join(process.cwd(), "node_modules", "@tesseract.js-data", "eng", "4.0.0_best_int");
  await timed("find language model", async () => {
    const { stat } = await import("node:fs/promises");
    await stat(path.join(langPath, "eng.traineddata.gz"));
  }, 5_000);
  await timed("load tesseract.js", () => import("tesseract.js"), 15_000);
  resetOcrWorker();
  const worker = await timed("start OCR worker", () => ocrWorker(), 45_000);
  let text: string | undefined;
  if (worker && png) {
    const result = await timed("recognise", () => worker.recognize(png), 45_000);
    text = result?.data.text?.trim();
  }
  scheduleIdleShutdown();
  return { provider: readerProvider(), ok: stages.every((s) => s.ok), stages, text };
}
