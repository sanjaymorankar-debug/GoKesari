/**
 * Module 7 — self-service account deletion against real PostgreSQL
 * (docs/account-deletion-2026-11): the code, the anonymisation, what is kept,
 * the blockers, every session ending, and the original email signing up anew.
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
import { accountDeletionRequests, addresses, auditLogs, featureFlags, loginOtps, pushTokens, users, wallets } from "@/server/db/schema";
import { verifyLoginOtp, requestLoginOtp } from "@/server/otp/service";
import {
  anonymisedEmail,
  deleteAccount,
  deletionPrecheck,
  requestAccountDeletionCode,
} from "@/server/services/account-deletion";
import { AUDIT_ACTIONS } from "@/server/services/audit";
import { clearFeatureFlagCache } from "@/server/services/feature-flags";
import { createUser, deliveryAddressId, resetDatabase } from "../helpers/fixtures";

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

describe("deleting an account", () => {
  beforeEach(() => setFlag(true));

  it("anonymises the account, strips addresses and push tokens, ends sessions and lets the email sign up again", async () => {
    const user = await createUser({ email: "leaving@example.com", name: "Asha Leaving" });
    await deliveryAddressId(user.id);
    await db.insert(pushTokens).values({ userId: user.id, token: `tok-${user.id}`, platform: "android" });

    expect((await deletionPrecheck(user.id)).canDelete).toBe(true);
    const sent = await requestAccountDeletionCode({ id: user.id, role: user.role });
    expect(sent.maskedEmail).not.toBe("leaving@example.com");
    const code = lastCodeTo("leaving@example.com");

    const result = await deleteAccount({ id: user.id, role: user.role }, { code, confirmText: "DELETE", reason: "Moving away" });
    expect(result.deleted).toBe(true);

    const [after] = await db.select().from(users).where(eq(users.id, user.id));
    expect(after).toMatchObject({ status: "DELETED", name: null, phone: null, phoneE164: null, email: anonymisedEmail(user.id) });
    expect(after.deletedAt).not.toBeNull();

    const [address] = await db.select().from(addresses).where(eq(addresses.userId, user.id));
    expect(address.line1).toBe("[deleted]");
    expect(address.deletedAt).not.toBeNull();
    expect(await db.select().from(pushTokens).where(eq(pushTokens.userId, user.id))).toHaveLength(0);

    const [request] = await db.select().from(accountDeletionRequests).where(eq(accountDeletionRequests.userId, user.id));
    expect(request).toMatchObject({ status: "COMPLETED", reason: "Moving away" });

    const audits = await db
      .select({ action: auditLogs.action })
      .from(auditLogs)
      .where(and(eq(auditLogs.entityType, "user"), eq(auditLogs.entityId, user.id)));
    expect(audits.map((a) => a.action)).toEqual(expect.arrayContaining([AUDIT_ACTIONS.ACCOUNT_DELETION_REQUESTED, AUDIT_ACTIONS.ACCOUNT_DELETED]));

    // Every session of the account is dropped on its next request.
    expect(await readSession({ sub: user.id, sid: "any-device" })).toBeNull();

    // Completion email to the ORIGINAL address, after commit.
    expect(state.outbox.some((m) => m.to === "leaving@example.com" && /has been deleted/.test(m.subject))).toBe(true);

    // The original email signs up again as a brand-new, empty account.
    await requestLoginOtp({ email: "leaving@example.com" });
    const login = await verifyLoginOtp({ email: "leaving@example.com", code: lastCodeTo("leaving@example.com"), acceptedTerms: true });
    expect(login.isNewUser).toBe(true);
    expect(login.user.id).not.toBe(user.id);
  });

  it("a wrong word or a wrong code deletes nothing", async () => {
    const user = await createUser({ email: "careful@example.com" });
    await requestAccountDeletionCode({ id: user.id, role: user.role });
    await expect(deleteAccount({ id: user.id, role: user.role }, { code: lastCodeTo("careful@example.com"), confirmText: "delete" })).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
    });
    await expect(deleteAccount({ id: user.id, role: user.role }, { code: "000000", confirmText: "DELETE" })).rejects.toMatchObject({
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
