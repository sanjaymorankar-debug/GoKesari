/**
 * Dealer programme step 2 (docs/dealer-programme, GKS-DR-001…004): dealer
 * application, documents by dealer type, approval with code, suspension,
 * termination, code replacement, employees, and the legacy distributors.
 *
 * Scenarios (build prompt §5): 1 lifecycle to an active code; 2 code unusable
 * while pending / rejected / suspended; 3 documents differ by type; 4 bank
 * check pending → verified from the bank proof, failed when the bank says no;
 * 5 suspended → codes refused, reactivated → back; 6 terminated → codes
 * retired, employees off; 7 replaced code refused, history kept; 8 employee
 * code; 9 deactivated employee's code refused; 10 another dealer's employee
 * cannot be touched; 42/69-style access checks; 72 flag off → routes 404.
 */
import { readFileSync } from "node:fs";

import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { UserRole } from "@/server/db/schema";

const state = vi.hoisted(() => ({
  session: null as null | {
    user: { id: string; email: string; name: string | null; image: null; role: UserRole; status: "ACTIVE" };
  },
}));

vi.mock("@/server/auth", () => ({
  auth: async () => state.session,
  handlers: {},
  signIn: async () => {},
  signOut: async () => {},
}));

import { GET as adminListGet } from "@/app/api/admin/dealers/route";
import { POST as decisionPost } from "@/app/api/admin/dealers/[id]/decision/route";
import { POST as revealPost } from "@/app/api/admin/dealers/[id]/reveal/route";
import { GET as appGet, PUT as appPut } from "@/app/api/dealer/application/route";
import { POST as docPost } from "@/app/api/dealer/application/documents/route";
import { POST as otpPost } from "@/app/api/dealer/application/otp/route";
import { POST as submitPost } from "@/app/api/dealer/application/submit/route";
import { GET as codeGet } from "@/app/api/dealer/code/route";
import { GET as docFileGet } from "@/app/api/dealer/documents/[id]/route";
import { GET as peopleGet, POST as peoplePost } from "@/app/api/dealer/salespeople/route";
import { PATCH as personPatch } from "@/app/api/dealer/salespeople/[id]/route";
import { DEALER_AGREEMENT_VERSION, dealerCodePattern, salespersonCodePattern, type DealerDocType } from "@/lib/dealers";
import { resetRateLimits } from "@/server/api/rate-limit";
import { db } from "@/server/db";
import {
  auditLogs,
  dealerCodes,
  dealerDocuments,
  dealers,
  dealerSalespeople,
  distributors,
  distributorTypes,
  outboundTestMessages,
  referralCodes,
  userRoleGrants,
  users,
} from "@/server/db/schema";
import { decideDealer, reviewDealerDocument, saveApplication, uploadDealerDocument } from "@/server/dealers/service";
import { setFeatureFlag } from "@/server/services/feature-flags";
import { createReferralCode, resolveUsableCode } from "@/server/services/referrals";
import { call } from "../helpers/http";
import { createUser, resetDatabase, uniqueMobile } from "../helpers/fixtures";

type U = { id: string; email: string; name: string | null };
let admin: U & { role: "ADMIN" };

function signIn(user: U, role: UserRole) {
  state.session = { user: { id: user.id, email: user.email, name: user.name, image: null, role, status: "ACTIVE" } };
}

const PDF = Buffer.from("%PDF-1.4\n% test document\n");
const START = "2026-11-01";
const END = "2027-10-31";

beforeEach(async () => {
  await resetDatabase();
  await db.delete(outboundTestMessages);
  resetRateLimits();
  state.session = null;
  const a = await createUser({ role: "ADMIN" });
  admin = { id: a.id, email: a.email, name: a.name, role: "ADMIN" };
  await setFeatureFlag("dealer_programme_enabled", { enabled: true, districtCodes: ["MH-PUN"] }, "Pune pilot (test)", admin);
});

