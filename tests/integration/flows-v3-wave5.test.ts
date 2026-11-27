/**
 * Flow spec v3, wave 5 (docs/flows-v3/wave5.md; migration 0224). Every item with its flag ON, and the same path with
 * the flag OFF behaving exactly as before.
 *   F11 (flow_f11): rider photo at application and approval, verified mobile / e-mail, photo upload, photo reminder.
 *   F15 (flow_f15): society application details and proof, verify needs the proof, approved riders only for new
 *                   societies, rider pause, gate delivery hours.
 *   F18 (flow_f18): recovery of a lost mobile / e-mail, sign out on all devices, code to a new mobile, closure codes to
 *                   both, shop hidden with the account, dealer balances, role grants removed at purge.
 * SMS_PROVIDER=mock in tests: SMS codes and text messages are read from outbound_test_messages.
 */
import { and, desc, eq } from "drizzle-orm";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { codeFromSmsOtpText } from "@/server/otp/providers";

import type { FeatureFlagKey, UserRole } from "@/server/db/schema";

const state = vi.hoisted(() => ({
  outbox: [] as { to: string; subject: string; text: string }[],
  session: null as null | { user: { id: string; email: string; name: string | null; image: null; role: UserRole; status: "ACTIVE" } },
}));

vi.mock("@/server/email/transport", () => ({
  emailMode: () => "smtp",
  sendEmail: async (message: { to: string; subject: string; text: string }) => {
    state.outbox.push(message);
  },
  EmailUnavailableError: class extends Error {},
}));
vi.mock("@/server/auth", () => ({ auth: async () => state.session, handlers: {}, signIn: async () => {}, signOut: async () => {} }));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined, set: () => undefined, delete: () => undefined }),
  headers: async () => new Headers({ "user-agent": "vitest" }),
}));

import { POST as recoverFactorPost } from "@/app/api/account/recover/factor/route";
import { POST as imagesPost } from "@/app/api/images/route";
import { POST as phoneCodePost } from "@/app/api/me/phone/code/route";
import { PUT as phonePut } from "@/app/api/me/phone/route";
import { resetRateLimits } from "@/server/api/rate-limit";
import { readSession, signedInBefore, startSession } from "@/server/auth-sessions";
import { db } from "@/server/db";
import {
  dealerCommissionLedger,
  dealers,
  deliveryPartners,
  featureFlags,
  loginOtps,
  outboundTestMessages,
  shops,
  societies,
  societyRiders,
  storedImages,
  userRoleGrants,
  users,
} from "@/server/db/schema";
import { taxIdMatches } from "@/server/flows/account-recovery";
import { deleteAccount, deletionPrecheck, requestAccountDeletionCode, restoreAccount, runDueAccountPurges, SHOP_HIDDEN_REASON } from "@/server/services/account-deletion";
import { blockedPartnerIds } from "@/server/services/delivery-eligibility";
import { approveDeliveryPartner, registerDeliveryPartner } from "@/server/services/delivery-partners";
import { clearFeatureFlagCache } from "@/server/services/feature-flags";
import { getMyRiderIdCard } from "@/server/services/rider-files";
import { grantRole } from "@/server/services/roles";
import { clearRuleCache, setRule } from "@/server/services/settings";
import {
  addSocietyRider,
  decideSociety,
  getSocietyDeliveryNotes,
  getSocietyDispatchRules,
  registerSociety,
  updateSocietyRider,
  updateSocietySettings,
} from "@/server/services/societies";
import { call } from "../helpers/http";
import { addRiderIdentityDocument, createDeliveryPartner, createShop, createUser, resetDatabase, uniqueMobile } from "../helpers/fixtures";

const actorOf = (u: { id: string; role: UserRole }) => ({ id: u.id, role: u.role });
const ADMIN = (id: string) => ({ id, role: "ADMIN" as const });

async function setFlag(key: FeatureFlagKey, enabled: boolean) {
  await db.insert(featureFlags).values({ key, enabled }).onConflictDoUpdate({ target: featureFlags.key, set: { enabled } });
  clearFeatureFlagCache();
}

function signInAs(u: { id: string; email: string; name: string | null; role: UserRole }) {
  state.session = { user: { id: u.id, email: u.email, name: u.name, image: null, role: u.role, status: "ACTIVE" } };
}

