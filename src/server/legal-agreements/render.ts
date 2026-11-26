/**
 * Builds the complete HTML page of one agreement in one language from its template and a shop snapshot, and
 * the Electronic Acceptance Certificate page (docs/seller-agreements-2026-11). Pure; the PDF printer and the
 * in-site viewer both use it, so what the owner reads is what is signed.
 */
import type { LegalLanguage } from "@/server/db/legal-agreements-schema";

import { localise, type AgreementSnapshot, type SignatureInfo } from "./data";
import { LABELS, LANGUAGE_NAMES, dateTimeIst } from "./i18n";
import { buildPartials } from "./partials";
import { baseStyles, watermarkHtml } from "./pdf/html-to-pdf";
import { escapeHtml as e, renderTemplate } from "./template-engine";

const DOC_STYLES = `
h1{font-size:17pt;margin:0 0 2mm;color:#1f3a68;text-align:center}
p.subtitle{text-align:center;margin:0 0 5mm;color:#555}
h2{font-size:12pt;margin:6mm 0 2mm;color:#1f3a68;break-after:avoid}
h3{font-size:11pt;margin:5mm 0 2mm;color:#1f3a68;break-after:avoid}
p{margin:0 0 2.5mm;text-align:justify}
ol,ul{margin:0 0 3mm;padding-left:7mm}
li{margin:0 0 1.5mm}
table{border-collapse:collapse;width:100%;margin:2mm 0 4mm;font-size:9pt;break-inside:auto}
tr{break-inside:avoid}
th,td{border:0.6pt solid #9aa6b8;padding:1.6mm 2mm;vertical-align:top;text-align:left}
th{background:#e8eef7;color:#1f3a68}
table.kv td:first-child{width:42%;background:#f6f8fb}
table.licences{font-size:8.2pt}
table.signatures td:first-child{width:18%;background:#f6f8fb}
.sig-signed{color:#0b5d1e}
.sig-pending{color:#8a6d00;font-style:italic}
img.e-seal{height:22mm;margin-top:1.5mm}
p.note{font-size:8pt;color:#555}
.ref{font-family:monospace;font-size:7.5pt}
p.lang-notice{background:#fff7e0;border:0.6pt solid #e6c766;padding:1.5mm 2.5mm;font-size:9pt}
.draft-banner{border:1pt dashed #c0392b;color:#c0392b;padding:2mm 3mm;margin:0 0 4mm;font-weight:700;font-size:9pt}
.cert h1{font-size:15pt}
.cert table td:first-child{width:38%;background:#f6f8fb}
.cert .hash{font-family:monospace;font-size:7.5pt;word-break:break-all}
`;

export type RenderedAgreement = { html: string; missing: string[]; unknownPartials: string[] };

export type TemplateLike = { templateBody: string; title: string; version: string; language: LegalLanguage };

export function renderAgreementHtml(
  template: TemplateLike,
  snapshot: AgreementSnapshot,
  options: { effectiveAt: Date; signature: SignatureInfo; preview: boolean },
): RenderedAgreement {
  const lang = template.language;
  const data = localise(snapshot, lang, options.effectiveAt, options.signature);
  const body = renderTemplate(template.templateBody, data, buildPartials(snapshot, lang, options.signature));
  const banner = options.preview ? `<div class="draft-banner">${e(LABELS[lang].draftBanner)}</div>` : "";
  const html = `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><title>${e(template.title)} v${e(template.version)}</title><style>${baseStyles()}${DOC_STYLES}</style></head><body>${watermarkHtml()}${banner}${body.html}</body></html>`;
  return { html, missing: body.missing, unknownPartials: body.unknownPartials };
}

export type CertificateInput = {
  lang: LegalLanguage;
  docTitle: string;
  version: string;
  snapshot: AgreementSnapshot;
  snapshotSha256: string;
  signerName: string;
  designationLabel: string;
  acceptedAt: Date;
  ip: string | null;
  platform: "web" | "android" | "ios";
  otpRef: string;
  mobileMasked: string | null;
  signedHashes: Partial<Record<LegalLanguage, string>>;
  verifyUrl: string;
  registeredBy: string | null;
};

const PLATFORM_NAMES = { web: "Website (gokesari.com)", android: "Android app", ios: "iOS app" } as const;

export function renderCertificateHtml(c: CertificateInput): string {
  const L = LABELS[c.lang];
  const rows: [string, string][] = [
    [L.cert.document, e(c.docTitle)],
    [L.cert.version, e(c.version)],
    [L.cert.shop, e(c.snapshot.seller.legalName)],
    [L.cert.sellerId, e(c.snapshot.seller.sellerId)],
    [L.cert.signer, e(c.signerName)],
    [L.cert.designation, e(c.designationLabel)],
    [L.cert.mobile, e(c.mobileMasked ?? "—")],
    [L.cert.acceptedAt, e(dateTimeIst(c.acceptedAt))],
    [L.cert.ip, e(c.ip ?? "—")],
    [L.cert.platform, e(PLATFORM_NAMES[c.platform])],
    [L.cert.otpRef, `<span class="hash">${e(c.otpRef)}</span>`],
    [L.cert.licencesAsOf, e(dateTimeIst(new Date(c.snapshot.licencesAsOf)))],
    [L.cert.snapshotHash, `<span class="hash">${e(c.snapshotSha256)}</span>`],
    [
      L.cert.hashes,
      (Object.entries(c.signedHashes) as [LegalLanguage, string][])
        .map(([lang, hash]) => `${e(LANGUAGE_NAMES[lang])}: <span class="hash">${e(hash)}</span>`)
        .join("<br/>"),
    ],
    ...(c.registeredBy ? ([[L.cert.registeredBy, e(c.registeredBy)]] as [string, string][]) : []),
    [L.cert.verify, `<span class="hash">${e(c.verifyUrl)}</span>`],
  ];
  return `<!doctype html><html lang="${c.lang}"><head><meta charset="utf-8"><title>${e(L.certificateTitle)}</title><style>${baseStyles()}${DOC_STYLES}</style></head><body class="cert">${watermarkHtml()}<div class="cert"><h1>${e(L.certificateTitle)}</h1><p>${e(L.certificateIntro)}</p><table class="kv"><tbody>${rows
    .map(([k, v]) => `<tr><td>${e(k)}</td><td>${v}</td></tr>`)
    .join("")}</tbody></table><p class="note">${e(L.certificateFooter)}</p></div></body></html>`;
}