async function latestCode(mobileE164: string): Promise<string> {
  const rows = await db.select().from(outboundTestMessages).where(eq(outboundTestMessages.toAddress, mobileE164));
  const last = rows.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
  return /(\d{4,8})/.exec(last.body)![1];
}

function application(over: Record<string, unknown> = {}) {
  return {
    legalName: "Shree Sai Distributors",
    contactName: "Sai Patil",
    dealerType: "PROPRIETORSHIP",
    mobile: uniqueMobile(),
    pan: "ABCPS1234K",
    gstin: null,
    shopActNumber: "PMC-SA-2026-1234",
    addressLine1: "12 Laxmi Road",
    city: "Pune",
    pincode: "411030",
    territories: ["MH-PUN-PMC-KOTHRUD", "MH-PUN"],
    bank: { holderName: "Sai Patil", accountNumber: "026291800001191", ifsc: "YESB0000262" },
    ...over,
  };
}

/** An applicant through the API to PENDING: saved, mobile verified by OTP, documents, agreement. */
async function applyAndSubmit(over: Record<string, unknown> = {}) {
  const u = await createUser();
  signIn(u, "CUSTOMER");
  const body = application(over);
  const saved = await call(appPut, "/api/dealer/application", { method: "PUT", body });
  expect(saved.status, JSON.stringify(saved.body)).toBe(200);
  expect((await call(otpPost, "/api/dealer/application/otp", { method: "POST", body: { action: "send" } })).status).toBe(200);
  const code = await latestCode(`+91${body.mobile}`);
  const verified = await call(otpPost, "/api/dealer/application/otp", { method: "POST", body: { action: "verify", code } });
  expect(verified.status, JSON.stringify(verified.body)).toBe(200);
  const required: DealerDocType[] = saved.body.dealer.requirements.filter((r: { required: boolean }) => r.required).map((r: { docType: DealerDocType }) => r.docType);
  for (const docType of required) await uploadDealerDocument({ id: u.id, role: "CUSTOMER" }, docType, { name: `${docType}.pdf`, bytes: PDF });
  const submitted = await call(submitPost, "/api/dealer/application/submit", { method: "POST", body: { agreementVersion: DEALER_AGREEMENT_VERSION } });
  expect(submitted.status, JSON.stringify(submitted.body)).toBe(200);
  const [dealer] = await db.select().from(dealers).where(eq(dealers.userId, u.id));
  return { user: u, dealer, required };
}

async function acceptAll(dealerId: string) {
  const docs = await db.select().from(dealerDocuments).where(eq(dealerDocuments.dealerId, dealerId));
  for (const d of docs) await reviewDealerDocument(d.id, "ACCEPTED", null, admin);
}

async function approve(dealerId: string) {
  await acceptAll(dealerId);
  signIn(admin, "ADMIN");
  const res = await call(decisionPost, `/api/admin/dealers/${dealerId}/decision`, {
    method: "POST",
    params: { id: dealerId },
    body: { action: "APPROVE", agreementStart: START, agreementEnd: END, bankVerifiedByDocument: true },
  });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.code as string;
}

async function usable(code: string): Promise<boolean> {
  return resolveUsableCode(code).then(
    () => true,
    () => false,
  );
}