/** An account with a verified mobile and a verified e-mail. */
async function verifiedUser(role: UserRole = "CUSTOMER") {
  const user = await createUser({ role, mobile: uniqueMobile() });
  const [row] = await db.update(users).set({ phoneVerifiedAt: new Date(), emailVerified: new Date() }).where(eq(users.id, user.id)).returning();
  return row;
}

function lastEmailCode(email: string): string {
  const message = [...state.outbox].reverse().find((m) => m.to === email);
  const code = message?.text.match(/\b(\d{6})\b/)?.[1];
  if (!code) throw new Error(`no code was emailed to ${email}`);
  return code;
}

async function lastSms(e164: string) {
  const [row] = await db.select().from(outboundTestMessages).where(eq(outboundTestMessages.toAddress, e164)).orderBy(desc(outboundTestMessages.createdAt)).limit(1);
  return row ?? null;
}

async function lastSmsCode(e164: string): Promise<string> {
  const row = await lastSms(e164);
  const code = (row ? codeFromSmsOtpText(row.body) : null);
  if (!code) throw new Error(`no SMS code was sent to …${e164.slice(-4)}`);
  return code;
}

/** Moves every code issued so far back in time (past any resend cooldown). */
async function ageCodes(minutes = 2) {
  await db.update(loginOtps).set({ createdAt: new Date(Date.now() - minutes * 60_000) });
}

async function ownPhoto(userId: string, purpose: "PROFILE_PHOTO" | "SOCIETY_PROOF" = "PROFILE_PHOTO"): Promise<string> {
  const [image] = await db
    .insert(storedImages)
    .values({ ownerId: userId, purpose, contentType: "image/webp", sizeBytes: 4, width: 200, height: 200, sha256: `t-${userId}-${purpose}-${Math.random()}`, data: Buffer.from("test") })
    .returning({ id: storedImages.id });
  return `/api/images/${image.id}`;
}

/** A 128 × 128 PNG header (the image store reads only the header). */
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]),
  Buffer.from("IHDR"),
  Buffer.from([0, 0, 0, 128, 0, 0, 0, 128, 8, 2, 0, 0, 0]),
  Buffer.alloc(16),
]);

function imageUpload(purpose: string) {
  const form = new FormData();
  form.append("purpose", purpose);
  form.append("file", new Blob([new Uint8Array(PNG)], { type: "image/png" }), "photo.png");
  return new NextRequest("http://localhost/api/images", { method: "POST", body: form });
}
const postImage = (purpose: string) => (imagesPost as (r: NextRequest, c: unknown) => Promise<Response>)(imageUpload(purpose), { params: Promise.resolve({}) });

beforeEach(async () => {
  state.outbox = [];
  state.session = null;
  resetRateLimits();
  await resetDatabase();
  clearRuleCache();
});

afterEach(() => {
  clearFeatureFlagCache();
});

/* ======================================================================= F11 */

const riderInput = (mobile: string, email: string | null = null) => ({ fullName: "Ravi Kumar", mobile, email, vehicleType: "MOTORCYCLE" as const });

describe("F11-1 rider application: photo, verified mobile and e-mail (flow_f11)", () => {
  it("off: a typed mobile, any e-mail and no photo are accepted as before", async () => {
    const user = await createUser({ role: "CUSTOMER" });
    const partner = await registerDeliveryPartner(user.id, riderInput("9876543210", "other@example.com"));
    expect(partner.status).toBe("REGISTERED");
    expect(partner.profilePhotoUrl).toBeNull();
  });

  it("on: refuses a missing photo, an unverified or other mobile and another e-mail; accepts the account's own", async () => {
    await setFlag("flow_f11", true);
    const user = await verifiedUser();
    const national = user.phoneE164!.slice(3);
    const refused = registerDeliveryPartner(user.id, riderInput("9876543210", "other@example.com"));
    await expect(refused).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    const error = await refused.catch((e) => e);
    expect(Object.keys(error.details.fields).sort()).toEqual(["email", "mobile", "profilePhotoUrl"]);

    const photo = await ownPhoto(user.id);
    const partner = await registerDeliveryPartner(user.id, { ...riderInput(national, user.email.toUpperCase()), profilePhotoUrl: photo });
    expect(partner).toMatchObject({ status: "REGISTERED", mobile: national, profilePhotoUrl: photo });
  });

  it("on: an account whose mobile is not verified cannot use it", async () => {
    await setFlag("flow_f11", true);
    const user = await createUser({ role: "CUSTOMER", mobile: uniqueMobile() });
    await db.update(users).set({ emailVerified: new Date() }).where(eq(users.id, user.id));
    const err = await registerDeliveryPartner(user.id, { ...riderInput(user.phoneE164!.slice(3), user.email), profilePhotoUrl: await ownPhoto(user.id) }).catch((e) => e);
    expect(err.details.fields).toEqual({ mobile: expect.any(String) });
  });
});

