/**
 * Deterministic stand-in for a real vendor: local development, CI, and
 * test.gokesari.com before sandbox keys arrive. It makes no network call.
 *
 * The outcome is chosen by the number itself, so every scenario in the
 * sandbox test plan can be reproduced by typing a number. For PAN and GSTIN
 * the four digits of the (embedded) PAN decide; for the others, the last
 * digits of the number:
 *
 *   …0000  not found at source             …9999  vendor timeout (stays PENDING)
 *   …8888  inactive / cancelled / expired  …7777  name on record does not match
 *   …6666  FSSAI only: expires in 20 days  …5555  vendor can't check this (manual review)
 *   anything else: active, name = the name supplied to match
 *
 * Shop Act in Maharashtra returns "unsupported" (no vendor confirms MH
 * coverage, see the Part 1 notes) unless the number ends in 2222, which
 * stands in for a registration the vendor can verify.
 */
import type { KycAdapter, ProviderOutcome, SourceRecord, VerifyRequest } from "../types";
import { KycUnavailableError } from "../types";

const DAY_MS = 86_400_000;

function isoDate(offsetDays: number, from = Date.now()): string {
  return new Date(from + offsetDays * DAY_MS).toISOString().slice(0, 10);
}

/** The four scenario digits for a request. */
function scenarioDigits(req: VerifyRequest): string {
  if (req.docType === "PAN") return req.number.slice(5, 9);
  if (req.docType === "GSTIN") return req.number.slice(7, 11);
  return req.number.replace(/\D/g, "").slice(-4);
}

export function createMockAdapter(now: () => number = Date.now): KycAdapter {
  return {
    id: "mock",
    async verify(req: VerifyRequest): Promise<ProviderOutcome> {
      const digits = scenarioDigits(req);
      const providerRef = `mock-${req.idempotencyKey}`;

      if (digits === "9999") throw new KycUnavailableError("timeout", "Mock vendor timeout.");
      if (digits === "0000") return { kind: "not_found", providerRef };
      if (digits === "5555") return { kind: "unsupported", reason: "Mock vendor cannot check this document." };
      if (req.docType === "SHOP_ACT" && (req.extra.stateCode ?? "MH") === "MH" && digits !== "2222") {
        return { kind: "unsupported", reason: "Shop Act verification is not available for Maharashtra." };
      }

      const name = digits === "7777" ? "MISMATCHED NAME ENTERPRISES" : (req.extra.nameToMatch ?? "TEST SELLER").toUpperCase();
      const record: SourceRecord = { docStatus: "active", name, stateCode: req.extra.stateCode ?? "MH", pincode: "411001" };

      switch (req.docType) {
        case "PAN":
          record.entityType = req.number[3];
          if (digits === "8888") record.docStatus = "inactive";
          break;
        case "GSTIN":
          record.tradeName = name;
          record.linkedPan = req.number.slice(2, 12);
          record.stateCode = req.number.slice(0, 2);
          if (digits === "8888") record.docStatus = "cancelled";
          break;
        case "UDYAM":
          record.category = "MICRO";
          record.ownerName = name;
          record.stateCode = req.number.slice(6, 8);
          if (digits === "8888") record.docStatus = "cancelled";
          break;
        case "FSSAI":
          record.category = "STATE";
          record.validUntil = isoDate(digits === "8888" ? -10 : digits === "6666" ? 20 : 730, now());
          if (digits === "8888") record.docStatus = "expired";
          break;
        case "SHOP_ACT":
          record.validUntil = digits === "8888" ? isoDate(-10, now()) : null;
          if (digits === "8888") record.docStatus = "expired";
          break;
      }
      return { kind: "found", record, providerRef };
    },
  };
}
