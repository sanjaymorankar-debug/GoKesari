/**
 * Consent versioning (Part 58 — DPDPA 2023 §6: consent must be demonstrable).
 */
import { beforeEach, describe, expect, it } from "vitest";

import { eq } from "drizzle-orm";

import { db } from "@/server/db";
import { auditLogs, users, type ConsentType } from "@/server/db/schema";
import { AUDIT_ACTIONS } from "@/server/services/audit";
import {
  CURRENT_POLICY_VERSION,
  getConsentOverview,
  getLatestConsent,
  getMarketingConsentStatus,
  getUserConsentTrail,
  hasCurrentConsent,
  listConsentChanges,
  listConsentHistory,
  recordConsent,
} from "@/server/services/consents";
import { createUser, resetDatabase } from "../helpers/fixtures";

describe("consent recording", () => {
  beforeEach(resetDatabase);

  it("records a consent against the current policy version by default", async () => {
    const user = await createUser();
    const consent = await recordConsent(user.id, "TERMS_AND_PRIVACY");
    expect(consent.version).toBe(CURRENT_POLICY_VERSION);
    expect(consent.userId).toBe(user.id);
  });

  it("reports hasCurrentConsent true only when the latest record matches CURRENT_POLICY_VERSION", async () => {
    const user = await createUser();
    expect(await hasCurrentConsent(user.id, "TERMS_AND_PRIVACY")).toBe(false);

    await recordConsent(user.id, "TERMS_AND_PRIVACY", { version: "2020-01-01" });
    expect(await hasCurrentConsent(user.id, "TERMS_AND_PRIVACY")).toBe(false);

    await recordConsent(user.id, "TERMS_AND_PRIVACY");
    expect(await hasCurrentConsent(user.id, "TERMS_AND_PRIVACY")).toBe(true);
  });

  it("is append-only — a later consent supersedes without deleting the earlier record", async () => {
    const user = await createUser();
    await recordConsent(user.id, "TERMS_AND_PRIVACY", { version: "2020-01-01" });
    await recordConsent(user.id, "TERMS_AND_PRIVACY", { version: "2021-06-01" });

    const history = await listConsentHistory(user.id);
    expect(history).toHaveLength(2);

    const latest = await getLatestConsent(user.id, "TERMS_AND_PRIVACY");
    expect(latest?.version).toBe("2021-06-01");
  });

  it("tracks consent types independently", async () => {
    const user = await createUser();
    await recordConsent(user.id, "TERMS_AND_PRIVACY");
    expect(await getLatestConsent(user.id, "MARKETING_COMMUNICATIONS")).toBeUndefined();
  });
});

/**
 * NAV-019 — operations' view of the consent record.
 *
 * The overview runs raw SQL (a DISTINCT ON to pick the newest row per user and
 * type), so these exercise it against real PostgreSQL rather than mocking the
 * arithmetic. The point of each case is one claim operations relies on: a
 * withdrawal supersedes a grant, a stale policy version is not a current
 * consent, and a deleted account drops out entirely.
 */
