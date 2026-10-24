/**
 * Notifications that need the local server (TC-NTF-002, 005, 008, 010, 011,
 * 017, 020): e-mail read from the local mail catcher (127.0.0.1:2525 →
 * test-results/qa/mail), security notices after an admin changes a role or
 * suspends an account, duplicate events and long Hindi / Marathi text.
 */
import { as } from "../lib/actors";
import { deliveryCode, fulfil, offerFor, onlyRiderOnline, packOrder, pickupCode, riderAction, sellable, shopOf } from "../lib/flows";
import { call, expectStatus, RUN } from "../lib/http";
import { checkoutNow, fillCart, mailsTo, notificationsOf, placeVia, sleep, waitForNotification } from "../lib/money-helpers";
import { expect, manual, need, qa } from "../lib/record";
import { world } from "../lib/world";

const local = { tier: "local" as const, timeout: 300_000 };

/** Mails to `email` since `since` mentioning `needle`, waiting for them to arrive. */
async function mailsAbout(email: string, needle: string, since: number, waitMs = 15_000) {
  const until = Date.now() + waitMs;
  let hits = mailsTo(email, since).filter((m) => m.text.includes(needle));
  while (!hits.length && Date.now() < until) {
    await sleep(1000);
    hits = mailsTo(email, since).filter((m) => m.text.includes(needle));
  }
  return hits;
}

function subjects(mails: { subject: string }[]) {
  return mails.map((m) => m.subject);
}

qa("TC-NTF-002", "e-mail for order events: placed, accepted, rider assigned, arriving, picked up, delivered, cancelled", async () => {
  const email = need(world().users.customer?.email, "the customer's e-mail");
  await onlyRiderOnline("rider");
  const since = Date.now();
  const listing = await sellable("A", 3);
  const order = await placeVia("customer", "WALLET", listing);
  expectStatus(await fulfil(order.id, "accept"), 200, "accept");
  await packOrder(order.id).catch(async () => {
    await fulfil(order.id, "start");
    await fulfil(order.id, "ready");
  });
  const offer = await offerFor(order.id, "rider");
  if (offer.status === "OFFERED") expectStatus(await riderAction(offer.deliveryOrderId, "accept"), 200, "rider accepts");
  const code = await pickupCode(order.id);
  expectStatus(await riderAction(offer.deliveryOrderId, "pickup", code ? { pickupCode: code } : {}), 200, "pickup");
  expectStatus(await riderAction(offer.deliveryOrderId, "start"), 200, "start");
  await riderAction(offer.deliveryOrderId, "arrived_customer");
  const otp = await deliveryCode(order.id);
  expectStatus(await riderAction(offer.deliveryOrderId, "deliver", { otp }), 200, "deliver");
  const other = await placeVia("customer", "WALLET", listing);
  expectStatus(await fulfil(other.id, "reject", { reason: "QA: cannot fulfil" }), 200, "shop cancels");
  await sleep(4000);
  const mails = await mailsAbout(email, order.orderNumber, since);
  const cancelMails = await mailsAbout(email, other.orderNumber, since);
  const got = subjects(mails);
  const missing: string[] = [];
  for (const [what, re] of [["placed", /placed|confirmed/i], ["accepted", /accepted/i], ["rider assigned", /assigned/i], ["arriving", /arriv/i], ["picked up", /picked up|on its way/i], ["delivered", /delivered/i]] as const) {
    if (!got.some((s) => re.test(s))) missing.push(what);
  }
  if (!subjects(cancelMails).some((s) => /cancel/i.test(s))) missing.push("cancelled");
  expect(missing, `no e-mail for: ${missing.join(", ")} — got [${got.join(" | ")}] and [${subjects(cancelMails).join(" | ")}]`).toEqual([]);
  return `${email}: ${got.join(" | ")} | ${subjects(cancelMails).join(" | ")}`;
}, local);

qa("TC-NTF-005", "with 'Your orders → Email' off no order e-mail is sent, while the in-app notice still arrives", async () => {
  const email = need(world().users.customer?.email, "the customer's e-mail");
  const c = await as("customer");
  expectStatus(await call(c, "PUT", "/api/notifications/preferences", { category: "ORDERS", channel: "EMAIL", enabled: false }), 200, "switch order e-mails off");
  try {
    const since = Date.now();
    const order = await placeVia("customer", "WALLET", await sellable("A", 1));
    expectStatus(await fulfil(order.id, "accept"), 200, "accept");
    const inApp = await waitForNotification("customer", (n) => /accepted/i.test(n.title) && n.body.includes(order.orderNumber), since, 15_000);
    await sleep(5000);
    const mails = mailsTo(email, since).filter((m) => m.text.includes(order.orderNumber));
    expect(inApp, "the in-app notice arrives").toBeTruthy();
    expect(subjects(mails), "no e-mail for the order").toEqual([]);
    await fulfil(order.id, "reject", { reason: "QA clean-up" }).catch(() => undefined);
    return `ORDERS e-mail off → ${order.orderNumber} placed + accepted: in-app "${inApp!.title}", 0 e-mails`;
  } finally {
    await call(c, "PUT", "/api/notifications/preferences", { category: "ORDERS", channel: "EMAIL", enabled: true });
  }
}, local);

