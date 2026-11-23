/**
 * RBAC v2 Phase 3 (docs/rbac/03-phase3-accounting.md): Accountant → CA journals, high value CA → Admin,
 * period close, reversal-only corrections (DB triggers), rate proposals through the existing setters,
 * four-eye on rules / commission / fees.
 */
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { db } from "@/server/db";
import { commissionRates, featureFlags, finJournalEntries, finJournalLines, rateChangeProposals } from "@/server/db/schema";
import { decideApproval, FOUR_EYE_TYPES, requestFourEye } from "@/server/approvals";
import {
  closePeriod,
  createJournalDraft,
  createReversal,
  getJournal,
  reopenPeriod,
  submitJournal,
  trialBalance,
  updateJournalDraft,
  withdrawJournal,
} from "@/server/rbac-accounting/journals";
import { activateDueRateProposals, proposeRateChange } from "@/server/rbac-accounting/rates";
import { clearFeatureFlagCache } from "@/server/services/feature-flags";
import { getRule } from "@/server/services/settings";
import { createUser, resetDatabase } from "../helpers/fixtures";

vi.mock("@/server/email/transport", () => ({ sendEmail: vi.fn(async () => undefined) }));
vi.mock("@/server/auth", () => ({ auth: async () => null, handlers: {}, signIn: async () => {}, signOut: async () => {} }));

async function flagOn(key: "rbac_v2_accounting" | "rbac_v2_four_eye_admin") {
  await db.insert(featureFlags).values({ key, enabled: true }).onConflictDoUpdate({ target: featureFlags.key, set: { enabled: true } });
  clearFeatureFlagCache();
}

async function people() {
  const acc = await createUser({ role: "ACCOUNTANT" });
  const ca = await createUser({ role: "CA" });
  const ca2 = await createUser({ role: "CA" });
  const adm = await createUser({ role: "ADMIN" });
  return {
    accountant: { id: acc.id, role: "ACCOUNTANT" as const },
    ca: { id: ca.id, role: "CA" as const },
    ca2: { id: ca2.id, role: "CA" as const },
    admin: { id: adm.id, role: "ADMIN" as const, email: adm.email },
  };
}

const entry = (amount: number, date = "2026-11-10") => ({
  entryDate: date,
  narration: "Bank charges for November",
  lines: [
    { accountCode: "6100", accountName: "Bank charges", debitPaise: amount },
    { accountCode: "1010", accountName: "HDFC current account", creditPaise: amount },
  ],
});

/** The database's own refusal (drizzle wraps it; the trigger's text is in the cause). */
async function dbRefuses(run: Promise<unknown>, pattern: RegExp) {
  const error = await run.then(() => null, (e: unknown) => e as { message?: string; cause?: { message?: string } });
  expect(error).not.toBeNull();
  expect(`${error?.message} ${error?.cause?.message ?? ""}`).toMatch(pattern);
}

beforeEach(async () => {
  await resetDatabase();
  await flagOn("rbac_v2_accounting");
});