describe("consent overview for operations (NAV-019)", () => {
  beforeEach(resetDatabase);

  const summaryFor = (overview: Awaited<ReturnType<typeof getConsentOverview>>, type: ConsentType) =>
    overview.byType.find((s) => s.consentType === type)!;

  it("lists every consent type even with nothing recorded, and counts accounts with no record", async () => {
    await createUser();
    await createUser();

    const overview = await getConsentOverview();
    expect(overview.policyVersion).toBe(CURRENT_POLICY_VERSION);
    expect(overview.liveUsers).toBe(2);
    expect(overview.byType.map((s) => s.consentType).sort()).toEqual([
      "MARKETING_COMMUNICATIONS",
      "TERMS_AND_PRIVACY",
    ]);
    for (const summary of overview.byType) {
      expect(summary).toMatchObject({ current: 0, stale: 0, withdrawn: 0, never: 2 });
    }
  });

  it("separates current grants, stale versions and withdrawals", async () => {
    const current = await createUser();
    const stale = await createUser();
    const withdrawn = await createUser();
    await createUser(); // never chose

    await recordConsent(current.id, "MARKETING_COMMUNICATIONS", { granted: true });
    await recordConsent(stale.id, "MARKETING_COMMUNICATIONS", { granted: true, version: "2020-01-01" });
    await recordConsent(withdrawn.id, "MARKETING_COMMUNICATIONS", { granted: true });
    await recordConsent(withdrawn.id, "MARKETING_COMMUNICATIONS", { granted: false });

    const marketing = summaryFor(await getConsentOverview(), "MARKETING_COMMUNICATIONS");
    expect(marketing).toMatchObject({ current: 1, stale: 1, withdrawn: 1, never: 1 });
  });

  it("counts only the newest row per user — a re-grant after a withdrawal is current again", async () => {
    const user = await createUser();
    await recordConsent(user.id, "MARKETING_COMMUNICATIONS", { granted: true });
    await recordConsent(user.id, "MARKETING_COMMUNICATIONS", { granted: false });
    await recordConsent(user.id, "MARKETING_COMMUNICATIONS", { granted: true });

    const marketing = summaryFor(await getConsentOverview(), "MARKETING_COMMUNICATIONS");
    expect(marketing).toMatchObject({ current: 1, withdrawn: 0, never: 0 });
    // Still three rows on the ledger — the count is about the latest, not the history.
    expect(await listConsentHistory(user.id)).toHaveLength(3);
  });

  it("counts a stale grant apart from a current one, though both are reachable for marketing", async () => {
    // The consent page says this in so many words, so it is pinned here: the
    // overview splits on policy version, but the campaign audience filter
    // (hasMarketingConsent in marketing.ts, mirrored by
    // getMarketingConsentStatus) asks only whether the newest row is a grant.
    // If marketing ever starts enforcing the version, this test fails and the
    // page's wording has to change with it.
    const user = await createUser();
    await recordConsent(user.id, "MARKETING_COMMUNICATIONS", { granted: true, version: "2020-01-01" });

    expect(summaryFor(await getConsentOverview(), "MARKETING_COMMUNICATIONS")).toMatchObject({
      current: 0,
      stale: 1,
    });
    expect(await hasCurrentConsent(user.id, "MARKETING_COMMUNICATIONS")).toBe(false);
    expect((await getMarketingConsentStatus(user.id)).granted).toBe(true);
  });

  it("keeps the two consent types independent", async () => {
    const user = await createUser();
    await recordConsent(user.id, "TERMS_AND_PRIVACY", { granted: true });
    await recordConsent(user.id, "MARKETING_COMMUNICATIONS", { granted: false });

    const overview = await getConsentOverview();
    expect(summaryFor(overview, "TERMS_AND_PRIVACY")).toMatchObject({ current: 1, withdrawn: 0 });
    expect(summaryFor(overview, "MARKETING_COMMUNICATIONS")).toMatchObject({ current: 0, withdrawn: 1 });
  });

  it("excludes a deleted account from the counts and from the trail", async () => {
    const kept = await createUser();
    const removed = await createUser();
    await recordConsent(kept.id, "MARKETING_COMMUNICATIONS", { granted: true });
    await recordConsent(removed.id, "MARKETING_COMMUNICATIONS", { granted: true });

    await db.update(users).set({ deletedAt: new Date() }).where(eq(users.id, removed.id));

    const overview = await getConsentOverview();
    expect(overview.liveUsers).toBe(1);
    expect(summaryFor(overview, "MARKETING_COMMUNICATIONS")).toMatchObject({ current: 1, never: 0 });

    const changes = await listConsentChanges();
    expect(changes.map((c) => c.userId)).toEqual([kept.id]);
  });
});

