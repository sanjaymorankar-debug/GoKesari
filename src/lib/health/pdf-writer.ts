/**
 * GoKesari Health: a small, dependency-free PDF writer (docs/health/DECISIONS.md H-05).
 *
 * Enough for prescriptions and health-record exports: pages of any size, the
 * two standard fonts Helvetica and Helvetica-Bold (WinAnsi), text with word
 * wrapping, lines, rectangles, JPEG images (callers convert other formats with
 * sharp first) and vector QR codes. Coordinates are in points from the
 * BOTTOM-LEFT corner, as in PDF; helpers take millimetres where noted.
 *
 * Server-only in practice (Buffer), but has no Node imports beyond Buffer so it
 * can be unit-tested anywhere.
 */

export const MM = 72 / 25.4;
export const mm = (v: number): number => v * MM;

export const PAPER_SIZES_MM = {
  A4: { w: 210, h: 297 },
  A5: { w: 148, h: 210 },
  LETTER: { w: 215.9, h: 279.4 },
} as const;
export type PaperSize = keyof typeof PAPER_SIZES_MM;

export type FontKey = "regular" | "bold";
export type Rgb = readonly [number, number, number];

const BLACK: Rgb = [0, 0, 0];

/** Helvetica glyph widths (1/1000 em) for ASCII 32..126 — the standard AFM metrics. */
const HELVETICA = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, 1015, 667,
  667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500,
  556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
];
const HELVETICA_BOLD = [
  278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611, 975, 722,
  722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556, 333, 556, 611, 556,
  611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611, 611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584,
];

/** Characters outside WinAnsi are replaced so the standard fonts can show every line. */
const REPLACEMENTS: Record<string, string> = {
  "₹": "Rs.",
  "–": "-",
  "—": "-",
  "‘": "'",
  "’": "'",
  "“": '"',
  "”": '"',
  "…": "...",
  "•": "-",
  "×": "x",
  "°": " deg",
  "µ": "u",
  "₂": "2",
  "≤": "<=",
  "≥": ">=",
  " ": " ",
};

/** Makes a string safe for the standard fonts (ASCII only; other scripts become "?"). */
export function pdfSafe(text: string): string {
  let out = "";
  for (const ch of text.normalize("NFC")) {
    if (REPLACEMENTS[ch] !== undefined) out += REPLACEMENTS[ch];
    else {
      const code = ch.codePointAt(0)!;
      if (code === 9) out += "  ";
      else if (code >= 32 && code <= 126) out += ch;
      else if (code === 10 || code === 13) out += " ";
      else out += "?";
    }
  }
  return out;
}

export function textWidth(text: string, size: number, font: FontKey = "regular"): number {
  const table = font === "bold" ? HELVETICA_BOLD : HELVETICA;
  let w = 0;
  for (const ch of pdfSafe(text)) {
    const c = ch.charCodeAt(0);
    w += table[c - 32] ?? 556;
  }
  return (w * size) / 1000;
}

/** Splits text into lines no wider than maxWidth (points); long words are broken. */
export function wrapText(text: string, size: number, maxWidth: number, font: FontKey = "regular"): string[] {
  const lines: string[] = [];
  for (const paragraph of pdfSafe(text.replace(/\r/g, "")).split(/\n/)) {
    const words = paragraph.split(/ +/);
    let line = "";
    for (const word of words) {
      const candidate = line ? `${line} ${word}` : word;
      if (textWidth(candidate, size, font) <= maxWidth) {
        line = candidate;
        continue;
      }
      if (line) lines.push(line);
      if (textWidth(word, size, font) <= maxWidth) {
        line = word;
        continue;
      }
      // A single word wider than the line: break it by characters.
      let part = "";
      for (const ch of word) {
        if (textWidth(part + ch, size, font) > maxWidth && part) {
          lines.push(part);
          part = ch;
        } else part += ch;
      }
      line = part;
    }
    lines.push(line);
  }
  return lines;
}