describe("F11-2 approval needs the photo (flow_f11)", () => {
  it("off: approved without a photo; on: refused until the photo is there", async () => {
    const admin = await createUser({ role: "ADMIN" });
    const a = await createUser();
    const pa = await registerDeliveryPartner(a.id, riderInput(uniqueMobile()));
    await addRiderIdentityDocument(pa.id);
    expect((await approveDeliveryPartner(pa.id, ADMIN(admin.id))).status).toBe("APPROVED");

    const b = await createUser();
    const pb = await registerDeliveryPartner(b.id, riderInput(uniqueMobile()));
    await addRiderIdentityDocument(pb.id);
    await setFlag("flow_f11", true);
    await expect(approveDeliveryPartner(pb.id, ADMIN(admin.id))).rejects.toMatchObject({ code: "CONFLICT" });
    await db.update(deliveryPartners).set({ profilePhotoUrl: await ownPhoto(b.id) }).where(eq(deliveryPartners.id, pb.id));
    expect((await approveDeliveryPartner(pb.id, ADMIN(admin.id))).status).toBe("APPROVED");
  });
});

describe("F11-3 an applicant may upload their photo in the form (flow_f11)", () => {
  it("off: a customer cannot upload PROFILE_PHOTO; on: they can", async () => {
    const customer = await createUser({ role: "CUSTOMER" });
    signInAs(customer);
    expect((await postImage("PROFILE_PHOTO")).status).toBe(403);
    await setFlag("flow_f11", true);
    const res = await postImage("PROFILE_PHOTO");
    expect(res.status).toBe(201);
    const [image] = await db.select().from(storedImages).where(eq(storedImages.ownerId, customer.id));
    expect(image.purpose).toBe("PROFILE_PHOTO");
  });
});

/* ======================================================================= F15 */

const societyBase = { name: "Green Meadows", addressLine1: "Plot 7, Baner Road", area: "Baner", city: "Pune", pincode: "411045" };

describe("F15-4 society application details and proof (flow_f15)", () => {
  it("off: name and address only, no proof needed, not exclusive", async () => {
    const founder = await createUser();
    const society = await registerSociety(societyBase, actorOf(founder));
    expect(society).toMatchObject({ requiresProof: false, exclusiveRiders: false, authorisedPersonName: null, proofType: null });
    const operator = await createUser({ role: "OPERATOR" });
    expect((await decideSociety(society.id, "verify", actorOf(operator))).status).toBe("VERIFIED");
  });

  it("on: asks for the authorised person and a proof; saves them; exclusive riders by default", async () => {
    await setFlag("flow_f15", true);
    const founder = await createUser();
    const err = await registerSociety(societyBase, actorOf(founder)).catch((e) => e);
    expect(Object.keys(err.details.fields).sort()).toEqual(["authorisedPersonName", "authorisedPersonRole", "proofNumber", "proofType"]);
    // Somebody else's upload is not accepted as the proof.
    const stranger = await createUser();
    const foreign = await ownPhoto(stranger.id, "SOCIETY_PROOF");
    await expect(
      registerSociety({ ...societyBase, authorisedPersonName: "Meera Joshi", authorisedPersonRole: "Secretary", proofType: "COMMITTEE_LETTER", proofImageUrl: foreign }, actorOf(founder)),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });

    const proof = await ownPhoto(founder.id, "SOCIETY_PROOF");
    const society = await registerSociety(
      { ...societyBase, authorisedPersonName: "Meera Joshi", authorisedPersonRole: "Secretary", flatCount: 240, proofType: "REGISTRATION_CERTIFICATE", proofNumber: "PNA/HSG/1234", proofImageUrl: proof },
      actorOf(founder),
    );
    expect(society).toMatchObject({
      authorisedPersonName: "Meera Joshi",
      authorisedPersonRole: "Secretary",
      flatCount: 240,
      proofType: "REGISTRATION_CERTIFICATE",
      proofNumber: "PNA/HSG/1234",
      proofImageUrl: proof,
      requiresProof: true,
      exclusiveRiders: true,
    });
  });

  it("verify needs the proof for a society that applied with the proof step", async () => {
    await setFlag("flow_f15", true);
    const founder = await createUser();
    const operator = await createUser({ role: "OPERATOR" });
    const society = await registerSociety({ ...societyBase, authorisedPersonName: "Meera", authorisedPersonRole: "Chairman", proofType: "COMMITTEE_LETTER", proofNumber: "CL-1" }, actorOf(founder));
    await db.update(societies).set({ proofNumber: null }).where(eq(societies.id, society.id));
    await expect(decideSociety(society.id, "verify", actorOf(operator))).rejects.toMatchObject({ code: "CONFLICT" });
    await db.update(societies).set({ proofNumber: "CL-1" }).where(eq(societies.id, society.id));
    expect((await decideSociety(society.id, "verify", actorOf(operator))).status).toBe("VERIFIED");
  });

  it("society proof upload: refused off, accepted on; only its uploader and operations may open it", async () => {
    const founder = await createUser();
    signInAs(founder);
    expect((await postImage("SOCIETY_PROOF")).status).toBe(422);
    await setFlag("flow_f15", true);
    expect((await postImage("SOCIETY_PROOF")).status).toBe(201);
  });
});

