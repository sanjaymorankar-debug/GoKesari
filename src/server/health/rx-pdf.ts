/**
 * GoKesari Health: the prescription PDF (and the letterhead calibration sheet).
 *
 * Three letterhead modes (docs/health/DOCTOR_GUIDE.md):
 *  - DIGITAL: the doctor's header / footer images (or a full-page background) with content margins;
 *  - PREPRINTED: nothing in the header / footer areas — text only, inside the margins the doctor
 *    measured with the calibration sheet, so it lands in the blank area of their printed paper;
 *  - STANDARD: a header built from the profile (name, qualifications, registration, clinic).
 * The e-mailed / downloaded PDF is always complete: in PREPRINTED mode it uses the digital images if
 * uploaded, else the standard header. Hindi / Marathi instruction lines are printed by the HTML print
 * view (the standard PDF fonts have no Devanagari) — DECISIONS.md H-05.
 */
import { PAPER_SIZES_MM, PdfDocument, mm, textWidth, wrapText, type JpegImage, type PdfPage, type PaperSize, type Rgb } from "@/lib/health/pdf-writer";
import { DEFAULT_RX_SECTIONS, RX_FREQUENCY_LABELS, RX_TIMING_LABELS, type RxSection, type RxTiming } from "@/lib/health/constants";
import type { HealthLetterhead, Vitals } from "@/server/db/schema";

export interface RxContentItem {
  lineNo: number;
  genericName: string;
  brandName?: string | null;
  strength?: string | null;
  form: string;
  dose: string;
  frequency: string;
  timing: string;
  durationDays: number;
  quantity: number;
  instructions?: string | null;
  instructionsLocal?: string | null;
}

export interface RxContentSuggestion {
  type: string;
  text: string;
  printOnRx: boolean;
}

/** The frozen content of an issued prescription (prescriptions.content). */
export interface RxContent {
  rxNumber: string;
  version: number;
  issuedAt: string;
  validUntil: string | null;
  amendReason?: string | null;
  doctor: { name: string; qualifications: string; specialties: string[]; council: string; registrationNumber: string; registrationYear?: number | null };
  clinic: { name: string; address: string; phone: string | null; email?: string | null };
  patient: { name: string; age: string | null; gender: string | null; phone?: string | null; abha?: string | null };
  mode: string;
  bookingNumber?: string | null;
  vitals: Vitals;
  chiefComplaints?: string | null;
  history?: string | null;
  examination?: string | null;
  diagnoses: { code?: string | null; text: string }[];
  items: RxContentItem[];
  investigations: { name: string; note?: string | null }[];
  advice?: string | null;
  followUpDate?: string | null;
  suggestions: RxContentSuggestion[];
  verifyUrl: string;
}

export interface RxImages {
  header?: { jpeg: Buffer; width: number; height: number } | null;
  footer?: { jpeg: Buffer; width: number; height: number } | null;
  background?: { jpeg: Buffer; width: number; height: number } | null;
  signature?: { jpeg: Buffer; width: number; height: number } | null;
  stamp?: { jpeg: Buffer; width: number; height: number } | null;
}

export type LetterheadSettings = Pick<
  HealthLetterhead,
  "mode" | "paper" | "marginTopMm" | "marginBottomMm" | "marginLeftMm" | "marginRightMm" | "headerHeightMm" | "footerHeightMm" | "fontSizePt" | "sections" | "showSignature"
>;

export const DEFAULT_LETTERHEAD: LetterheadSettings = {
  mode: "STANDARD",
  paper: "A4",
  marginTopMm: 15,
  marginBottomMm: 15,
  marginLeftMm: 15,
  marginRightMm: 15,
  headerHeightMm: 35,
  footerHeightMm: 15,
  fontSizePt: 10,
  sections: {},
  showSignature: true,
};

const GREY: Rgb = [0.35, 0.35, 0.35];
const ACCENT: Rgb = [0.76, 0.25, 0.05];
const LIGHT: Rgb = [0.85, 0.85, 0.85];

export function sectionsOf(settings: Pick<LetterheadSettings, "sections">): Record<RxSection, boolean> {
  return { ...DEFAULT_RX_SECTIONS, ...(settings.sections as Partial<Record<RxSection, boolean>>) };
}

export function frequencyText(f: string): string {
  return RX_FREQUENCY_LABELS[f]?.en ? `${f} (${RX_FREQUENCY_LABELS[f].en})` : f;
}

export function timingText(t: string): string {
  return RX_TIMING_LABELS[t as RxTiming]?.en ?? t;
}