function escapeText(text: string): string {
  return pdfSafe(text).replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

const n = (v: number): string => (Math.round(v * 100) / 100).toString();
const rgb = (c: Rgb): string => `${n(c[0])} ${n(c[1])} ${n(c[2])}`;

export interface JpegImage {
  /** Index in the document's image list (internal). */
  readonly index: number;
  readonly width: number;
  readonly height: number;
}

interface ImageEntry {
  bytes: Buffer;
  width: number;
  height: number;
  components: 1 | 3;
}

export class PdfPage {
  readonly ops: string[] = [];
  readonly usedImages = new Set<number>();
  constructor(
    readonly width: number,
    readonly height: number,
  ) {}

  text(x: number, y: number, text: string, opts: { size?: number; font?: FontKey; color?: Rgb } = {}): void {
    const size = opts.size ?? 10;
    const font = opts.font === "bold" ? "F2" : "F1";
    this.ops.push(`BT /${font} ${n(size)} Tf ${rgb(opts.color ?? BLACK)} rg ${n(x)} ${n(y)} Td (${escapeText(text)}) Tj ET`);
  }

  /** Text aligned right at x. */
  textRight(x: number, y: number, text: string, opts: { size?: number; font?: FontKey; color?: Rgb } = {}): void {
    this.text(x - textWidth(text, opts.size ?? 10, opts.font), y, text, opts);
  }

  textCenter(cx: number, y: number, text: string, opts: { size?: number; font?: FontKey; color?: Rgb } = {}): void {
    this.text(cx - textWidth(text, opts.size ?? 10, opts.font) / 2, y, text, opts);
  }

  line(x1: number, y1: number, x2: number, y2: number, opts: { width?: number; color?: Rgb } = {}): void {
    this.ops.push(`${n(opts.width ?? 0.5)} w ${rgb(opts.color ?? BLACK)} RG ${n(x1)} ${n(y1)} m ${n(x2)} ${n(y2)} l S`);
  }

  rect(x: number, y: number, w: number, h: number, opts: { fill?: Rgb; stroke?: Rgb; width?: number } = {}): void {
    const parts: string[] = [];
    if (opts.fill) parts.push(`${rgb(opts.fill)} rg`);
    if (opts.stroke) parts.push(`${n(opts.width ?? 0.5)} w ${rgb(opts.stroke)} RG`);
    parts.push(`${n(x)} ${n(y)} ${n(w)} ${n(h)} re`);
    parts.push(opts.fill && opts.stroke ? "B" : opts.fill ? "f" : "S");
    this.ops.push(parts.join(" "));
  }

  image(img: JpegImage, x: number, y: number, w: number, h: number): void {
    this.usedImages.add(img.index);
    this.ops.push(`q ${n(w)} 0 0 ${n(h)} ${n(x)} ${n(y)} cm /Im${img.index} Do Q`);
  }

  /** Draws a QR matrix (modules[row][col] true = dark) as filled squares, top-left at (x, yTop). */
  qr(modules: readonly (readonly boolean[])[], x: number, yTop: number, sizePt: number): void {
    const count = modules.length;
    if (!count) return;
    const cell = sizePt / count;
    const parts: string[] = ["0 0 0 rg"];
    for (let r = 0; r < count; r++) {
      for (let c = 0; c < count; c++) {
        if (modules[r][c]) parts.push(`${n(x + c * cell)} ${n(yTop - (r + 1) * cell)} ${n(cell + 0.05)} ${n(cell + 0.05)} re`);
      }
    }
    parts.push("f");
    this.ops.push(parts.join("\n"));
  }
}

export class PdfDocument {
  readonly pages: PdfPage[] = [];
  private readonly images: ImageEntry[] = [];
  constructor(private readonly info: { title?: string; author?: string; subject?: string } = {}) {}

  addPage(widthPt: number, heightPt: number): PdfPage {
    const page = new PdfPage(widthPt, heightPt);
    this.pages.push(page);
    return page;
  }

  addPageMm(size: PaperSize): PdfPage {
    const s = PAPER_SIZES_MM[size];
    return this.addPage(mm(s.w), mm(s.h));
  }

  /** Registers a baseline JPEG (width/height in pixels; 3 = RGB, 1 = greyscale). */
  addJpeg(bytes: Buffer, width: number, height: number, components: 1 | 3 = 3): JpegImage {
    const index = this.images.length;
    this.images.push({ bytes, width, height, components });
    return { index, width, height };
  }

  build(): Buffer {
    const chunks: Buffer[] = [];
    const offsets: number[] = [];
    let length = 0;
    const push = (b: Buffer | string) => {
      const buf = typeof b === "string" ? Buffer.from(b, "latin1") : b;
      chunks.push(buf);
      length += buf.length;
    };
    // Object numbers: 1 catalog, 2 pages, 3 font regular, 4 font bold, 5 info,
    // then images, then (page, content) pairs.
    const imageBase = 6;
    const pageBase = imageBase + this.images.length;
    const pageObj = (i: number) => pageBase + i * 2;
    const contentObj = (i: number) => pageBase + i * 2 + 1;
    const total = pageBase + this.pages.length * 2 - 1;

    const obj = (num: number, body: Buffer | string, stream?: Buffer) => {
      offsets[num] = length;
      push(`${num} 0 obj\n`);
      push(body);
      if (stream) {
        push("\nstream\n");
        push(stream);
        push("\nendstream");
      }
      push("\nendobj\n");
    };

    push("%PDF-1.4\n%\xE2\xE3\xCF\xD3\n");
    obj(1, "<< /Type /Catalog /Pages 2 0 R >>");
    obj(2, `<< /Type /Pages /Count ${this.pages.length} /Kids [${this.pages.map((_, i) => `${pageObj(i)} 0 R`).join(" ")}] >>`);
    obj(3, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
    obj(4, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>");
    const pdfString = (s: string) => `(${escapeText(s)})`;
    obj(
      5,
      `<< /Producer (GoKesari Health) /Creator (GoKesari)${this.info.title ? ` /Title ${pdfString(this.info.title)}` : ""}${this.info.author ? ` /Author ${pdfString(this.info.author)}` : ""}${
        this.info.subject ? ` /Subject ${pdfString(this.info.subject)}` : ""
      } >>`,
    );
    this.images.forEach((img, i) => {
      obj(
        imageBase + i,
        `<< /Type /XObject /Subtype /Image /Width ${img.width} /Height ${img.height} /ColorSpace /${img.components === 1 ? "DeviceGray" : "DeviceRGB"} /BitsPerComponent 8 /Filter /DCTDecode /Length ${img.bytes.length} >>`,
        img.bytes,
      );
    });
    this.pages.forEach((page, i) => {
      const xobjects = [...page.usedImages].map((idx) => `/Im${idx} ${imageBase + idx} 0 R`).join(" ");
      obj(
        pageObj(i),
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${n(page.width)} ${n(page.height)}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >>${xobjects ? ` /XObject << ${xobjects} >>` : ""} >> /Contents ${contentObj(i)} 0 R >>`,
      );
      const content = Buffer.from(page.ops.join("\n"), "latin1");
      obj(contentObj(i), `<< /Length ${content.length} >>`, content);
    });
    const xref = length;
    push(`xref\n0 ${total + 1}\n0000000000 65535 f \n`);
    for (let i = 1; i <= total; i++) push(`${String(offsets[i] ?? 0).padStart(10, "0")} 00000 n \n`);
    push(`trailer\n<< /Size ${total + 1} /Root 1 0 R /Info 5 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
    return Buffer.concat(chunks);
  }
}