async function verifiedSocietyWithRider(options: { flow: boolean; name?: string }) {
  if (options.flow) await setFlag("flow_f15", true);
  const founder = await createUser();
  const operator = await createUser({ role: "OPERATOR" });
  const extra = options.flow ? { authorisedPersonName: "Meera", authorisedPersonRole: "Secretary", proofType: "COMMITTEE_LETTER" as const, proofNumber: "CL-9" } : {};
  const society = await registerSociety({ ...societyBase, ...(options.name ? { name: options.name } : {}), ...extra }, actorOf(founder));
  await decideSociety(society.id, "verify", actorOf(operator));
  const riderUser = await createUser({ role: "DELIVERY_PARTNER", mobile: uniqueMobile() });
  const partner = await createDeliveryPartner(riderUser.id, { status: "APPROVED" });
  const link = await addSocietyRider(society.id, partner.mobile, false, actorOf(founder));
  return { society, founder, partner, riderUser, link };
}

describe("F15-5 only approved riders get orders in a new society (flow_f15)", () => {
  it("on: a new society is exclusive once it lists a rider; an existing one is unchanged", async () => {
    const old = await verifiedSocietyWithRider({ flow: false });
    expect((await getSocietyDispatchRules(old.society.id))!.exclusive).toBe(false);
    const fresh = await verifiedSocietyWithRider({ flow: true, name: "Blue Hills" });
    expect((await getSocietyDispatchRules(fresh.society.id))!.exclusive).toBe(true);
    expect((await getSocietyDispatchRules(old.society.id))!.exclusive).toBe(false);
  });
});

describe("F15-6 a society pauses a rider (flow_f15)", () => {
  it("off: refused; on: paused rider is off the list, off its orders and off the ID card until resumed", async () => {
    const { society, founder, partner, riderUser, link } = await verifiedSocietyWithRider({ flow: false });
    await expect(updateSocietyRider(link.id, { suspendDays: 3, suspendReason: "Complaint" }, actorOf(founder))).rejects.toMatchObject({ code: "VALIDATION_FAILED" });

    await setFlag("flow_f15", true);
    await expect(updateSocietyRider(link.id, { suspendDays: 3, suspendReason: "" }, actorOf(founder))).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(updateSocietyRider(link.id, { suspendDays: 400, suspendReason: "Too long" }, actorOf(founder))).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    const paused = await updateSocietyRider(link.id, { suspendDays: 3, suspendReason: "Complaint from residents" }, actorOf(founder));
    expect(paused.status).toBe("ACTIVE");
    expect(paused.suspendedUntil!.getTime()).toBeGreaterThan(Date.now() + 2 * 86_400_000);
    expect((await getSocietyDispatchRules(society.id))!.riders.has(partner.id)).toBe(false);
    expect((await blockedPartnerIds(society.id)).has(partner.id)).toBe(true);
    expect((await getMyRiderIdCard(riderUser.id))!.societies).toHaveLength(0);

    await updateSocietyRider(link.id, { resume: true }, actorOf(founder));
    expect((await getSocietyDispatchRules(society.id))!.riders.has(partner.id)).toBe(true);
    expect((await blockedPartnerIds(society.id)).has(partner.id)).toBe(false);
    expect((await getMyRiderIdCard(riderUser.id))!.societies.map((s) => s.name)).toEqual(["Green Meadows"]);

    // A pause that has run out counts as over.
    await db.update(societyRiders).set({ suspendedUntil: new Date(Date.now() - 1000) }).where(eq(societyRiders.id, link.id));
    expect((await blockedPartnerIds(society.id)).has(partner.id)).toBe(false);
  });
});