describe("journal entries — maker / checker", () => {
  it("is refused while rbac_v2_accounting is off for the role", async () => {
    const { accountant } = await people();
    await db.update(featureFlags).set({ enabled: false }).where(eq(featureFlags.key, "rbac_v2_accounting"));
    clearFeatureFlagCache();
    await expect(createJournalDraft(entry(10_000), accountant)).rejects.toThrow(/not available/);
  });

  it("refuses an unbalanced entry, and a CA or Support User preparing one", async () => {
    const { accountant, ca } = await people();
    const support = await createUser({ role: "SUPPORT_USER" });
    await expect(
      createJournalDraft({ ...entry(100), lines: [entry(100).lines[0], { accountCode: "1010", accountName: "Bank", creditPaise: 90 }] }, accountant),
    ).rejects.toThrow(/does not balance/);
    await expect(createJournalDraft(entry(100), ca)).rejects.toThrow(/Only an Accountant/);
    await expect(createJournalDraft(entry(100), { id: support.id, role: "SUPPORT_USER" })).rejects.toThrow(/not available|Only an Accountant/);
  });

  it("Accountant submits → the CA posts it; nobody approves their own; posted entries cannot be edited", async () => {
    const { accountant, ca } = await people();
    const draft = await createJournalDraft(entry(25_000), accountant);
    expect(draft.entryNumber).toMatch(/^JE-\d{6}$/);
    const submitted = await submitJournal(draft.id, accountant);
    expect(submitted.status).toBe("SUBMITTED");
    await expect(decideApproval({ requestId: submitted.approvalRequestId!, actor: accountant, decision: "APPROVE" })).rejects.toThrow(/Only a CA/);
    const r = await decideApproval({ requestId: submitted.approvalRequestId!, actor: ca, decision: "APPROVE" });
    expect(r.applied).toBe(true);
    const { entry: posted } = await getJournal(draft.id);
    expect(posted.status).toBe("POSTED");
    expect(posted.postedBy).toBe(ca.id);
    // Finalised: the database itself refuses edits.
    await dbRefuses(db.update(finJournalEntries).set({ narration: "edited" }).where(eq(finJournalEntries.id, draft.id)), /reversing entry/);
    await dbRefuses(db.update(finJournalLines).set({ debitPaise: 1 }).where(eq(finJournalLines.entryId, draft.id)), /cannot change/);
    await dbRefuses(db.delete(finJournalEntries).where(eq(finJournalEntries.id, draft.id)), /cannot be deleted/);
    await expect(updateJournalDraft(draft.id, entry(1), accountant)).rejects.toThrow(/Only a draft or a rejected/);
  });

  it("a rejected entry can be corrected and resubmitted; a withdrawn one goes back to draft", async () => {
    const { accountant, ca } = await people();
    const draft = await createJournalDraft(entry(5_000), accountant);
    const s1 = await submitJournal(draft.id, accountant);
    await expect(decideApproval({ requestId: s1.approvalRequestId!, actor: ca, decision: "REJECT" })).rejects.toThrow(/Say why/);
    await decideApproval({ requestId: s1.approvalRequestId!, actor: ca, decision: "REJECT", comment: "Wrong account" });
    expect((await getJournal(draft.id)).entry.status).toBe("REJECTED");
    const fixed = await updateJournalDraft(draft.id, { ...entry(5_000), lines: [{ accountCode: "6110", accountName: "Gateway charges", debitPaise: 5_000 }, entry(5_000).lines[1]] }, accountant);
    expect(fixed.status).toBe("DRAFT");
    const s2 = await submitJournal(draft.id, accountant);
    const back = await withdrawJournal(draft.id, accountant);
    expect(back.status).toBe("DRAFT");
    await expect(decideApproval({ requestId: s2.approvalRequestId!, actor: ca, decision: "APPROVE" })).rejects.toThrow(/already been decided/);
  });

  it("high value: a CA and then an admin (not the same person)", async () => {
    const { accountant, ca, admin } = await people();
    const { highValueJournalPaise } = await getRule("rbacV2");
    const draft = await createJournalDraft(entry(highValueJournalPaise), accountant);
    const s = await submitJournal(draft.id, accountant);
    const stage = await decideApproval({ requestId: s.approvalRequestId!, actor: ca, decision: "APPROVE" });
    expect(stage.request.stage).toBe(2);
    expect((await getJournal(draft.id)).entry.status).toBe("SUBMITTED");
    await decideApproval({ requestId: s.approvalRequestId!, actor: admin, decision: "APPROVE" });
    expect((await getJournal(draft.id)).entry.status).toBe("POSTED");
  });

  it("corrections only by a reversing entry; the trial balance nets to zero", async () => {
    const { accountant, ca } = await people();
    const draft = await createJournalDraft(entry(7_500), accountant);
    const s = await submitJournal(draft.id, accountant);
    await decideApproval({ requestId: s.approvalRequestId!, actor: ca, decision: "APPROVE" });
    let tb = await trialBalance();
    expect(tb.totalDebitPaise).toBe(7_500);
    expect(tb.totalCreditPaise).toBe(7_500);
    const reversal = await createReversal(draft.id, { entryDate: "2026-11-12", reason: "Charged twice by the bank" }, accountant);
    await expect(createReversal(draft.id, { entryDate: "2026-11-12", reason: "again please" }, accountant)).rejects.toThrow(/already being prepared/);
    const rs = await submitJournal(reversal.id, accountant);
    await decideApproval({ requestId: rs.approvalRequestId!, actor: ca, decision: "APPROVE" });
    expect((await getJournal(draft.id)).entry.status).toBe("REVERSED");
    tb = await trialBalance();
    for (const row of tb.rows) expect(row.balancePaise).toBe(0);
  });
});

describe("financial periods", () => {
  it("only the CA closes; nothing is drafted, submitted or posted into a closed month; reopen needs a reason", async () => {
    const { accountant, ca } = await people();
    const draft = await createJournalDraft(entry(1_000, "2026-10-15"), accountant);
    const s = await submitJournal(draft.id, accountant);
    await expect(closePeriod("2026-10", accountant)).rejects.toThrow(/Only the CA/);
    await expect(closePeriod("2026-10", ca)).rejects.toThrow(/waits? for approval/);
    await withdrawJournal(draft.id, accountant);
    await closePeriod("2026-10", ca, "October books closed");
    await expect(createJournalDraft(entry(1_000, "2026-10-20"), accountant)).rejects.toThrow(/closed/);
    await expect(submitJournal(draft.id, accountant)).rejects.toThrow(/closed/);
    await expect(reopenPeriod("2026-10", ca, "x")).rejects.toThrow(/Say why/);
    await reopenPeriod("2026-10", ca, "Late bank statement arrived");
    const again = await submitJournal(draft.id, accountant);
    expect(again.status).toBe("SUBMITTED");
    expect(s.approvalRequestId).not.toBe(again.approvalRequestId);
  });
});

