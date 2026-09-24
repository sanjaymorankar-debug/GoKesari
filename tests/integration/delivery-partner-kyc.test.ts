/**
 * SEC-02 (docs/gokesari-audit/GOKESARI_AUDIT_FINDINGS.md): delivery-partner
 * KYC and bank details are encrypted at rest, and no route or service
 * returns them — plaintext or ciphertext — to a caller. Route-level tests
 * cover the wire responses, which is where the exposure actually was.
 */
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { UserRole } from "@/server/db/schema";

const state = vi.hoisted(() => ({
  keyConfigured: true,
  session: null as null | {
    user: {
      id: string;
      email: string;
      name: string | null;
      image: string | null;
      role: UserRole;
      status: "ACTIVE" | "SUSPENDED" | "DELETED";
    };
  },
}));

vi.mock("@/server/auth", () => ({
  auth: async () => state.session,
  handlers: {},
  signIn: async () => {},
  signOut: async () => {},
}));

// Lets a test simulate a host where PAN_ENCRYPTION_KEY was never set.
vi.mock("@/lib/env", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/env")>();
  return {
    ...actual,
    isPanEncryptionConfigured: () => state.keyConfigured && actual.isPanEncryptionConfigured(),
  };
});

import { GET as detailRoute, PATCH as transitionRoute } from "@/app/api/delivery-partner/[id]/route";
import { GET as meRoute } from "@/app/api/delivery-partner/me/route";
import { GET as listRoute, POST as registerRoute } from "@/app/api/delivery-partner/route";
import { PATCH as statusRoute } from "@/app/api/delivery-partner/status/route";
import { decryptSecret, encryptSecret } from "@/lib/pan-crypto";
import { resetRateLimits } from "@/server/api/rate-limit";
import { db } from "@/server/db";
import { deliveryPartners, users } from "@/server/db/schema";
import {
  KYC_FIELDS,
  backfillDeliveryPartnerKyc,
  type KycField,
} from "@/server/services/delivery-partner-kyc";
import {
  approveDeliveryPartner,
  deactivateDeliveryPartner,
  getDeliveryPartnerById,
  getMyDeliveryPartnerProfile,
  goOffline,
  goOnline,
  listDeliveryPartners,
  reactivateDeliveryPartner,
  registerDeliveryPartner,
  rejectDeliveryPartner,
  requireOwnDeliveryPartnerProfile,
  startDeliveryPartnerReview,
  suspendDeliveryPartner,
} from "@/server/services/delivery-partners";
import { call } from "../helpers/http";
import { createUser, resetDatabase } from "../helpers/fixtures";

const ADMIN = (id: string) => ({ id, role: "ADMIN" as const });

/** Deliberately distinct from the partner's own full name, which the API legitimately returns. */
const KYC: Record<KycField, string> = {
  panNumber: "ABCDE1234F",
  governmentIdNumber: "123412341234",
  bankAccountHolderName: "R K Savings Account",
  bankAccountNumber: "000123456789",
  bankIfsc: "HDFC0001234",
  drivingLicenceNumber: "MH1220110012345",
};

const baseInput = {
  fullName: "Ravi Kumar",
  mobile: "9876543210",
  vehicleType: "MOTORCYCLE" as const,
};

const ENCRYPTED_COLUMN = (field: KycField) => `${field}Encrypted` as const;
const SENSITIVE_NAMES: string[] = [...KYC_FIELDS, ...KYC_FIELDS.map(ENCRYPTED_COLUMN)];

function signInAs(user: { id: string; email: string; name: string | null }, role: UserRole) {
  state.session = {
    user: { id: user.id, email: user.email, name: user.name, image: null, role, status: "ACTIVE" },
  };
}

/** No key of the sensitive kind, and none of the values, anywhere in what a caller would receive. */
function expectNoKyc(payload: unknown) {
  const text = JSON.stringify(payload);
  for (const name of SENSITIVE_NAMES) expect(text).not.toContain(`"${name}"`);
  for (const value of Object.values(KYC)) expect(text).not.toContain(value);
}

