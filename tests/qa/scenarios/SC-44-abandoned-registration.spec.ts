/**
 * SC-44 — an abandoned registration: reminders, the dealer notice, a restart
 * (onboarding Phase 2 WP4; owner brief 08-Nov-2026 Flow 2):
 *   the owner registers with a dealer's code and stops at the Address step;
 *   is reminded after 24 h and again after 72 h idle, when the dealer is told;
 *   after 7 days no more reminders go out, and (owner, 25-Nov-2026) /shop/register
 *   resumes the same registration at "Confirm your shop address".
 *
 * Local tier: a fresh owner and a dealer with a code arranged in the local
 * database; the waits are taken by bringing the reminder due
 * (scheduled_notices.due_at) and back-dating the draft's last step; the
 * every-minute cron sends what is due, as on the server.
 */
import { db } from "../lib/db";
import { cron, dealerWithCode, noticesOf, reminderDueNow, reminderOf, startDraft, wizardOf } from "../lib/go-live-helpers";
import { expect, need, qa } from "../lib/record";
import { pageFor } from "../lib/sellers-helpers";

qa("SC-44", "abandoned registration: reminded at 24 h and 72 h, the dealer told at 72 h, no more reminders after that; after 7 days the owner resumes at 'Confirm your shop address'", async ({ browser }) => {
  const dealer = await dealerWithCode("sc44");
  // 1. The owner stops at the Address step.
  const d = await startDraft("sc44", { code: dealer.code });
  const draftId = d.view.id;
  const since = new Date(Date.now() - 2_000);
  const owner = () => noticesOf(d.owner.id, "shop.registration_idle", since);
  const told = () => noticesOf(dealer.user.id, "dealer.registration_idle", since);

  // 2. 24 h: the owner is reminded; the dealer is not told yet.
  await reminderDueNow(draftId);
  await cron("/api/cron/every-minute");
  await expect.poll(async () => (await owner()).length, { message: "the 24 h reminder", timeout: 10_000 }).toBe(1);
  expect((await owner())[0].title).toBe("Your shop is 4 steps from going live");
  expect(await told(), "the dealer is not told at 24 h").toHaveLength(0);

  // 72 h: the second reminder and the dealer notice.
  await reminderDueNow(draftId);
  await cron("/api/cron/every-minute");
  await expect.poll(async () => (await owner()).length, { message: "the 72 h reminder", timeout: 10_000 }).toBe(2);
  await expect.poll(async () => (await told()).length, { message: "the dealer notice", timeout: 10_000 }).toBe(1);
  const [notice] = await told();
  expect(notice.title).toBe("A shop with your code has not finished registering");
  expect(notice.body).toContain(`with your code ${dealer.code} 3 days ago and stopped at "Confirm your shop address"`);

  // 3. 7 days without a step: no reminder beyond the two.
  await db()`update shop_registration_drafts set updated_at = now() - interval '7 days 1 hour' where id = ${draftId}`;
  await db()`update scheduled_notices set sent_at = null, cancelled_at = null, due_at = now() - interval '1 minute' where key = ${`registration-idle:${draftId}`}`;
  need(await reminderOf(draftId), "the reminder row");
  const { context, page } = await pageFor(browser, d.owner);
  try {
    // 4. The owner comes back (owner, 25-Nov-2026): the same registration, where it stopped.
    await page.goto("/shop/register");
    await expect(page.getByRole("heading", { name: "Confirm your shop address" })).toBeVisible();
    await expect(page.getByTestId("registration-progress")).toHaveText("Step 3 of 5");
  } finally {
    await context.close();
  }
  const [old] = await db()<{ status: string }[]>`select status from shop_registration_drafts where id = ${draftId}`;
  expect(old.status).toBe("OPEN");
  expect((await wizardOf(d.ctx))?.id, "the same registration").toBe(draftId);
  return `reminded at 24 h and 72 h ("Your shop is 4 steps from going live"); dealer ${dealer.code} told at 72 h; after 7 days the owner resumes the same registration at "Confirm your shop address"`;
}, { tier: "local", timeout: 300_000, partial: "'no reminders once paid' is proven by TC-ONB-087's check (tests/qa/local/sellers-go-live.spec.ts)" });
