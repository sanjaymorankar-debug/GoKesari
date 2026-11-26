/**
 * docs/onboarding-v2-2026-11 (Flow 2), licence "Scan": what a licence photo says, read on the owner's device
 * (lib/kyc/browser-ocr.ts) and pre-filled for the owner to confirm — number, holder name, valid until and the
 * issuing authority. Reuses the document reader's extraction (lib/kyc/document-extract.ts) for the number, name
 * and validity of every known document; a licence an admin added (DOC:…) is read as an "Other licence". Nothing
 * here is trusted: the owner confirms every field and the number is then checked like a typed one.
 */
import { extractDocumentFields, isUploadDocType, normaliseOcrText, type UploadDocType } from "@/lib/kyc/document-extract";

export interface LicenceOcrFields {
  number: string | null;
  holderName: string | null;
  validUntil: string | null;
  issuingAuthority: string | null;
}

/** The document reader's type for a licence key; admin-added documents (DOC:…) are "Other licence". */
export function uploadTypeForLicence(licenceKey: string): UploadDocType {
  return isUploadDocType(licenceKey) ? licenceKey : "OTHER_LICENCE";
}

/** A labelled authority ("Issuing Authority: …", "Issued by …"); a bare "Authority" only with a colon, so an
 * issuer's own name ("Food Safety and Standards Authority of India") is not read as the label. */
const AUTHORITY_LABEL = /(?:(?:ISSUING|LICENSING|LICENCING|REGISTERING)\s+AUTHORITY\s*[:\-.]?|ISSUED\s+BY\s*[:\-.]?|\bAUTHORITY\s*:)\s*(.*)$/i;
const AUTHORITY_WORDS = /\b(MUNICIPAL|CORPORATION|COMMISSIONER|DEPARTMENT|DIRECTORATE|COUNCIL|GOVERNMENT|GOVT|FOOD SAFETY|DRUGS? CONTROL|NAGAR|PANCHAYAT|LABOUR|MINISTRY)\b/i;
/** A generic licence / registration number on a line labelled as one. */
const NUMBER_LABEL = /(?:LICEN[CS]E|REGISTRATION|REGN|CERTIFICATE|NOC)\s*(?:NO|NUMBER|#)\.?\s*[:\-.]?\s*([A-Z0-9][A-Z0-9/\-. ]{3,40})/i;

function authorityOf(lines: string[]): string | null {
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(AUTHORITY_LABEL);
    if (!m) continue;
    const here = m[1]?.trim();
    if (here && here.length >= 3) return here.slice(0, 120);
    const next = lines[i + 1]?.trim();
    if (next && next.length >= 3) return next.slice(0, 120);
  }
  const line = lines.find((l) => AUTHORITY_WORDS.test(l));
  return line ? line.slice(0, 120) : null;
}

/** The fields a licence photo's text gives, for the owner to confirm. */
export function extractLicenceFields(rawText: string, licenceKey: string): LicenceOcrFields {
  const type = uploadTypeForLicence(licenceKey);
  const { fields } = extractDocumentFields(rawText, type);
  const { lines } = normaliseOcrText(rawText);
  let number = fields.number;
  if (!number) {
    for (const line of lines) {
      const m = line.match(NUMBER_LABEL);
      if (m) {
        number = m[1].trim().replace(/\s+/g, " ");
        break;
      }
    }
  }
  return {
    number: number ?? null,
    holderName: fields.name ?? null,
    validUntil: fields.validUntil ?? null,
    issuingAuthority: authorityOf(lines),
  };
}
