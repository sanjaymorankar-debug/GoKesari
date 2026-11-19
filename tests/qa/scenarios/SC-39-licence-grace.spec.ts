/**
 * SC-39 — a PAN-only shop with a mandatory licence: grace, reminder,
 * suspension (owner brief 08-Nov-2026; DI-12, DI-14, KYC-SBX):
 *   the owner registers with the PAN and the "not GST-registered" declaration,
 *   picks a food shop type and reads the FSSAI 90-day notice, pays and goes
 *   live; gets the grace e-mail and a follow-up reminder; the grace ends and
 *   the follow-up run suspends the shop; admins are told and a customer sees
 *   the shop is not taking orders.
 *
 * Local tier: a fresh owner, the mock KYC provider (PAN), the sandbox fee
 * page, the local mail catcher, and the daily cron with rule
 * shopDocumentFollowUp made to act today (restored after). The grace is
 * shortened as the case says: graceDays 15 and the approval back-dated 16
 * days; today's reminder is moved back to the previous reminder day.
 */
import { db } from "../lib/db";
import {
  addressAndPin,
  createShop,
  displayDate,
  expectLive,
  licenceNotice,
  mailMatching,
  noticesOf,
  payFee,
  runFollowUp,
  shopDetails,
  shopName,
  slugOf,
  startDraft,
  withFollowUpToday,
  MAIL_SUFFIX,
} from "../lib/go-live-helpers";
import { istDate, ruleOf } from "../lib/money-helpers";
import { expect, need, qa } from "../lib/record";
import { pageFor, shopRow } from "../lib/sellers-helpers";
import { world } from "../lib/world";

qa("SC-39", "PAN-only food shop: FSSAI 90-day notice → paid and live → grace e-mail and a reminder → grace over → suspended automatically, admins told, customers see it is not taking orders", async ({ browser }) => {
  const notes: string[] = [];
  // 1. PAN with the declaration and consent.
  const d = await startDraft("sc39", { route: "PAN" });
  expect(d.view.route).toBe("PAN_ONLY");
  const view = await addressAndPin(d);
  const graceDays = view.licenceGraceDays;

  // 2. The food shop type shows the FSSAI notice on the screen.
  const { context, page } = await pageFor(browser, d.owner);
  try {
    await page.goto("/shop/register");
    await expect(page.getByRole("heading", { name: "Contact and shop details" })).toBeVisible();
    await page.getByTestId("shop-type").selectOption("BAKERY");
    await expect(page.getByTestId("licence-grace-notice")).toContainText(licenceNotice("FSSAI licence", graceDays));
  } finally {
    await context.close();
  }
  await shopDetails(d, { name: shopName("Sc39 Bakers"), shopType: "BAKERY" });
  const shop = await createShop(d);
  const since = Date.now() - 2_000;
  await payFee(browser, d.owner, shop.shopId, "pay");
  await expectLive(shop.shopId);
  notes.push(`"${shop.shopName}" (PAN only, BAKERY) live without FSSAI`);

  // 3. The grace e-mail, then a reminder from the follow-up.
  const mail = await mailMatching(d.owner.email, since, /^Upload your licence within/);
  expect(mail?.subject).toBe(`Upload your licence within ${graceDays} days — ${shop.shopName}${MAIL_SUFFIX}`);
  const [grace] = await noticesOf(d.owner.id, "shop.licence_grace_notice", new Date(since), 10_000);
  expect(grace?.body).toContain(`Please upload it on GoKesari by ${displayDate(istDate(graceDays))}.`);
  await withFollowUpToday({}, async () => {
    const at = new Date(Date.now() - 2_000);
    await runFollowUp();
    const [reminder] = await noticesOf(d.owner.id, "shop.documents_follow_up", at, 10_000);
    expect(reminder?.body).toContain("FSSAI licence / registration");
    expect(reminder?.body).toContain("your shop will be suspended automatically. We will remind you every 15 days until then.");
    notes.push(`grace e-mail due ${displayDate(istDate(graceDays))}; "${reminder?.title}"`);
  });

  // 4. The grace ends (15 days, approved 16 days ago; the reminder was on an earlier reminder day).
  await db()`update shops set approved_at = now() - interval '16 days' where id = ${shop.shopId}`;
  await db()`update shop_document_reminders set sent_on = sent_on - 15 where shop_id = ${shop.shopId}`;
  const staffSince = new Date(Date.now() - 2_000);
  await withFollowUpToday({ graceDays: 15 }, () => runFollowUp());
  expect((await shopRow(shop.shopId)).status, "suspended by the run").toBe("SUSPENDED");
  const admin = need(world().users.admin?.id, "the admin account");
  const [told] = (await noticesOf(admin, "support.shop_suspended_documents", staffSince, 10_000)).filter((n) => n.title.includes(shop.shopName));
  expect(told?.title).toBe(`Shop suspended for missing documents: ${shop.shopName}`);

  // 5. A customer opens the shop page.
  const customer = await pageFor(browser, { id: need(world().users.customer?.id, "customer 1"), email: need(world().users.customer?.email, "customer 1's e-mail") });
  try {
    await customer.page.goto(`/shops/${await slugOf(shop.shopId)}`);
    await expect(customer.page.getByTestId("shop-suspended")).toContainText("This shop is suspended and is not taking orders.");
  } finally {
    await customer.context.close();
  }
  notes.push(`suspended after ${(await ruleOf("shopDocumentFollowUp")).value.graceDays}-day grace (15 for the run); admin told; public page says it is not taking orders`);
  return notes.join("; ");
}, { tier: "local", timeout: 600_000, partial: "the 15-day grace and the reminder day are made by the rule change and back-dated rows (the case: 'grace shortened with the developer')" });
