/**
 * Growth journeys.
 *   SC-17 — a marketing campaign with consent: of two customers of shop A
 *           only the one who agreed to offers is messaged; their order after
 *           opening it is counted as a conversion; after they withdraw
 *           consent the next campaign does not reach them.
 *   SC-35 — customer referral: a friend who joins with customer 1's code
 *           and has a first order delivered rewards both once; customer 1's
 *           own second account (same home, same phone) earns nothing and
 *           raises a risk flag.
 *
 * Local tier: the customers are new local accounts; rule `marketing`'s
 * weekly allowances are raised (so only consent decides who is messaged)
 * and rule `customerReferrals` is switched on, both restored afterwards.
 */
import type { APIRequestContext } from "@playwright/test";

import {
  api,
  deliverToPerson,
  freeRider,
  freshListing,
  freshPerson,
  packOrder,
  personBuys,
  shopId,
  withRules,
  type Person,
} from "../lib/finance-helpers";
import { db } from "../lib/db";
import { call, expectStatus, RUN } from "../lib/http";
import { expect, need, qa } from "../lib/record";

const local = { tier: "local" as const, timeout: 480_000 };

async function inbox(ctx: APIRequestContext, title: string) {
  const res = await call(ctx, "GET", "/api/notifications");
  expectStatus(res, 200, "notifications");
  return (res.body.notifications as { id: string; title: string }[]).filter((n) => n.title.endsWith(`: ${title}`));
}

async function campaign(id: string) {
  const res = await api("shop", "GET", `/api/shops/${shopId("A")}/marketing/campaigns`);
  return need((res.body as { id: string; status: string; sentCount: number; stats: { opened: number; converted: number; revenuePaise: number } }[]).find((c) => c.id === id), `campaign ${id}`);
}

/** Shop A builds a segment of recent customers and a campaign, submits it; operations approve; the shop sends it. */
async function sendCampaign(title: string) {
  const a = shopId("A");
  const seg = await api("shop", "POST", `/api/shops/${a}/marketing/segments`, { name: `QA SC-17 ${title}`, rules: { orderedWithinDays: 1 } });
  expectStatus(seg, 201, "segment");
  const draft = await api("shop", "POST", `/api/shops/${a}/marketing/campaigns`, { segmentId: seg.body.id, title, message: `QA ${RUN}: fresh paneer and curd at the shop this week.`, maxRecipients: 500 });
  expectStatus(draft, 201, "draft");
  const id = draft.body.id as string;
  expectStatus(await api("shop", "PATCH", `/api/shops/${a}/marketing/campaigns/${id}`, { action: "submit" }), 200, "submit");
  expectStatus(await api("ops", "POST", `/api/admin/campaigns/${id}/decision`, { decision: "approve" }), 200, "operations approve");
  expectStatus(await api("shop", "PATCH", `/api/shops/${a}/marketing/campaigns/${id}`, { action: "send" }), 200, "send");
  return id;
}

/** A first order from shop A, cancelled again (the person is then a recent customer of the shop). */
async function orderedOnce(p: Person, listing: Awaited<ReturnType<typeof freshListing>>) {
  const { res, order } = await personBuys(p, listing, 1);
  expectStatus(res, 201, "an order from shop A");
  expectStatus(await call(p.ctx, "PATCH", `/api/orders/${order!.id}/status`, { status: "CANCELLED", note: "QA marketing audience" }), 200, "cancel");
}

/* ------------------------------------------------------------------ SC-17 */