export function medicineTitle(i: Pick<RxContentItem, "brandName" | "genericName" | "strength" | "form">): string {
  const name = i.brandName ? `${i.brandName} (${i.genericName})` : i.genericName;
  return [name, i.strength, i.form.charAt(0) + i.form.slice(1).toLowerCase()].filter(Boolean).join(" ");
}

export function vitalsLine(v: Vitals): string {
  const parts: string[] = [];
  if (v.bpSystolic && v.bpDiastolic) parts.push(`BP ${v.bpSystolic}/${v.bpDiastolic} mmHg`);
  if (v.pulse) parts.push(`Pulse ${v.pulse}/min`);
  if (v.temperatureC) parts.push(`Temp ${v.temperatureC} C`);
  if (v.spo2) parts.push(`SpO2 ${v.spo2}%`);
  if (v.respiratoryRate) parts.push(`RR ${v.respiratoryRate}/min`);
  if (v.weightKg) parts.push(`Wt ${v.weightKg} kg`);
  if (v.heightCm) parts.push(`Ht ${v.heightCm} cm`);
  if (v.bmi) parts.push(`BMI ${v.bmi}`);
  if (v.bloodSugar) parts.push(`Sugar ${v.bloodSugar} mg/dL`);
  return parts.join("   ");
}

function istDateTime(iso: string): string {
  const d = new Date(new Date(iso).getTime() + 330 * 60_000);
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const hh = d.getUTCHours();
  const h12 = hh % 12 === 0 ? 12 : hh % 12;
  return `${String(d.getUTCDate()).padStart(2, "0")}-${months[d.getUTCMonth()]}-${d.getUTCFullYear()} ${h12}:${String(d.getUTCMinutes()).padStart(2, "0")} ${hh < 12 ? "AM" : "PM"} IST`;
}

