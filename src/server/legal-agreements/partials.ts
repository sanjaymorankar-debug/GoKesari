/**
 * Blocks built in code and dropped into templates with {{> name}} (docs/seller-agreements-2026-11): Annexure A,
 * the Schedule of Licences, the medical agreement's particulars table and both signature blocks. Rows the shop
 * has no data for are left out — never "null" or an empty cell (brief §2).
 */
import type { LegalLanguage } from "@/server/db/legal-agreements-schema";

import { type AgreementSnapshot, type SignatureInfo } from "./data";
import { DESIGNATION_LABELS, LABELS, LICENCE_KIND_LABELS, calendarDate, dateTimeIst } from "./i18n";
import { escapeHtml, type PartialRenderer } from "./template-engine";

const e = escapeHtml;

function table(head: string[], rows: string[][], className = ""): string {
  return `<table class="${className}"><thead><tr>${head.map((h) => `<th>${e(h)}</th>`).join("")}</tr></thead><tbody>${rows
    .map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`)
    .join("")}</tbody></table>`;
}

function kv(rows: [string, string | null | undefined][], lang: LegalLanguage): string {
  const L = LABELS[lang];
  const present = rows.filter((r): r is [string, string] => typeof r[1] === "string" && r[1].trim() !== "");
  return table([L.field, L.details], present.map(([k, v]) => [e(k), v]), "kv");
}

export function licenceLabel(kind: string, customName: string | null, lang: LegalLanguage): string {
  const base = LICENCE_KIND_LABELS[kind]?.[lang] ?? kind;
  return customName ? `${base}: ${customName}` : base;
}

export function buildPartials(s: AgreementSnapshot, lang: LegalLanguage, signature: SignatureInfo): Record<string, PartialRenderer> {
  const L = LABELS[lang];
  const sellerDesignation = signature.signed
    ? DESIGNATION_LABELS[signature.designation][lang]
    : s.owner.designation
      ? DESIGNATION_LABELS[s.owner.designation][lang]
      : `${DESIGNATION_LABELS.PROPRIETOR[lang]} / ${DESIGNATION_LABELS.PARTNER[lang]} / ${DESIGNATION_LABELS.DIRECTOR[lang]}`;
  const signedWhen = signature.signed ? dateTimeIst(signature.signedAt) : null;
  const drugLicences = s.licences.filter((l) => l.kind.startsWith("DRUG_LICENCE"));
  const fssai = s.licences.find((l) => l.kind === "FSSAI");

  const sellerSignatureCell = signature.signed
    ? `<div class="sig-signed"><strong>${e(L.digitallySigned)}</strong><br/>${e(signature.signerName)}<br/>${e(signedWhen!)}</div>`
    : `<div class="sig-pending">${e(L.toBeSigned)}</div>`;
  const platformSignatureCell = signature.signed
    ? `<div class="sig-signed"><strong>${e(L.platformSigned)}</strong>${
        signature.sealDataUrl ? `<br/><img class="e-seal" src="${signature.sealDataUrl}" alt="${e(L.eSealAffixed)}"/>` : ""
      }</div>`
    : `<div class="sig-pending">${e(L.toBeSigned)}</div>`;

  return {
    signatures: () =>
      table(
        ["", L.forPlatform, L.forSeller],
        [
          [e(L.entity), "ASMY Global Trading &amp; Consultancy India Private Limited (gokesari.com)", `<strong>${e(s.seller.legalName)}</strong>`],
          [e(L.signatoryName), e(s.platform.signatoryName), e(signature.signed ? signature.signerName : s.owner.name)],
          [e(L.designation), e(s.platform.signatoryDesignation), e(sellerDesignation)],
          [e(L.signature), platformSignatureCell, sellerSignatureCell],
          [e(L.date), signedWhen ? e(signedWhen) : e(L.toBeSigned), signedWhen ? e(signedWhen) : e(L.toBeSigned)],
          [e(L.place), e(s.place), e(s.place)],
        ],
        "signatures",
      ),

    seller_details: () =>
      kv(
        [
          [L.legalName, e(s.seller.legalName)],
          [L.tradeName, s.seller.tradeName !== s.seller.legalName ? e(s.seller.tradeName) : null],
          [L.owner, `${e(signature.signed ? signature.signerName : s.owner.name)} (${e(sellerDesignation)})`],
          [L.address, e(`${s.seller.addressLine} – ${s.seller.pincode}`)],
          [L.googleLocation, s.seller.googleLocationUrl ? e(s.seller.googleLocationUrl) : null],
          [L.shopTypes, e(s.seller.shopTypeLabels.join(", "))],
          [L.pan, s.ids.pan ? e(s.ids.pan) : null],
          [L.gstin, s.ids.gstin ? e(s.ids.gstin) : null],
          [L.shopAct, s.ids.shopAct ? e(s.ids.shopAct) : null],
          [L.udyam, s.ids.udyam ? e(s.ids.udyam) : null],
          [
            L.drugLicence,
            drugLicences.length
              ? drugLicences.map((l) => `${e(l.number)}${l.validUntil ? ` (${e(calendarDate(l.validUntil))})` : ""}`).join("<br/>")
              : null,
          ],
          [L.pharmacist, s.pharmacist ? e(`${s.pharmacist.name} – ${s.pharmacist.registrationNumber}`) : null],
          [L.fssai, fssai ? e(fssai.number) : null],
          [L.complaintContact, e(s.complaintContact)],
          [L.bank, s.bankLast4 ? e(L.bankLast4(s.bankLast4)) : null],
          [L.sellerId, e(s.seller.sellerId)],
        ],
        lang,
      ),

    medical_particulars: () =>
      kv(
        [
          [LABELS[lang].drugLicence, drugLicences.length ? drugLicences.map((l) => e(l.number)).join("<br/>") : null],
          [L.pharmacist, s.pharmacist ? e(`${s.pharmacist.name} – ${s.pharmacist.registrationNumber}`) : null],
          [L.gstin, s.ids.gstin ? e(s.ids.gstin) : null],
          [L.pan, s.ids.pan ? e(s.ids.pan) : null],
          [L.fssai, fssai ? e(fssai.number) : null],
          [L.mobileWhatsappEmail, [s.owner.mobileMasked, s.owner.email].filter(Boolean).map((v) => e(v!)).join(" / ") || null],
        ],
        lang,
      ),

    licence_schedule: () => {
      if (s.licences.length === 0) return `<p>${e(L.noLicences)}</p>`;
      const hasFrom = s.licences.some((l) => l.validFrom);
      const head = [L.licenceType, L.licenceNumber, L.issuingAuthority, ...(hasFrom ? [L.validFrom] : []), L.validUntil, L.verificationStatus, L.documentReference];
      const rows = s.licences.map((l) => [
        e(licenceLabel(l.kind, l.customName, lang)),
        e(l.number),
        e(l.authority ?? L.notStated),
        ...(hasFrom ? [e(l.validFrom ? calendarDate(l.validFrom) : L.notStated)] : []),
        e(l.validUntil ? calendarDate(l.validUntil) : L.noExpiry),
        e(L.status[l.status]),
        `<span class="ref">${e(l.reference)}</span>`,
      ]);
      const asOf = dateTimeIst(new Date(s.licencesAsOf));
      return `${table(head, rows, "licences")}<p class="note">${e(L.licenceScheduleNote(asOf))}</p>`;
    },

    declaration_signature: () =>
      `<p class="declaration-sign">${e(
        signature.signed ? L.declarationSigned(signature.signerName, signedWhen!) : L.declarationUnsigned,
      )} ${e(L.place)}: ${e(s.place)}</p>`,
  };
}
