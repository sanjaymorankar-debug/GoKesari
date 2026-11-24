/**
 * docs/tax-register/BOOKS.md (0200): a paid payout queues a balanced posting (flag auto_journals);
 * the Accountant turns it into a journal draft or dismisses it.
 */
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { db } from "@/server/db";
import { deliveryPartnerEarnings, finAutoPostings, finJournalEntries, type UserRole } from "@/server/db/schema";
import { dismissPosting, draftFromPosting, listAutoPostings, statutoryLiabilities } from "@/server/rbac-accounting/auto-post";
import { clearFeatureFlagCache, setFeatureFlag } from "@/server/services/feature-flags";
import { decideRiderPayout, prepareRiderPayouts } from "@/server/services/finance";
import { createDeliveryPartner, createUser, resetDatabase } from "../helpers/fixtures";

vi.mock("@/server/email/transport", () => ({ sendEmail: vi.fn(async () => undefined) }));

let admin: { id: string; role: UserRole };
let accountant: { id: string; role: UserRole };

beforeEach(async () => {
  await resetDatabase();
  clearFeatureFlagCache();
  admin = { id: (await createUser({ role: "ADMIN" })).id, role: "ADMIN" };
  accountant = { id: (await createUser({ role: "ACCOUNTANT" })).id, role: "ACCOUNTANT" };
});

async function flag(key: "auto_journals" | "payout_deductions" | "rbac_v2_accounting", on: boolean) {
  await setFeatureFlag(key, { enabled: on, districtCodes: null }, "books (test)", admin as { id: string; role: "ADMIN" });
  clearFeatureFlagCache();
}

function monday(): string {
  const ist = new Date(Date.now() + 330 * 60_000);
  ist.setUTCDate(ist.getUTCDate() - ((ist.getUTCDay() + 6) % 7));
  return ist.toISOString().slice(0, 10);
}

async function paidRiderPayout(totalPaise: number) {
  const user = await createUser({ role: "DELIVERY_PARTNER" });
  const partner = await createDeliveryPartner(user.id, { status: "APPROVED" });
  await db.insert(deliveryPartnerEarnings).values({ deliveryPartnerId: partner.id, returnPickupId: crypto.randomUUID(), basePaise: totalPaise, distancePaise: 0, totalPaise });
  const [p] = (await prepareRiderPayouts(monday(), admin)).filter((x) => x.deliveryPartnerId === partner.id);
  await decideRiderPayout(p.id, "approve", admin);
  await decideRiderPayout(p.id, "process", admin);
  await decideRiderPayout(p.id, "pay", admin, "UTR-TEST-1");
  return p;
}

describe("auto postings", () => {
  it("nothing is queued with the flag off", async () => {
    await paidRiderPayout(100_000);
    expect(await listAutoPostings()).toEqual([]);
  });

  it("a paid rider payout queues gross / TDS / bank; the Accountant drafts a journal from it", async () => {
    await flag("auto_journals", true);
    await flag("payout_deductions", true);
    await flag("rbac_v2_accounting", true);
    const p = await paidRiderPayout(4_000_000); // TDS s.194C without PAN: 20%
    const [posting] = await listAutoPostings("PENDING");
    expect(posting).toMatchObject({ sourceType: "rider_payouts", sourceId: p.id, totalPaise: 4_000_000 });
    expect(posting.lines.map((l) => [l.accountCode, l.debitPaise, l.creditPaise])).toEqual([
      ["2110", 4_000_000, 0],
      ["2321", 0, 800_000],
      ["1100", 0, 3_200_000],
    ]);
    const liabilities = await statutoryLiabilities(posting.entryDate.slice(0, 7));
    expect(liabilities.find((l) => l.accountCode === "2321")).toMatchObject({ postedPaise: 0, pendingPaise: 800_000 });

    const { entryId } = await draftFromPosting(posting.id, accountant);
    const [entry] = await db.select().from(finJournalEntries).where(eq(finJournalEntries.id, entryId));
    expect(entry).toMatchObject({ status: "DRAFT", totalPaise: 4_000_000, preparedBy: accountant.id });
    await expect(draftFromPosting(posting.id, accountant)).rejects.toThrow(/already/);
  });

  it("dismiss needs a reason and only once", async () => {
    await flag("auto_journals", true);
    await paidRiderPayout(100_000);
    const [posting] = await listAutoPostings("PENDING");
    await expect(dismissPosting(posting.id, "no", accountant)).rejects.toThrow(/reason/);
    expect((await dismissPosting(posting.id, "Booked by hand in Tally", accountant)).status).toBe("DISMISSED");
    const [row] = await db.select().from(finAutoPostings).where(eq(finAutoPostings.id, posting.id));
    expect(row.dismissedReason).toBe("Booked by hand in Tally");
  });
});