async function rawRow(id: string) {
  const [row] = await db.select().from(deliveryPartners).where(eq(deliveryPartners.id, id));
  return row;
}

/** A row as it looked before SEC-02: plaintext only, no ciphertext. */
async function seedLegacyPartner(userId: string, overrides: Partial<typeof deliveryPartners.$inferInsert> = {}) {
  const [row] = await db
    .insert(deliveryPartners)
    .values({
      userId,
      fullName: "Legacy Rider",
      mobile: "9123456780",
      vehicleType: "MOTORCYCLE",
      status: "APPROVED",
      ...KYC,
      ...overrides,
    })
    .returning();
  return row;
}

beforeEach(async () => {
  state.session = null;
  state.keyConfigured = true;
  resetRateLimits();
  await resetDatabase();
});

describe("registration encrypts KYC at rest", () => {
  it("stores ciphertext only: plaintext columns stay empty and every field round-trips", async () => {
    const user = await createUser({ role: "CUSTOMER" });
    const partner = await registerDeliveryPartner(user.id, {
      ...baseInput,
      ...KYC,
      governmentIdType: "AADHAAR",
    });

    const row = await rawRow(partner.id);
    for (const field of KYC_FIELDS) {
      expect(row[field], `${field} must not be stored in plaintext`).toBeNull();
      const encrypted = row[ENCRYPTED_COLUMN(field)];
      expect(encrypted).toBeTruthy();
      expect(encrypted).not.toContain(KYC[field]);
      expect(decryptSecret(encrypted!)).toBe(KYC[field]);
    }
    // The ID *type* is a label, not a secret — it stays readable.
    expect(row.governmentIdType).toBe("AADHAAR");
  });

  it("trims what it encrypts, as registration always trimmed what it stored", async () => {
    const user = await createUser({ role: "CUSTOMER" });
    const partner = await registerDeliveryPartner(user.id, { ...baseInput, bankIfsc: "  HDFC0001234  " });
    expect(decryptSecret((await rawRow(partner.id)).bankIfscEncrypted!)).toBe("HDFC0001234");
  });

  it("registration without KYC is unchanged: nothing is encrypted and no key is needed", async () => {
    state.keyConfigured = false;
    const user = await createUser({ role: "CUSTOMER" });
    const partner = await registerDeliveryPartner(user.id, { ...baseInput, panNumber: "   ", bankAccountNumber: "" });

    const row = await rawRow(partner.id);
    for (const field of KYC_FIELDS) {
      expect(row[field]).toBeNull();
      expect(row[ENCRYPTED_COLUMN(field)]).toBeNull();
    }
  });

  it("refuses KYC when no encryption key is configured — never stores plaintext, creates nothing", async () => {
    state.keyConfigured = false;
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const user = await createUser({ role: "CUSTOMER" });

    await expect(
      registerDeliveryPartner(user.id, { ...baseInput, bankAccountNumber: KYC.bankAccountNumber }),
    ).rejects.toMatchObject({ message: expect.stringContaining("can't securely store") });
    // The caller gets a safe message; the operator gets told why, and the value is never logged.
    expect(logged).toHaveBeenCalledWith(expect.stringContaining("PAN_ENCRYPTION_KEY"));
    expect(JSON.stringify(logged.mock.calls)).not.toContain(KYC.bankAccountNumber);
    logged.mockRestore();

    expect(await getMyDeliveryPartnerProfile(user.id)).toBeNull();
    const [account] = await db.select({ role: users.role }).from(users).where(eq(users.id, user.id));
    expect(account.role).toBe("CUSTOMER"); // not promoted for an application that was never saved
    expect(await db.select().from(deliveryPartners)).toHaveLength(0);
  });
});

describe("the leak check is not vacuous", () => {
  it("expectNoKyc fails on a raw, unprojected row — legacy plaintext and ciphertext alike", async () => {
    const legacyUser = await createUser({ role: "DELIVERY_PARTNER" });
    const legacy = await rawRow((await seedLegacyPartner(legacyUser.id)).id);
    expect(() => expectNoKyc(legacy)).toThrow();

    const applicant = await createUser({ role: "CUSTOMER" });
    const encrypted = await rawRow((await registerDeliveryPartner(applicant.id, { ...baseInput, ...KYC })).id);
    expect(() => expectNoKyc(encrypted)).toThrow();
  });
});

