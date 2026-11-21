/**
 * docs/shop-welcome-kit-2026-11: a one-page PDF that holds a single JPEG,
 * centred on an A4 page with a margin and scaled to fit (aspect kept). Used for
 * the printable shop banner. The JPEG is embedded as-is (DCTDecode), so no PDF
 * library is needed; every PDF reader and print shop can open it.
 */

/** A4 in points (1/72 inch). */
export const A4_PORTRAIT = { width: 595.28, height: 841.89 } as const;
export const A4_LANDSCAPE = { width: 841.89, height: 595.28 } as const;

export interface ImagePdfInput {
  jpeg: Buffer;
  /** Pixel size of the JPEG. */
  widthPx: number;
  heightPx: number;
  page?: { width: number; height: number };
  /** Space kept clear on every side, in points (default 24 ≈ 8.5 mm). */
  marginPt?: number;
  title?: string;
}

function pdfString(text: string): string {
  return `(${text.replace(/[^\x20-\x7e]/g, "?").replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)")})`;
}

export function imagePdf(input: ImagePdfInput): Buffer {
  const page = input.page ?? (input.widthPx >= input.heightPx ? A4_LANDSCAPE : A4_PORTRAIT);
  const margin = input.marginPt ?? 24;
  const scale = Math.min((page.width - 2 * margin) / input.widthPx, (page.height - 2 * margin) / input.heightPx);
  const w = input.widthPx * scale;
  const h = input.heightPx * scale;
  const x = (page.width - w) / 2;
  const y = (page.height - h) / 2;
  const content = `q\n${w.toFixed(2)} 0 0 ${h.toFixed(2)} ${x.toFixed(2)} ${y.toFixed(2)} cm\n/Im1 Do\nQ\n`;

  const chunks: Buffer[] = [];
  const offsets: number[] = [];
  let length = 0;
  const push = (part: string | Buffer) => {
    const buf = typeof part === "string" ? Buffer.from(part, "latin1") : part;
    chunks.push(buf);
    length += buf.length;
  };
  const object = (n: number, body: () => void) => {
    offsets[n] = length;
    push(`${n} 0 obj\n`);
    body();
    push(`\nendobj\n`);
  };

  push("%PDF-1.4\n%\xe2\xe3\xcf\xd3\n");
  object(1, () => push(`<< /Type /Catalog /Pages 2 0 R >>`));
  object(2, () => push(`<< /Type /Pages /Kids [3 0 R] /Count 1 >>`));
  object(3, () =>
    push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${page.width} ${page.height}] ` +
        `/Resources << /XObject << /Im1 4 0 R >> >> /Contents 5 0 R >>`,
    ),
  );
  object(4, () => {
    push(
      `<< /Type /XObject /Subtype /Image /Width ${input.widthPx} /Height ${input.heightPx} ` +
        `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${input.jpeg.length} >>\nstream\n`,
    );
    push(input.jpeg);
    push(`\nendstream`);
  });
  object(5, () => push(`<< /Length ${Buffer.byteLength(content, "latin1")} >>\nstream\n${content}endstream`));
  object(6, () => push(`<< /Title ${pdfString(input.title ?? "GoKesari")} /Producer (GoKesari) >>`));

  const xref = length;
  const count = offsets.length;
  push(`xref\n0 ${count}\n0000000000 65535 f \n`);
  for (let n = 1; n < count; n += 1) push(`${String(offsets[n]).padStart(10, "0")} 00000 n \n`);
  push(`trailer\n<< /Size ${count} /Root 1 0 R /Info 6 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return Buffer.concat(chunks);
}
