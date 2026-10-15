/**
 * docs/document-upload-2026-10, "Reading in the browser": the route that
 * serves the browser's OCR files only ever serves its fixed list, at the
 * installed version.
 */
import { describe, expect, it } from "vitest";

import { GET } from "@/app/api/ocr-assets/[...asset]/route";
import { OCR_ASSET_BASE, OCR_ASSET_VERSION } from "@/lib/kyc/browser-ocr-assets";

const get = (...asset: string[]) => GET(new Request("http://localhost/x") as never, { params: Promise.resolve({ asset }) });

describe("/api/ocr-assets", () => {
  it("serves the worker, the LSTM cores and the English model at the installed version, cached for a year", async () => {
    expect(OCR_ASSET_BASE).toBe(`/api/ocr-assets/${OCR_ASSET_VERSION}`);
    for (const file of [
      ["worker.min.js"],
      ["core", "tesseract-core-lstm.wasm.js"],
      ["core", "tesseract-core-simd-lstm.wasm.js"],
      ["core", "tesseract-core-relaxedsimd-lstm.wasm.js"],
      ["lang", "eng.traineddata.gz"],
    ]) {
      const response = await get(OCR_ASSET_VERSION, ...file);
      expect(response.status, file.join("/")).toBe(200);
      expect(response.headers.get("cache-control")).toContain("immutable");
      expect(Number(response.headers.get("content-length"))).toBeGreaterThan(50_000);
    }
    const model = await get(OCR_ASSET_VERSION, "lang", "eng.traineddata.gz");
    expect(model.headers.get("content-type")).toBe("application/octet-stream");
    // Still gzipped: the worker un-gzips it itself.
    expect(Buffer.from(await model.arrayBuffer()).subarray(0, 2)).toEqual(Buffer.from([0x1f, 0x8b]));
  });

  it("refuses another version, other files and paths out of the list", async () => {
    expect((await get("0.0.1", "worker.min.js")).status).toBe(404);
    expect((await get(OCR_ASSET_VERSION, "core", "tesseract-core.wasm.js")).status).toBe(404);
    expect((await get(OCR_ASSET_VERSION, "..", "..", "package.json")).status).toBe(404);
    expect((await get(OCR_ASSET_VERSION)).status).toBe(404);
  });
});