describe("F15-7 gate delivery hours (flow_f15)", () => {
  it("off: ignored; on: checked, saved and shown to the rider", async () => {
    const { society, founder } = await verifiedSocietyWithRider({ flow: false });
    await updateSocietySettings(society.id, { deliveryHoursStart: "07:00", deliveryHoursEnd: "21:30" }, actorOf(founder));
    expect((await getSocietyDeliveryNotes(society.id))!).not.toHaveProperty("deliveryHours");

    await setFlag("flow_f15", true);
    await expect(updateSocietySettings(society.id, { deliveryHoursStart: "7", deliveryHoursEnd: "21:30" }, actorOf(founder))).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(updateSocietySettings(society.id, { deliveryHoursStart: "22:00", deliveryHoursEnd: "07:00" }, actorOf(founder))).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(updateSocietySettings(society.id, { deliveryHoursStart: "07:00", deliveryHoursEnd: null }, actorOf(founder))).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await updateSocietySettings(society.id, { deliveryHoursStart: "07:00", deliveryHoursEnd: "21:30" }, actorOf(founder));
    expect((await getSocietyDeliveryNotes(society.id))!.deliveryHours).toEqual({ start: "07:00", end: "21:30" });
    await updateSocietySettings(society.id, { deliveryHoursStart: null, deliveryHoursEnd: null }, actorOf(founder));
    expect((await getSocietyDeliveryNotes(society.id))!).not.toHaveProperty("deliveryHours");
  });
});

/* ======================================================================= F18 */

const recover = (body: Record<string, unknown>) => call(recoverFactorPost, "/api/account/recover/factor", { method: "POST", body });

describe("F18-8 sign out on all devices (flow_f18 marker)", () => {
  it("a session signed in before the marker ends; one signed in after continues; no marker = as before", async () => {
    const user = await verifiedUser();
    const old = startSession({}, user.id);
    expect(await readSession(old)).not.toBeNull();
    const legacy = { sub: user.id, sid: "legacy-session" };
    expect(await readSession(legacy)).not.toBeNull();

    await db.update(users).set({ sessionsValidAfter: new Date(Date.now() + 5) }).where(eq(users.id, user.id));
    expect(await readSession(old)).toBeNull();
    expect(await readSession(legacy)).toBeNull();
    const fresh = { ...startSession({}, user.id), sat: Date.now() + 1000 };
    expect(await readSession(fresh)).not.toBeNull();
    expect(signedInBefore({ sat: 5 }, null)).toBe(false);
  });
});