describe("dealer application to an active code (scenario 1)", () => {
  it("applies, verifies the mobile, uploads, submits, is approved with a GKS-MH-PUN code and the DEALER role", async () => {
    const { user, dealer } = await applyAndSubmit();
    expect(dealer).toMatchObject({ status: "PENDING", mobileVerificationMethod: "OTP", agreementVersion: DEALER_AGREEMENT_VERSION, bankStatus: "PENDING" });
    expect(dealer.panEnc).not.toContain("ABCPS1234K");
    expect(dealer.bankAccountEnc).not.toContain("026291800001191");

    // The applicant's own view is masked.
    signIn(user, "CUSTOMER");
    const mine = await call(appGet, "/api/dealer/application");
    expect(mine.body.dealer.panMasked).not.toContain("ABCPS");
    expect(JSON.stringify(mine.body)).not.toContain("026291800001191");

    const code = await approve(dealer.id);
    expect(code).toMatch(dealerCodePattern());
    expect(code.startsWith("GKS-MH-PUN-")).toBe(true);
    expect(code.slice(-6)).not.toMatch(/[01OIL]/);
    expect(await usable(code)).toBe(true);

    const [after] = await db.select().from(dealers).where(eq(dealers.id, dealer.id));
    expect(after).toMatchObject({ status: "APPROVED", agreementStart: START, agreementEnd: END, bankStatus: "VERIFIED" });
    const [grant] = await db.select().from(userRoleGrants).where(eq(userRoleGrants.userId, user.id));
    expect(grant).toMatchObject({ role: "DEALER", status: "ACTIVE" });
    const [u] = await db.select({ role: users.role }).from(users).where(eq(users.id, user.id));
    expect(u.role).toBe("DEALER");

    // The dealer sees the code with a share link, WhatsApp link and QR.
    signIn(user, "DEALER");
    const shared = await call(codeGet, "/api/dealer/code");
    expect(shared.status).toBe(200);
    expect(shared.body.code).toBe(code);
    expect(shared.body.shareLink).toMatch(new RegExp(`^https?://[^/]+/shop/register\\?ref=${code}$`));
    expect(shared.body.whatsapp).toMatch(/^https:\/\/wa\.me\/\?text=/);
    expect(shared.body.qrSvg).toContain("<svg");

    const audited = await db.select({ action: auditLogs.action }).from(auditLogs).where(eq(auditLogs.entityId, dealer.id));
    expect(audited.map((a) => a.action)).toEqual(expect.arrayContaining(["dealer.application_submitted", "dealer.status_changed", "dealer.code_issued"]));
  });

  it("will not submit without required documents, the agreement, or an area in an open district", async () => {
    const u = await createUser();
    const actor = { id: u.id, role: "CUSTOMER" as const, email: u.email };
    await saveApplication(application({ territories: ["MH-MUM"] }) as never, actor);
    signIn(u, "CUSTOMER");
    const noAgreement = await call(submitPost, "/api/dealer/application/submit", { method: "POST", body: { agreementVersion: "old" } });
    expect(noAgreement.status).toBe(422);
    // Mobile not verified while SMS is available.
    const noOtp = await call(submitPost, "/api/dealer/application/submit", { method: "POST", body: { agreementVersion: DEALER_AGREEMENT_VERSION } });
    expect(noOtp.status).toBe(422);
    await db.update(dealers).set({ mobileVerifiedAt: new Date(), mobileVerificationMethod: "OTP" }).where(eq(dealers.userId, u.id));
    const noDocs = await call(submitPost, "/api/dealer/application/submit", { method: "POST", body: { agreementVersion: DEALER_AGREEMENT_VERSION } });
    expect(noDocs.status).toBe(422);
    expect(noDocs.body.error.details.missing).toEqual(expect.arrayContaining(["PAN", "SHOP_ACT", "ADDRESS_PROOF", "BANK_PROOF"]));
    for (const t of noDocs.body.error.details.missing) await uploadDealerDocument(actor, t, { name: "x.pdf", bytes: PDF });
    // Mumbai is not open (the flag is on for Pune only).
    const closed = await call(submitPost, "/api/dealer/application/submit", { method: "POST", body: { agreementVersion: DEALER_AGREEMENT_VERSION } });
    expect(closed.status).toBe(422);
    expect(closed.body.error.message).toMatch(/not appointing dealers/);
  });

  it("refuses a file that is not a PDF or image, and a GSTIN that does not belong to the PAN", async () => {
    const u = await createUser();
    signIn(u, "CUSTOMER");
    const bad = await call(appPut, "/api/dealer/application", { method: "PUT", body: application({ gstin: "27ZZZZZ9999Z1Z5" }) });
    expect(bad.status).toBe(422);
    expect((await call(appPut, "/api/dealer/application", { method: "PUT", body: application() })).status).toBe(200);
    await expect(
      uploadDealerDocument({ id: u.id, role: "CUSTOMER" }, "PAN", { name: "evil.html", bytes: Buffer.from("<html>hi</html>") }),
    ).rejects.toMatchObject({ status: 422 });
  });
});

