/**
 * Module 7 — self-service account deletion against real PostgreSQL
 * (docs/account-deletion-2026-11): the code, the 90-day cooling-off (0196: the
 * account hidden, a hidden account unable to act, restore at sign-in, admin
 * cancel), the daily purge with a fake clock (anonymisation, what is kept, a
 * blocker at purge time), every session ending, and the original email signing
 * up anew.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ outbox: [] as { to: string; subject: string; text: string }[] }));

vi.mock("@/server/email/transport", () => ({
  emailMode: () => "smtp",
  sendEmail: async (message: { to: string; subject: string; text: string }) => {
    state.outbox.push(message);
  },
  EmailUnavailableError: class extends Error {},
}));

import { and, eq } from "drizzle-orm";

import { resetRateLimits } from "@/server/api/rate-limit";
import { readSession } from "@/server/auth-sessions";
import { db } from "@/server/db";
import { accountDeletionRequests, addresses, auditLogs, deliveryPartners, featureFlags, loginOtps, pushTokens, users, wallets } from "@/server/db/schema";
import { verifyLoginOtp, requestLoginOtp } from "@/server/otp/service";
import {
  adminCancelDeletion,
  anonymisedEmail,
  deleteAccount,
  deletionPrecheck,
  getPendingDeletion,
  listDeletionRequests,
  requestAccountDeletionCode,
  restoreAccount,
  runDueAccountPurges,
} from "@/server/services/account-deletion";
import { AUDIT_ACTIONS } from "@/server/services/audit";
import { clearFeatureFlagCache } from "@/server/services/feature-flags";
import { getEnv } from "@/lib/env";
import type { UserRole } from "@/server/db/schema";
import { createDeliveryPartner, createUser, deliveryAddressId, resetDatabase } from "../helpers/fixtures";

async function setFlag(enabled: boolean) {
  await db.insert(featureFlags).values({ key: "account_self_deletion_enabled", enabled }).onConflictDoUpdate({ target: featureFlags.key, set: { enabled } });
  clearFeatureFlagCache();
}

function lastCodeTo(email: string): string {
  const message = [...state.outbox].reverse().find((m) => m.to === email);
  const code = message?.text.match(/\b(\d{4,8})\b/)?.[1];
  if (!code) throw new Error(`no code was emailed to ${email}`);
  return code;
}

beforeEach(async () => {
  state.outbox = [];
  resetRateLimits();
  await resetDatabase();
  await db.delete(loginOtps);
  await db.delete(accountDeletionRequests);
});

describe("flag off", () => {
  it("every step answers 404", async () => {
    const user = await createUser();
    await expect(deletionPrecheck(user.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(requestAccountDeletionCode({ id: user.id, role: user.role })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(state.outbox).toHaveLength(0);
  });
});

const DAY = 24 * 60 * 60 * 1000;
const NO_DEPS = { goOffline: async () => undefined };

/** Confirms the deletion (code + DELETE + reason) at `now`; the account is then hidden. */
async function confirmDeletion(user: { id: string; role: UserRole }, email: string, now: Date, reason = "Moving away") {
  await requestAccountDeletionCode({ id: user.id, role: user.role });
  return deleteAccount(
    { id: user.id, role: user.role },
    { code: lastCodeTo(email), confirmText: "DELETE", reasonCode: "OTHER", reason },
    {},
    { ...NO_DEPS, now: () => now },
  );
}

async function auditActions(userId: string) {
  const rows = await db
    .select({ action: auditLogs.action })
    .from(auditLogs)
    .where(and(eq(auditLogs.entityType, "user"), eq(auditLogs.entityId, userId)));
  return rows.map((a) => a.action);
}