describe("nothing sensitive leaves the service layer", () => {
  it("every function that returns a partner strips plaintext and ciphertext, even for legacy rows", async () => {
    const legacyUser = await createUser({ role: "DELIVERY_PARTNER" });
    const legacy = await seedLegacyPartner(legacyUser.id); // plaintext only
    const applicant = await createUser({ role: "CUSTOMER" });
    const registered = await registerDeliveryPartner(applicant.id, { ...baseInput, ...KYC }); // ciphertext only
    const admin = ADMIN((await createUser({ role: "ADMIN" })).id);

    const results = [
      registered,
      await getMyDeliveryPartnerProfile(applicant.id),
      await getMyDeliveryPartnerProfile(legacyUser.id),
      await getDeliveryPartnerById(registered.id),
      await getDeliveryPartnerById(legacy.id),
      await requireOwnDeliveryPartnerProfile(applicant.id, registered.id),
      ...(await listDeliveryPartners()),
      await startDeliveryPartnerReview(registered.id, admin),
      await approveDeliveryPartner(registered.id, admin),
      await suspendDeliveryPartner(registered.id, "policy check", admin),
      await reactivateDeliveryPartner(registered.id, admin),
      await goOnline(legacyUser.id, 18.52, 73.85),
      await goOffline(legacyUser.id),
      await rejectDeliveryPartner((await registerDeliveryPartner((await createUser()).id, { ...baseInput, ...KYC })).id, "unclear documents", admin),
      await deactivateDeliveryPartner(legacy.id, "requested by partner", admin),
    ];

    expect(results.length).toBeGreaterThan(10);
    for (const result of results) {
      expectNoKyc(result);
      expect(result).toHaveProperty("fullName"); // the projection strips KYC, not the record
    }
  });
});

describe("no route returns KYC", () => {
  it("registration, own profile, status changes and the admin views are all free of it", async () => {
    const applicant = await createUser({ role: "CUSTOMER" });
    const admin = await createUser({ role: "ADMIN" });

    signInAs(applicant, "CUSTOMER");
    const registered = await call(registerRoute, "/api/delivery-partner", {
      method: "POST",
      body: { ...baseInput, ...KYC, governmentIdType: "AADHAAR" },
    });
    expect(registered.status).toBe(201);
    expect(registered.body.fullName).toBe("Ravi Kumar");
    expectNoKyc(registered.body);
    const partnerId: string = registered.body.id;

    signInAs(applicant, "DELIVERY_PARTNER");
    const me = await call(meRoute, "/api/delivery-partner/me");
    expect(me.status).toBe(200);
    expect(me.body.id).toBe(partnerId);
    expectNoKyc(me.body);

    signInAs(admin, "ADMIN");
    const list = await call(listRoute, "/api/delivery-partner");
    expect(list.status).toBe(200);
    expect(list.body.partners).toHaveLength(1);
    expectNoKyc(list.body);

    const detail = await call(detailRoute, `/api/delivery-partner/${partnerId}`, { params: { id: partnerId } });
    expect(detail.status).toBe(200);
    expectNoKyc(detail.body);

    const approved = await call(transitionRoute, `/api/delivery-partner/${partnerId}`, {
      method: "PATCH",
      params: { id: partnerId },
      body: { action: "approve" },
    });
    expect(approved.status).toBe(200);
    expect(approved.body.status).toBe("APPROVED");
    expectNoKyc(approved.body);

    signInAs(applicant, "DELIVERY_PARTNER");
    const offline = await call(statusRoute, "/api/delivery-partner/status", {
      method: "PATCH",
      body: { action: "offline" },
    });
    expect(offline.status).toBe(200);
    expectNoKyc(offline.body);
  });
});

