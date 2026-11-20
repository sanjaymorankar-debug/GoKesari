/**
 * GoKesari Health: the medical store's bill for a completed prescription order (rx-orders.ts), as a PDF
 * (src/lib/health/pdf-writer.ts). Saved encrypted in the patient's record (health.documents, source
 * STORE, kind BILL) at completion and downloaded from the order page.
 */
import { mm, PdfDocument, type PdfPage, wrapText } from "@/lib/health/pdf-writer";

export interface RxBillLine {
  name: string;
  /** "Substitute for <prescribed>" when the store gave a substitute. */
  note: string | null;
  batchNumber: string | null;
  expiryDate: string | null;
  qty: number;
  unitPricePaise: number;
  discountPaise: number;
  amountPaise: number;
}

export interface RxBillData {
  store: { name: string; address: string; phone: string | null; gstin: string | null; drugLicence: string; pharmacist: string; pharmacistRegistration: string };
  billNumber: string;
  orderNumber: string;
  billedAt: Date;
  patientName: string;
  prescription: { rxNumber: string; doctor: string; registration: string };
  fulfilment: "PICKUP" | "DELIVERY";
  address: string | null;
  deliveredBy: string | null;
  lines: RxBillLine[];
  goodsPaise: number;
  discountPaise: number;
  deliveryPaise: number;
  totalPaise: number;
  paidOnlinePaise: number;
  paidCashPaise: number;
  refundPaise: number;
}

const INK = [0.12, 0.12, 0.14] as const;
const MUTED = [0.4, 0.4, 0.44] as const;
const LINE = [0.8, 0.8, 0.82] as const;
const BAND = [0.97, 0.94, 0.88] as const;

