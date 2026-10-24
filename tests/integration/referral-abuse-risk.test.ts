/**
 * TC-MKT-015 (QA run 24 Oct 2026): repeated referral abuse raises a risk flag.
 * Trying one's own code was refused but left no trace, so no rule could see
 * it; risk rule REFERRAL_ABUSE counts those tries and the friends' referrals
 * refused at reward time.
 */
import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { db } from "@/server/db";
import { customerReferrals, platformSettings, riskFlags, users } from "@/server/db/schema";
import { applyReferralCode, getOrCreateReferralCode } from "@/server/services/customer-referrals";
import { runRiskRules } from "@/server/services/risk";
import { clearRuleCache, setRule } from "@/server/services/settings";
import { createUser, resetDatabase } from "../helpers/fixtures";

let admin = { id: "", role: "ADMIN" as const };

beforeEach(async () => {
  await resetDatabase();
  await db.delete(platformSettings).where(eq(platformSettings.key, "customerReferrals"));
  await db.delete(platformSettings).where(eq(platformSettings.key, "riskRules"));
  clearRuleCache();
  admin = { id: (await createUser({ role: "ADMIN" })).id, role: "ADMIN" };
  await setRule(
    "customerReferrals",
    { enabled: true, referrerRewardPaise: 5000, refereeRewardPaise: 3000, maxRewardsPerReferrer: 20, applyWithinDays: 30 },
    admin,
  );
});

const flagsOf = (userId: string) =>
  db.query.riskFlags.findMany({ where: and(eq(riskFlags.subjectId, userId), eq(riskFlags.ruleCode, "REFERRAL_ABUSE")) });

describe("REFERRAL_ABUSE", () => {
  it("flags a customer who keeps trying their own code", async () => {
    const me = await createUser();
    const code = await getOrCreateReferralCode(me.id);
    for (let i = 0; i < 2; i += 1) await expect(applyReferralCode(me.id, code)).rejects.toThrow(/own referral code/);
    await runRiskRules(admin);
    expect(await flagsOf(me.id), "2 tries stay under the default of 3").toHaveLength(0);

    await expect(applyReferralCode(me.id, code)).rejects.toThrow(/own referral code/);
    await runRiskRules(admin);
    const [flag] = await flagsOf(me.id);
    expect(flag?.severity).toBe("MEDIUM");
    expect(flag?.status).toBe("OPEN");
  });

  it("counts friends' referrals refused at reward time towards the referrer", async () => {
    const referrer = await createUser();
    await db.update(users).set({ createdAt: new Date(Date.now() - 10 * 86_400_000) }).where(eq(users.id, referrer.id));
    const code = await getOrCreateReferralCode(referrer.id);
    await expect(applyReferralCode(referrer.id, code)).rejects.toThrow(/own referral code/);
    for (let i = 0; i < 2; i += 1) {
      const friend = await createUser();
      await db.insert(customerReferrals).values({ referrerUserId: referrer.id, refereeUserId: friend.id, code, status: "REJECTED", rejectionReason: "Delivered to the referrer's own address." });
    }
    await runRiskRules(admin);
    expect(await flagsOf(referrer.id)).toHaveLength(1);
  });
});