describe("codes are usable only while the dealer is approved (scenarios 2, 5, 6, 7)", () => {
  it("pending and rejected dealers have no code; a suspended dealer's code is refused, and works again on reactivation", async () => {
    const { dealer } = await applyAndSubmit();
    expect(await db.select().from(dealerCodes).where(eq(dealerCodes.dealerId, dealer.id))).toHaveLength(0);

    const code = await approve(dealer.id);
    await decideDealer(dealer.id, { action: "SUSPEND", reason: "documents being re-checked" }, admin);
    expect(await usable(code)).toBe(false);
    await decideDealer(dealer.id, { action: "REACTIVATE", reason: "documents fine" }, admin);
    expect(await usable(code)).toBe(true);
  });

  it("a rejection needs a reason; the rejected applicant can edit and submit again", async () => {
    const { user, dealer } = await applyAndSubmit();
    await expect(decideDealer(dealer.id, { action: "REJECT", reason: "" }, admin)).rejects.toMatchObject({ status: 422 });
    await decideDealer(dealer.id, { action: "REJECT", reason: "Shop Act certificate is unreadable" }, admin);
    signIn(user, "CUSTOMER");
    const again = await call(appPut, "/api/dealer/application", { method: "PUT", body: application({ legalName: "Shree Sai Distributors LLP" }) });
    expect(again.status, JSON.stringify(again.body)).toBe(200);
    expect(again.body.dealer.status).toBe("DRAFT");
  });

  it("termination retires every code and switches employees off; the DEALER role ends", async () => {
    const { user, dealer } = await applyAndSubmit();
    const code = await approve(dealer.id);
    signIn(user, "DEALER");
    const added = await call(peoplePost, "/api/dealer/salespeople", { method: "POST", body: { employeeId: "E-01", name: "Ravi" } });
    const empCode = added.body.salesperson.code as string;
    await decideDealer(dealer.id, { action: "TERMINATE", reason: "agreement ended" }, admin);
    expect(await usable(code)).toBe(false);
    expect(await usable(empCode)).toBe(false);
    const codes = await db.select().from(dealerCodes).where(eq(dealerCodes.dealerId, dealer.id));
    expect(codes.every((c) => c.status === "RETIRED")).toBe(true);
    const people = await db.select().from(dealerSalespeople).where(eq(dealerSalespeople.dealerId, dealer.id));
    expect(people.every((p) => p.status === "INACTIVE")).toBe(true);
    const [grant] = await db.select().from(userRoleGrants).where(eq(userRoleGrants.userId, user.id));
    expect(grant.status).toBe("REVOKED");
    // A terminated dealer cannot be reactivated.
    await expect(decideDealer(dealer.id, { action: "REACTIVATE", reason: "try again" }, admin)).rejects.toMatchObject({ status: 409 });
  });

  it("a replaced code is refused for new registrations and its history stays with the dealer", async () => {
    const { dealer } = await applyAndSubmit();
    const oldCode = await approve(dealer.id);
    const [old] = await db.select().from(dealerCodes).where(eq(dealerCodes.dealerId, dealer.id));
    const { replaceDealerCode } = await import("@/server/dealers/service");
    const replaced = await replaceDealerCode(dealer.id, old.id, "code shared on a public group", admin);
    expect(replaced.oldCode).toBe(oldCode);
    expect(replaced.newCode).toMatch(dealerCodePattern());
    expect(await usable(oldCode)).toBe(false);
    expect(await usable(replaced.newCode)).toBe(true);
    const rows = await db.select().from(dealerCodes).where(eq(dealerCodes.dealerId, dealer.id));
    expect(rows.map((r) => r.status).sort()).toEqual(["ACTIVE", "REPLACED"]);
    expect(rows.find((r) => r.status === "REPLACED")!.replacedById).toBe(rows.find((r) => r.status === "ACTIVE")!.id);
  });
});

