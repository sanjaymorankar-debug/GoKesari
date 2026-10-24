/**
 * Tax invoices after delivery (NEW-007), on the local server with rule
 * `invoicing` switched on for the file (restored by its last check): the
 * GST-registered shop's tax invoice (TC-FIN-028), the unregistered shop's bill
 * of supply (TC-FIN-029), the credit note after a refund (TC-FIN-030), who
 * may open an invoice (TC-FIN-031) and the GST arithmetic and numbering
 * (TC-FIN-032).
 *
 * Local tier: the rule is global, shop A is given a GSTIN for the file (put
 * back at the end) and the products' GST rates are set on fresh listings.
 */
import {
  api,
  asPage,
  checkoutLines,
  deliverOrder,
  freeRider,
  freshListing,
  listingOf,
  orderDetail,
  packOrder,
  paiseIn,
  rid,
  ruleState,
  setRules,
  shopId,
  type Listing,
} from "../lib/finance-helpers";
import { as } from "../lib/actors";
import { db } from "../lib/db";
import { anonymous, call, expectStatus, stash, unstash } from "../lib/http";
import { blocked, expect, need, qa } from "../lib/record";
import { world, type Role } from "../lib/world";

const local = { tier: "local" as const, timeout: 300_000 };
const K = (k: string) => `fin-invoices-${k}`;
const GSTIN = "27AAACQ1234A1Z5";

interface InvoiceRow {
  id: string;
  invoice_number: string;
  sequence: number;
  kind: string;
  supply_type: string;
  total_paise: number;
  taxable_paise: number;
  cgst_paise: number;
  sgst_paise: number;
  igst_paise: number;
  snapshot: {
    lines: { description: string; hsn: string | null; rateBp: number; grossPaise: number; taxablePaise: number; cgstPaise: number; sgstPaise: number; igstPaise: number }[];
    seller: { name: string; gstin: string | null };
    payment: { deliveryFeePaise: number; paidByCustomerPaise: number };
    totals: { totalPaise: number };
  };
}

async function invoiceOf(orderId: string): Promise<InvoiceRow | undefined> {
  const [row] = await db()<InvoiceRow[]>`select id, invoice_number, sequence, kind, supply_type, total_paise::int, taxable_paise::int, cgst_paise::int, sgst_paise::int, igst_paise::int, snapshot
    from tax_invoices where order_id = ${orderId}`;
  return row;
}

/** Places and delivers one order of these lines from shop A or B. */
async function deliveredLines(lines: { listing: Listing; quantity: number }[], shop: Role = "shop") {
  await freeRider("rider");
  const out = await checkoutLines(lines);
  expectStatus(out.res, 201, "checkout");
  const order = out.orders[0];
  await packOrder(order.id, shop);
  await deliverOrder(order.id, { shop });
  return order;
}

/** Inclusive-tax split the invoice must show: taxable = round(gross × 10000 / (10000 + rate)). */
function split(gross: number, rateBp: number) {
  const taxable = rateBp > 0 ? Math.round((gross * 10_000) / (10_000 + rateBp)) : gross;
  const tax = gross - taxable;
  const cgst = Math.floor(tax / 2);
  return { taxable, cgst, sgst: tax - cgst };
}