qa("SC-17", "marketing campaign with consent: only the consenting customer is messaged, their order after opening it is a conversion, and nothing reaches them after they withdraw consent", async () => {
  return withRules({ marketing: { shopCampaignsPerWeek: 50, perShopPerCustomerPerWeek: 20, totalPerCustomerPerWeek: 50 } }, async () => {
    const listing = await freshListing({ name: "QA Campaign Curd", pricePaise: 4000, stock: 50 });
    const yes = await freshPerson("sc17-yes", { walletPaise: 100_000, address: true });
    const no = await freshPerson("sc17-no", { walletPaise: 100_000, address: true });
    try {
      // 1. Both order from the shop; one agrees to offers.
      await orderedOnce(yes, listing);
      await orderedOnce(no, listing);
      expectStatus(await call(yes.ctx, "PUT", "/api/consents/marketing", { granted: true }), 200, "grant marketing consent");
      // 2.–3. Segment and campaign, approved and sent.
      const title = `QA SC-17 week ${RUN}`;
      const first = await sendCampaign(title);
      const gotYes = await inbox(yes.ctx, title);
      const gotNo = await inbox(no.ctx, title);
      const bad: string[] = [];
      if (gotYes.length !== 1) bad.push(`the consenting customer got ${gotYes.length} messages`);
      if (gotNo.length !== 0) bad.push(`the customer without consent got ${gotNo.length} messages`);
      // 4. The consenting customer opens it and orders.
      if (gotYes[0]) expectStatus(await call(yes.ctx, "PATCH", "/api/notifications", { id: gotYes[0].id }), 200, "open the message");
      const { res, order } = await personBuys(yes, listing, 2);
      expectStatus(res, 201, "order after the campaign");
      const stats = (await campaign(first)).stats;
      if (stats.opened < 1 || stats.converted < 1 || stats.revenuePaise < order!.totalPaise) bad.push(`campaign figures opened ${stats.opened}, converted ${stats.converted}, revenue ${stats.revenuePaise} (order ${order!.totalPaise})`);
      expectStatus(await call(yes.ctx, "PATCH", `/api/orders/${order!.id}/status`, { status: "CANCELLED", note: "QA cleanup" }), 200, "cancel");
      // 5. Consent withdrawn; the next campaign does not reach them.
      expectStatus(await call(yes.ctx, "PUT", "/api/consents/marketing", { granted: false }), 200, "withdraw consent");
      const title2 = `QA SC-17 after ${RUN}`;
      const second = await sendCampaign(title2);
      const after = [...(await inbox(yes.ctx, title2)), ...(await inbox(no.ctx, title2))];
      if (after.length !== 0) bad.push(`${after.length} messages after the withdrawal`);
      const recipients = (await db()<{ user_id: string }[]>`select user_id from campaign_recipients where campaign_id = ${second}`).map((r) => r.user_id);
      if (recipients.includes(yes.id) || recipients.includes(no.id)) bad.push("a recipient row for a customer without consent");
      expect(bad, bad.join("\n")).toEqual([]);
      return `campaign 1 (sent to ${(await campaign(first)).sentCount}): consenting customer 1 message, the other none; opened ${stats.opened} → converted ${stats.converted}, revenue ₹${stats.revenuePaise / 100}; after withdrawal campaign 2 reached neither (sent to ${(await campaign(second)).sentCount} others)`;
    } finally {
      await yes.ctx.dispose();
      await no.ctx.dispose();
    }
  });
}, local);

/* ------------------------------------------------------------------ SC-35 */

const REFERRALS = { enabled: true, referrerRewardPaise: 5000, refereeRewardPaise: 5000, maxRewardsPerReferrer: 20, applyWithinDays: 30 };
const REFERRER_TEXT = "Referral reward — your friend's first order was delivered";
const REFEREE_TEXT = "Welcome reward — referred by a friend";

async function credits(userId: string) {
  return db()<{ amount: number; description: string }[]>`select amount_paise::int as amount, description from wallet_transactions where user_id = ${userId} and type = 'PROMOTIONAL_CREDIT'`;
}