describe("rate proposals — Accountant → CA → Admin, through the existing setters", () => {
  it("activates a commission change only after the CA and an admin; rates are untouched before", async () => {
    const { accountant, ca, admin } = await people();
    const p = await proposeRateChange({ rateKind: "COMMISSION", scope: "DEFAULT", rateBp: 250, effectiveAt: new Date(Date.now() - 60_000), reason: "Board approved 2.5%" }, accountant);
    expect(p.status).toBe("PENDING_CA");
    expect(await db.select().from(commissionRates)).toHaveLength(0);
    await expect(decideApproval({ requestId: p.approvalRequestId!, actor: admin, decision: "APPROVE" })).rejects.toThrow(/Only a CA/);
    await decideApproval({ requestId: p.approvalRequestId!, actor: ca, decision: "APPROVE" });
    expect((await db.select().from(rateChangeProposals).where(eq(rateChangeProposals.id, p.id)))[0].status).toBe("PENDING_ADMIN");
    await decideApproval({ requestId: p.approvalRequestId!, actor: admin, decision: "APPROVE" });
    const [rate] = await db.select().from(commissionRates).where(eq(commissionRates.isActive, true));
    expect(rate.rateBp).toBe(250);
    expect((await db.select().from(rateChangeProposals).where(eq(rateChangeProposals.id, p.id)))[0].status).toBe("ACTIVATED");
  });

  it("a future commission is SCHEDULED and activated by the sweep once due", async () => {
    const { accountant, ca, admin } = await people();
    const p = await proposeRateChange({ rateKind: "COMMISSION", scope: "DEFAULT", rateBp: 300, effectiveAt: new Date(Date.now() + 3_600_000), reason: "From next hour" }, accountant);
    await decideApproval({ requestId: p.approvalRequestId!, actor: ca, decision: "APPROVE" });
    await decideApproval({ requestId: p.approvalRequestId!, actor: admin, decision: "APPROVE" });
    expect((await db.select().from(rateChangeProposals).where(eq(rateChangeProposals.id, p.id)))[0].status).toBe("SCHEDULED");
    expect(await activateDueRateProposals()).toEqual({ activated: 0, failed: 0 });
    await db.update(rateChangeProposals).set({ effectiveAt: new Date(Date.now() - 1000) }).where(eq(rateChangeProposals.id, p.id));
    expect(await activateDueRateProposals()).toEqual({ activated: 1, failed: 0 });
    expect((await db.select().from(commissionRates).where(eq(commissionRates.isActive, true)))[0].rateBp).toBe(300);
  });

  it("the delivery charge goes through rule shopWallet; a rejection leaves it unchanged", async () => {
    const { accountant, ca, admin } = await people();
    const before = (await getRule("shopWallet")).deliveryChargePaise;
    const p = await proposeRateChange({ rateKind: "DELIVERY_CHARGE", amountPaise: 2_500, effectiveAt: new Date(), reason: "Fuel price rise" }, accountant);
    await decideApproval({ requestId: p.approvalRequestId!, actor: ca, decision: "REJECT", comment: "Not this quarter" });
    expect((await getRule("shopWallet")).deliveryChargePaise).toBe(before);
    const p2 = await proposeRateChange({ rateKind: "DELIVERY_CHARGE", amountPaise: 2_500, effectiveAt: new Date(), reason: "Fuel price rise, revised" }, accountant);
    await decideApproval({ requestId: p2.approvalRequestId!, actor: ca, decision: "APPROVE" });
    await decideApproval({ requestId: p2.approvalRequestId!, actor: admin, decision: "APPROVE" });
    expect((await getRule("shopWallet")).deliveryChargePaise).toBe(2_500);
  });

  it("only an Accountant proposes", async () => {
    const { ca } = await people();
    await expect(proposeRateChange({ rateKind: "COMMISSION", rateBp: 100, effectiveAt: new Date(), reason: "CA trying" }, ca)).rejects.toThrow(/Only an Accountant/);
  });
});

describe("four-eye on sensitive configuration", () => {
  it("a commission change by one admin waits for a second admin", async () => {
    await flagOn("rbac_v2_four_eye_admin");
    const { admin } = await people();
    const admin2 = await createUser({ role: "ADMIN" });
    const pending = await requestFourEye(FOUR_EYE_TYPES.COMMISSION_RATE_SET, admin, {
      subjectType: "commission_rate",
      subjectId: "DEFAULT",
      title: "Commission DEFAULT → 2%",
      reason: "Commission rate change",
      payload: { scope: "DEFAULT", rateBp: 200 },
    });
    expect(await db.select().from(commissionRates)).toHaveLength(0);
    await decideApproval({ requestId: pending.approvalId, actor: { id: admin2.id, role: "ADMIN" }, decision: "APPROVE" });
    expect((await db.select().from(commissionRates))[0].rateBp).toBe(200);
  });
});
