/**
 * Policy re-consent (open-features CONSENT; docs/policy-reconsent-2026-11).
 */
import { and, eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { db } from "@/server/db";
import { auditLogs, policyAcceptances } from "@/server/db/schema";
import { AUDIT_ACTIONS } from "@/server/services/audit";
import { recordConsent } from "@/server/services/consents";
import { clearFeatureFlagCache } from "@/server/services/feature-flags";
import {
  acceptPolicies,
  getPendingPolicies,
  getPolicyAcceptanceReport,
  getReconsentState,
  listCurrentVersions,
  publishPolicyVersion,
  recordCurrentAcceptances,
} from "@/server/services/policy-versions";
import { createShop, createUser, resetDatabase } from "../helpers/fixtures";

async function setFlag(enabled: boolean) {
  await db.execute(sql`
    INSERT INTO feature_flags (key, enabled) VALUES ('policy_reconsent_enabled', ${enabled})
    ON CONFLICT (key) DO UPDATE SET enabled = EXCLUDED.enabled`);
  clearFeatureFlagCache();
}

async function publish(doc: "terms" | "privacy-policy" | "seller-terms", version: string, requiresAcceptance = true) {
  const admin = await createUser({ role: "ADMIN" });
  return publishPolicyVersion(admin, {
    doc,
    version,
    summary: { en: `What changed in ${version}`, hi: `${version} में बदलाव` },
    requiresAcceptance,
    reason: "test",
  });
}

describe("policy re-consent", () => {
  beforeEach(async () => {
    await resetDatabase();
    // Keep the migration's baseline rows (2026-10-24, minor); drop versions earlier tests published.
    await db.execute(sql`DELETE FROM policy_versions WHERE reason IS DISTINCT FROM 'baseline'`);
    await setFlag(false);
  });

  it("asks nobody with only the baseline versions, even with the flag on", async () => {
    await setFlag(true);
    const user = await createUser();
    expect(await getReconsentState(user.id)).toEqual({ enabled: true, needsReconsent: false, pending: [] });
  });

  it("asks nobody while the flag is off, but still knows what is pending", async () => {
    await publish("terms", "2026-12-01");
    const user = await createUser();
    expect((await getReconsentState(user.id)).needsReconsent).toBe(false);
    expect((await getPendingPolicies(user.id)).map((p) => p.doc)).toEqual(["terms"]);
  });

  it("asks a user who accepted an older version, and records the acceptance with channel and audit", async () => {
    const user = await createUser();
    await recordConsent(user.id, "TERMS_AND_PRIVACY"); // sign-up, before the new version
    await setFlag(true);
    await publish("terms", "2026-12-01");
    await publish("privacy-policy", "2026-12-01");

    const state = await getReconsentState(user.id);
    expect(state.needsReconsent).toBe(true);
    expect(state.pending.map((p) => [p.doc, p.version])).toEqual([
      ["privacy-policy", "2026-12-01"],
      ["terms", "2026-12-01"],
    ]);
    expect(state.pending[0].summary.hi).toBe("2026-12-01 में बदलाव");

    const after = await acceptPolicies(user.id, {
      accept: [
        { doc: "terms", version: "2026-12-01" },
        { doc: "privacy-policy", version: "2026-12-01" },
      ],
      channel: "SHOP_PORTAL",
      ipAddress: "203.0.113.9",
      userAgent: "test-agent",
    });
    expect(after.needsReconsent).toBe(false);

    const rows = await db.select().from(policyAcceptances).where(eq(policyAcceptances.userId, user.id));
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.channel === "SHOP_PORTAL" && r.ipAddress === "203.0.113.9")).toBe(true);

    const audits = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.actorId, user.id), eq(auditLogs.action, AUDIT_ACTIONS.POLICY_ACCEPTED)));
    expect(audits).toHaveLength(2);
  });

  it("counts a sign-up made after the version was published as accepting terms and privacy", async () => {
    await setFlag(true);
    await publish("terms", "2026-12-01");
    const user = await createUser();
    await recordConsent(user.id, "TERMS_AND_PRIVACY");
    expect((await getReconsentState(user.id)).needsReconsent).toBe(false);
  });

  it("does not ask again for a minor version", async () => {
    await setFlag(true);
    const user = await createUser();
    await publish("terms", "2026-12-01");
    await acceptPolicies(user.id, { accept: [{ doc: "terms", version: "2026-12-01" }], channel: "WEB" });
    await publish("terms", "2026-12-05", false);
    expect((await getReconsentState(user.id)).needsReconsent).toBe(false);
    const current = (await listCurrentVersions()).find((c) => c.doc === "terms");
    expect(current?.latest?.version).toBe("2026-12-05");
    expect(current?.required?.version).toBe("2026-12-01");
  });

  it("refuses an acceptance of a version that is no longer the one required", async () => {
    await setFlag(true);
    const user = await createUser();
    await publish("terms", "2026-12-01");
    await publish("terms", "2026-12-10");
    await expect(
      acceptPolicies(user.id, { accept: [{ doc: "terms", version: "2026-12-01" }], channel: "WEB" }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect((await getReconsentState(user.id)).needsReconsent).toBe(true);
  });

  it("asks only shop owners to accept the seller terms; registration records them", async () => {
    await setFlag(true);
    await publish("seller-terms", "2026-12-01");
    const customer = await createUser();
    const owner = await createUser({ role: "SHOP_OWNER" });
    await createShop(owner.id);
    expect((await getReconsentState(customer.id)).needsReconsent).toBe(false);
    expect((await getReconsentState(owner.id)).pending.map((p) => p.doc)).toEqual(["seller-terms"]);

    const newOwner = await createUser({ role: "SHOP_OWNER" });
    await createShop(newOwner.id);
    await recordCurrentAcceptances(newOwner.id, ["seller-terms"], "SHOP_REGISTRATION");
    expect((await getReconsentState(newOwner.id)).needsReconsent).toBe(false);
  });

  it("only lets an administrator publish, forward only, and audits it", async () => {
    const operator = await createUser({ role: "OPERATOR" });
    await expect(
      publishPolicyVersion(operator, { doc: "terms", version: "2026-12-01", summary: { en: "x" }, requiresAcceptance: true, reason: "r" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    const row = await publish("terms", "2026-12-01");
    await expect(publish("terms", "2026-12-01")).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(publish("terms", "2026-11-01")).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(publish("terms", "December")).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    const [audit] = await db.select().from(auditLogs).where(eq(auditLogs.entityId, row.id));
    expect(audit.action).toBe(AUDIT_ACTIONS.POLICY_VERSION_PUBLISHED);
  });

  it("reports acceptance counts per version and who is still to accept", async () => {
    await setFlag(true);
    const a = await createUser();
    const b = await createUser();
    await createUser();
    await publish("terms", "2026-12-01");
    await acceptPolicies(a.id, { accept: [{ doc: "terms", version: "2026-12-01" }], channel: "WEB" });
    await acceptPolicies(b.id, { accept: [{ doc: "terms", version: "2026-12-01" }], channel: "APP" });

    const report = await getPolicyAcceptanceReport();
    const terms = report.find((d) => d.doc === "terms")!;
    // Audience counts every live account, the admin created by publish() included.
    expect(terms.upToDate).toBe(2);
    expect(terms.pending).toBe(terms.audience - 2);
    const v = terms.versions.find((x) => x.version === "2026-12-01")!;
    expect(v.acceptedBy).toBe(2);
    expect(v.byChannel).toEqual({ WEB: 1, APP: 1 });
    expect(report.find((d) => d.doc === "privacy-policy")!.pending).toBe(0);
  });
});