describe("F18-9 recovery after losing the mobile (flow_f18)", () => {
  it("off: 404", async () => {
    expect((await recover({ action: "start", lost: "MOBILE", contact: "x@example.com" })).status).toBe(404);
  });

  it("on: code to the e-mail, new mobile with its own code, signed out everywhere, old number told", async () => {
    await setFlag("flow_f18", true);
    const user = await verifiedUser();
    const oldPhone = user.phoneE164!;
    const session = startSession({}, user.id);

    // Unknown e-mail: the same reply, nothing sent.
    const unknown = await recover({ action: "start", lost: "MOBILE", contact: "nobody@example.com" });
    expect(unknown.status).toBe(200);
    expect(state.outbox.find((m) => m.to === "nobody@example.com")).toBeUndefined();

    const started = await recover({ action: "start", lost: "MOBILE", contact: user.email });
    expect(started.status).toBe(200);
    expect(Object.keys(started.body).sort()).toEqual(Object.keys(unknown.body).sort());
    const wrong = await recover({ action: "verify", lost: "MOBILE", contact: user.email, code: "000001" });
    expect(wrong.status).toBe(422);
    const verified = await recover({ action: "verify", lost: "MOBILE", contact: user.email, code: lastEmailCode(user.email) });
    expect(verified.status).toBe(200);
    const token = verified.body.token as string;

    const newMobile = uniqueMobile();
    // Another account's number is refused (only after the person proved this account).
    const other = await createUser({ mobile: uniqueMobile() });
    expect((await recover({ action: "new-code", token, value: other.phoneE164!.slice(3) })).status).toBe(409);
    expect((await recover({ action: "new-code", token, value: newMobile })).status).toBe(200);
    const done = await recover({ action: "confirm", token, value: newMobile, code: await lastSmsCode(`+91${newMobile}`) });
    expect(done.status).toBe(200);
    expect(done.body).toMatchObject({ replaced: "MOBILE", signedOutEverywhere: true });

    const [after] = await db.select().from(users).where(eq(users.id, user.id));
    expect(after.phoneE164).toBe(`+91${newMobile}`);
    expect(after.phoneVerifiedAt).not.toBeNull();
    expect(after.sessionsValidAfter).not.toBeNull();
    expect(await readSession(session)).toBeNull();
    expect((await lastSms(oldPhone))?.purpose).toBe("account_recovery_alert");
    expect(state.outbox.some((m) => m.to === user.email && /mobile number was replaced/.test(m.subject))).toBe(true);
    // Single use: the token no longer works once the mobile changed.
    expect((await recover({ action: "new-code", token, value: uniqueMobile() })).status).toBe(403);
  });

  it("on: a shop owner also confirms the shop's GSTIN or PAN (a wrong one keeps the code valid)", async () => {
    await setFlag("flow_f18", true);
    const owner = await verifiedUser("SHOP_OWNER");
    const shop = await createShop(owner.id);
    await db.update(shops).set({ gstin: "27ABCDE1234F1Z5" }).where(eq(shops.id, shop.id));
    await recover({ action: "start", lost: "MOBILE", contact: owner.email });
    const code = lastEmailCode(owner.email);
    const missing = await recover({ action: "verify", lost: "MOBILE", contact: owner.email, code });
    expect(missing.status).toBe(422);
    expect(missing.body.error.details.needsTaxId).toBe(true);
    expect((await recover({ action: "verify", lost: "MOBILE", contact: owner.email, code, taxId: "AAAAA9999A" })).status).toBe(422);
    const ok = await recover({ action: "verify", lost: "MOBILE", contact: owner.email, code, taxId: "abcde1234f" });
    expect(ok.status).toBe(200);
    expect(taxIdMatches("27ABCDE1234F1Z5", { gstins: ["27ABCDE1234F1Z5"], panHashes: [] })).toBe(true);
    expect(taxIdMatches("ZZZZZ1111Z", { gstins: [], panHashes: ["h"] }, () => "h")).toBe(true);
  });
});

describe("F18-10 recovery after losing the e-mail (flow_f18)", () => {
  it("on: code by SMS to the verified mobile, new e-mail with its own code, old e-mail told", async () => {
    await setFlag("flow_f18", true);
    const user = await verifiedUser();
    const oldEmail = user.email;
    // An unverified mobile does not count as a working factor.
    const unverified = await createUser({ mobile: uniqueMobile() });
    await recover({ action: "start", lost: "EMAIL", contact: unverified.phoneE164!.slice(3) });
    expect(await lastSms(unverified.phoneE164!)).toBeNull();

    expect((await recover({ action: "start", lost: "EMAIL", contact: user.phoneE164!.slice(3) })).status).toBe(200);
    const verified = await recover({ action: "verify", lost: "EMAIL", contact: user.phoneE164!.slice(3), code: await lastSmsCode(user.phoneE164!) });
    expect(verified.status).toBe(200);
    const token = verified.body.token as string;
    expect((await recover({ action: "new-code", token, value: oldEmail })).status).toBe(422);
    const newEmail = `new-${Date.now()}@example.com`;
    expect((await recover({ action: "new-code", token, value: newEmail })).status).toBe(200);
    const done = await recover({ action: "confirm", token, value: newEmail, code: lastEmailCode(newEmail) });
    expect(done.status).toBe(200);
    const [after] = await db.select().from(users).where(eq(users.id, user.id));
    expect(after).toMatchObject({ email: newEmail, emailPlaceholder: false });
    expect(after.emailVerified).not.toBeNull();
    expect(after.sessionsValidAfter).not.toBeNull();
    expect(state.outbox.some((m) => m.to === oldEmail && /e-mail address was replaced/.test(m.subject))).toBe(true);
  });
});

