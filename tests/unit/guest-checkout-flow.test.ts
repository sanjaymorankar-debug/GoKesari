/**
 * docs/guest-checkout-2026-11: the guest verification flow with the OTP service, database and
 * address service stubbed — flag off, codes sent, mobile code required where SMS is set up, the
 * account marked guest-created, the proven mobile, the address saved or reused.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  on: true,
  sms: false,
  existingAddresses: [] as { id: string; line1: string; pincode: string }[],
  updates: [] as Record<string, unknown>[],
  calls: [] as string[],
  user: { id: "u1", name: null as string | null, role: "CUSTOMER", phoneE164: "+919876543210", phoneVerifiedAt: null as Date | null },
  isNewUser: true,
}));

vi.mock("@/server/guest-checkout/tracking", () => ({ isGuestCheckoutOn: async () => m.on }));
vi.mock("@/server/services/feature-flags", () => ({
  featureNotAvailable: () => Object.assign(new Error("Not found"), { code: "NOT_FOUND" }),
}));
vi.mock("@/server/services/audit", () => ({ AUDIT_ACTIONS: { GUEST_CHECKOUT_VERIFIED: "guest_checkout.verified" }, recordAudit: async () => {} }));
vi.mock("@/server/services/addresses", () => ({
  createAddress: async (_userId: string, input: { isDefault: boolean }) => {
    m.calls.push(`createAddress:default=${input.isDefault}`);
    return { id: "addr-new" };
  },
}));
vi.mock("@/server/otp/service", () => ({
  guestMobileCodesAvailable: async () => m.sms,
  requestLoginOtp: async (input: { email: string; mobile: string }) => {
    m.calls.push(`requestLoginOtp:${input.email}:${input.mobile}`);
    return { status: "SENT", maskedEmail: "a***@example.com", resendAfterSeconds: 30, expiryMinutes: 10 };
  },
  requestGuestMobileOtp: async (input: { mobile: string }) => {
    m.calls.push(`requestGuestMobileOtp:${input.mobile}`);
    return { resendAfterSeconds: 30, expiryMinutes: 10 };
  },
  verifyGuestMobileOtp: async (input: { code: string }) => {
    m.calls.push(`verifyGuestMobileOtp:${input.code}`);
    if (input.code !== "1111") throw new Error("That code is wrong or has expired.");
    return "+919876543210";
  },
  verifyLoginOtp: async (input: { code: string; acceptedTerms: boolean }) => {
    m.calls.push(`verifyLoginOtp:${input.code}:${input.acceptedTerms}`);
    if (input.code !== "2222") throw new Error("That code is wrong or has expired.");
    return { user: m.user, isNewUser: m.isNewUser };
  },
}));
vi.mock("@/server/db", () => ({
  db: {
    update: () => ({ set: (patch: Record<string, unknown>) => ({ where: async () => void m.updates.push(patch) }) }),
    select: () => ({ from: () => ({ where: async () => m.existingAddresses }) }),
  },
}));

import { completeGuestCheckout, parseGuestContact, startGuestCheckout } from "@/server/guest-checkout/service";

const base = {
  name: "Asha Kulkarni",
  mobile: "98765 43210",
  email: "Asha@Example.com",
  address: { line1: "12 MG Road", city: "Pune", pincode: "411001" },
};

beforeEach(() => {
  m.on = true;
  m.sms = false;
  m.existingAddresses = [];
  m.updates = [];
  m.calls = [];
  m.user = { id: "u1", name: null, role: "CUSTOMER", phoneE164: "+919876543210", phoneVerifiedAt: null };
  m.isNewUser = true;
});

describe("guest checkout — flag off", () => {
  it("refuses both steps while guest checkout is off (the site as before)", async () => {
    m.on = false;
    await expect(startGuestCheckout(base, null)).rejects.toThrow("Not found");
    await expect(completeGuestCheckout({ ...base, emailCode: "2222", acceptedTerms: true }, null)).rejects.toThrow("Not found");
    expect(m.calls).toEqual([]);
  });
});

describe("startGuestCheckout", () => {
  it("sends the e-mail code with the mobile, normalised; no SMS where SMS is not set up", async () => {
    const r = await startGuestCheckout(base, "1.2.3.4");
    expect(r).toMatchObject({ mobileCodeSent: false, maskedEmail: "a***@example.com" });
    expect(m.calls).toEqual(["requestLoginOtp:asha@example.com:+919876543210"]);
  });

  it("also sends an SMS code where SMS is set up (mock on the test site)", async () => {
    m.sms = true;
    const r = await startGuestCheckout(base, null);
    expect(r.mobileCodeSent).toBe(true);
    expect(m.calls).toContain("requestGuestMobileOtp:+919876543210");
  });

  it("refuses bad contact details before sending anything", async () => {
    await expect(startGuestCheckout({ ...base, mobile: "12345" }, null)).rejects.toThrow();
    await expect(startGuestCheckout({ ...base, email: "nope" }, null)).rejects.toThrow();
    await expect(startGuestCheckout({ ...base, address: { ...base.address, pincode: "011001" } }, null)).rejects.toThrow();
    expect(m.calls).toEqual([]);
  });
});

describe("completeGuestCheckout", () => {
  it("creates the account through e-mail sign-in, marks it guest-created, saves name and address", async () => {
    const r = await completeGuestCheckout({ ...base, emailCode: "2222", acceptedTerms: true }, null);
    expect(r).toEqual({ userId: "u1", isNewUser: true, addressId: "addr-new", phoneVerified: false });
    expect(m.calls).toContain("verifyLoginOtp:2222:true");
    expect(m.calls).toContain("createAddress:default=true");
    expect(m.updates[0]).toMatchObject({ guestCreated: true, name: "Asha Kulkarni" });
    expect(m.updates[0]).not.toHaveProperty("phoneVerifiedAt");
  });

  it("an existing account keeps its name and is not marked guest-created; an identical address is reused", async () => {
    m.isNewUser = false;
    m.user = { ...m.user, name: "Asha K" };
    m.existingAddresses = [{ id: "addr-old", line1: "12 mg road ", pincode: "411001" }];
    const r = await completeGuestCheckout({ ...base, emailCode: "2222", acceptedTerms: false }, null);
    expect(r.addressId).toBe("addr-old");
    expect(m.updates).toEqual([]);
    expect(m.calls.some((c) => c.startsWith("createAddress"))).toBe(false);
  });

  it("with SMS set up, needs the mobile code, checks it before the e-mail code and records the proven number", async () => {
    m.sms = true;
    await expect(completeGuestCheckout({ ...base, emailCode: "2222", acceptedTerms: true }, null)).rejects.toThrow("Enter the code we sent to your mobile.");
    await expect(completeGuestCheckout({ ...base, emailCode: "2222", mobileCode: "0000", acceptedTerms: true }, null)).rejects.toThrow();
    expect(m.calls.some((c) => c.startsWith("verifyLoginOtp"))).toBe(false);
    const r = await completeGuestCheckout({ ...base, emailCode: "2222", mobileCode: "1111", acceptedTerms: true }, null);
    expect(r.phoneVerified).toBe(true);
    expect(m.updates.at(-1)).toHaveProperty("phoneVerifiedAt");
  });

  it("a wrong e-mail code creates nothing", async () => {
    await expect(completeGuestCheckout({ ...base, emailCode: "9999", acceptedTerms: true }, null)).rejects.toThrow();
    expect(m.updates).toEqual([]);
    expect(m.calls.some((c) => c.startsWith("createAddress"))).toBe(false);
  });
});

describe("parseGuestContact", () => {
  it("normalises the e-mail and the mobile", () => {
    expect(parseGuestContact({ name: " Asha ", mobile: "+91 98765-43210", email: " A@B.COM " })).toEqual({
      name: "Asha",
      email: "a@b.com",
      e164: "+919876543210",
    });
  });
});
