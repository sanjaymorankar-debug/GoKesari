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
export function textPdf(lines: PdfLine[], options: { title?: string } = {}): Buffer {
  const pages: PdfLine[][] = [];
  for (let i = 0; i < Math.max(lines.length, 1); i += LINES_PER_PAGE) pages.push(lines.slice(i, i + LINES_PER_PAGE));

  const objects: string[] = [];
  const add = (body: string) => {
    objects.push(body);
    return objects.length; // object number
  };
  const catalog = add("");
  const pagesObj = add("");
  const fontRegular = add("<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>");
  const fontBold = add("<< /Type /Font /Subtype /Type1 /BaseFont /Courier-Bold /Encoding /WinAnsiEncoding >>");
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
    const stream = ops.join("\n");
    const content = add(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
    pageIds.push(
      add(
        `<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] ` +
          `/Resources << /Font << /F1 ${fontRegular} 0 R /F2 ${fontBold} 0 R >> >> /Contents ${content} 0 R >>`,
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