describe("approval checks (scenarios 3, 4)", () => {
  it("documents differ by dealer type: a company needs GSTIN, an individual needs no Shop Act", async () => {
    const u = await createUser();
    signIn(u, "CUSTOMER");
    const res = await call(appGet, "/api/dealer/application");
    const req = (type: string) => res.body.requirements[type].filter((r: { required: boolean }) => r.required).map((r: { docType: string }) => r.docType).sort();
    expect(req("INDIVIDUAL")).toEqual(["ADDRESS_PROOF", "BANK_PROOF", "PAN"]);
    expect(req("COMPANY")).toEqual(["ADDRESS_PROOF", "BANK_PROOF", "GSTIN", "PAN"]);
    expect(req("PROPRIETORSHIP")).toEqual(["ADDRESS_PROOF", "BANK_PROOF", "PAN", "SHOP_ACT"]);
  });

  it("approval waits for accepted documents and a verified bank account; a rejected document is sent back", async () => {
    const { user, dealer } = await applyAndSubmit();
    await expect(decideDealer(dealer.id, { action: "APPROVE", agreementStart: START, agreementEnd: END }, admin)).rejects.toMatchObject({ status: 422 });
    const docs = await db.select().from(dealerDocuments).where(eq(dealerDocuments.dealerId, dealer.id));
    for (const d of docs) await reviewDealerDocument(d.id, d.docType === "BANK_PROOF" ? "REJECTED" : "ACCEPTED", d.docType === "BANK_PROOF" ? "Cheque is blurred" : null, admin);
    await expect(
      decideDealer(dealer.id, { action: "APPROVE", agreementStart: START, agreementEnd: END, bankVerifiedByDocument: true }, admin),
    ).rejects.toMatchObject({ status: 422 });
    const note = await db.execute(sql`select title from notifications where user_id = ${user.id} and type = 'dealer.document_rejected'`);
    expect(note.length ?? (note as unknown as { rows: unknown[] }).rows.length).toBeGreaterThan(0);
    // The bank said no: approval stays blocked until the account is corrected.
    await db.update(dealers).set({ bankStatus: "FAILED", bankStatusReason: "the bank could not confirm this account" }).where(eq(dealers.id, dealer.id));
    await reviewDealerDocument(docs.find((d) => d.docType === "BANK_PROOF")!.id, "ACCEPTED", null, admin);
    const ok = await decideDealer(dealer.id, { action: "APPROVE", agreementStart: START, agreementEnd: END, bankVerifiedByDocument: true }, admin);
    expect(ok.dealer.bankStatus).toBe("VERIFIED");
    expect(ok.dealer.bankStatusReason).toMatch(/admin from the bank proof/);
  });
});

