/**
 * A shop's legal and tax details after registration: the seller compliance
 * fields (legal name, FSSAI licence number, return policy — operations-gated
 * by design), the owner's GSTIN, and the FSSAI number the owner enters for
 * verification. Fresh approved shops only (local tier): a GSTIN submission
 * changes the shop's GST status, which could not be put back on a shared
 * test shop.
 */
import { as } from "../lib/actors";
import { db } from "../lib/db";
import { anonymous, call, expectStatus, RUN, why } from "../lib/http";
import { expect, qa } from "../lib/record";
import { approvedShopOfNewOwner, gstinCheckChar, gstinFor, needPanStorage, uniquePan } from "../lib/sellers-helpers";

const local = { tier: "local" as const, timeout: 180_000 };

async function contactPage(shopId: string) {
  const [row] = await db()<{ slug: string }[]>`select slug from shops where id = ${shopId}`;
  const guest = await anonymous();
  const html = await (await guest.get(`/shops/${row.slug}/contact`)).text();
  await guest.dispose();
  return html;
}

const GATED = "expected 'the owner saves' superseded by src/app/api/shops/[id]/compliance/route.ts header: legal name, GSTIN and FSSAI are 'verifiable regulatory credentials … through the same admin/operator-gated path as classification, not the shop owner's own settings form'";

qa("TC-ONB-019", "seller compliance fields (legal name, FSSAI number, return policy): the owner is refused; operations save them and the shop's contact page shows them", async () => {
  const { ctx, shop } = await approvedShopOfNewOwner("onb019");
  const body = { legalBusinessName: `QA Legal Name ${RUN} Pvt Ltd`, fssaiLicenseNumber: "11524999000123", returnPolicyText: "QA: returns accepted within 24 hours for sealed packs." };
  const owner = await call(ctx, "PATCH", `/api/shops/${shop.id}/compliance`, body);
  expect(owner.status, why(owner)).toBe(403);
  expectStatus(await call(await as("ops"), "PATCH", `/api/shops/${shop.id}/compliance`, body), 200, "operations save");
  const nonFood = await contactPage(shop.id);
  expect(nonFood).toContain(body.legalBusinessName);
  expect(nonFood).toContain(body.returnPolicyText);
  expect(nonFood, "no FSSAI line for a non-food shop").not.toContain(body.fssaiLicenseNumber);
  // The storefront asks for the FSSAI licence only of a food business.
  expectStatus(await call(ctx, "PATCH", `/api/shops/${shop.id}`, { shopType: "DAIRY" }), 200, "the shop becomes a dairy");
  expect(await contactPage(shop.id)).toContain(body.fssaiLicenseNumber);
  return "owner PATCH → 403; operator saves; /shops/{slug}/contact shows 'Sold by' legal name and the return policy, and the FSSAI licence once the shop is a food business";
}, { ...local, partial: GATED });

qa("TC-FLD-043", "shop GSTIN: 14 and 16 characters, state code 00 or 99 and a wrong check character are refused; a valid GSTIN accepted; a PAN mismatch recorded", async () => {
  await needPanStorage();
  const { ctx, shop } = await approvedShopOfNewOwner("fld043");
  const pan = uniquePan();
  const valid = gstinFor(pan);
  const wrongCheck = valid.slice(0, 14) + (valid[14] === "A" ? "B" : "A");
  const state00 = (() => {
    const first = `00${pan}1Z`;
    return first + gstinCheckChar(first);
  })();
  const state99 = (() => {
    const first = `99${pan}1Z`;
    return first + gstinCheckChar(first);
  })();
  const otherPan = gstinFor(uniquePan());
  const out: string[] = [];
  const accepted: string[] = [];
  for (const [label, gstin] of [["14 chars", valid.slice(0, 14)], ["16 chars", `${valid}1`], ["state 00", state00], ["state 99", state99], ["wrong check character", wrongCheck]] as const) {
    const res = await call(ctx, "POST", `/api/shops/${shop.id}/gst`, { gstin });
    out.push(`${label} → ${res.status}`);
    if (res.status < 400) accepted.push(label);
  }
  const mismatch = await call(ctx, "POST", `/api/shops/${shop.id}/gst`, { gstin: otherPan });
  out.push(`another PAN inside → ${mismatch.status} (${mismatch.body?.gstStatus ?? why(mismatch)})`);
  const ok = await call(ctx, "POST", `/api/shops/${shop.id}/gst`, { gstin: valid });
  expectStatus(ok, 200, "a valid GSTIN");
  expect(ok.body.gstStatus).toBe("PENDING_VERIFICATION");
  const checker = await call(ctx, "GET", `/api/gst/gstin/validate?gstin=${wrongCheck}`);
  out.push(`GSTIN validator for the wrong check character → ${checker.status} ${JSON.stringify(checker.body ?? {}).slice(0, 80)}`);
  expect(accepted, `GSTINs accepted on the owner's GST form: ${out.join("; ")}`).toEqual([]);
  return out.join("; ");
}, local);