qa("TC-NTF-008", "security events always notify: a role change and a suspension / reinstatement each send a security notice (in-app and e-mail)", async () => {
  const target = need(world().users.customer2, "customer 2");
  const id = need(target.id, "customer 2's id");
  const admin = await as("admin");
  const since = Date.now();
  const out: string[] = [];
  // Every switchable category's e-mail off: security notices must still come.
  for (const category of ["ORDERS", "GENERAL", "WALLET"]) await call(await as("customer2"), "PUT", "/api/notifications/preferences", { category, channel: "EMAIL", enabled: false });
  try {
    const grant = await call(admin, "PATCH", `/api/users/${id}/role`, { role: "SOCIETY_ADMIN" });
    expectStatus(grant, 200, "grant a role");
    const revoke = await call(admin, "DELETE", `/api/users/${id}/roles?role=SOCIETY_ADMIN`);
    expectStatus(revoke, 200, "revoke the role");
    const role = await waitForNotification("customer2", (n) => /role/i.test(n.title), since, 15_000);
    out.push(`role change → ${role ? `"${role.title}"` : "no in-app notice"}`);
    const suspend = await call(admin, "POST", `/api/users/${id}/suspend`, { reason: `QA ${RUN} security notice test` });
    expectStatus(suspend, 200, "suspend");
    const reinstate = await call(admin, "POST", `/api/users/${id}/reinstate`, { reason: `QA ${RUN} done` });
    expectStatus(reinstate, 200, "reinstate");
    const status = await waitForNotification("customer2", (n) => /status|suspend|reinstat/i.test(`${n.title} ${n.body}`), since, 15_000);
    out.push(`suspend / reinstate → ${status ? `"${status.title}: ${status.body.slice(0, 60)}"` : "no in-app notice"}`);
    await sleep(3000);
    const mails = subjects(mailsTo(target.email, since));
    out.push(`e-mails: ${mails.join(" | ") || "none"}`);
    expect(role, "role-change notice").toBeTruthy();
    expect(status, "account-status notice").toBeTruthy();
    expect(mails.filter((s) => /role|status|account/i.test(s)).length, "security e-mails despite e-mail switched off elsewhere").toBeGreaterThanOrEqual(2);
    return out.join("; ");
  } finally {
    for (const category of ["ORDERS", "GENERAL", "WALLET"]) await call(await as("customer2"), "PUT", "/api/notifications/preferences", { category, channel: "EMAIL", enabled: true });
  }
}, { ...local, partial: "linking / removing a mobile number needs an SMS code to a handset and is not run" });

qa("TC-NTF-020", "the same event twice gives one notice; a long Hindi / Marathi shop name arrives whole and readable in-app and by e-mail", async () => {
  const email = need(world().users.customer?.email, "the customer's e-mail");
  const shop = await shopOf("A");
  const current = await call(await as("shop"), "GET", `/api/shops/${shop.id}`);
  const oldName = String(current.body?.name ?? current.body?.shop?.name ?? shop.name);
  const hindi = `क्यूए किराणा आणि डेअरी भांडार — गोकेसरी परीक्षण दुकान, कोथरूड पुणे ${RUN}`;
  expectStatus(await call(await as("shop"), "PATCH", `/api/shops/${shop.id}`, { name: hindi }), 200, "rename the shop");
  try {
    const listing = await sellable("A", 1);
    await fillCart("customer", [{ listing }]);
    const since = Date.now();
    const first = await checkoutNow("customer", "WALLET", [shop.id]);
    expectStatus(first.res, 201, "checkout");
    const replay = await checkoutNow("customer", "WALLET", [shop.id], {}, first.requestId);
    expect(replay.res.body?.deduplicated, "the same checkout twice").toBe(true);
    const number = first.res.body.orders[0].orderNumber as string;
    await sleep(3000);
    const notes = (await notificationsOf("customer")).notifications.filter((n) => n.body.includes(number) && new Date(n.createdAt).getTime() >= since - 3000);
    const confirmed = notes.filter((n) => /confirmed|placed/i.test(n.title));
    expect(confirmed.length, "one notice for one event").toBe(1);
    expect(confirmed[0].body, "the full name, not cut or garbled").toContain(hindi);
    const mails = await mailsAbout(email, number, since);
    expect(mails.length, "an e-mail").toBeGreaterThan(0);
    expect(mails.length, "one e-mail for the event").toBe(1);
    expect(mails[0].text, "the e-mail carries the full name readable").toContain(hindi);
    await fulfil(first.res.body.orders[0].id, "reject", { reason: "QA clean-up" }).catch(() => undefined);
    return `checkout + replay → 1 in-app "${confirmed[0].title}" and 1 e-mail; body "${confirmed[0].body.slice(0, 90)}…" keeps the ${hindi.length}-character Hindi/Marathi name intact`;
  } finally {
    await call(await as("shop"), "PATCH", `/api/shops/${shop.id}`, { name: oldName });
  }
}, { ...local, partial: "SMS / WhatsApp copies (cut at 480 characters by design) are not available on this server" });

manual("TC-NTF-010", "failed e-mail delivery, retries and dead letter", "needs SMTP broken for this server only (it shares the local mail catcher with the other local servers) and the 1 / 5 / 30-minute retry waits; on test.gokesari.com only with the owner's agreement — then GET /api/admin/notifications?status=DEAD and requeue", { tier: "local" });
manual("TC-NTF-011", "no SMTP configured: e-mails are skipped, not failed", "needs a server started without AUTH_EMAIL_SERVER (every local server here has the mail catcher); then trigger an order event and check the delivery is SKIPPED in /api/admin/notifications", { tier: "local" });
manual("TC-NTF-017", "a failing provider: retried, dead-lettered, shown failed, never marked sent", "needs one channel provider made to fail (an SMS / WhatsApp vendor in test mode or broken SMTP); the providers here are none (SMS, WhatsApp) and the shared mail catcher", { tier: "local" });