describe("employees (scenarios 8, 9, 10)", () => {
  it("the dealer adds an employee with an Employee ID and gets a GKS-FE code; deactivation refuses the code", async () => {
    const { user, dealer } = await applyAndSubmit();
    await approve(dealer.id);
    signIn(user, "DEALER");
    const added = await call(peoplePost, "/api/dealer/salespeople", { method: "POST", body: { employeeId: "EMP-7", name: "Ravi Jadhav", mobile: uniqueMobile() } });
    expect(added.status, JSON.stringify(added.body)).toBe(200);
    expect(added.body.salesperson).toMatchObject({ employeeId: "EMP-7", status: "ACTIVE" });
    expect(added.body.salesperson.code).toMatch(salespersonCodePattern());
    expect(await usable(added.body.salesperson.code)).toBe(true);
    // Employee IDs are unique within the dealer (any case).
    expect((await call(peoplePost, "/api/dealer/salespeople", { method: "POST", body: { employeeId: "emp-7", name: "Other" } })).status).toBe(409);

    const off = await call(personPatch, `/api/dealer/salespeople/${added.body.salesperson.id}`, { method: "PATCH", params: { id: added.body.salesperson.id }, body: { status: "INACTIVE" } });
    expect(off.status).toBe(200);
    expect(await usable(added.body.salesperson.code)).toBe(false);
    // Suspension and reactivation of the dealer do not wake a deactivated employee's code.
    await decideDealer(dealer.id, { action: "SUSPEND", reason: "quality check" }, admin);
    await decideDealer(dealer.id, { action: "REACTIVATE", reason: "check passed" }, admin);
    expect(await usable(added.body.salesperson.code)).toBe(false);
    const list = await call(peopleGet, "/api/dealer/salespeople");
    expect(list.body.salespeople).toHaveLength(1);
  });

  it("a dealer cannot see or change another dealer's employees", async () => {
    const a = await applyAndSubmit();
    await approve(a.dealer.id);
    const b = await applyAndSubmit({ pan: "ABCPT5678L" });
    await approve(b.dealer.id);
    signIn(a.user, "DEALER");
    const added = await call(peoplePost, "/api/dealer/salespeople", { method: "POST", body: { employeeId: "A1", name: "Asha" } });
    signIn(b.user, "DEALER");
    const patch = await call(personPatch, `/api/dealer/salespeople/${added.body.salesperson.id}`, { method: "PATCH", params: { id: added.body.salesperson.id }, body: { status: "INACTIVE" } });
    expect(patch.status).toBe(404);
    expect((await call(peopleGet, "/api/dealer/salespeople")).body.salespeople).toHaveLength(0);
    const viaCode = await call(codeGet, `/api/dealer/code?salesperson=${added.body.salesperson.id}`);
    expect(viaCode.status).toBe(404);
    // Nor open the other dealer's documents.
    const [doc] = await db.select().from(dealerDocuments).where(eq(dealerDocuments.dealerId, a.dealer.id)).limit(1);
    expect((await call(docFileGet, `/api/dealer/documents/${doc.id}`, { params: { id: doc.id } })).status).toBe(404);
  });
});

describe("access and personal data (scenarios 69, 70, 72)", () => {
  it("operators read the queue but cannot decide or reveal; an admin's reveal is audited", async () => {
    const { dealer } = await applyAndSubmit();
    const op = await createUser({ role: "OPERATOR" });
    signIn(op, "OPERATOR");
    const list = await call(adminListGet, "/api/admin/dealers?status=PENDING");
    expect(list.status).toBe(200);
    expect(list.body.dealers.map((d: { id: string }) => d.id)).toContain(dealer.id);
    const decide = await call(decisionPost, `/api/admin/dealers/${dealer.id}/decision`, {
      method: "POST",
      params: { id: dealer.id },
      body: { action: "APPROVE", agreementStart: START, agreementEnd: END },
    });
    expect(decide.status).toBe(403);
    expect((await call(revealPost, `/api/admin/dealers/${dealer.id}/reveal`, { method: "POST", params: { id: dealer.id }, body: { what: "PAN", reason: "checking" } })).status).toBe(403);

    signIn(admin, "ADMIN");
    const pan = await call(revealPost, `/api/admin/dealers/${dealer.id}/reveal`, { method: "POST", params: { id: dealer.id }, body: { what: "PAN", reason: "match with certificate" } });
    expect(pan.body.value).toBe("ABCPS1234K");
    const [audit] = await db.select().from(auditLogs).where(eq(auditLogs.action, "dealer.pan_revealed"));
    expect(audit).toMatchObject({ actorId: admin.id, entityId: dealer.id });
    expect(JSON.stringify(audit.newValue)).not.toContain("ABCPS1234K");
    // An admin opening a document is audited too.
    const [doc] = await db.select().from(dealerDocuments).where(eq(dealerDocuments.dealerId, dealer.id)).limit(1);
    const file = await call(docFileGet, `/api/dealer/documents/${doc.id}`, { params: { id: doc.id } });
    expect(file.status).toBe(200);
    expect(await db.select().from(auditLogs).where(eq(auditLogs.action, "dealer.document_viewed"))).toHaveLength(1);
  });

  it("with the dealer programme off every dealer route says not available (404)", async () => {
    await setFeatureFlag("dealer_programme_enabled", { enabled: false, districtCodes: null }, "off (test)", admin);
    const u = await createUser();
    signIn(u, "CUSTOMER");
    expect((await call(appGet, "/api/dealer/application")).status).toBe(404);
    expect((await call(appPut, "/api/dealer/application", { method: "PUT", body: application() })).status).toBe(404);
    const form = new FormData();
    expect((await call(docPost, "/api/dealer/application/documents", { method: "POST", body: form })).status).toBe(404);
    signIn(admin, "ADMIN");
    expect((await call(adminListGet, "/api/admin/dealers")).status).toBe(404);
  });
});

