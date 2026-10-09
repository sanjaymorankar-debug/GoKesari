/**
 * Refunds to bank (docs/four-features-2026-10, O-2): the Wallet Terms and the
 * Refund Policy carry the owner's approved wording (9 Oct 2026) only while
 * rule bankRefunds is on; otherwise they read exactly as before.
 */
import { inArray } from "drizzle-orm";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it } from "vitest";

import RefundPolicyPage from "@/app/legal/refund-policy/page";
import WalletTermsPage from "@/app/legal/wallet-terms/page";
import { db } from "@/server/db";
import { platformSettings } from "@/server/db/schema";
import { clearRuleCache, setRule } from "@/server/services/settings";
import { createUser, resetDatabase } from "../helpers/fixtures";

const text = (html: string) => html.replace(/<[^>]+>/g, "").replace(/\s+/g, " ");
const wallet = async () => text(renderToStaticMarkup(await WalletTermsPage()));
const refund = async () => text(renderToStaticMarkup(await RefundPolicyPage()));

beforeEach(async () => {
  await resetDatabase();
  await db.delete(platformSettings).where(inArray(platformSettings.key, ["bankRefunds"]));
  clearRuleCache();
});

describe("legal pages and refunds to bank", () => {
  it("off (default): the wallet cannot be transferred to a bank; no bank refunds in the Refund Policy", async () => {
    expect(await wallet()).toContain("It cannot be withdrawn as cash or transferred to a bank account, UPI ID, or any external payment method.");
    expect(await refund()).not.toContain("verified bank account");
  });

  it("on: the approved wording, with the rule's own numbers", async () => {
    const admin = await createUser({ role: "ADMIN" });
    await setRule("bankRefunds", { enabled: true }, { id: admin.id, role: "ADMIN" });
    const terms = await wallet();
    expect(terms).toContain(
      "It cannot be withdrawn as cash. Money refunded to your wallet (not promotional credit, not top-ups) can be sent to your own verified bank account within 30 days of the refund; see the Refund Policy.",
    );
    expect(terms).not.toContain("transferred to a bank account, UPI ID");
    expect(await refund()).toContain(
      "Within 30 days of a refund you can ask for it to be sent to your verified bank account instead (My Wallet). It leaves your wallet straight away and reaches your bank within 5 working days; if the transfer fails, it returns to your wallet.",
    );

    await setRule("bankRefunds", { enabled: true, windowDays: 14, expectedWorkingDays: 3 }, { id: admin.id, role: "ADMIN" });
    expect(await wallet()).toContain("within 14 days of the refund");
    expect(await refund()).toContain("Within 14 days of a refund");
    expect(await refund()).toContain("within 3 working days");
  });
});