qa("SC-35", "customer referral: a friend's first delivered order rewards both once; customer 1's own second account (same home, same phone) earns nothing and raises a risk flag", async () => {
  return withRules({ customerReferrals: REFERRALS }, async () => {
    await freeRider("rider");
    const listing = await freshListing({ name: "QA Referral Rusk", pricePaise: 6000, stock: 20 });
    const one = await freshPerson("sc35-one", { walletPaise: 100_000, address: true });
    const friend = await freshPerson("sc35-friend", { walletPaise: 100_000, address: true });
    const own = await freshPerson("sc35-own", { walletPaise: 100_000 });
    try {
      // 1. Customer 1's code.
      const mine = await call(one.ctx, "GET", "/api/customer-referrals");
      expectStatus(mine, 200, "customer 1's referral page");
      const code = need(mine.body.code as string | undefined, "customer 1's referral code");
      // 2. The friend joins with it (the sign-up form's referral field) and has a first order delivered.
      expectStatus(await call(friend.ctx, "POST", "/api/me/signup-referral", { code }), [200, 201], "the friend enters the code at sign-up");
      const bad: string[] = [];
      if ((await credits(one.id)).length) bad.push("rewarded before any delivery");
      const { res, order } = await personBuys(friend, listing, 1);
      expectStatus(res, 201, "the friend's first order");
      await packOrder(order!.id);
      await deliverToPerson(order!.id, order!.orderNumber, friend);
      const r1 = await credits(one.id);
      const r2 = await credits(friend.id);
      if (r1.filter((c) => c.description === REFERRER_TEXT).map((c) => c.amount).join() !== "5000") bad.push(`customer 1's reward: ${JSON.stringify(r1)}`);
      if (r2.filter((c) => c.description === REFEREE_TEXT).map((c) => c.amount).join() !== "5000") bad.push(`the friend's reward: ${JSON.stringify(r2)}`);
      // 3. Customer 1's own second account: the same home address; the same mobile is refused for a second account.
      const [home] = await db()<{ line1: string; latitude: string; longitude: string; pincode: string }[]>`select line1, latitude, longitude, pincode from addresses where id = ${one.addressId}`;
      const [addr] = await db()<{ id: string }[]>`
        insert into addresses (user_id, line1, area, city, state, pincode, latitude, longitude, address_type, recipient_name, is_default, location_verified, location_verified_at, location_source)
        values (${own.id}, ${home.line1}, 'Kothrud', 'Pune', 'Maharashtra', ${home.pincode}, ${home.latitude}, ${home.longitude}, 'HOME', 'QA Own', true, true, now(), 'MANUAL_ENTRY') returning id`;
      own.addressId = addr.id;
      const samePhone = await db()`update users set phone = ${one.mobile}, phone_e164 = ${`+91${one.mobile}`} where id = ${own.id}`.then(() => "accepted", () => "refused (one account per mobile)");
      expectStatus(await call(own.ctx, "POST", "/api/me/signup-referral", { code }), [200, 201], "the second account enters customer 1's code");
      const second = await personBuys(own, listing, 1);
      expectStatus(second.res, 201, "the second account's first order");
      await packOrder(second.order!.id);
      await deliverToPerson(second.order!.id, second.order!.orderNumber, own);
      const [ref] = await db()<{ status: string; rejection_reason: string | null }[]>`select status, rejection_reason from customer_referrals where referee_user_id = ${own.id}`;
      const extra = (await credits(one.id)).length - 1 + (await credits(own.id)).length;
      if (extra !== 0) bad.push(`the self-referral earned ${extra} reward(s) (referral ${ref?.status} ${ref?.rejection_reason ?? ""})`);
      expectStatus(await api("ops", "POST", "/api/admin/risk", {}), [200, 201], "run the risk rules");
      const flags = await db()<{ rule_code: string; subject_id: string }[]>`select rule_code, subject_id from risk_flags where subject_id = any(${[one.id, own.id]}) and status = 'OPEN'`;
      if (flags.length === 0) bad.push("no risk flag for customer 1 or the second account (src/server/services/risk.ts has no referral rule; SHARED_PHONE needs two accounts on one mobile, which the database does not allow)");
      expect(bad, bad.join("\n")).toEqual([]);
      return `code ${code}; friend's ${order!.orderNumber} delivered → ₹50 each, once; own second account: same mobile ${samePhone}, same home → referral ${ref?.status} "${ref?.rejection_reason}", no reward; flags ${flags.map((f) => f.rule_code).join(", ")}`;
    } finally {
      for (const p of [one, friend, own]) await p.ctx.dispose();
    }
  });
}, local);