describe("backfillDeliveryPartnerKyc", () => {
  it("a dry run reports the work and changes nothing", async () => {
    const user = await createUser({ role: "DELIVERY_PARTNER" });
    const legacy = await seedLegacyPartner(user.id);

    const result = await backfillDeliveryPartnerKyc();
    expect(result).toMatchObject({ dryRun: true, rowsWithPlaintext: 1, fieldsEncrypted: 6, plaintextNulled: 0, mismatches: 0 });

    const row = await rawRow(legacy.id);
    for (const field of KYC_FIELDS) {
      expect(row[field]).toBe(KYC[field]);
      expect(row[ENCRYPTED_COLUMN(field)]).toBeNull();
    }
  });

  it("--apply writes ciphertext that decrypts to the original and keeps the plaintext; a re-run is a no-op", async () => {
    const user = await createUser({ role: "DELIVERY_PARTNER" });
    const legacy = await seedLegacyPartner(user.id);

    const first = await backfillDeliveryPartnerKyc({ apply: true });
    expect(first).toMatchObject({ dryRun: false, fieldsEncrypted: 6, plaintextNulled: 0, mismatches: 0 });

    const row = await rawRow(legacy.id);
    for (const field of KYC_FIELDS) {
      expect(row[field]).toBe(KYC[field]); // plaintext retained until the second, verified step
      expect(decryptSecret(row[ENCRYPTED_COLUMN(field)]!)).toBe(KYC[field]);
    }

    const second = await backfillDeliveryPartnerKyc({ apply: true });
    expect(second).toMatchObject({ fieldsEncrypted: 0, fieldsAlreadyEncrypted: 6, mismatches: 0 });
  });

  it("nullPlaintext clears the plaintext once the ciphertext is verified, and leaves nothing to do afterwards", async () => {
    const user = await createUser({ role: "DELIVERY_PARTNER" });
    const legacy = await seedLegacyPartner(user.id);

    const result = await backfillDeliveryPartnerKyc({ nullPlaintext: true });
    expect(result).toMatchObject({ dryRun: false, fieldsEncrypted: 6, plaintextNulled: 6, mismatches: 0 });

    const row = await rawRow(legacy.id);
    for (const field of KYC_FIELDS) {
      expect(row[field]).toBeNull();
      expect(decryptSecret(row[ENCRYPTED_COLUMN(field)]!)).toBe(KYC[field]);
    }

    expect(await backfillDeliveryPartnerKyc({ nullPlaintext: true })).toMatchObject({
      rowsWithPlaintext: 0,
      fieldsEncrypted: 0,
      plaintextNulled: 0,
    });
  });

  it("never clears a plaintext value whose ciphertext does not decrypt to it, and reports it", async () => {
    const user = await createUser({ role: "DELIVERY_PARTNER" });
    const legacy = await seedLegacyPartner(user.id, {
      panNumberEncrypted: encryptSecret("SOMETHING-ELSE"), // e.g. written under a different key or by mistake
    });

    const result = await backfillDeliveryPartnerKyc({ nullPlaintext: true });
    expect(result).toMatchObject({ mismatches: 1, fieldsEncrypted: 5, plaintextNulled: 5 });

    const row = await rawRow(legacy.id);
    expect(row.panNumber).toBe(KYC.panNumber); // still there — a human has to look
    expect(decryptSecret(row.panNumberEncrypted!)).toBe("SOMETHING-ELSE"); // and untouched
    expect(row.bankAccountNumber).toBeNull(); // the other five were fine
  });

  it("ignores rows that hold no plaintext, and rows registered after SEC-02", async () => {
    const legacyUser = await createUser({ role: "DELIVERY_PARTNER" });
    await seedLegacyPartner(legacyUser.id);
    const applicant = await createUser({ role: "CUSTOMER" });
    const modern = await registerDeliveryPartner(applicant.id, { ...baseInput, ...KYC });
    const before = await rawRow(modern.id);

    const result = await backfillDeliveryPartnerKyc({ nullPlaintext: true });
    expect(result.rowsWithPlaintext).toBe(1);

    expect(await rawRow(modern.id)).toEqual(before);
  });

  it("refuses to run without an encryption key", async () => {
    state.keyConfigured = false;
    await expect(backfillDeliveryPartnerKyc({ apply: true })).rejects.toThrow(/PAN_ENCRYPTION_KEY/);
  });
});