describe("confirming starts the cooling-off period", () => {
  beforeEach(() => setFlag(true));

  it("hides the account for 90 days, stores the reason, ends sessions; nothing is anonymised yet", async () => {
    const user = await createUser({ email: "leaving@example.com", name: "Asha Leaving" });
    await deliveryAddressId(user.id);
    await db.insert(pushTokens).values({ userId: user.id, token: `tok-${user.id}`, platform: "android" });
    const now = new Date();

    expect((await deletionPrecheck(user.id)).canDelete).toBe(true);
    const result = await confirmDeletion(user, "leaving@example.com", now);
    expect(result.scheduled).toBe(true);
    expect(result.purgeAfter.getTime()).toBe(now.getTime() + 90 * DAY);

    const [after] = await db.select().from(users).where(eq(users.id, user.id));
    expect(after).toMatchObject({ status: "PENDING_DELETION", name: "Asha Leaving", email: "leaving@example.com", deletedAt: null });
    const [address] = await db.select().from(addresses).where(eq(addresses.userId, user.id));
    expect(address.deletedAt).toBeNull();
    expect(await db.select().from(pushTokens).where(eq(pushTokens.userId, user.id))).toHaveLength(0);

    const [request] = await db.select().from(accountDeletionRequests).where(eq(accountDeletionRequests.userId, user.id));
    expect(request).toMatchObject({ status: "COOLING_OFF", reasonCode: "OTHER", reason: "Moving away" });
    expect(request.purgeAfter?.getTime()).toBe(result.purgeAfter.getTime());
    expect(await auditActions(user.id)).toEqual(expect.arrayContaining([AUDIT_ACTIONS.ACCOUNT_DELETION_REQUESTED, AUDIT_ACTIONS.ACCOUNT_DELETION_COOLING_OFF]));
    expect(state.outbox.some((m) => m.to === "leaving@example.com" && /will be deleted on/.test(m.subject))).toBe(true);

    // Admins see it under the cooling period, with the reason; name and email for admins only.
    const [adminRow] = await listDeletionRequests({ includePersonal: true });
    expect(adminRow).toMatchObject({ status: "COOLING_OFF", reason: "Moving away", person: { name: "Asha Leaving", email: "leaving@example.com" } });
    const [operatorRow] = await listDeletionRequests({ includePersonal: false });
    expect(operatorRow.person).toBeNull();
  });

  it("a hidden account cannot act: sessions dropped, no sign-in session, no second request", async () => {
    const user = await createUser({ email: "hidden@example.com" });
    await confirmDeletion(user, "hidden@example.com", new Date());

    expect(await readSession({ sub: user.id, sid: "any-device" })).toBeNull();
    await expect(
      deleteAccount({ id: user.id, role: user.role }, { code: "000000", confirmText: "DELETE", reasonCode: "NOT_USING" }, {}, NO_DEPS),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    // A code is still emailed (to restore), but only the sign-in page's restore path accepts it.
    await requestLoginOtp({ email: "hidden@example.com" });
    const code = lastCodeTo("hidden@example.com");
    await expect(verifyLoginOtp({ email: "hidden@example.com", code })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await requestLoginOtp({ email: "hidden@example.com" }).catch(() => undefined);
    resetRateLimits();
    await db.delete(loginOtps);
    await requestLoginOtp({ email: "hidden@example.com" });
    const login = await verifyLoginOtp({ email: "hidden@example.com", code: lastCodeTo("hidden@example.com"), allowPendingDeletion: true });
    expect(login).toMatchObject({ pendingDeletion: true, isNewUser: false });
    expect(login.user.id).toBe(user.id);
    expect((await getPendingDeletion(user.id))?.purgeAfter).toBeInstanceOf(Date);
  });

  it("restore at sign-in: ACTIVE again, request CANCELLED, rider switched back, audited and emailed", async () => {
    const user = await createUser({ email: "back@example.com", role: "DELIVERY_PARTNER" });
    const rider = await createDeliveryPartner(user.id, { status: "APPROVED" });
    await confirmDeletion(user, "back@example.com", new Date());
    const [hiddenRider] = await db.select().from(deliveryPartners).where(eq(deliveryPartners.id, rider.id));
    expect(hiddenRider.status).toBe("DEACTIVATED");

    await restoreAccount(user.id, { id: user.id, role: user.role }, { by: "SELF" });
    const [after] = await db.select().from(users).where(eq(users.id, user.id));
    expect(after.status).toBe("ACTIVE");
    const [backRider] = await db.select().from(deliveryPartners).where(eq(deliveryPartners.id, rider.id));
    expect(backRider.status).toBe("APPROVED");
    const [request] = await db.select().from(accountDeletionRequests).where(eq(accountDeletionRequests.userId, user.id));
    expect(request).toMatchObject({ status: "CANCELLED", cancelledBy: user.id });
    expect(await auditActions(user.id)).toContain(AUDIT_ACTIONS.ACCOUNT_DELETION_RESTORED);
    expect(state.outbox.some((m) => m.to === "back@example.com" && /restored/.test(m.subject))).toBe(true);
    expect(await getPendingDeletion(user.id)).toBeNull();
    // Nothing left to restore; the purge job finds nothing due.
    await expect(restoreAccount(user.id, { id: user.id, role: user.role })).rejects.toMatchObject({ code: "CONFLICT" });
    expect((await runDueAccountPurges(new Date(Date.now() + 100 * DAY))).due).toBe(0);
  });

  it("an admin cancels a deletion with a note (restores the account); an operator cannot", async () => {
    const user = await createUser({ email: "called@example.com" });
    const admin = await createUser({ role: "ADMIN" });
    await confirmDeletion(user, "called@example.com", new Date());
    const [request] = await db.select().from(accountDeletionRequests).where(eq(accountDeletionRequests.userId, user.id));

    await expect(adminCancelDeletion({ id: admin.id, role: "OPERATOR" }, request.id, "Customer called")).rejects.toMatchObject({ code: "FORBIDDEN" });
    await adminCancelDeletion({ id: admin.id, role: "ADMIN" }, request.id, "Customer called support to stay");
    const [after] = await db.select().from(users).where(eq(users.id, user.id));
    expect(after.status).toBe("ACTIVE");
    const [cancelled] = await db.select().from(accountDeletionRequests).where(eq(accountDeletionRequests.id, request.id));
    expect(cancelled).toMatchObject({ status: "CANCELLED", cancelledBy: admin.id, cancelNote: "Customer called support to stay" });
    const restored = await db
      .select({ actorId: auditLogs.actorId })
      .from(auditLogs)
      .where(and(eq(auditLogs.entityId, user.id), eq(auditLogs.action, AUDIT_ACTIONS.ACCOUNT_DELETION_RESTORED)));
    expect(restored.map((r) => r.actorId)).toEqual([admin.id]);
  });
});

describe("the daily purge after the cooling-off period (fake clock)", () => {
  beforeEach(() => setFlag(true));

  it("does nothing before day 90; then anonymises, completes, emails the original address; the email signs up anew", async () => {
    const user = await createUser({ email: "gone@example.com", name: "Ravi Gone" });
    await deliveryAddressId(user.id);
    const start = new Date();
    await confirmDeletion(user, "gone@example.com", start);

    expect(await runDueAccountPurges(new Date(start.getTime() + 89 * DAY))).toMatchObject({ due: 0, completed: 0 });
    expect((await db.select().from(users).where(eq(users.id, user.id)))[0].status).toBe("PENDING_DELETION");

    const run = await runDueAccountPurges(new Date(start.getTime() + 90 * DAY + 60_000));
    expect(run).toMatchObject({ due: 1, completed: 1, blocked: 0 });

    const [after] = await db.select().from(users).where(eq(users.id, user.id));
    expect(after).toMatchObject({ status: "DELETED", name: null, phone: null, phoneE164: null, email: anonymisedEmail(user.id) });
    const [address] = await db.select().from(addresses).where(eq(addresses.userId, user.id));
    expect(address.line1).toBe("[deleted]");
    const [request] = await db.select().from(accountDeletionRequests).where(eq(accountDeletionRequests.userId, user.id));
    expect(request.status).toBe("COMPLETED");
    expect(request.completedAt).not.toBeNull();
    expect(await auditActions(user.id)).toContain(AUDIT_ACTIONS.ACCOUNT_DELETED);
    expect(state.outbox.some((m) => m.to === "gone@example.com" && /has been deleted/.test(m.subject))).toBe(true);
    expect(await readSession({ sub: user.id, sid: "any-device" })).toBeNull();

    // A second run does nothing.
    expect((await runDueAccountPurges(new Date(start.getTime() + 91 * DAY))).due).toBe(0);

    await requestLoginOtp({ email: "gone@example.com" });
    const login = await verifyLoginOtp({ email: "gone@example.com", code: lastCodeTo("gone@example.com"), acceptedTerms: true });
    expect(login.isNewUser).toBe(true);
    expect(login.user.id).not.toBe(user.id);
  });

  it("a blocker that appeared holds the purge (BLOCKED, ops alerted once) until it clears", async () => {
    const user = await createUser({ email: "refund@example.com" });
    const start = new Date();
    await confirmDeletion(user, "refund@example.com", start);
    // A refund landed in the wallet during the cooling-off period.
    await db.insert(wallets).values({ userId: user.id, balancePaise: 25_000 }).onConflictDoUpdate({ target: wallets.userId, set: { balancePaise: 25_000 } });

    const later = new Date(start.getTime() + 91 * DAY);
    expect(await runDueAccountPurges(later)).toMatchObject({ due: 1, completed: 0, blocked: 1 });
    const [held] = await db.select().from(accountDeletionRequests).where(eq(accountDeletionRequests.userId, user.id));
    expect(held.status).toBe("BLOCKED");
    expect(held.blockers.map((b) => b.code)).toEqual(["WALLET_BALANCE"]);
    expect((await db.select().from(users).where(eq(users.id, user.id)))[0]).toMatchObject({ status: "PENDING_DELETION", email: "refund@example.com" });
    expect(await auditActions(user.id)).toContain(AUDIT_ACTIONS.ACCOUNT_DELETION_PURGE_BLOCKED);
    const alerts = () => state.outbox.filter((m) => m.to === getEnv().SUPER_ADMIN_EMAIL && /held/.test(m.subject));
    expect(alerts()).toHaveLength(1);

    // Retried the next day: still blocked, no second alert.
    expect(await runDueAccountPurges(new Date(later.getTime() + DAY))).toMatchObject({ blocked: 1 });
    expect(alerts()).toHaveLength(1);

    // Money refunded to the bank: the next run purges.
    await db.update(wallets).set({ balancePaise: 0 }).where(eq(wallets.userId, user.id));
    expect(await runDueAccountPurges(new Date(later.getTime() + 2 * DAY))).toMatchObject({ completed: 1 });
    expect((await db.select().from(users).where(eq(users.id, user.id)))[0].status).toBe("DELETED");
  });
});

describe("refusals", () => {
  beforeEach(() => setFlag(true));

  it("a wrong word, a missing reason or a wrong code changes nothing", async () => {
    const user = await createUser({ email: "careful@example.com" });
    await requestAccountDeletionCode({ id: user.id, role: user.role });
    const code = lastCodeTo("careful@example.com");
    await expect(deleteAccount({ id: user.id, role: user.role }, { code, confirmText: "delete", reasonCode: "NOT_USING" })).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
    });
    await expect(deleteAccount({ id: user.id, role: user.role }, { code, confirmText: "DELETE" })).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
    });
    await expect(deleteAccount({ id: user.id, role: user.role }, { code: "000000", confirmText: "DELETE", reasonCode: "NOT_USING" })).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
    });
    const [after] = await db.select().from(users).where(eq(users.id, user.id));
    expect(after.status).toBe("ACTIVE");
  });

  it("money in the wallet blocks: no code is sent and a BLOCKED request is recorded", async () => {
    const user = await createUser({ email: "rich@example.com" });
    await db.insert(wallets).values({ userId: user.id, balancePaise: 10_000 });
    const pre = await deletionPrecheck(user.id);
    expect(pre.blockers.map((b) => b.code)).toEqual(["WALLET_BALANCE"]);
    await expect(requestAccountDeletionCode({ id: user.id, role: user.role })).rejects.toMatchObject({ code: "CONFLICT" });
    expect(state.outbox).toHaveLength(0);
    const [request] = await db.select().from(accountDeletionRequests).where(eq(accountDeletionRequests.userId, user.id));
    expect(request.status).toBe("BLOCKED");
    expect(request.blockers.map((b) => b.code)).toEqual(["WALLET_BALANCE"]);
  });
});
