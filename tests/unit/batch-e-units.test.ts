/**
 * batch-2026-10 WS-E — pure parts: payout cycle windows, place of supply,
 * document numbering, provider signatures, QR drawing in the PDF writer.
 */
import { createHmac } from "node:crypto";

import { describe, expect, it } from "vitest";

import { textPdf } from "@/lib/pdf";
import { stateForPincode } from "@/lib/pincode-state";
import { qrMatrix } from "@/lib/qr";
import { resolvePlaceOfSupply, sellerRegistrationNotes } from "@/server/invoicing/place-of-supply";
import { cycleWindowFor } from "@/server/payouts/cycle";
import { cashfreePayoutProvider, cashfreePayoutSignature } from "@/server/payouts/providers/cashfree";
import { razorpayxPayoutProvider, razorpayxSignature } from "@/server/payouts/providers/razorpayx";
import { buildSandboxWebhook, sandboxOutcome, sandboxPayoutProvider, sandboxRef, sandboxUtr } from "@/server/payouts/providers/sandbox";
import { formatPlatformDocNumber, gstOnTaxable } from "@/server/platform-invoices/service";
import { decodePdfQr, pdfHasImage } from "../helpers/pdf-qr";

describe("payout cycle windows", () => {
  it("TC-B26-E-001 closes the last complete 5-day cycle counted from the anchor, and follows a changed cycle length", () => {
    expect(cycleWindowFor("2026-10-04", "2026-10-01", 5)).toBeNull();
    expect(cycleWindowFor("2026-10-06", "2026-10-01", 5)).toEqual({ start: "2026-10-01", end: "2026-10-06" });
    expect(cycleWindowFor("2026-10-10", "2026-10-01", 5)).toEqual({ start: "2026-10-01", end: "2026-10-06" });
    expect(cycleWindowFor("2026-10-11", "2026-10-01", 5)).toEqual({ start: "2026-10-06", end: "2026-10-11" });
    // Configurable: a 7-day cycle.
    expect(cycleWindowFor("2026-10-15", "2026-10-01", 7)).toEqual({ start: "2026-10-08", end: "2026-10-15" });
    expect(cycleWindowFor("2026-10-15", "2026-10-01", 0)).toBeNull();
  });
});

describe("place of supply and supplier wording", () => {
  it("TC-B26-E-002 uses the address state, then its PIN code, then (assumed) the shop's state; pickup is the shop", () => {
    const base = { sellerState: "MH", hasDeliveryAddress: true, usePincode: true };
    expect(resolvePlaceOfSupply({ ...base, addressState: "Karnataka", addressPincode: "411001" })).toEqual({ state: "KA", source: "ADDRESS_STATE" });
    expect(resolvePlaceOfSupply({ ...base, addressState: null, addressPincode: "560001" })).toEqual({ state: "KA", source: "ADDRESS_PIN" });
    expect(resolvePlaceOfSupply({ ...base, addressState: null, addressPincode: "800001" })).toEqual({ state: "MH", source: "ASSUMED_SELLER_STATE" });
    expect(resolvePlaceOfSupply({ ...base, usePincode: false, addressState: null, addressPincode: "560001" }).source).toBe("ASSUMED_SELLER_STATE");
    expect(resolvePlaceOfSupply({ ...base, hasDeliveryAddress: false, addressState: null, addressPincode: null })).toEqual({ state: "MH", source: "PICKUP_SHOP" });
    expect(resolvePlaceOfSupply({ ...base, sellerState: null, addressState: null, addressPincode: "800001" })).toEqual({ state: null, source: "UNKNOWN" });
    expect(stateForPincode("403001")).toBe("GA");
    expect(stateForPincode("110001")).toBe("DL");
    expect(stateForPincode("844101")).toBeNull();
    expect(stateForPincode("12345")).toBeNull();
  });

  it("TC-B26-E-003 words a PAN-only / unregistered or composition supplier's bill of supply", () => {
    expect(sellerRegistrationNotes("UNREGISTERED", "XXXXXX234F")[0]).toContain("PAN-only seller, PAN XXXXXX234F");
    expect(sellerRegistrationNotes("COMPOSITION", null)[0]).toContain("Composition taxable person, not eligible to collect tax on supplies");
    expect(sellerRegistrationNotes("REGISTERED", null)).toEqual([]);
  });
});

describe("GoKesari document numbers and GST", () => {
  it("TC-B26-E-004 numbers GKP/2627/000001 in at most 16 characters and refuses longer", () => {
    expect(formatPlatformDocNumber("GKP", "2026-27", 1)).toBe("GKP/2627/000001");
    expect(formatPlatformDocNumber("GKPI", "2026-27", 999_999)).toHaveLength(16);
    expect(() => formatPlatformDocNumber("GKPIX", "2026-27", 1)).toThrow();
    expect(gstOnTaxable(10_000, 1800, "INTRA")).toEqual({ cgstPaise: 900, sgstPaise: 900, igstPaise: 0 });
    expect(gstOnTaxable(10_001, 1800, "INTER")).toEqual({ cgstPaise: 0, sgstPaise: 0, igstPaise: 1800 });
  });
});