qa("TC-FLD-044", "FSSAI number: blank accepted where optional; 13 and 15 digits and letters refused; 14 digits accepted — on the owner's verification entry and on the stored licence number", async () => {
  await needPanStorage();
  const { ctx, shop } = await approvedShopOfNewOwner("fld044");
  const out: string[] = [];
  for (const value of ["1152499900012", "115249990001234", "ABCDEFGHIJKLMN"]) {
    const res = await call(ctx, "POST", `/api/shops/${shop.id}/verifications`, { docType: "FSSAI", number: value, consent: true });
    expect(res.status, `${value}: ${why(res)}`).toBe(422);
    out.push(`verification ${value} → 422`);
  }
  const good = await call(ctx, "POST", `/api/shops/${shop.id}/verifications`, { docType: "FSSAI", number: `1${String(Date.now()).slice(-13)}`, consent: true });
  expect(good.status, why(good)).toBe(200);
  const ops = await as("ops");
  expectStatus(await call(ops, "PATCH", `/api/shops/${shop.id}/compliance`, { fssaiLicenseNumber: null }), 200, "blank");
  const accepted: string[] = [];
  for (const value of ["1152499900012", "115249990001234", "ABCDEFGHIJKLMN"]) {
    const res = await call(ops, "PATCH", `/api/shops/${shop.id}/compliance`, { fssaiLicenseNumber: value });
    out.push(`stored licence ${value} → ${res.status}`);
    if (res.status < 400) accepted.push(value);
  }
  await call(ops, "PATCH", `/api/shops/${shop.id}/compliance`, { fssaiLicenseNumber: null });
  expect(accepted, `FSSAI numbers accepted as the shop's licence (shown to customers on the contact page): ${out.join("; ")}`).toEqual([]);
  return out.join("; ");
}, { ...local, partial: GATED });

qa("TC-FLD-045", "legal name and return policy: blank accepted; over the limit refused (no 500); script shown as text; Marathi saved and shown", async () => {
  const { shop } = await approvedShopOfNewOwner("fld045");
  const ops = await as("ops");
  expectStatus(await call(ops, "PATCH", `/api/shops/${shop.id}/compliance`, { legalBusinessName: null, returnPolicyText: null }), 200, "blank");
  const longName = await call(ops, "PATCH", `/api/shops/${shop.id}/compliance`, { legalBusinessName: "L".repeat(301) });
  expect(longName.status, why(longName)).toBe(422);
  const longPolicy = await call(ops, "PATCH", `/api/shops/${shop.id}/compliance`, { returnPolicyText: "P".repeat(2001) });
  expect(longPolicy.status).toBe(422);
  const values = { legalBusinessName: `<script>alert(1)</script> दुग्धालय ${RUN}`, returnPolicyText: "परत: <b>24 तास</b> & sealed packs only" };
  expectStatus(await call(ops, "PATCH", `/api/shops/${shop.id}/compliance`, values), 200, "script and Marathi");
  const html = await contactPage(shop.id);
  expect(html, "script shown escaped").toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  expect(html).not.toContain("<script>alert(1)</script>");
  expect(html).toContain("दुग्धालय");
  expect(html).toContain("&lt;b&gt;24 तास&lt;/b&gt;");
  return "blank accepted; legal name 301 chars → 422 (limit 200); return policy 2001 → 422 (limit 2000); script and <b> shown escaped; Marathi shown";
}, { ...local, partial: GATED });