describe("consent trail and lookup (NAV-019)", () => {
  beforeEach(resetDatabase);

  const OPERATOR = (id: string) => ({ id, role: "OPERATOR" as const });

  it("returns the trail newest first and audits who read it", async () => {
    const operator = await createUser({ role: "OPERATOR" });
    const subject = await createUser({ name: "Asha", email: "asha@example.com" });
    await recordConsent(subject.id, "TERMS_AND_PRIVACY", { granted: true });
    await recordConsent(subject.id, "MARKETING_COMMUNICATIONS", { granted: true });
    await recordConsent(subject.id, "MARKETING_COMMUNICATIONS", { granted: false });

    const trail = await getUserConsentTrail(subject.id, OPERATOR(operator.id));
    expect(trail?.user.email).toBe("asha@example.com");
    expect(trail?.history).toHaveLength(3);
    expect(trail!.history[0].granted).toBe(false); // newest first

    const [audit] = await db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.action, AUDIT_ACTIONS.CONSENT_HISTORY_VIEWED));
    expect(audit.actorId).toBe(operator.id);
    expect(audit.entityId).toBe(subject.id);
  });

  it("never hands back the stored IP address", async () => {
    // The IP is evidence that the act of consenting happened; it is not for
    // staff to browse. The service projects it away rather than relying on the
    // page to omit it, so this holds for any future caller too.
    const operator = await createUser({ role: "OPERATOR" });
    const subject = await createUser();
    await recordConsent(subject.id, "MARKETING_COMMUNICATIONS", {
      granted: true,
      ipAddress: "203.0.113.77",
    });

    const trail = await getUserConsentTrail(subject.id, OPERATOR(operator.id));
    expect(trail!.history).toHaveLength(1);
    expect(JSON.stringify(trail)).not.toContain("203.0.113.77");
    expect(Object.keys(trail!.history[0]).sort()).toEqual([
      "consentType",
      "createdAt",
      "granted",
      "id",
      "version",
    ]);

    // It is still on the row — withheld from the view, not discarded.
    const [stored] = await listConsentHistory(subject.id);
    expect(stored.ipAddress).toBe("203.0.113.77");
  });

  it("omits the IP from the change list as well", async () => {
    const user = await createUser();
    await recordConsent(user.id, "MARKETING_COMMUNICATIONS", {
      granted: true,
      ipAddress: "203.0.113.77",
    });

    expect(JSON.stringify(await listConsentChanges())).not.toContain("203.0.113.77");
  });

  it("refuses a reader who is not operations, and writes no audit row for the attempt", async () => {
    const customer = await createUser();
    const subject = await createUser();

    await expect(
      getUserConsentTrail(subject.id, { id: customer.id, role: "CUSTOMER" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    const audits = await db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.action, AUDIT_ACTIONS.CONSENT_HISTORY_VIEWED));
    expect(audits).toHaveLength(0);
  });

  it("returns null for an unknown or deleted account without auditing", async () => {
    const operator = await createUser({ role: "OPERATOR" });
    const removed = await createUser();
    await db.update(users).set({ deletedAt: new Date() }).where(eq(users.id, removed.id));

    expect(await getUserConsentTrail(removed.id, OPERATOR(operator.id))).toBeNull();
    expect(
      await getUserConsentTrail("00000000-0000-0000-0000-000000000000", OPERATOR(operator.id)),
    ).toBeNull();

    const audits = await db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.action, AUDIT_ACTIONS.CONSENT_HISTORY_VIEWED));
    expect(audits).toHaveLength(0);
  });

  it("filters the change list by consent type and by decision", async () => {
    const user = await createUser();
    await recordConsent(user.id, "TERMS_AND_PRIVACY", { granted: true });
    await recordConsent(user.id, "MARKETING_COMMUNICATIONS", { granted: true });
    await recordConsent(user.id, "MARKETING_COMMUNICATIONS", { granted: false });

    expect(await listConsentChanges()).toHaveLength(3);
    expect(await listConsentChanges({ consentType: "TERMS_AND_PRIVACY" })).toHaveLength(1);
    expect(await listConsentChanges({ granted: false })).toHaveLength(1);
    expect(
      await listConsentChanges({ consentType: "MARKETING_COMMUNICATIONS", granted: true }),
    ).toHaveLength(1);
  });

  it("carries the person's name and email so a row is identifiable without a second query", async () => {
    const user = await createUser({ name: "Ravi", email: "ravi@example.com" });
    await recordConsent(user.id, "MARKETING_COMMUNICATIONS", { granted: true });

    const [change] = await listConsentChanges();
    expect(change).toMatchObject({
      userName: "Ravi",
      userEmail: "ravi@example.com",
      consentType: "MARKETING_COMMUNICATIONS",
      granted: true,
      version: CURRENT_POLICY_VERSION,
    });
  });
});