function dateText(key: string): string {
  const [y, m, d] = key.split("-").map(Number);
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${String(d).padStart(2, "0")}-${months[m - 1]}-${y}`;
}

interface Frame {
  doc: PdfDocument;
  page: PdfPage;
  x0: number;
  x1: number;
  yTop: number;
  yBottom: number;
  y: number;
  size: number;
  pageNo: number;
  newPage: () => void;
}

/** Renders the prescription. purpose "print": PREPRINTED leaves header/footer blank; "email": always complete. */
export function renderRxPdf(content: RxContent, settings: LetterheadSettings, images: RxImages, purpose: "print" | "email", qrModules: boolean[][] | null): Buffer {
  const doc = new PdfDocument({ title: `Prescription ${content.rxNumber}${content.version > 1 ? ` v${content.version}` : ""}`, author: content.doctor.name, subject: `Prescription for ${content.patient.name}` });
  const paper = (settings.paper in PAPER_SIZES_MM ? settings.paper : "A4") as PaperSize;
  const size = settings.fontSizePt;
  const sections = sectionsOf(settings);
  let mode = settings.mode;
  if (purpose === "email" && mode === "PREPRINTED") mode = images.header || images.background ? "DIGITAL" : "STANDARD";

  const jpeg = (img: RxImages["header"]): JpegImage | null => (img ? doc.addJpeg(img.jpeg, img.width, img.height) : null);
  const headerImg = mode === "DIGITAL" ? jpeg(images.header) : null;
  const footerImg = mode === "DIGITAL" ? jpeg(images.footer) : null;
  const bgImg = mode === "DIGITAL" ? jpeg(images.background) : null;
  const sigImg = settings.showSignature && sections.signature ? jpeg(images.signature) : null;
  const stampImg = settings.showSignature && sections.signature ? jpeg(images.stamp) : null;

  const W = mm(PAPER_SIZES_MM[paper].w);
  const H = mm(PAPER_SIZES_MM[paper].h);
  const mL = mm(settings.marginLeftMm);
  const mR = mm(settings.marginRightMm);
  // Body area: below the header block and above the footer block.
  const headerH = mode === "STANDARD" ? 0 : mode === "DIGITAL" && !bgImg ? mm(settings.headerHeightMm) : 0;
  const footerH = mode === "DIGITAL" && !bgImg && footerImg ? mm(settings.footerHeightMm) : 0;

  const drawChrome = (page: PdfPage, first: boolean): number => {
    if (bgImg) page.image(bgImg, 0, 0, W, H);
    if (headerImg) {
      const h = mm(settings.headerHeightMm);
      page.image(headerImg, 0, H - h, W, h);
    }
    if (footerImg) {
      const h = mm(settings.footerHeightMm);
      page.image(footerImg, 0, 0, W, h);
    }
    let y = H - mm(settings.marginTopMm) - headerH;
    if (mode === "STANDARD") y = drawStandardHeader(page, content, mL, W - mR, H - mm(Math.min(settings.marginTopMm, 15)), first);
    return y;
  };

  const page1 = doc.addPageMm(paper);
  const startY = drawChrome(page1, true);
  const f: Frame = {
    doc,
    page: page1,
    x0: mL,
    x1: W - mR,
    yTop: startY,
    yBottom: mm(settings.marginBottomMm) + footerH + 14,
    y: startY,
    size,
    pageNo: 1,
    newPage: () => {
      f.pageNo += 1;
      f.page = doc.addPageMm(paper);
      f.yTop = drawChrome(f.page, false);
      f.y = f.yTop;
      f.page.text(f.x0, f.y, `${content.patient.name} - ${content.rxNumber}${content.version > 1 ? ` v${content.version}` : ""} (continued)`, { size: size - 1, color: GREY });
      f.y -= size * 1.8;
    },
  };
  const need = (h: number) => {
    if (f.y - h < f.yBottom) f.newPage();
  };
  const para = (label: string | null, text: string, opts: { bold?: boolean; color?: Rgb; sz?: number } = {}) => {
    const sz = opts.sz ?? size;
    const lw = label ? textWidth(`${label} `, sz, "bold") : 0;
    const lines = wrapText(text, sz, f.x1 - f.x0 - lw, opts.bold ? "bold" : "regular");
    lines.forEach((line, i) => {
      need(sz * 1.35);
      if (label && i === 0) f.page.text(f.x0, f.y, label, { size: sz, font: "bold" });
      f.page.text(f.x0 + lw, f.y, line, { size: sz, font: opts.bold ? "bold" : "regular", color: opts.color });
      f.y -= sz * 1.35;
    });
  };
  const gap = (n = 0.5) => (f.y -= size * n);

  // Patient strip.
  need(size * 4);
  f.page.rect(f.x0, f.y - size * 2.6, f.x1 - f.x0, size * 3.4, { fill: [0.97, 0.95, 0.93] });
  const pLine = [content.patient.name, content.patient.age, content.patient.gender].filter(Boolean).join(" / ");
  f.page.text(f.x0 + 4, f.y - size * 0.2, `Patient: ${pLine}`, { size, font: "bold" });
  f.page.textRight(f.x1 - 4, f.y - size * 0.2, `Date: ${istDateTime(content.issuedAt)}`, { size: size - 1 });
  const idLine = [`Rx No: ${content.rxNumber}${content.version > 1 ? ` (version ${content.version})` : ""}`, content.bookingNumber ? `Booking: ${content.bookingNumber}` : null, content.mode === "VIDEO" ? "Video consultation" : content.mode === "PHONE" ? "Phone consultation" : null, content.patient.abha ? `ABHA: ${content.patient.abha}` : null]
    .filter(Boolean)
    .join("   ");
  f.page.text(f.x0 + 4, f.y - size * 1.6, idLine, { size: size - 1.5, color: GREY });
  f.y -= size * 3.8;
  if (content.amendReason) {
    para("Amended:", content.amendReason, { color: ACCENT, sz: size - 1 });
    gap();
  }

  if (sections.vitals) {
    const v = vitalsLine(content.vitals);
    if (v) para("Vitals:", v, { sz: size - 0.5 });
  }
  if (sections.complaints && content.chiefComplaints) para("Complaints:", content.chiefComplaints);
  if (sections.history && content.history) para("History:", content.history);
  if (sections.examination && content.examination) para("Examination:", content.examination);
  if (sections.diagnosis && content.diagnoses.length) para("Diagnosis:", content.diagnoses.map((d) => (d.code ? `${d.text} (${d.code})` : d.text)).join("; "));
  gap(0.6);

  if (sections.medicines && content.items.length) {
    need(size * 3);
    f.page.text(f.x0, f.y - size * 0.4, "Rx", { size: size + 8, font: "bold", color: ACCENT });
    f.y -= size * 2.2;
    const cols = { no: f.x0, name: f.x0 + 14, dose: f.x0 + (f.x1 - f.x0) * 0.47, dur: f.x0 + (f.x1 - f.x0) * 0.8, qty: f.x1 };
    f.page.text(cols.name, f.y, "Medicine", { size: size - 1, font: "bold", color: GREY });
    f.page.text(cols.dose, f.y, "Dose / when", { size: size - 1, font: "bold", color: GREY });
    f.page.text(cols.dur, f.y, "Days", { size: size - 1, font: "bold", color: GREY });
    f.page.textRight(cols.qty, f.y, "Qty", { size: size - 1, font: "bold", color: GREY });
    f.y -= size * 0.6;
    f.page.line(f.x0, f.y, f.x1, f.y, { color: LIGHT });
    f.y -= size * 1.2;
    for (const item of content.items) {
      const nameLines = wrapText(medicineTitle(item), size, cols.dose - cols.name - 6, "bold");
      const doseLines = wrapText(`${item.dose}, ${frequencyText(item.frequency)}, ${timingText(item.timing)}`, size - 1, cols.dur - cols.dose - 6);
      const rows = Math.max(nameLines.length, doseLines.length);
      need(rows * size * 1.3 + (item.instructions ? size * 1.3 : 0) + 4);
      f.page.text(cols.no, f.y, `${item.lineNo}.`, { size, font: "bold" });
      nameLines.forEach((l, i) => f.page.text(cols.name, f.y - i * size * 1.3, l, { size, font: "bold" }));
      doseLines.forEach((l, i) => f.page.text(cols.dose, f.y - i * size * 1.3, l, { size: size - 1 }));
      f.page.text(cols.dur, f.y, item.durationDays ? `${item.durationDays}` : "-", { size: size - 1 });
      f.page.textRight(cols.qty, f.y, String(item.quantity), { size: size - 1 });
      f.y -= rows * size * 1.3;
      if (item.instructions) {
        for (const l of wrapText(item.instructions, size - 1.5, f.x1 - cols.name)) {
          need(size * 1.2);
          f.page.text(cols.name, f.y, l, { size: size - 1.5, color: GREY });
          f.y -= size * 1.2;
        }
      }
      f.y -= size * 0.4;
    }
    f.page.line(f.x0, f.y + size * 0.4, f.x1, f.y + size * 0.4, { color: LIGHT });
    gap(0.6);
  }

  if (sections.investigations && content.investigations.length) para("Tests advised:", content.investigations.map((i) => (i.note ? `${i.name} (${i.note})` : i.name)).join("; "));
  if (sections.advice && content.advice) para("Advice:", content.advice);
  if (sections.followUp && content.followUpDate) para("Follow-up:", `on ${dateText(content.followUpDate)}`, { bold: true });
  const printed = content.suggestions.filter((s) => s.printOnRx);
  if (sections.suggestions && printed.length) {
    gap(0.3);
    para("Referrals and suggestions:", "");
    f.y += size * 1.35;
    gap(1.3);
    for (const s of printed) para("-", s.text, { sz: size - 0.5 });
  }

  // Signature block (bottom right of the last page) and verification QR (bottom left).
  const blockH = mm(28);
  need(blockH + size);
  const sigTop = f.y - size;
  if (sigImg) {
    const h = mm(14);
    const w = Math.min(mm(45), (sigImg.width / sigImg.height) * h);
    f.page.image(sigImg, f.x1 - w, sigTop - h, w, h);
  }
  if (stampImg) {
    const h = mm(18);
    const w = Math.min(mm(30), (stampImg.width / stampImg.height) * h);
    f.page.image(stampImg, f.x1 - mm(48) - w, sigTop - h, w, h);
  }
  f.page.textRight(f.x1, sigTop - mm(17), content.doctor.name, { size, font: "bold" });
  f.page.textRight(f.x1, sigTop - mm(17) - size * 1.3, `Reg. No. ${content.doctor.registrationNumber}`, { size: size - 1.5, color: GREY });
  f.page.textRight(f.x1, sigTop - mm(17) - size * 2.5, content.doctor.council, { size: size - 2, color: GREY });
  if (sections.qr && qrModules) {
    const q = mm(20);
    f.page.qr(qrModules, f.x0, sigTop, q);
    f.page.text(f.x0 + q + 6, sigTop - size * 1.0, "Scan to verify this prescription", { size: size - 2, color: GREY });
    for (const [i, l] of wrapText(content.verifyUrl, size - 3, mm(70)).entries()) f.page.text(f.x0 + q + 6, sigTop - size * (2.2 + i * 1.1), l, { size: size - 3, color: GREY });
  }
  f.y = sigTop - blockH;

  // Footer line on every page.
  const total = doc.pages.length;
  doc.pages.forEach((p, i) => {
    const y = mm(settings.marginBottomMm) + footerH * 0 + 4;
    const yy = footerImg ? mm(settings.footerHeightMm) + 4 : y;
    const valid = content.validUntil ? `Valid for dispensing until ${dateText(content.validUntil)}. ` : "";
    p.text(mL, yy, `${valid}Electronic prescription issued on GoKesari Health by a verified registered medical practitioner.`, { size: 6.5, color: GREY });
    p.textRight(W - mR, yy, `Page ${i + 1} of ${total}`, { size: 6.5, color: GREY });
  });
  return doc.build();
}

function drawStandardHeader(page: PdfPage, c: RxContent, x0: number, x1: number, top: number, first: boolean): number {
  let y = top - 16;
  page.text(x0, y, c.doctor.name, { size: first ? 16 : 12, font: "bold", color: ACCENT });
  page.textRight(x1, y, c.clinic.name, { size: first ? 12 : 10, font: "bold" });
  y -= 13;
  page.text(x0, y, [c.doctor.qualifications, c.doctor.specialties.join(", ")].filter(Boolean).join(" - "), { size: 9 });
  const addr = wrapText(c.clinic.address, 8.5, (x1 - x0) * 0.45);
  addr.slice(0, 3).forEach((l, i) => page.textRight(x1, y - i * 10.5, l, { size: 8.5, color: GREY }));
  y -= 11;
  page.text(x0, y, `Reg. No. ${c.doctor.registrationNumber} - ${c.doctor.council}${c.doctor.registrationYear ? ` (${c.doctor.registrationYear})` : ""}`, { size: 8.5, color: GREY });
  y -= 11;
  if (c.clinic.phone) page.text(x0, y, `Phone: ${c.clinic.phone}`, { size: 8.5, color: GREY });
  y -= Math.max(0, (addr.length - 2) * 10.5) + 8;
  page.line(x0, y, x1, y, { width: 1.2, color: ACCENT });
  return y - 16;
}

/** The calibration sheet: a millimetre grid with the doctor's current margins drawn on it. */
export function renderCalibrationPdf(settings: LetterheadSettings): Buffer {
  const doc = new PdfDocument({ title: "GoKesari letterhead calibration" });
  const paper = (settings.paper in PAPER_SIZES_MM ? settings.paper : "A4") as PaperSize;
  const { w, h } = PAPER_SIZES_MM[paper];
  const page = doc.addPageMm(paper);
  for (let x = 0; x <= w; x += 5) {
    const major = x % 10 === 0;
    page.line(mm(x), 0, mm(x), mm(h), { width: major ? 0.35 : 0.15, color: major ? [0.6, 0.6, 0.6] : [0.82, 0.82, 0.82] });
    if (x % 20 === 0 && x > 0) page.text(mm(x) + 1, mm(h) - 8, `${x}`, { size: 5.5, color: GREY });
  }
  for (let y = 0; y <= h; y += 5) {
    const major = y % 10 === 0;
    page.line(0, mm(h - y), mm(w), mm(h - y), { width: major ? 0.35 : 0.15, color: major ? [0.6, 0.6, 0.6] : [0.82, 0.82, 0.82] });
    if (y % 20 === 0 && y > 0) page.text(2, mm(h - y) + 1, `${y}`, { size: 5.5, color: GREY });
  }
  const red: Rgb = [0.85, 0.1, 0.1];
  const top = mm(h - settings.marginTopMm);
  const bottom = mm(settings.marginBottomMm);
  const left = mm(settings.marginLeftMm);
  const right = mm(w - settings.marginRightMm);
  page.rect(left, bottom, right - left, top - bottom, { stroke: red, width: 1.2 });
  page.rect(mm(w / 2 - 50), mm(h / 2 - 22), mm(100), mm(44), { fill: [1, 1, 1], stroke: red, width: 0.6 });
  page.textCenter(mm(w / 2), mm(h / 2) + 34, "GoKesari letterhead calibration", { size: 11, font: "bold", color: red });
  page.textCenter(mm(w / 2), mm(h / 2) + 18, `Paper ${paper}. Red box = where prescription text will print.`, { size: 8 });
  page.textCenter(mm(w / 2), mm(h / 2) + 6, `Top ${settings.marginTopMm} mm, bottom ${settings.marginBottomMm} mm, left ${settings.marginLeftMm} mm, right ${settings.marginRightMm} mm.`, { size: 8 });
  page.textCenter(mm(w / 2), mm(h / 2) - 8, "Print this on your letterhead paper at 100% (no 'fit to page').", { size: 8 });
  page.textCenter(mm(w / 2), mm(h / 2) - 20, "Read the grid where your printed header ends; enter it as the top margin.", { size: 8 });
  // Corner crosses: check the printer does not shift or scale.
  for (const [cx, cy] of [
    [10, 10],
    [w - 10, 10],
    [10, h - 10],
    [w - 10, h - 10],
  ]) {
    page.line(mm(cx - 4), mm(h - cy), mm(cx + 4), mm(h - cy), { width: 0.8, color: red });
    page.line(mm(cx), mm(h - cy - 4), mm(cx), mm(h - cy + 4), { width: 0.8, color: red });
  }
  return doc.build();
}
