/**
 * Gridlines (OnGrid) adapter — the primary vendor chosen in Part 1.
 *
 * Auth: `X-Auth-Type: API-Key` plus `X-API-Key`; production may also require
 * the calling server's IP to be whitelisted (HTTP 406 otherwise).
 *
 * CONFIRM IN SANDBOX: the endpoint paths and response field names below come
 * from Gridlines' public documentation pages as far as they could be read
 * when this was written, not from a live call. Field lookup is therefore
 * tolerant (several candidate names per field), and a response this code
 * cannot read raises KycConfigError("unexpected_response"), which sends the
 * document to manual review — it is never treated as verified. Run the
 * sandbox test plan and correct GRIDLINES_ENDPOINTS / the field lists before
 * switching test.gokesari.com from the mock.
 */
import type { SellerDocType } from "@/lib/kyc/doc-formats";

import { kycPostJson, type KycHttpOptions } from "../http";
import {
  KycConfigError,
  type KycAdapter,
  type ProviderOutcome,
  type SourceDocStatus,
  type SourceRecord,
  type VerifyRequest,
} from "../types";

export const GRIDLINES_BASE_URL = "https://api.gridlines.io";

/** Path and request body per document. */
export const GRIDLINES_ENDPOINTS: Record<
  SellerDocType,
  { path: string; body: (req: VerifyRequest) => Record<string, unknown> }
> = {
  PAN: { path: "/pan-api/fetch-detailed", body: (r) => ({ pan_number: r.number, consent: "Y" }) },
  GSTIN: { path: "/gstin-api/fetch-detailed", body: (r) => ({ gstin: r.number, consent: "Y" }) },
  UDYAM: { path: "/udyam-api/fetch-udyam", body: (r) => ({ udyam_reference_number: r.number, consent: "Y" }) },
  FSSAI: { path: "/fssai-api/fetch-license", body: (r) => ({ license_number: r.number, consent: "Y" }) },
  SHOP_ACT: {
    path: "/shops-api/fetch-details",
    body: (r) => ({ registration_number: r.number, state: r.extra.stateCode, city: r.extra.city, consent: "Y" }),
  },
};

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** First non-empty string among candidate keys (searched one level deep too). */
function pick(obj: Json, keys: string[]): string | null {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number") return String(value);
  }
  for (const value of Object.values(obj)) {
    if (isObject(value)) {
      for (const key of keys) {
        const nested = value[key];
        if (typeof nested === "string" && nested.trim()) return nested.trim();
      }
    }
  }
  return null;
}

function toDocStatus(raw: string | null): SourceDocStatus {
  if (!raw) return "unknown";
  const s = raw.toLowerCase();
  if (/(^|\b)(active|valid|existing|approved)(\b|$)/.test(s) && !/inactive|invalid/.test(s)) return "active";
  if (/cancel/.test(s)) return "cancelled";
  if (/suspend/.test(s)) return "suspended";
  if (/expir/.test(s)) return "expired";
  if (/inactive|invalid|deactivat|deleted|surrender/.test(s)) return "inactive";
  return "unknown";
}

/** Accepts YYYY-MM-DD, DD/MM/YYYY or DD-MM-YYYY; returns YYYY-MM-DD or null. */
export function toIsoDate(raw: string | null): string | null {
  if (!raw) return null;
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(raw);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const dmy = /^(\d{2})[/-](\d{2})[/-](\d{4})$/.exec(raw.trim());
  if (dmy) return `${dmy[3]}-${dmy[2]}-${dmy[1]}`;
  return null;
}

function extractPincode(address: string | null): string | null {
  const match = address ? /\b(\d{6})\b/.exec(address) : null;
  return match ? match[1] : null;
}

/**
 * Gridlines wraps results as { request_id, status, data: { code, message, <doc>_data } }.
 * Codes outside the "found" family mean the number is unknown at source.
 */
export function parseGridlinesResponse(req: VerifyRequest, status: number, body: unknown): ProviderOutcome {
  if (!isObject(body)) throw new KycConfigError("unexpected_response", "Gridlines response was not an object.");
  const providerRef = typeof body.request_id === "string" ? body.request_id : null;
  const data = isObject(body.data) ? body.data : null;
  const message = data && typeof data.message === "string" ? data.message.toLowerCase() : "";

  if (status === 404 || /not found|does not exist|no record|invalid (pan|gstin|udyam|license|licence)/.test(message)) {
    return { kind: "not_found", providerRef };
  }
  if (/not supported|unsupported|state not available|not available for/.test(message)) {
    return { kind: "unsupported", reason: "Gridlines cannot verify this document for this state." };
  }
  // The record sits under a "<something>_data" key, or is `data` itself.
  const recordKey = data ? Object.keys(data).find((k) => k.endsWith("_data") && isObject(data[k])) : undefined;
  const raw = data && recordKey ? (data[recordKey] as Json) : data;
  if (!raw) throw new KycConfigError("unexpected_response", "Gridlines response had no data.");

  const name = pick(raw, ["legal_name", "name", "name_as_per_pan", "full_name", "enterprise_name", "company_name", "establishment_name", "registered_name"]);
  const address = pick(raw, ["address", "principal_address", "premises_address", "official_address", "full_address"]);
  const record: SourceRecord = {
    docStatus: toDocStatus(pick(raw, ["status", "gstin_status", "pan_status", "license_status", "licence_status", "registration_status"])),
    name,
    tradeName: pick(raw, ["trade_name", "trade_name_of_business"]),
    ownerName: pick(raw, ["owner_name", "proprietor_name", "name_of_entrepreneur"]),
    entityType: pick(raw, ["category", "constitution_of_business", "constitution", "organisation_type", "organization_type", "taxpayer_type"]),
    linkedPan: pick(raw, ["pan", "pan_number"]),
    stateCode: pick(raw, ["state_code", "state"]),
    pincode: pick(raw, ["pincode", "pin_code", "premises_pincode"]) ?? extractPincode(address),
    address,
    category: pick(raw, ["license_type", "licence_type", "enterprise_type", "type_of_enterprise"]),
    validUntil: toIsoDate(pick(raw, ["valid_upto", "valid_till", "expiry_date", "validity_date", "valid_until", "expiry"])),
  };

  if (!record.name && record.docStatus === "unknown") {
    throw new KycConfigError("unexpected_response", "Gridlines response had neither a name nor a status this code recognises.");
  }
  return { kind: "found", record, providerRef };
}

export function createGridlinesAdapter(apiKey: string, http: KycHttpOptions, baseUrl = GRIDLINES_BASE_URL): KycAdapter {
  return {
    id: "gridlines",
    async verify(req: VerifyRequest): Promise<ProviderOutcome> {
      const endpoint = GRIDLINES_ENDPOINTS[req.docType];
      const { status, body } = await kycPostJson(
        `${baseUrl}${endpoint.path}`,
        { "X-Auth-Type": "API-Key", "X-API-Key": apiKey, "X-Reference-ID": req.idempotencyKey },
        endpoint.body(req),
        req.idempotencyKey,
        http,
      );
      return parseGridlinesResponse(req, status, body);
    },
  };
}
