/** batch-2026-10 WS-E: reads the QR image back out of a PDF made by lib/pdf.ts and decodes it (jsQR). */
import jsQR from "jsqr";

export function pdfHasImage(pdf: Buffer): boolean {
  return pdf.toString("latin1").includes("/Subtype /Image");
}

/** The text in the PDF's QR code, or null when there is none / it does not decode. */
export function decodePdfQr(pdf: Buffer): string | null {
  const text = pdf.toString("latin1");
  const m = /\/Subtype \/Image \/Name \/QR1 \/Width (\d+) \/Height (\d+)[^]*?stream\n([0-9A-F\n]+)>/.exec(text);
  if (!m) return null;
  const n = Number(m[1]);
  const hex = m[3].replace(/\n/g, "");
  const scale = 4;
  const size = n * scale;
  const rgba = new Uint8ClampedArray(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const i = Math.floor(y / scale) * n + Math.floor(x / scale);
      const v = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
      const o = (y * size + x) * 4;
      rgba[o] = v;
      rgba[o + 1] = v;
      rgba[o + 2] = v;
      rgba[o + 3] = 255;
    }
  }
  return jsQR(rgba, size, size)?.data ?? null;
}
