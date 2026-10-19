/**
 * batch-2026-10 WS-E: QR matrices for documents (invoice PDFs). Uses the
 * `qrcode` package's encoder only — the drawing is done by lib/pdf.ts, so no
 * image library is needed at runtime.
 */
import { create } from "qrcode";

export interface QrMatrix {
  /** Modules per side. */
  size: number;
  /** Row-major, 1 = dark. */
  modules: Uint8Array;
}

/** Error correction M (15%) — what GST portals use for invoice QR codes. */
export function qrMatrix(text: string, level: "L" | "M" | "Q" | "H" = "M"): QrMatrix {
  const code = create(text, { errorCorrectionLevel: level });
  const size = code.modules.size;
  const modules = new Uint8Array(size * size);
  for (let i = 0; i < size * size; i += 1) modules[i] = code.modules.data[i] ? 1 : 0;
  return { size, modules };
}
