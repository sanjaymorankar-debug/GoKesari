/**
 * QR codes from invoice photos, scans and PDFs (Module 2, purchase entry).
 *
 * A signed-QR-sized token (a JWT of several hundred characters, as the IRP
 * prints on e-invoices) is rendered with `qrcode`, placed top-right on an
 * A4-sized white page and found again — as a PNG, as a low-contrast JPEG and
 * as an image inside a hand-built PDF.
 */
import { deflateSync } from "node:zlib";
import QRCode from "qrcode";
import sharp from "sharp";
import { describe, expect, it } from "vitest";

import { findQrCodes, findQrCodesInPdf } from "@/server/accounts/qr-decode";

const b64url = (s: string) => Buffer.from(s).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

const TOKEN = [
  b64url(JSON.stringify({ alg: "RS256", kid: "B8BE2B6C3F7B4D4F", typ: "JWT", x5t: "uL4rbD97TU9JbxcaRyrwbrrQK4E" })),
  b64url(
    JSON.stringify({
      data: JSON.stringify({
        SellerGstin: "27AABCA1111B1Z1",
        BuyerGstin: "27AAACK1234F1Z5",
        DocNo: "AD/2026/0451",
        DocTyp: "INV",
        DocDt: "05/09/2026",
        TotInvVal: 3360,
        ItemCnt: 2,
        MainHsnCode: "04051000",
        Irn: "8b7c1f0e5a9d3c2b4a6e8f0d1c3b5a7e9f1d3c5b7a9e1f3d5c7b9a1e3f5d7c9b",
        IrnDt: "2026-09-05 11:20:00",
      }),
      iss: "NIC",
    }),
  ),
  b64url("x".repeat(256)),
].join(".");

const UPI = "upi://pay?pa=kesaridairy@okicici&pn=Kesari%20Dairy&cu=INR";

async function qrPng(text: string, scale: number): Promise<Buffer> {
  return QRCode.toBuffer(text, { errorCorrectionLevel: "M", margin: 4, scale, type: "png" });
}

/** An A4 page at ~200 dpi with the e-invoice QR top-right and a UPI QR bottom-left. */
async function invoicePage(): Promise<Buffer> {
  const einv = await qrPng(TOKEN, 4);
  const upi = await qrPng(UPI, 4);
  const { width = 0 } = await sharp(einv).metadata();
  return sharp({ create: { width: 1654, height: 2339, channels: 3, background: "#ffffff" } })
    .composite([
      { input: einv, left: 1654 - width - 80, top: 80 },
      { input: upi, left: 100, top: 1900 },
    ])
    .png()
    .toBuffer();
}

/** A one-page PDF whose only content is the given grayscale image, FlateDecode-compressed. */
function pdfWithImage(gray: Buffer, width: number, height: number): Buffer {
  const image = deflateSync(gray);
  const content = Buffer.from(`q 400 0 0 400 150 400 cm /Im1 Do Q`);
  const objects: Buffer[] = [
    Buffer.from("<< /Type /Catalog /Pages 2 0 R >>"),
    Buffer.from("<< /Type /Pages /Kids [3 0 R] /Count 1 >>"),
    Buffer.from("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /XObject << /Im1 4 0 R >> >> /Contents 5 0 R >>"),
    Buffer.concat([
      Buffer.from(`<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode /Length ${image.length} >>\nstream\n`),
      image,
      Buffer.from("\nendstream"),
    ]),
    Buffer.concat([Buffer.from(`<< /Length ${content.length} >>\nstream\n`), content, Buffer.from("\nendstream")]),
  ];
  const parts: Buffer[] = [Buffer.from("%PDF-1.4\n")];
  const offsets: number[] = [];
  let length = parts[0].length;
  objects.forEach((body, i) => {
    offsets.push(length);
    const obj = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`), body, Buffer.from("\nendobj\n")]);
    parts.push(obj);
    length += obj.length;
  });
  const xref = [`xref\n0 ${objects.length + 1}\n`, "0000000000 65535 f \n", ...offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`)].join("");
  parts.push(Buffer.from(`${xref}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${length}\n%%EOF\n`));
  return Buffer.concat(parts);
}

describe("findQrCodes", () => {
  it("finds the e-invoice QR (top-right) and a second QR on the page", async () => {
    const found = await findQrCodes(await invoicePage());
    expect(found).toContain(TOKEN);
    expect(found).toContain(UPI);
    expect(new Set(found).size).toBe(found.length);
  }, 30_000);

  it("finds it in a greyed, low-contrast JPEG photo", async () => {
    const photo = await sharp(await invoicePage())
      .linear(0.45, 90) // washed out: black → ~90, white → ~205
      .blur(0.8)
      .jpeg({ quality: 70 })
      .toBuffer();
    expect(await findQrCodes(photo)).toContain(TOKEN);
  }, 30_000);

  it("returns [] for a page without QR codes and for non-images", async () => {
    const blank = await sharp({ create: { width: 800, height: 600, channels: 3, background: "#ffffff" } }).png().toBuffer();
    expect(await findQrCodes(blank)).toEqual([]);
    expect(await findQrCodes(Buffer.from("not an image"))).toEqual([]);
    expect(await findQrCodes(Buffer.alloc(0))).toEqual([]);
  }, 30_000);
});

describe("findQrCodesInPdf", () => {
  it("finds a QR drawn from an image in the PDF", async () => {
    const { data, info } = await sharp(await qrPng(TOKEN, 6)).grayscale().raw().toBuffer({ resolveWithObject: true });
    const pdf = pdfWithImage(data, info.width, info.height);
    expect(await findQrCodesInPdf(pdf)).toEqual([TOKEN]);
  }, 30_000);

  it("returns [] for garbage instead of throwing", async () => {
    expect(await findQrCodesInPdf(Buffer.from("%PDF-1.4 broken"))).toEqual([]);
    expect(await findQrCodesInPdf(Buffer.from("hello"))).toEqual([]);
  }, 30_000);
});
