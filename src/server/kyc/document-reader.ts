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
}

export type ReaderProvider = "tesseract" | "claude" | "off";

export function readerProvider(): ReaderProvider {
  const value = (process.env.DOCUMENT_OCR_PROVIDER ?? "tesseract").trim().toLowerCase();
  if (value === "off" || value === "none") return "off";
  if (value === "claude" && process.env.ANTHROPIC_API_KEY) return "claude";
  return "tesseract";
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
  return next;
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
      const text = await readPdfText(data);
      return { text, engine: "pdf-text", confidence: null, imageMinSide: null, note: text.trim() ? undefined : "pdf without text layer" };
    } catch (error) {
      return { text: "", engine: "pdf-text", confidence: null, imageMinSide: null, note: `pdf unreadable: ${(error as Error).name}` };
    }
  }
  try {
    const { text, confidence, minSide } = await readImageText(data);
    return { text, engine: "tesseract", confidence, imageMinSide: minSide };
  } catch (error) {
    return { text: "", engine: "tesseract", confidence: 0, imageMinSide: null, note: `ocr failed: ${(error as Error).name}` };
  }
}