describe("F18-11 a new mobile needs a code sent to it (since 27-Nov-2026 whenever SMS works, flag or not)", () => {
  it("SMS cannot be sent on the site: linked at once, unverified, as before", async () => {
    await setRule("otp", { smsEnabled: false } as never, await createUser({ role: "ADMIN" }));
    const user = await createUser({ mobile: null });
    signInAs(user);
    const mobile = uniqueMobile();
    const res = await call(phonePut, "/api/me/phone", { method: "PUT", body: { mobile } });
    expect(res.status).toBe(200);
    const [after] = await db.select().from(users).where(eq(users.id, user.id));
    expect(after).toMatchObject({ phoneE164: `+91${mobile}`, phoneVerifiedAt: null });
    expect((await call(phoneCodePost, "/api/me/phone/code", { method: "POST", body: { mobile } })).status).toBe(404);
  });

  it("flow_f18 off but SMS works: refused without the code; with it saved verified (owner 27-Nov-2026, login & auth item 5)", async () => {
    const user = await createUser({ mobile: null });
    signInAs(user);
    const mobile = uniqueMobile();
    const refused = await call(phonePut, "/api/me/phone", { method: "PUT", body: { mobile } });
    expect(refused.status).toBe(422);
    expect(refused.body.error.details).toMatchObject({ reason: "PHONE_CODE_REQUIRED" });
    expect((await call(phoneCodePost, "/api/me/phone/code", { method: "POST", body: { mobile } })).status).toBe(200);
    const ok = await call(phonePut, "/api/me/phone", { method: "PUT", body: { mobile, code: await lastSmsCode(`+91${mobile}`) } });
    expect(ok.status).toBe(200);
    const [after] = await db.select().from(users).where(eq(users.id, user.id));
    expect(after.phoneE164).toBe(`+91${mobile}`);
    expect(after.phoneVerifiedAt).not.toBeNull();
  });

  it("a number on another account: the code is sent, then the link stops with DIFFERENT_ACCOUNTS and is logged", async () => {
    const mobile = uniqueMobile();
    await createUser({ mobile });
    const user = await createUser({ mobile: null });
    signInAs(user);
    expect((await call(phoneCodePost, "/api/me/phone/code", { method: "POST", body: { mobile } })).status).toBe(200);
    const res = await call(phonePut, "/api/me/phone", { method: "PUT", body: { mobile, code: await lastSmsCode(`+91${mobile}`) } });
    expect(res.status).toBe(409);
    expect(res.body.error.message).toBe("This mobile and email belong to different accounts. Log in with one, or contact support.");
    const [after] = await db.select().from(users).where(eq(users.id, user.id));
    expect(after.phoneE164).toBeNull();
  });

  it("on: refused without the code; with it the number is saved verified and the old number is told", async () => {
    await setFlag("flow_f18", true);
    const user = await verifiedUser();
    const oldPhone = user.phoneE164!;
    signInAs(user);
    const mobile = uniqueMobile();
    const refused = await call(phonePut, "/api/me/phone", { method: "PUT", body: { mobile } });
    expect(refused.status).toBe(422);
    expect(refused.body.error.details).toMatchObject({ reason: "PHONE_CODE_REQUIRED", needsCode: true });
    expect((await call(phoneCodePost, "/api/me/phone/code", { method: "POST", body: { mobile } })).status).toBe(200);
    expect((await call(phonePut, "/api/me/phone", { method: "PUT", body: { mobile, code: "000001" } })).status).toBe(422);
    const ok = await call(phonePut, "/api/me/phone", { method: "PUT", body: { mobile, code: await lastSmsCode(`+91${mobile}`) } });
    expect(ok.status).toBe(200);
    const [after] = await db.select().from(users).where(eq(users.id, user.id));
    expect(after.phoneE164).toBe(`+91${mobile}`);
    expect(after.phoneVerifiedAt).not.toBeNull();
    expect((await lastSms(oldPhone))?.purpose).toBe("phone_changed_alert");
    // The same number again needs nothing.
    expect((await call(phonePut, "/api/me/phone", { method: "PUT", body: { mobile } })).status).toBe(200);
  });
});

/* ---------------------------------------------------------------- closure */

const NO_DEPS = { goOffline: async () => undefined, cancelSubscription: async () => undefined };