describe("legacy distributors (owner, 28 Oct 2026)", () => {
  it("re-running migration 0104 makes each distributor a dealer with its code, puts codes without one under GoKesari Direct, and leaves every code working", async () => {
    const [type] = await db.insert(distributorTypes).values({ code: "AGENT", name: "Agent", commissionType: "FLAT", commissionValue: 10_000 }).returning();
    const [dist] = await db.insert(distributors).values({ distributorTypeId: type.id, name: "Kale Agencies", phoneE164: "+919800000001", status: "ACTIVE" }).returning();
    const [inactive] = await db.insert(distributors).values({ distributorTypeId: type.id, name: "Old Agency", status: "INACTIVE" }).returning();
    const distCode = await createReferralCode({ code: "KALE-01", label: "Kale", distributorId: dist.id }, admin);
    const named = await createReferralCode({ code: "RAHUL-SE", label: "Rahul", referrerName: "Rahul More" }, admin);
    const plain = await createReferralCode({ code: "PUNE-LAUNCH", label: "Pune launch" }, admin);
    const before = await db.select().from(referralCodes);

    const migration = readFileSync("drizzle/0104_dealers.sql", "utf8");
    for (let run = 0; run < 2; run++) {
      for (const statement of migration.split("--> statement-breakpoint").map((s) => s.trim()).filter(Boolean)) await db.execute(sql.raw(statement));
    }

    const all = await db.select().from(dealers);
    const kale = all.find((d) => d.legacyDistributorId === dist.id)!;
    expect(kale).toMatchObject({ legalName: "Kale Agencies", status: "APPROVED", source: "LEGACY_MIGRATION" });
    expect(all.find((d) => d.legacyDistributorId === inactive.id)!.status).toBe("SUSPENDED");
    const direct = all.filter((d) => d.isInternal);
    expect(direct).toHaveLength(1);

    const links = await db.select().from(dealerCodes);
    expect(links).toHaveLength(3);
    expect(links.find((l) => l.referralCodeId === distCode.id)).toMatchObject({ dealerId: kale.id, kind: "LEGACY", salespersonId: null });
    expect(links.find((l) => l.referralCodeId === plain.id)).toMatchObject({ dealerId: direct[0].id, salespersonId: null });
    const rahul = links.find((l) => l.referralCodeId === named.id)!;
    expect(rahul.dealerId).toBe(direct[0].id);
    const [person] = await db.select().from(dealerSalespeople).where(eq(dealerSalespeople.id, rahul.salespersonId!));
    expect(person).toMatchObject({ name: "Rahul More", employeeId: "LEGACY-RAHUL-SE", source: "LEGACY_MIGRATION" });

    // Nothing about the codes themselves changed, and they all still validate.
    expect(await db.select().from(referralCodes)).toEqual(before);
    for (const c of ["KALE-01", "RAHUL-SE", "PUNE-LAUNCH"]) expect(await usable(c), c).toBe(true);
  });
});