qa("TC-FIN-028", "tax invoice after delivery from a GST-registered shop: shop name, GSTIN, HSN, GST rate and amount per line, number and date; totals equal the order", async ({ browser }) => {
  // The rule, and shop A as a registered GST supplier, for this file.
  const [shop] = await db()<{ gstin: string | null; gst_status: string }[]>`select gstin, gst_status from shops where id = ${shopId("A")}`;
  if (!unstash(K("shopA"))) stash(K("shopA"), shop);
  if (!unstash(K("ruleSet"))) stash(K("rulePrev"), await ruleState("invoicing"));
  await setRules({ invoicing: { enabled: true, defaultGstRateBp: 0 } }); // put back by the last check of this file
  stash(K("ruleSet"), true);
  await db()`update shops set gstin = ${GSTIN}, gst_status = 'REGISTERED' where id = ${shopId("A")}`;

  const ghee = await freshListing({ name: "QA Ghee 5%", pricePaise: 52_500, gstRateBp: 500, hsn: "0405", stock: 20 });
  const soap = await freshListing({ name: "QA Soap 18%", pricePaise: 11_800, gstRateBp: 1800, hsn: "3401", stock: 20 });
  const order = await deliveredLines([
    { listing: ghee, quantity: 1 },
    { listing: soap, quantity: 2 },
  ]);
  const detail = need(await orderDetail("customer", order.id), "the order");
  const inv = need(await invoiceOf(order.id), "an invoice issued at delivery");
  stash(K("invoiced"), { orderId: order.id, orderNumber: order.orderNumber, invoiceId: inv.id, totalPaise: detail.totalPaise });
  expect(inv.kind).toBe("TAX_INVOICE");
  expect(inv.supply_type, "same-state supply").toBe("INTRA");
  expect(inv.total_paise, "invoice total = the goods of the order").toBe(detail.subtotalPaise);
  expect(inv.snapshot.payment.paidByCustomerPaise, "paid by the customer = the order total").toBe(detail.totalPaise);

  const page = await asPage(browser, "customer", "/orders?tab=past", async (p) => {
    const card = p.getByTestId("order-card").filter({ hasText: order.orderNumber }).first();
    await card.getByRole("link", { name: "Tax invoice" }).click();
    await p.waitForURL(/\/invoices\//);
    const box = p.getByTestId("invoice");
    await expect(box).toBeVisible();
    return box.innerText();
  });
  for (const want of ["Tax invoice", `Invoice no. ${inv.invoice_number}`, "Date:", need(world().shops.A, "shop A").name, `GSTIN ${GSTIN}`, "0405", "3401", "5%", "18%", "CGST", "SGST"]) {
    expect(page, `invoice shows "${want}"`).toContain(want);
  }
  for (const l of inv.snapshot.lines) {
    const s = split(l.grossPaise, l.rateBp);
    expect(paiseIn(page), `${l.description}: CGST ₹${s.cgst / 100}`).toContain(s.cgst);
    expect(paiseIn(page), `${l.description}: SGST ₹${s.sgst / 100}`).toContain(s.sgst);
  }
  const pdf = await call(await as("customer"), "GET", `/api/invoices/${inv.id}/pdf`);
  expect(pdf.status, "PDF download").toBe(200);
  expect(pdf.headers["content-type"]).toContain("application/pdf");
  return `${order.orderNumber}: ${inv.invoice_number} TAX_INVOICE, GSTIN ${GSTIN}, lines 5% (HSN 0405) and 18% (HSN 3401) with CGST/SGST, total ₹${inv.total_paise / 100} = goods; PDF 200`;
}, {
  ...local,
  mobile: false,
  partial:
    "expected 'a separate platform invoice for its own fees' superseded by src/server/services/invoices.ts (header) and rule platformInvoicing: GoKesari's delivery fee is shown under the shop invoice's totals, and GoKesari invoices its fees to the shop per payout cycle, not to the customer",
});

qa("TC-FIN-029", "a shop without a GSTIN issues a bill of supply: no GST lines, no GSTIN invented", async ({ browser }) => {
  if (!unstash(K("ruleSet"))) blocked("needs rule invoicing switched on by TC-FIN-028");
  const [b] = await db()<{ gstin: string | null }[]>`select gstin from shops where id = ${shopId("B")}`;
  if (b.gstin) blocked("shop B has a GSTIN on this site");
  const order = await deliveredLines([{ listing: listingOf("sharedB"), quantity: 1 }], "shopB");
  const inv = need(await invoiceOf(order.id), "a bill of supply issued at delivery");
  expect(inv.kind).toBe("BILL_OF_SUPPLY");
  expect(inv.cgst_paise + inv.sgst_paise + inv.igst_paise, "no tax charged").toBe(0);
  expect(inv.snapshot.seller.gstin, "no GSTIN").toBeNull();
  const text = await asPage(browser, "customer", `/invoices/${inv.id}`, async (p) => p.getByTestId("invoice").innerText());
  expect(text).toContain("Bill of supply");
  expect(text).toContain("Not GST-registered");
  expect(text, "no GSTIN printed").not.toMatch(/GSTIN \d{2}[A-Z0-9]{13}/);
  expect(text).toMatch(/0%/);
  return `${order.orderNumber}: ${inv.invoice_number} BILL_OF_SUPPLY, tax 0, "Not GST-registered", no GSTIN`;
}, local);

qa("TC-FIN-030", "a refund of one line on an invoiced order issues a credit note linked to the invoice; the invoice itself is not edited", async ({ browser }) => {
  const inv0 = unstash<{ orderId: string; orderNumber: string; invoiceId: string }>(K("invoiced")) ?? blocked("needs the invoiced order of TC-FIN-028");
  const before = need(await invoiceOf(inv0.orderId), "the invoice");
  const line = before.snapshot.lines.find((l) => l.rateBp === 1800) ?? before.snapshot.lines[0];
  const refund = await api("admin", "POST", "/api/finance/refunds", { orderNumber: inv0.orderNumber, amountPaise: line.grossPaise, reason: "QA: soap returned", chargeTo: "SHOP", requestId: rid("cn") });
  expectStatus(refund, 201, "refund of one line");
  const notes = await db()<{ id: string; credit_note_number: string; total_paise: number; tax_invoice_id: string }[]>`
    select id, credit_note_number, total_paise::int, tax_invoice_id from credit_notes where order_id = ${inv0.orderId}`;
  expect(notes.length, "one credit note").toBe(1);
  expect(notes[0].tax_invoice_id, "linked to the invoice").toBe(before.id);
  expect(notes[0].total_paise, "credits the refunded amount").toBe(line.grossPaise);
  const after = need(await invoiceOf(inv0.orderId), "the invoice");
  expect(after.total_paise, "invoice total unchanged").toBe(before.total_paise);
  expect(JSON.stringify(after.snapshot), "invoice snapshot unchanged").toBe(JSON.stringify(before.snapshot));
  const text = await asPage(browser, "customer", `/invoices/${before.id}`, async (p) => p.locator("main").first().innerText());
  expect(text, "the invoice page lists the credit note").toContain(notes[0].credit_note_number);
  const pdf = await call(await as("customer"), "GET", `/api/credit-notes/${notes[0].id}/pdf`);
  expect(pdf.status, "credit note PDF").toBe(200);
  return `refund ₹${line.grossPaise / 100} on ${inv0.orderNumber} → credit note ${notes[0].credit_note_number} against ${before.invoice_number}; invoice unchanged; listed on the invoice page; PDF 200`;
}, {
  ...local,
  partial:
    "the refund is the admin's after-delivery refund of one line's value (the return → approve path is in scenarios/SC-10); 'for the refunded line' superseded by src/server/gst/credit-notes.ts: a refund is an amount, spread over the invoice lines in proportion",
});

qa("TC-FIN-031", "an issued invoice opens for the buyer, the selling shop and finance staff only; another customer and another shop get 404, a guest 401", async () => {
  const inv0 = unstash<{ invoiceId: string }>(K("invoiced")) ?? blocked("needs the invoice of TC-FIN-028");
  const bad: string[] = [];
  const want: [Role, number][] = [
    ["customer", 200],
    ["shop", 200],
    ["admin", 200],
    ["ops", 200],
    ["customer2", 404],
    ["shopB", 404],
    ["rider", 404],
  ];
  for (const [role, status] of want) {
    if (!world().users[role]) continue;
    const res = await call(await as(role), "GET", `/api/invoices/${inv0.invoiceId}/pdf`);
    if (res.status !== status) bad.push(`${role} → ${res.status} (expected ${status})`);
    const page = await call(await as(role), "GET", `/invoices/${inv0.invoiceId}`, undefined, { maxRedirects: 0 });
    if ((status === 200) !== (page.status === 200)) bad.push(`${role} /invoices page → ${page.status}`);
  }
  const guest = await anonymous();
  const g = await call(guest, "GET", `/api/invoices/${inv0.invoiceId}/pdf`);
  if (g.status !== 401) bad.push(`guest → ${g.status}`);
  await guest.dispose();
  expect(bad, bad.join("\n")).toEqual([]);
  return "buyer, selling shop, admin, operator → 200; customer 2, shop B owner, rider → 404; guest → 401 (PDF and page)";
}, local);

qa("TC-FIN-032", "GST arithmetic per line to the paisa (0%, 5%, 18%, a loose product), CGST + SGST same-state; numbers sequential per shop with no gaps; a cancelled order has no invoice", async () => {
  if (!unstash(K("ruleSet"))) blocked("needs rule invoicing switched on by TC-FIN-028");
  const zero = await freshListing({ name: "QA Rice 0%", pricePaise: 6_499, gstRateBp: 0, hsn: "1006", stock: 20 });
  const five = await freshListing({ name: "QA Tea 5%", pricePaise: 13_337, gstRateBp: 500, hsn: "0902", stock: 20 });
  const eighteen = await freshListing({ name: "QA Shampoo 18%", pricePaise: 9_901, gstRateBp: 1800, hsn: "3305", stock: 20 });
  const loose = await freshListing({ name: "QA Loose Dal 5%", kind: "LOOSE", unit: "kg", unitSizeMilli: 250, pricePaise: 11_999, gstRateBp: 500, hsn: "0713", stock: 40 });
  const first = await deliveredLines([
    { listing: zero, quantity: 1 },
    { listing: five, quantity: 3 },
    { listing: eighteen, quantity: 1 },
    { listing: loose, quantity: 3 },
  ]);
  const cancelled = await checkoutLines([{ listing: zero, quantity: 1 }]);
  expectStatus(cancelled.res, 201, "an order to cancel");
  expectStatus(await api("customer", "PATCH", `/api/orders/${cancelled.orders[0].id}/status`, { status: "CANCELLED", note: "QA" }), 200, "cancel");
  const second = await deliveredLines([{ listing: five, quantity: 1 }]);
  const third = await deliveredLines([{ listing: eighteen, quantity: 1 }]);

  const inv = need(await invoiceOf(first.id), "the first invoice");
  const bad: string[] = [];
  for (const l of inv.snapshot.lines) {
    const s = split(l.grossPaise, l.rateBp);
    if (l.taxablePaise !== s.taxable || l.cgstPaise !== s.cgst || l.sgstPaise !== s.sgst || l.igstPaise !== 0) {
      bad.push(`${l.description} ₹${l.grossPaise / 100} @${l.rateBp / 100}%: taxable ${l.taxablePaise}/${s.taxable} CGST ${l.cgstPaise}/${s.cgst} SGST ${l.sgstPaise}/${s.sgst}`);
    }
    if (l.taxablePaise + l.cgstPaise + l.sgstPaise !== l.grossPaise) bad.push(`${l.description}: parts do not add up to the line`);
  }
  const looseLine = inv.snapshot.lines.find((l) => l.description.startsWith("QA Loose Dal"));
  if (looseLine?.grossPaise !== Math.round((11_999 * 750) / 1000)) bad.push(`loose 750 g line ₹${(looseLine?.grossPaise ?? 0) / 100}`);
  const sum = inv.snapshot.lines.reduce((s, l) => s + l.grossPaise, 0);
  if (inv.total_paise !== sum) bad.push(`invoice total ${inv.total_paise} ≠ lines ${sum}`);
  const seq: InvoiceRow[] = [];
  for (const o of [first, second, third]) seq.push(need(await invoiceOf(o.id), `invoice of ${o.orderNumber}`));
  const numbers = seq.map((s) => s.sequence);
  for (let i = 1; i < numbers.length; i++) if (numbers[i] !== numbers[i - 1] + 1) bad.push(`sequence ${numbers.join(", ")} has a gap or repeat`);
  if (new Set(seq.map((s) => s.invoice_number)).size !== seq.length) bad.push("an invoice number repeats");
  if (await invoiceOf(cancelled.orders[0].id)) bad.push("the cancelled order has an invoice");
  const askCancelled = await api("customer", "POST", `/api/orders/${cancelled.orders[0].id}/invoice`);
  if (![404, 409].includes(askCancelled.status)) bad.push(`invoice for the cancelled order → ${askCancelled.status}`);
  expect(bad, bad.join("\n")).toEqual([]);
  return `${inv.invoice_number}: ${inv.snapshot.lines.map((l) => `${l.rateBp / 100}% ₹${l.grossPaise / 100} → ${l.taxablePaise}+${l.cgstPaise}+${l.sgstPaise}`).join("; ")}; numbers ${seq.map((s) => s.invoice_number).join(", ")} consecutive; the cancelled order has none (${askCancelled.status})`;
}, local);

qa("TC-FIN-028", "rule invoicing and shop A's GST details are put back", async () => {
  const shop = unstash<{ gstin: string | null; gst_status: string }>(K("shopA"));
  if (shop) await db()`update shops set gstin = ${shop.gstin}, gst_status = ${shop.gst_status} where id = ${shopId("A")}`;
  const prev = unstash<{ key: string; value: Record<string, unknown>; overridden: boolean }>(K("rulePrev"));
  if (unstash(K("ruleSet")) && prev) {
    const res = prev.overridden
      ? await api("admin", "PUT", "/api/admin/settings", { key: "invoicing", value: prev.value })
      : await api("admin", "DELETE", "/api/admin/settings?key=invoicing");
    expectStatus(res, 200, "restore rule invoicing");
  }
  stash(K("ruleSet"), null);
  stash(K("shopA"), null);
  stash(K("rulePrev"), null);
  return `rule invoicing back to ${prev?.overridden ? "its earlier override" : "its default"}; shop A GSTIN ${shop?.gstin ?? "none"} / ${shop?.gst_status ?? "UNKNOWN"}`;
}, local);