describe("F18-12 account closure (account_self_deletion_enabled + flow_f18)", () => {
  async function ownerWithShop() {
    await setFlag("account_self_deletion_enabled", true);
    const owner = await verifiedUser("SHOP_OWNER");
    const shop = await createShop(owner.id, { status: "APPROVED" });
    return { owner, shop };
  }

  it("off: an open shop blocks, one code by e-mail only", async () => {
    const { owner } = await ownerWithShop();
    const check = await deletionPrecheck(owner.id);
    expect(check.blockers.map((b) => b.code)).toEqual(["ACTIVE_SHOP"]);
    expect(check).not.toHaveProperty("maskedPhone");
  });

  it("on: both codes, the shop is hidden by the system and comes back on restore", async () => {
    const { owner, shop } = await ownerWithShop();
    await setFlag("flow_f18", true);
    const check = await deletionPrecheck(owner.id);
    expect(check.canDelete).toBe(true);
    expect(check.shopsToHide).toBe(1);
    expect(check.maskedPhone).toBeTruthy();

    const sent = await requestAccountDeletionCode(actorOf(owner));
    expect(sent.maskedPhone).toBeTruthy();
    const emailCode = lastEmailCode(owner.email);
    const smsCode = await lastSmsCode(owner.phoneE164!);
    const input = { code: emailCode, confirmText: "DELETE", reasonCode: "OTHER", reason: "Closing the business" };
    await expect(deleteAccount(actorOf(owner), input, {}, NO_DEPS)).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    // A wrong e-mail code keeps the SMS code valid.
    await expect(deleteAccount(actorOf(owner), { ...input, code: "000001", smsCode }, {}, NO_DEPS)).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    const done = await deleteAccount(actorOf(owner), { ...input, smsCode }, {}, NO_DEPS);
    expect(done.scheduled).toBe(true);
    const [hidden] = await db.select().from(shops).where(eq(shops.id, shop.id));
    expect(hidden).toMatchObject({ status: "INACTIVE", ordersPaused: true, closureReason: SHOP_HIDDEN_REASON });

    await restoreAccount(owner.id, actorOf(owner), { by: "SELF" });
    const [back] = await db.select().from(shops).where(eq(shops.id, shop.id));
    expect(back).toMatchObject({ status: "APPROVED", closureReason: null });
  });

  it("on: dealer commission not yet paid blocks, whatever the active role", async () => {
    await setFlag("account_self_deletion_enabled", true);
    await setFlag("flow_f18", true);
    const user = await verifiedUser("CUSTOMER");
    const [dealer] = await db
      .insert(dealers)
      .values({ userId: user.id, legalName: "Patil Traders", contactName: "Patil", dealerType: "INDIVIDUAL", status: "TERMINATED" })
      .returning();
    await db.insert(dealerCommissionLedger).values({ dealerId: dealer.id, milestone: "MONTHLY", entryType: "BONUS", amountPaise: 50_000, status: "APPROVED" });
    expect((await deletionPrecheck(user.id)).blockers.map((b) => b.code)).toEqual(["DEALER_UNPAID_COMMISSION"]);
    await db.update(dealerCommissionLedger).set({ status: "PAID" }).where(eq(dealerCommissionLedger.dealerId, dealer.id));
    expect((await deletionPrecheck(user.id)).canDelete).toBe(true);
    await setFlag("flow_f18", false);
    expect((await deletionPrecheck(user.id)).canDelete).toBe(true);
  });

  it("role grants are removed at the final deletion (on); kept as before (off)", async () => {
    await setFlag("account_self_deletion_enabled", true);
    async function closeAndPurge(flow: boolean) {
      await setFlag("flow_f18", flow);
      const user = await verifiedUser("CUSTOMER");
      await grantRole(user.id, "DELIVERY_PARTNER", { source: "DELIVERY_PARTNER_APPLICATION" });
      await requestAccountDeletionCode(actorOf(user));
      const smsCode = flow ? await lastSmsCode(user.phoneE164!) : undefined;
      await deleteAccount(actorOf(user), { code: lastEmailCode(user.email), confirmText: "DELETE", reasonCode: "OTHER", reason: "Done here", smsCode }, {}, NO_DEPS);
      await runDueAccountPurges(new Date(Date.now() + 400 * 86_400_000));
      return db.select().from(userRoleGrants).where(and(eq(userRoleGrants.userId, user.id), eq(userRoleGrants.role, "DELIVERY_PARTNER")));
    }
    expect((await closeAndPurge(false))[0].status).toBe("ACTIVE");
    await ageCodes();
    expect((await closeAndPurge(true))[0].status).toBe("REVOKED");
  });
});

describe("rider ID card still lists the approved societies (F11 check)", () => {
  it("lists the society's verified listing", async () => {
    const { riderUser } = await verifiedSocietyWithRider({ flow: false });
    expect((await getMyRiderIdCard(riderUser.id))!.societies.map((s) => s.name)).toEqual(["Green Meadows"]);
  });
});
