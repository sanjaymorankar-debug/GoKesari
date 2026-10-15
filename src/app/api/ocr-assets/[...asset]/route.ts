/**
 * docs/document-upload-2026-10, "Reading in the browser": the files the
 * phone's or computer's browser needs to read a document photo itself —
 * tesseract.js's worker, its WebAssembly core and the English model — served
 * from our own site out of node_modules, so no outside CDN is involved and the
 * document never leaves the device to be read.
 *
 * Paths: /api/ocr-assets/<tesseract.js version>/worker.min.js,
 * …/core/<core file>, …/lang/eng.traineddata.gz. The version is in the path so
 * the files can be cached for a year; any other version is a 404.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";

import type { NextRequest } from "next/server";

import { OCR_ASSET_VERSION } from "@/lib/kyc/browser-ocr-assets";

export const dynamic = "force-dynamic";

const MODULES = path.join(process.cwd(), "node_modules");

/** Only these files, never a path built from the request. */
const ASSETS: Record<string, { file: string; type: string }> = {
  "worker.min.js": { file: path.join(MODULES, "tesseract.js", "dist", "worker.min.js"), type: "text/javascript" },
  // The LSTM engine only (OEM 1, the same as the server reader), in the three builds the worker picks between by device support.
  "core/tesseract-core-lstm.wasm.js": { file: path.join(MODULES, "tesseract.js-core", "tesseract-core-lstm.wasm.js"), type: "text/javascript" },
  "core/tesseract-core-simd-lstm.wasm.js": { file: path.join(MODULES, "tesseract.js-core", "tesseract-core-simd-lstm.wasm.js"), type: "text/javascript" },
  "core/tesseract-core-relaxedsimd-lstm.wasm.js": {
    file: path.join(MODULES, "tesseract.js-core", "tesseract-core-relaxedsimd-lstm.wasm.js"),
    type: "text/javascript",
  },
  // The model stays gzipped on the wire as a plain file: the worker un-gzips it itself (gzip: true).
  "lang/eng.traineddata.gz": {
    file: path.join(MODULES, "@tesseract.js-data", "eng", "4.0.0_best_int", "eng.traineddata.gz"),
    type: "application/octet-stream",
  },
};

export async function GET(_request: NextRequest, context: { params: Promise<{ asset: string[] }> }) {
  const [version, ...rest] = (await context.params).asset ?? [];
  const asset = ASSETS[rest.join("/")];
  if (!asset || version !== OCR_ASSET_VERSION) {
    return new Response("Not found", { status: 404 });
  }
  try {
    const body = await readFile(asset.file);
    return new Response(new Uint8Array(body), {
      headers: {
        "Content-Type": asset.type,
        "Content-Length": String(body.length),
        "Cache-Control": "public, max-age=31536000, immutable",
      },
    });
  } catch {
    return new Response("Not found", { status: 404 });
  }
}
