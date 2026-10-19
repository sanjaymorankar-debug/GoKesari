/**
 * A minimal PDF writer for plain-text documents (NEW-007 invoices).
 *
 * Writes A4 pages of fixed-width text in the standard Courier fonts, which
 * every PDF reader has built in — so nothing is embedded and no library is
 * needed. Fixed width keeps tables aligned with plain padding. Text is
 * limited to printable ASCII: the rupee sign becomes "Rs." and anything else
 * outside ASCII becomes "?".
 */

export interface PdfLine {
  text: string;
  bold?: boolean;
}

/**
 * batch-2026-10 WS-E: a QR code drawn as a real image (8-bit grey, hex-coded
 * so the file stays ASCII) under the text on the last page — or on a page of
 * its own when the last page is full. `modules` is the QR matrix, row by row,
 * 1 = dark (lib/qr.ts). Without it the PDF is byte-for-byte what it was.
 */
export interface PdfQrImage {
  size: number;
  modules: ArrayLike<number>;
  /** Printed beside the code. */
  caption?: string[];
  /** Printed width of the code in points (default 110). */
  widthPt?: number;
}

const PAGE_WIDTH = 595.28;
const PAGE_HEIGHT = 841.89;
const MARGIN_X = 40;
const MARGIN_TOP = 50;
const FONT_SIZE = 9;
const LEADING = 11.5;
/** Characters that fit across the page at 9 pt Courier (0.6 em wide). */
export const PDF_LINE_WIDTH = Math.floor((PAGE_WIDTH - 2 * MARGIN_X) / (FONT_SIZE * 0.6));
const LINES_PER_PAGE = Math.floor((PAGE_HEIGHT - 2 * MARGIN_TOP) / LEADING);

function asciiOnly(text: string): string {
  return text
    .replace(/₹\s?/g, "Rs. ")
    .replace(/[–—]/g, "-")
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[^\x20-\x7e]/g, "?");
}

function escapePdf(text: string): string {
  return asciiOnly(text).replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

/** Builds the PDF bytes. Long documents continue onto further pages. */
export function textPdf(lines: PdfLine[], options: { title?: string; qr?: PdfQrImage } = {}): Buffer {
  const pages: PdfLine[][] = [];
  for (let i = 0; i < Math.max(lines.length, 1); i += LINES_PER_PAGE) pages.push(lines.slice(i, i + LINES_PER_PAGE));
  // WS-E: where the QR goes — below the last line, else on a new page.
  const qrWidth = options.qr ? (options.qr.widthPt ?? 110) : 0;
  let qrPage = -1;
  let qrTop = 0;
  if (options.qr) {
    const used = pages[pages.length - 1].length;
    const top = PAGE_HEIGHT - MARGIN_TOP - used * LEADING - LEADING;
    if (top - qrWidth >= MARGIN_TOP) {
      qrPage = pages.length - 1;
      qrTop = top;
    } else {
      pages.push([]);
      qrPage = pages.length - 1;
      qrTop = PAGE_HEIGHT - MARGIN_TOP;
    }
  }

  const objects: string[] = [];
  const add = (body: string) => {
    objects.push(body);
    return objects.length; // object number
  };
  const catalog = add("");
  const pagesObj = add("");
  const fontRegular = add("<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>");
  const fontBold = add("<< /Type /Font /Subtype /Type1 /BaseFont /Courier-Bold /Encoding /WinAnsiEncoding >>");
  const qrImage = options.qr ? add(qrImageObject(options.qr)) : null;
  const pageIds: number[] = [];
  pages.forEach((pageLines, index) => {
    const ops: string[] = ["BT", `${LEADING} TL`, `${MARGIN_X} ${PAGE_HEIGHT - MARGIN_TOP} Td`];
    let font = "";
    for (const line of pageLines) {
      const wanted = line.bold ? "/F2" : "/F1";
      if (wanted !== font) {
        ops.push(`${wanted} ${FONT_SIZE} Tf`);
        font = wanted;
      }
      ops.push(`(${escapePdf(line.text.slice(0, PDF_LINE_WIDTH))}) Tj T*`);
    }
    if (pages.length > 1) {
      ops.push("/F1 8 Tf", `(${escapePdf(`Page ${index + 1} of ${pages.length}`)}) Tj`);
    }
    ops.push("ET");
    const withQr = qrImage != null && index === qrPage;
    if (withQr) ops.push(...qrOps(options.qr!, qrTop, qrWidth));
    const stream = ops.join("\n");
    const content = add(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
    const xobject = withQr ? ` /XObject << /QR1 ${qrImage} 0 R >>` : "";
    pageIds.push(
      add(
        `<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] ` +
          `/Resources << /Font << /F1 ${fontRegular} 0 R /F2 ${fontBold} 0 R >>${xobject} >> /Contents ${content} 0 R >>`,
      ),
    );
  });
  objects[catalog - 1] = `<< /Type /Catalog /Pages ${pagesObj} 0 R >>`;
  objects[pagesObj - 1] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pageIds.length} >>`;
  const info = options.title ? add(`<< /Title (${escapePdf(options.title)}) /Producer (GoKesari) >>`) : null;

  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) out += `${String(offset).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R${info ? ` /Info ${info} 0 R` : ""} >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

/** Quiet zone around the code, in modules (the QR standard asks for 4). */
const QR_QUIET = 4;

/** The QR matrix as an image XObject: 8-bit DeviceGray, one sample per module, ASCII-hex coded. */
function qrImageObject(qr: PdfQrImage): string {
  const n = qr.size + 2 * QR_QUIET;
  let hex = "";
  for (let r = 0; r < n; r += 1) {
    for (let c = 0; c < n; c += 1) {
      const row = r - QR_QUIET;
      const col = c - QR_QUIET;
      const dark = row >= 0 && col >= 0 && row < qr.size && col < qr.size && qr.modules[row * qr.size + col] === 1;
      hex += dark ? "00" : "FF";
    }
    hex += "\n";
  }
  hex += ">";
  return (
    `<< /Type /XObject /Subtype /Image /Name /QR1 /Width ${n} /Height ${n} /ColorSpace /DeviceGray ` +
    `/BitsPerComponent 8 /Interpolate false /Filter /ASCIIHexDecode /Length ${hex.length} >>\nstream\n${hex}\nendstream`
  );
}

/** Draws the image with its top-left at (MARGIN_X, top) and its caption to the right. */
function qrOps(qr: PdfQrImage, top: number, width: number): string[] {
  const ops = ["q", `${width} 0 0 ${width} ${MARGIN_X} ${(top - width).toFixed(2)} cm`, "/QR1 Do", "Q"];
  if (qr.caption?.length) {
    ops.push("BT", `${LEADING} TL`, `${MARGIN_X + width + 12} ${(top - LEADING).toFixed(2)} Td`, `/F1 ${FONT_SIZE} Tf`);
    const room = Math.floor((PAGE_WIDTH - MARGIN_X * 2 - width - 12) / (FONT_SIZE * 0.6));
    for (const line of qr.caption) ops.push(`(${escapePdf(line.slice(0, room))}) Tj T*`);
    ops.push("ET");
  }
  return ops;
}