describe("payout providers", () => {
  it("TC-B26-E-005 sandbox: deterministic outcomes, 16-character UTRs and signed webhooks", async () => {
    expect(sandboxOutcome(10_000, 1).ok).toBe(true);
    expect(sandboxOutcome(10_099, 1).ok).toBe(false);
    expect(sandboxOutcome(10_099, 2).ok).toBe(true);
    expect(sandboxOutcome(10_098, 3).ok).toBe(false);
    const ref = sandboxRef("payout-item:x:1");
    expect(sandboxUtr(ref)).toMatch(/^SBXN\d{12}$/);
    expect(sandboxPayoutProvider.isConfigured()).toBe(true);
    const created = await sandboxPayoutProvider.createTransfer({
      idempotencyKey: "k:1",
      referenceId: "00000000-0000-0000-0000-000000000001",
      amountPaise: 12_345,
      mode: "NEFT",
      beneficiary: { name: "A", method: "BANK_ACCOUNT", accountNumber: "1", ifsc: "HDFC0000001" },
      narration: "n",
      attempt: 1,
    });
    expect(created.status).toBe("PROCESSING");
    const hook = buildSandboxWebhook(created.providerRef, { referenceId: "x", amountPaise: 12_345, attempt: 1 });
    expect(sandboxPayoutProvider.verifyWebhook(hook.rawBody, hook.headers)).toBe(true);
    const event = sandboxPayoutProvider.parseWebhook(hook.rawBody, hook.headers);
    expect(event).toMatchObject({ status: "SUCCESS", providerRef: created.providerRef, referenceId: "00000000-0000-0000-0000-000000000001" });
    expect(event.utr).toMatch(/^SBXN\d{12}$/);
    expect(sandboxPayoutProvider.verifyWebhook(hook.rawBody.replace("processed", "failed"), hook.headers)).toBe(false);
  });

  it("TC-B26-E-006 RazorpayX and Cashfree scaffolds: unconfigured without keys; webhook signatures checked over the raw body", () => {
    const env = process.env as Record<string, string | undefined>;
    expect(razorpayxPayoutProvider.isConfigured()).toBe(false);
    expect(cashfreePayoutProvider.isConfigured()).toBe(false);
    // Without a secret every signature is refused.
    expect(razorpayxPayoutProvider.verifyWebhook("{}", new Headers({ "x-razorpay-signature": razorpayxSignature("{}", "s") }))).toBe(false);
    expect(env.RAZORPAYX_WEBHOOK_SECRET).toBeUndefined();
    expect(razorpayxSignature("body", "secret")).toBe(createHmac("sha256", "secret").update("body").digest("hex"));
    expect(cashfreePayoutSignature("123", "body", "secret")).toBe(createHmac("sha256", "secret").update("123body").digest("base64"));
    const rp = razorpayxPayoutProvider.parseWebhook(
      JSON.stringify({ event: "payout.processed", payload: { payout: { entity: { id: "pout_1", reference_id: "ref", status: "processed", utr: "HDFCN52026101800" } } } }),
      new Headers({ "x-razorpay-event-id": "evt_1" }),
    );
    expect(rp).toMatchObject({ eventId: "evt_1", status: "SUCCESS", utr: "HDFCN52026101800", providerRef: "pout_1" });
    const cf = cashfreePayoutProvider.parseWebhook(JSON.stringify({ type: "TRANSFER_FAILED", data: { cf_transfer_id: 99, transfer_id: "t", status_description: "Invalid IFSC" } }), new Headers());
    expect(cf).toMatchObject({ eventId: "99:TRANSFER_FAILED", status: "FAILED", failureReason: "Invalid IFSC" });
  });
});

describe("QR code in the PDF writer", () => {
  it("TC-B26-E-007 draws a real, decodable QR image; without one the PDF has no image", () => {
    const payload = "SellerGSTIN:27ABCDE1234F1Z5|DocNo:GK2627-000001|TotInvVal:441.00";
    const qr = qrMatrix(payload);
    const lines = Array.from({ length: 30 }, (_, i) => ({ text: `Line ${i}` }));
    const withQr = textPdf(lines, { title: "Q", qr: { ...qr, caption: ["Invoice QR"] } });
    expect(pdfHasImage(withQr)).toBe(true);
    expect(decodePdfQr(withQr)).toBe(payload);
    const plain = textPdf(lines, { title: "Q" });
    expect(pdfHasImage(plain)).toBe(false);
    expect(plain.toString("latin1")).not.toContain("/XObject");
    // A full last page pushes the code onto a page of its own.
    const full = textPdf(Array.from({ length: 65 }, (_, i) => ({ text: `L${i}` })), { qr });
    expect(full.toString("latin1")).toContain("/Count 2");
    expect(decodePdfQr(full)).toBe(payload);
  });
});
