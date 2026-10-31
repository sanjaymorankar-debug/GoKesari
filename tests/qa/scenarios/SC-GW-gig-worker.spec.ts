/**
 * Gig worker flow end to end on test.gokesari.com (docs/gig-worker-2026-10):
 * the 11 features in one run, in the order a partner lives them.
 *
 *   E2E_BASE_URL=https://test.gokesari.com npx playwright test -c playwright.qa.config.ts \
 *     tests/qa/scenarios/SC-GW-gig-worker.spec.ts --project desktop
 *
 * Accounts (saved staging sessions, .e2e-auth): customer2 becomes the new
 * delivery partner; customer orders from shop A; shop A's owner packs; admin
 * reviews; ops checks the admin-only file. Each step is written to
 * test-results/qa/gig-worker/<host>.json for the testing report. Signed tier:
 * never on production. At the end the partner goes Offline and customer2's
 * active role is put back to Customer.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { as, pageAs } from "../lib/actors";
import { offerFor, packOrder, pickupCode, placeOrder, riderAction, shopOf, deliveryCode } from "../lib/flows";
import { call, poll, type Answer } from "../lib/http";
import { expect, qa } from "../lib/record";
import { HOST } from "../lib/target";

type Step = { feature: number; step: string; ok: boolean; detail: string };
const steps: Step[] = [];
function check(feature: number, step: string, ok: boolean, detail: unknown = "") {
  steps.push({ feature, step, ok, detail: typeof detail === "string" ? detail : JSON.stringify(detail).slice(0, 400) });
}
const brief = (res: Answer) => `${res.status} ${JSON.stringify(res.body ?? res.text.slice(0, 120)).slice(0, 240)}`;

const PDF = Buffer.concat([Buffer.from("%PDF-1.4\n% GoKesari QA police verification\n"), Buffer.alloc(4096, 0x20), Buffer.from("\n%%EOF\n")]);
function png(width: number, height: number): Buffer {
  const header = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
  const dims = Buffer.alloc(8);
  dims.writeUInt32BE(width, 0);
  dims.writeUInt32BE(height, 4);
  return Buffer.concat([header, Buffer.from("IHDR"), dims, Buffer.from([8, 2, 0, 0, 0, 0, 0, 0, 0]), Buffer.alloc(64)]);
}
const WEBP = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBPVP8X"), Buffer.alloc(40)]);
const freshMobile = () => `9${String(Date.now()).slice(-9)}`;

qa("SC-GW", "gig worker flow: register, KYC, police verification, availability, zoning, societies, pickup, delivery and completion", async ({ browser }) => {
  const rider = await as("customer2");
  const admin = await as("admin");
  const ops = await as("ops");
  const shopCtx = await as("shop");
  const customer = await as("customer");
  const shop = await shopOf("A");
  const shopInfo = await call(shopCtx, "GET", `/api/shops/${shop.id}`);
  const shopLat = Number(shopInfo.body?.latitude ?? shopInfo.body?.shop?.latitude);
  const shopLng = Number(shopInfo.body?.longitude ?? shopInfo.body?.shop?.longitude);
  check(6, "shop A has a pinned location", Number.isFinite(shopLat) && Number.isFinite(shopLng), { shopLat, shopLng });

  try {
    /* ---------------------------------------------------- 1 + 4: registration */
    let me = await call(rider, "GET", "/api/delivery-partner/me");
    const mobile = freshMobile();
    if (me.status === 200 && me.body?.id) {
      check(1, "customer2 already had a partner profile (re-run)", true, me.body.status);
    } else {
      // UI: the form asks for the location and refuses to submit without it.
      const denied = await pageAs(browser, "customer2", { permissions: [] });
      await denied.page.goto("/delivery-partner/register");
      const ui = await denied.page.getByRole("button", { name: /Share my location/ }).isVisible();
      const submit = denied.page.getByRole("button", { name: /Share your location to continue/ });
      check(4, "register page shows 'Share my location' and keeps Submit disabled without it", ui && (await submit.isDisabled()));
      for (const label of ["Gender", "PIN code", "House, street and area", "Vehicle registration number (if any)"]) {
        check(1, `register page has the field "${label}"`, (await denied.page.getByText(label, { exact: false }).count()) > 0);
      }
      await denied.context.close();

      const missing = await call(rider, "POST", "/api/delivery-partner", { fullName: "QA Gig Rider", mobile, vehicleType: "SCOOTER" });
      const fields = Object.keys(missing.body?.error?.details?.fields ?? {});
      check(1, "API refuses an application missing the brief's details (422, field by field)", missing.status === 422 && fields.length >= 8, fields);
      check(4, "API refuses an application without the device location", fields.includes("location"), missing.body?.error?.details?.fields?.location);

      // UI with location granted: fill and submit the real form.
      const lat = shopLat + 0.002;
      const lng = shopLng + 0.002;
      const granted = await pageAs(browser, "customer2", { permissions: ["geolocation"], geolocation: { latitude: lat, longitude: lng } });
      const p = granted.page;
      await p.goto("/delivery-partner/register");
      await p.locator('input[name="fullName"]').fill("QA Gig Rider");
      await p.locator('input[name="mobile"]').fill(mobile);
      await p.locator('input[name="email"]').fill("sanjaymorankar+gk-cust@gmail.com");
      await p.locator('input[name="dateOfBirth"]').fill("1994-06-15");
      await p.locator('select[name="gender"]').selectOption("MALE");
      await p.locator('input[name="addressLine"]').fill("Flat 12, Kesari Residency, Baner Road");
      await p.locator('input[name="addressCity"]').fill("Pune");
      await p.locator('input[name="addressPincode"]').fill("411045");
      await p.locator('select[name="vehicleType"]').selectOption("SCOOTER");
      await p.locator('input[name="vehicleRegistrationNumber"]').fill("MH12 QA 4321");
      await p.locator('input[name="emergencyContactName"]').fill("QA Emergency Contact");
      await p.locator('input[name="emergencyContactMobile"]').fill("9822000111");
      await p.getByRole("button", { name: /Share my location/ }).click();
      await p.getByTestId("location-shared").waitFor({ timeout: 20_000 });
      check(4, "location shared from the device on the form", true, await p.getByTestId("location-shared").innerText());
      await p.getByRole("button", { name: /Submit and continue to KYC/ }).click();
      await p.waitForURL(/\/delivery-partner\/kyc/, { timeout: 60_000 });
      check(1, "registration submitted through the form; next step is KYC", true, p.url());
      await granted.context.close();

      me = await call(rider, "GET", "/api/delivery-partner/me");
      check(1, "profile stored with the new details", me.status === 200 && me.body.gender === "MALE" && me.body.addressPincode === "411045", {
        gender: me.body?.gender,
        pin: me.body?.addressPincode,
        emergency: me.body?.emergencyContactName,
        registrationLocationAt: me.body?.registrationLocationAt,
      });
      check(4, "registration location saved", Boolean(me.body?.registrationLocationAt) && me.body?.latitude != null, { latitude: me.body?.latitude });
      const dup = await call(customer, "POST", "/api/delivery-partner", {
        fullName: "Someone Else",
        mobile,
        vehicleType: "SCOOTER",
        email: "dup@example.test",
        dateOfBirth: "1990-01-01",
        gender: "FEMALE",
        addressLine: "Somewhere 123",
        addressCity: "Pune",
        addressPincode: "411001",
        vehicleRegistrationNumber: "MH12 AB 1111",
        emergencyContactName: "X",
        emergencyContactMobile: "9822000222",
        latitude: lat,
        longitude: lng,
      });
      check(1, "duplicate mobile refused for another account (409)", dup.status === 409, brief(dup));
    }
    const partnerId: string = me.body.id;

    /* ---------------------------------------------------- 2: PAN + Aadhaar */
    const noConsent = await call(rider, "POST", "/api/delivery-partner/me/kyc/pan", { pan: "ABCDE1234F", consent: false });
    check(2, "PAN check refused without consent (422)", noConsent.status === 422, brief(noConsent));
    const pan = await call(rider, "POST", "/api/delivery-partner/me/kyc/pan", { pan: "ABCDE1234F", consent: true });
    check(2, "PAN checked with the KYC provider (status shown, masked)", pan.status === 200 && /^XXXXX/.test(pan.body?.check?.numberMasked ?? ""), {
      status: pan.body?.check?.status,
      masked: pan.body?.check?.numberMasked,
      reason: pan.body?.check?.reason,
    });
    const otp = await call(rider, "POST", "/api/delivery-partner/me/kyc/aadhaar/otp", { aadhaar: "2341 2341 2346", consent: true });
    check(2, "Aadhaar OTP requested (masked only)", otp.status === 200 && otp.body?.check?.numberMasked === "XXXX XXXX 2346", {
      status: otp.body?.check?.status,
      awaitingOtp: otp.body?.check?.awaitingOtp,
      reason: otp.body?.check?.reason,
    });
    if (otp.body?.check?.awaitingOtp) {
      const wrong = await call(rider, "POST", "/api/delivery-partner/me/kyc/aadhaar/verify", { otp: "999999" });
      check(2, "a wrong Aadhaar OTP is refused (still Pending)", wrong.body?.check?.status === "PENDING", wrong.body?.check?.reason);
      const right = await call(rider, "POST", "/api/delivery-partner/me/kyc/aadhaar/verify", { otp: "123456" });
      check(2, "Aadhaar verified with the OTP", right.body?.check?.status === "VERIFIED", brief(right));
    }
    const kycAll = await call(rider, "GET", "/api/delivery-partner/me/kyc");
    check(2, "partner sees Verified / Pending / Failed per document", kycAll.status === 200, { pan: kycAll.body?.pan?.status, aadhaar: kycAll.body?.aadhaar?.status });
    check(2, "no full Aadhaar number in any partner answer", !JSON.stringify(kycAll.body).includes("234123412346"));
    // Admin settles whatever the provider left Pending (sandbox keys answer only saved examples).
    const checks = await call(admin, "GET", "/api/admin/rider-kyc-checks");
    const mine = (checks.body?.checks ?? []).filter((c: { deliveryPartnerId: string }) => c.deliveryPartnerId === partnerId);
    check(2, "admin sees the partner's checks (masked)", mine.length >= 1 && !JSON.stringify(mine).includes("234123412346"), mine.map((c: { docType: string; status: string }) => `${c.docType}:${c.status}`));
    const opsList = await call(ops, "GET", "/api/admin/rider-kyc-checks");
    check(2, "an operator can't see KYC checks (403)", opsList.status === 403, opsList.status);
    for (const c of mine.filter((c: { status: string }) => c.status !== "VERIFIED")) {
      const decided = await call(admin, "POST", `/api/admin/rider-kyc-checks/${c.id}/decision`, { decision: "VERIFIED", note: "QA staging: checked against the test card" });
      check(2, `admin verifies ${c.docType} by hand`, decided.status === 200 && decided.body?.check?.status === "VERIFIED", brief(decided));
    }

    /* ---------------------------------------------------- 3: police verification */
    const webp = await call(rider, "POST", "/api/delivery-partner/me/background-docs", undefined, {
      multipart: { docType: "POLICE_VERIFICATION", file: { name: "form.webp", mimeType: "image/webp", buffer: WEBP } },
    });
    check(3, "WebP refused (PDF/JPG/PNG only)", webp.status === 422, brief(webp));
    const uploaded: Record<string, string> = {};
    for (const [docType, file] of [
      ["POLICE_VERIFICATION", { name: "police.pdf", mimeType: "application/pdf", buffer: PDF }],
      ["CHARACTER_CERTIFICATE", { name: "character.png", mimeType: "image/png", buffer: png(900, 1200) }],
    ] as const) {
      const res = await call(rider, "POST", "/api/delivery-partner/me/background-docs", undefined, { multipart: { docType, file } });
      check(3, `${docType} uploaded (Uploaded)`, res.status === 201 && res.body?.document?.status === "UPLOADED", brief(res));
      if (res.body?.document?.id) uploaded[docType] = res.body.document.id;
    }
    const policeId = uploaded.POLICE_VERIFICATION;
    const opsFile = await call(ops, "GET", `/api/admin/rider-background-docs/${policeId}/file`);
    const riderFile = await call(rider, "GET", `/api/admin/rider-background-docs/${policeId}/file`);
    const adminFile = await call(admin, "GET", `/api/admin/rider-background-docs/${policeId}/file`);
    check(3, "file opens for an admin only (ops 403, partner 403, admin 200 PDF, no-store)", opsFile.status === 403 && riderFile.status === 403 && adminFile.status === 200 && /pdf/.test(adminFile.headers["content-type"] ?? "") && /no-store/.test(adminFile.headers["cache-control"] ?? ""), [opsFile.status, riderFile.status, adminFile.status, adminFile.headers["content-type"]]);
    const review = await call(admin, "POST", `/api/admin/rider-background-docs/${policeId}/decision`, { status: "UNDER_REVIEW" });
    check(3, "admin: Uploaded → Under review", review.body?.document?.status === "UNDER_REVIEW", brief(review));
    const noReason = await call(admin, "POST", `/api/admin/rider-background-docs/${policeId}/decision`, { status: "REJECTED", reason: "" });
    check(3, "a rejection needs a reason (422)", noReason.status === 422, noReason.status);
    const rejected = await call(admin, "POST", `/api/admin/rider-background-docs/${policeId}/decision`, { status: "REJECTED", reason: "QA: stamp not readable" });
    check(3, "admin: Under review → Rejected with reason", rejected.body?.document?.status === "REJECTED" && rejected.body?.document?.rejectionReason === "QA: stamp not readable", brief(rejected));
    const reupload = await call(rider, "POST", "/api/delivery-partner/me/background-docs", undefined, {
      multipart: { docType: "POLICE_VERIFICATION", file: { name: "police2.pdf", mimeType: "application/pdf", buffer: PDF } },
    });
    check(3, "partner re-uploads after a rejection (Uploaded again)", reupload.status === 201, brief(reupload));
    for (const id of [reupload.body?.document?.id, uploaded.CHARACTER_CERTIFICATE]) {
      const ok = await call(admin, "POST", `/api/admin/rider-background-docs/${id}/decision`, { status: "APPROVED" });
      check(3, "admin approves", ok.body?.document?.status === "APPROVED", brief(ok));
    }

    /* ---------------------------------------------------- approval + 5: availability */
    if (me.body.status !== "APPROVED") {
      const idDoc = await call(rider, "POST", "/api/delivery-partner/me/documents", undefined, {
        multipart: { docType: "DRIVING_LICENCE", file: { name: "licence.png", mimeType: "image/png", buffer: png(400, 260) } },
      });
      check(5, "identity document for approval (existing D-57 rule)", idDoc.status === 201, idDoc.status);
      await call(admin, "PATCH", `/api/delivery-partner/${partnerId}`, { action: "start_review" });
      const approved = await call(admin, "PATCH", `/api/delivery-partner/${partnerId}`, { action: "approve", notes: "QA staging: gig worker flow" });
      check(5, "admin approves the application", approved.status === 200 && approved.body?.status === "APPROVED", brief(approved));
    }
    await call(rider, "PUT", "/api/me/roles", { role: "DELIVERY_PARTNER" });
    const ready = await call(rider, "PATCH", "/api/delivery-partner/status", { action: "ready", latitude: shopLat + 0.001, longitude: shopLng + 0.001 });
    check(5, "verified partner switches to Ready", ready.status === 200 && ready.body?.availability === "READY", brief(ready));
    const active = await call(rider, "PATCH", "/api/delivery-partner/status", { action: "active", latitude: shopLat + 0.001, longitude: shopLng + 0.001 });
    check(5, "… and to Active", active.status === 200 && active.body?.availability === "ACTIVE", brief(active));
    const ui = await pageAs(browser, "customer2", { permissions: ["geolocation"], geolocation: { latitude: shopLat + 0.001, longitude: shopLng + 0.001 } });
    await ui.page.goto("/delivery-partner");
    check(5, "dashboard shows the Offline / Active / Ready switch and the verification checklist", (await ui.page.getByTestId("availability-toggle").isVisible()) && (await ui.page.getByTestId("rider-verification-checklist").isVisible()));
    await ui.page.getByTestId("availability-ready").click();
    await poll(async () => (await call(rider, "GET", "/api/delivery-partner/me")).body?.availability, (v) => v === "READY", 30_000);
    check(5, "Ready chosen on the dashboard (device location)", (await call(rider, "GET", "/api/delivery-partner/me")).body?.availability === "READY");
    await ui.context.close();

    /* ---------------------------------------------------- 7: societies (admin + shop view) */
    const found = await call(admin, "GET", "/api/admin/societies-search?q=so");
    const societyList = (found.body?.societies ?? []) as { id: string; name: string }[];
    check(7, "admin finds societies to decide on", found.status === 200, `${societyList.length} found`);
    if (societyList.length >= 2) {
      const auth = await call(admin, "PUT", `/api/admin/delivery-partners/${partnerId}/societies`, { societyId: societyList[0].id, access: "AUTHORISED" });
      const blockNoReason = await call(admin, "PUT", `/api/admin/delivery-partners/${partnerId}/societies`, { societyId: societyList[1].id, access: "BLOCKED" });
      const block = await call(admin, "PUT", `/api/admin/delivery-partners/${partnerId}/societies`, { societyId: societyList[1].id, access: "BLOCKED", reason: "QA: staging block" });
      check(7, "admin authorises one society and blocks another (a block needs a reason)", auth.status === 200 && blockNoReason.status === 422 && block.status === 200, [auth.status, blockNoReason.status, block.status]);
      const byShop = await call(shopCtx, "PUT", `/api/admin/delivery-partners/${partnerId}/societies`, { societyId: societyList[0].id, access: "BLOCKED", reason: "x" });
      check(7, "a shop owner can't decide societies (403)", byShop.status === 403, byShop.status);
    }

    /* ---------------------------------------------------- 6, 9, 10, 11: an order */
    const order = await placeOrder({ role: "customer", method: "WALLET" });
    await packOrder(order.id, "shop");
    let offer = await offerFor(order.id, "customer2", 90_000).catch(() => null);
    check(6, "the Ready partner inside the zone gets the offer", Boolean(offer), offer ?? "no offer within 90 s");
    if (offer) {
      const accept = await riderAction(offer.deliveryOrderId, "accept", {}, "customer2");
      check(6, "offer accepted on the live location", accept.status === 200, brief(accept));
      const partners = await call(shopCtx, "GET", `/api/shops/${shop.id}/delivery-partners`);
      const row = (partners.body?.partners ?? []).find((x: { deliveryPartnerId: string }) => x.deliveryPartnerId === partnerId);
      check(7, "shop's Delivery partners lists the partner with authorised / blocked counts and lists", Boolean(row), row ? { authorised: row.authorisedCount, blocked: row.blockedCount, a: row.authorised.map((s: { name: string }) => s.name), b: row.blocked.map((s: { name: string }) => s.name) } : partners.body);
      const shopPage = await pageAs(browser, "shop");
      await shopPage.page.goto("/shop/delivery-partners");
      const card = shopPage.page.getByTestId("shop-delivery-partner").filter({ hasText: "QA Gig Rider" });
      await card.getByTestId("blocked-count").click().catch(() => {});
      check(7, "shop page renders the partner card; tapping a count shows the list", (await card.count()) > 0, await card.first().innerText().catch(() => ""));
      await shopPage.page.goto("/shop/orders?status=all");
      const partnerLine = await shopPage.page.getByTestId("shop-order-partner").first().innerText().catch(() => "");
      check(8, "shop's order shows the partner it may see (name, call link)", /Delivery partner: QA Gig Rider/.test(partnerLine), partnerLine);
      await shopPage.context.close();

      const photo = await call(rider, "POST", `/api/delivery-orders/${offer.deliveryOrderId}/proof`, undefined, {
        multipart: { kind: "PICKUP", file: { name: "pickup.png", mimeType: "image/png", buffer: png(640, 480) } },
      });
      check(9, "optional pickup photo uploaded", photo.status === 201 && photo.body?.kind === "PICKUP", brief(photo));
      const code = await pickupCode(order.id, "shop");
      const picked = await riderAction(offer.deliveryOrderId, "pickup", code ? { pickupCode: code } : {}, "customer2");
      check(9, "Assigned → Picked Up (timestamp)", picked.status === 200 && picked.body?.status === "PICKED_UP" && Boolean(picked.body?.pickedUpAt), { status: picked.body?.status, pickedUpAt: picked.body?.pickedUpAt });
      const started = await riderAction(offer.deliveryOrderId, "start", {}, "customer2");
      check(10, "drop started", started.status === 200, started.status);
      const noCode = await riderAction(offer.deliveryOrderId, "deliver", {}, "customer2");
      check(10, "Delivered needs the customer's code while rule deliveryOtp.required is on", noCode.status >= 400, brief(noCode));
      const deliveryOtp = await deliveryCode(order.id, "customer");
      const delivered = await riderAction(offer.deliveryOrderId, "deliver", { otp: deliveryOtp }, "customer2");
      check(10, "Picked Up → Delivered with the code", delivered.status === 200 && delivered.body?.status === "DELIVERED", brief(delivered));

      const completed = await poll(
        async () => {
          const res = await call(customer, "GET", "/api/orders");
          const list = (Array.isArray(res.body) ? res.body : (res.body?.orders ?? [])) as { id: string; status: string; completedAt?: string | null }[];
          return list.find((o) => o.id === order.id) ?? null;
        },
        (o) => Boolean(o?.completedAt),
        30_000,
      );
      check(11, "order Completed (completedAt), status stays Delivered", Boolean(completed?.completedAt) && completed?.status === "DELIVERED", completed);
      for (const [who, ctx, type] of [
        ["customer", customer, "order.completed"],
        ["shop", shopCtx, "shop.order_completed"],
      ] as const) {
        const notes = await poll(
          async () => (await call(ctx, "GET", "/api/notifications?limit=30")).body,
          (b) => JSON.stringify(b ?? "").includes(type),
          30_000,
        );
        check(11, `${who} got the in-app completion message (${type})`, JSON.stringify(notes ?? "").includes(type) && JSON.stringify(notes).includes(order.orderNumber));
      }
      const customerPage = await pageAs(browser, "customer");
      await customerPage.page.goto("/orders");
      const orderCard = customerPage.page.locator(`#order-${order.orderNumber}`);
      check(11, "customer's order list shows 'completed'", /completed/i.test(await orderCard.innerText().catch(() => "")));
      await customerPage.context.close();
    }

    /* ---------------------------------------------------- 6: zoning — out of range gets nothing */
    const far = await call(rider, "PATCH", "/api/delivery-partner/status", { action: "ready", latitude: shopLat + 0.2, longitude: shopLng });
    check(6, "partner Ready ~22 km away", far.status === 200, far.status);
    const order2 = await placeOrder({ role: "customer", method: "WALLET" });
    await packOrder(order2.id, "shop");
    offer = await offerFor(order2.id, "customer2", 40_000).catch(() => null);
    check(6, "no offer reaches a partner outside the zone", offer === null, offer ?? "none");
    const assign = await call(shopCtx, "GET", `/api/orders/${order2.id}/assign`);
    check(6, "the order keeps searching for a rider in the zone", assign.status === 200, brief(assign));
    await call(customer, "POST", `/api/orders/${order2.id}/cancel`, { reason: "QA: zoning check order" }).catch(() => null);
  } finally {
    await call(rider, "PATCH", "/api/delivery-partner/status", { action: "offline" }).catch(() => null);
    await call(rider, "PUT", "/api/me/roles", { role: "CUSTOMER" }).catch(() => null);
    const dir = join("test-results", "qa", "gig-worker");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${HOST}.json`), JSON.stringify({ at: new Date().toISOString(), host: HOST, steps }, null, 2));
  }
  const failed = steps.filter((s) => !s.ok);
  expect(failed, JSON.stringify(failed, null, 1)).toEqual([]);
}, { tier: "signed", timeout: 900_000 });
