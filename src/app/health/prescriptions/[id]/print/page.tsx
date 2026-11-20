import { notFound, redirect } from "next/navigation";
import QRCode from "qrcode";

import { PrintNow } from "@/components/health/print-now";
import { PAPER_SIZES_MM, type PaperSize } from "@/lib/health/pdf-writer";
import { RX_FREQUENCY_LABELS, RX_TIMING_LABELS, type RxTiming } from "@/lib/health/constants";
import { AppError } from "@/lib/errors";
import { getCurrentUser } from "@/server/authz/guards";
import { effectiveLetterhead } from "@/server/health/letterheads";
import { prescriptionView } from "@/server/health/prescriptions";
import { medicineTitle, sectionsOf, vitalsLine } from "@/server/health/rx-pdf";

export const metadata = { title: "Print prescription" };
export const dynamic = "force-dynamic";

/**
 * The print-ready prescription (HTML, exact millimetre margins via @page). The issuing clinic prints on its
 * letterhead mode — on pre-printed paper nothing is printed in the header / footer area; the patient's copy
 * is complete. Hindi / Marathi instruction lines print here (DECISIONS.md H-05). ?auto=0 skips the dialog.
 */
export default async function PrintPrescriptionPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ auto?: string }> }) {
  const { id } = await params;
  const sp = await searchParams;
  const user = await getCurrentUser();
  if (!user) redirect(`/signin?callbackUrl=/health/prescriptions/${id}/print`);
  if (!/^[0-9a-f-]{36}$/.test(id)) notFound();
  const view = await prescriptionView(id, user).catch((e) => {
    if (e instanceof AppError) notFound();
    throw e;
  });
  const c = view.content;
  const rx = view.prescription;
  const lh = await effectiveLetterhead(rx.shopId, rx.memberId);
  const clinicCopy = view.viewer === "DOCTOR";
  const mode = clinicCopy ? lh.mode : "STANDARD";
  const paper = (lh.paper in PAPER_SIZES_MM ? lh.paper : "A4") as PaperSize;
  const s = sectionsOf(lh);
  const qr = s.qr ? await QRCode.toString(c.verifyUrl, { type: "svg", margin: 0, errorCorrectionLevel: "M" }) : null;
  const local = lh.localLanguage === "HI" ? "hi" : lh.localLanguage === "MR" ? "mr" : null;
  const imgSrc = (which: "header" | "footer") => `/api/health/letterhead/${rx.shopId}/image/view?which=${which}&member=${rx.memberId}`;
  const css = `
    @page { size: ${PAPER_SIZES_MM[paper].w}mm ${PAPER_SIZES_MM[paper].h}mm; margin: ${mode === "STANDARD" ? Math.min(lh.marginTopMm, 15) : lh.marginTopMm}mm ${lh.marginRightMm}mm ${lh.marginBottomMm}mm ${lh.marginLeftMm}mm; }
    @media print {
      .no-print { display: none !important; }
      body { background: #fff !important; }
      /* Only the prescription prints: the site header, menus and footer are hidden whatever their markup. */
      body * { visibility: hidden !important; }
      .rx, .rx * { visibility: visible !important; }
      .rx { position: absolute; left: 0; top: 0; width: 100%; }
    }
    .rx { font-size: ${lh.fontSizePt}pt; color: #111; font-family: system-ui, "Noto Sans Devanagari", sans-serif; }
    .rx table { width: 100%; border-collapse: collapse; }
    .rx td, .rx th { text-align: left; vertical-align: top; padding: 2mm 1mm; border-bottom: 0.2mm solid #ddd; }
  `;
  return (
    <div className="mx-auto max-w-3xl bg-white p-2">
      <style>{css}</style>
      <PrintNow auto={sp.auto !== "0"} logUrl={clinicCopy ? `/api/health/prescriptions/${rx.id}/pdf?print=1&log=1` : undefined} />
      <article className="rx" data-testid="health-rx-print" data-mode={mode}>
        {mode === "DIGITAL" && lh.headerImage ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={imgSrc("header")} alt="" style={{ width: "100%", height: `${lh.headerHeightMm}mm`, objectFit: "contain" }} />
        ) : null}
        {mode === "STANDARD" ? (
          <header style={{ borderBottom: "0.6mm solid #c2410c", paddingBottom: "2mm", marginBottom: "3mm", display: "flex", justifyContent: "space-between", gap: "4mm" }}>
            <div>
              <div style={{ fontSize: "1.5em", fontWeight: 800, color: "#c2410c" }}>{c.doctor.name}</div>
              <div>{[c.doctor.qualifications, c.doctor.specialties.join(", ")].filter(Boolean).join(" · ")}</div>
              <div style={{ color: "#555" }}>
                Reg. No. {c.doctor.registrationNumber} · {c.doctor.council}
              </div>
            </div>
            <div style={{ textAlign: "right" }}>
              <div style={{ fontWeight: 800 }}>{c.clinic.name}</div>
              <div style={{ color: "#555", maxWidth: "70mm" }}>{c.clinic.address}</div>
              {c.clinic.phone ? <div style={{ color: "#555" }}>Phone: {c.clinic.phone}</div> : null}
            </div>
          </header>
        ) : null}
        <div style={{ display: "flex", justifyContent: "space-between", background: "#f8f4ef", padding: "2mm", marginBottom: "3mm" }}>
          <strong>
            {c.patient.name} {[c.patient.age, c.patient.gender].filter(Boolean).join(" / ")}
          </strong>
          <span>
            {rx.rxNumber}
            {rx.version > 1 ? ` v${rx.version}` : ""} · {new Date(rx.issuedAt).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", dateStyle: "medium", timeStyle: "short" })} IST
          </span>
        </div>
        {s.vitals && vitalsLine(c.vitals) ? <p>Vitals: {vitalsLine(c.vitals)}</p> : null}
        {s.complaints && c.chiefComplaints ? <p>Complaints: {c.chiefComplaints}</p> : null}
        {s.history && c.history ? <p>History: {c.history}</p> : null}
        {s.examination && c.examination ? <p>Examination: {c.examination}</p> : null}
        {s.diagnosis && c.diagnoses.length ? <p>Diagnosis: {c.diagnoses.map((d) => (d.code ? `${d.text} (${d.code})` : d.text)).join("; ")}</p> : null}
        {s.medicines && c.items.length ? (
          <>
            <p style={{ fontSize: "1.6em", fontWeight: 800, color: "#c2410c", margin: "2mm 0 0" }}>℞</p>
            <table>
              <tbody>
                {c.items.map((i) => (
                  <tr key={i.lineNo}>
                    <td style={{ width: "5%" }}>{i.lineNo}.</td>
                    <td style={{ width: "45%" }}>
                      <strong>{medicineTitle(i)}</strong>
                      {i.instructions ? <div style={{ color: "#555" }}>{i.instructions}</div> : null}
                      {local && i.instructionsLocal ? <div style={{ color: "#333" }}>{i.instructionsLocal}</div> : null}
                    </td>
                    <td>
                      {i.dose}, {RX_FREQUENCY_LABELS[i.frequency]?.en ?? i.frequency}, {RX_TIMING_LABELS[i.timing as RxTiming]?.en ?? i.timing}
                      {local ? (
                        <div style={{ color: "#333" }}>
                          {RX_FREQUENCY_LABELS[i.frequency]?.[local] ?? ""} · {RX_TIMING_LABELS[i.timing as RxTiming]?.[local] ?? ""}
                        </div>
                      ) : null}
                    </td>
                    <td>{i.durationDays} days</td>
                    <td style={{ textAlign: "right" }}>Qty {i.quantity}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        ) : null}
        {s.investigations && c.investigations.length ? <p>Tests advised: {c.investigations.map((t) => t.name).join(", ")}</p> : null}
        {s.advice && c.advice ? <p>Advice: {c.advice}</p> : null}
        {s.followUp && c.followUpDate ? <p><strong>Follow-up: {c.followUpDate}</strong></p> : null}
        {s.suggestions && c.suggestions.filter((x) => x.printOnRx).length ? (
          <div>
            <strong>Referrals and suggestions</strong>
            <ul>
              {c.suggestions
                .filter((x) => x.printOnRx)
                .map((x, idx) => (
                  <li key={idx}>{x.text}</li>
                ))}
            </ul>
          </div>
        ) : null}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", marginTop: "8mm" }}>
          {qr ? (
            <div style={{ display: "flex", gap: "3mm", alignItems: "center" }}>
              <div style={{ width: "20mm", height: "20mm" }} dangerouslySetInnerHTML={{ __html: qr }} />
              <div style={{ fontSize: "0.75em", color: "#555", maxWidth: "60mm" }}>Scan to verify: {c.verifyUrl}</div>
            </div>
          ) : (
            <span />
          )}
          <div style={{ textAlign: "right" }}>
            {s.signature && lh.showSignature ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={`/api/health/doctor/${rx.memberId}/image/view?which=signature&rx=${rx.id}`} alt="" style={{ height: "14mm", maxWidth: "45mm", objectFit: "contain" }} />
            ) : null}
            <div style={{ fontWeight: 800 }}>{c.doctor.name}</div>
            <div style={{ color: "#555", fontSize: "0.85em" }}>Reg. No. {c.doctor.registrationNumber}</div>
          </div>
        </div>
        {mode === "DIGITAL" && lh.footerImage ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={imgSrc("footer")} alt="" style={{ width: "100%", height: `${lh.footerHeightMm}mm`, objectFit: "contain", marginTop: "4mm" }} />
        ) : null}
        <p style={{ fontSize: "0.7em", color: "#777", marginTop: "3mm" }}>
          {c.validUntil ? `Valid for dispensing until ${c.validUntil}. ` : ""}Electronic prescription issued on GoKesari Health by a verified registered medical practitioner.
        </p>
      </article>
    </div>
  );
}