export const rs = (paise: number): string => `Rs. ${(paise / 100).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function istText(at: Date): string {
  const d = new Date(at.getTime() + 330 * 60_000);
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const h = d.getUTCHours();
  return `${String(d.getUTCDate()).padStart(2, "0")}-${months[d.getUTCMonth()]}-${d.getUTCFullYear()} ${h % 12 === 0 ? 12 : h % 12}.${String(d.getUTCMinutes()).padStart(2, "0")} ${h < 12 ? "AM" : "PM"} IST`;
}

/** Column x positions (points from the left margin) for the medicines table. */
const COLS = { no: 0, name: 18, batch: 230, expiry: 300, qty: 360, rate: 420, disc: 470, amount: 523 };

export function renderRxBillPdf(data: RxBillData): Buffer {
  const doc = new PdfDocument({ title: `Bill ${data.billNumber} (${data.orderNumber})`, author: data.store.name, subject: "Medicines bill" });
  const left = mm(15);
  const right = mm(195);
  const width = right - left;
  let page: PdfPage = doc.addPageMm("A4");
  let y = page.height - mm(15);

  const newPage = () => {
    page = doc.addPageMm("A4");
    y = page.height - mm(15);
    page.text(left, y, `${data.store.name} - bill ${data.billNumber} (continued)`, { size: 9, color: MUTED });
    y -= 18;
    tableHeader();
  };
  const ensure = (needed: number) => {
    if (y - needed < mm(25)) newPage();
  };
  function tableHeader() {
    page.rect(left, y - 4, width, 16, { fill: BAND });
    const at = (k: keyof typeof COLS) => left + COLS[k];
    page.text(at("no") + 2, y + 1, "#", { size: 8, font: "bold" });
    page.text(at("name"), y + 1, "Medicine", { size: 8, font: "bold" });
    page.text(at("batch"), y + 1, "Batch", { size: 8, font: "bold" });
    page.text(at("expiry"), y + 1, "Expiry", { size: 8, font: "bold" });
    page.textRight(at("qty") + 30, y + 1, "Qty", { size: 8, font: "bold" });
    page.textRight(at("rate") + 44, y + 1, "Rate", { size: 8, font: "bold" });
    page.textRight(at("disc") + 46, y + 1, "Disc.", { size: 8, font: "bold" });
    page.textRight(right - 2, y + 1, "Amount", { size: 8, font: "bold" });
    y -= 18;
  }

  // Store header.
  page.text(left, y, data.store.name, { size: 16, font: "bold", color: INK });
  page.textRight(right, y, "BILL", { size: 14, font: "bold", color: INK });
  y -= 14;
  for (const l of wrapText(data.store.address, 9, width * 0.65)) {
    page.text(left, y, l, { size: 9, color: MUTED });
    y -= 11;
  }
  const facts = [
    data.store.phone ? `Phone ${data.store.phone}` : null,
    `Drug licence ${data.store.drugLicence}`,
    `Pharmacist ${data.store.pharmacist} (Reg. ${data.store.pharmacistRegistration})`,
    data.store.gstin ? `GSTIN ${data.store.gstin}` : null,
  ].filter((v): v is string => Boolean(v));
  for (const f of facts) {
    page.text(left, y, f, { size: 9, color: MUTED });
    y -= 11;
  }
  y -= 4;
  page.line(left, y, right, y, { color: LINE, width: 0.8 });
  y -= 16;

  // Bill facts.
  const pairs: [string, string][] = [
    ["Bill number", data.billNumber],
    ["GoKesari order", data.orderNumber],
    ["Date", istText(data.billedAt)],
    ["Patient", data.patientName],
    ["Prescription", `${data.prescription.rxNumber} by ${data.prescription.doctor} (${data.prescription.registration})`],
    ["Handover", data.fulfilment === "PICKUP" ? "Collected at the store" : `Delivered${data.deliveredBy ? ` by ${data.deliveredBy}` : ""}`],
  ];
  if (data.fulfilment === "DELIVERY" && data.address) pairs.push(["Address", data.address]);
  for (const [k, v] of pairs) {
    page.text(left, y, k, { size: 9, color: MUTED });
    const lines = wrapText(v, 9.5, width - 100);
    for (const [i, l] of lines.entries()) {
      page.text(left + 100, y - i * 12, l, { size: 9.5, color: INK });
    }
    y -= 12 * Math.max(1, lines.length) + 2;
  }
  y -= 8;

  tableHeader();
  data.lines.forEach((line, idx) => {
    const nameLines = wrapText(line.name, 9, COLS.batch - COLS.name - 6);
    const noteLines = line.note ? wrapText(line.note, 7.5, COLS.batch - COLS.name - 6) : [];
    const h = nameLines.length * 11 + noteLines.length * 9 + 6;
    ensure(h);
    const at = (k: keyof typeof COLS) => left + COLS[k];
    page.text(at("no") + 2, y, String(idx + 1), { size: 9 });
    nameLines.forEach((l, i) => page.text(at("name"), y - i * 11, l, { size: 9, font: "bold" }));
    noteLines.forEach((l, i) => page.text(at("name"), y - nameLines.length * 11 - i * 9 + 2, l, { size: 7.5, color: MUTED }));
    page.text(at("batch"), y, line.batchNumber ?? "-", { size: 8.5 });
    page.text(at("expiry"), y, line.expiryDate ?? "-", { size: 8.5 });
    page.textRight(at("qty") + 30, y, String(line.qty), { size: 9 });
    page.textRight(at("rate") + 44, y, (line.unitPricePaise / 100).toFixed(2), { size: 9 });
    page.textRight(at("disc") + 46, y, line.discountPaise ? (line.discountPaise / 100).toFixed(2) : "-", { size: 9 });
    page.textRight(right - 2, y, (line.amountPaise / 100).toFixed(2), { size: 9, font: "bold" });
    y -= h;
    page.line(left, y + 4, right, y + 4, { color: LINE, width: 0.4 });
  });

  ensure(110);
  y -= 8;
  const totals: [string, string, boolean][] = [
    ["Medicines", rs(data.goodsPaise), false],
    ["Discount", data.discountPaise ? `- ${rs(data.discountPaise)}` : rs(0), false],
    ["Delivery", rs(data.deliveryPaise), false],
    ["Total", rs(data.totalPaise), true],
  ];
  if (data.paidOnlinePaise > 0) totals.push(["Paid online (GoKesari)", rs(data.paidOnlinePaise), false]);
  if (data.paidCashPaise > 0) totals.push(["Paid at handover", rs(data.paidCashPaise), false]);
  if (data.refundPaise > 0) totals.push(["Refunded to you", rs(data.refundPaise), false]);
  for (const [k, v, bold] of totals) {
    page.textRight(right - 110, y, k, { size: bold ? 10.5 : 9.5, font: bold ? "bold" : "regular", color: bold ? INK : MUTED });
    page.textRight(right - 2, y, v, { size: bold ? 10.5 : 9.5, font: bold ? "bold" : "regular", color: INK });
    y -= bold ? 16 : 13;
  }
  y -= 10;
  for (const l of wrapText(
    "Medicines are dispensed by the store and its registered pharmacist against the prescription above. Prices and stock are the store's. This bill is saved in the patient's GoKesari health record.",
    7.5,
    width,
  )) {
    ensure(10);
    page.text(left, y, l, { size: 7.5, color: MUTED });
    y -= 9;
  }
  return doc.build();
}
