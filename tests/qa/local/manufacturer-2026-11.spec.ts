/**
 * A manufacturer member's own journeys in the portal (F9.1.2): uploading a
 * catalogue file and following its import (TC-MFR-002), and an API key shown
 * once, used, revoked and then refused (TC-MFR-003).
 *
 * Local tier: there is no manufacturer account on staging. As the admin would
 * (Admin → product master → manufacturers), each check creates a manufacturer
 * account through the admin API and links a new local account to it; the
 * member then works in the browser. Uploads go into the local product master
 * only. Rule pmdSources.manufacturerPortalEnabled is on by default.
 */
import { as } from "../lib/actors";
import { browserWithCookie, localUser } from "../lib/auth-helpers";
import { anonymous, call, expectStatus, RUN } from "../lib/http";
import { expect, qa } from "../lib/record";
import { gtin13, wrongCheckDigit } from "../lib/regression-2026-11-helpers";

const local = { tier: "local" as const, timeout: 300_000 };
const KEY_REFUSED = "A valid manufacturer API key is required (Authorization: Bearer <key>).";

/** A manufacturer account with one brand and a new local account linked to it as its owner. */
async function manufacturerMember(label: string) {
  const member = await localUser(`mfr-${label}`);
  const admin = await as("admin");
  const name = `QA Manufacturer ${RUN} ${label}`;
  const brand = `QA Brand ${RUN} ${label}`;
  const account = await call(admin, "POST", "/api/pmd/manufacturers", { name, brandNames: [brand] });
  expectStatus(account, 201, "create a manufacturer account");
  const linked = await call(admin, "POST", `/api/pmd/manufacturers/${account.body.id}/members`, { email: member.email, role: "OWNER" });
  expectStatus(linked, 201, "link the member");
  return { member, accountId: String(account.body.id), name, brand };
}

qa("TC-MFR-002", "a manufacturer uploads a catalogue file and follows the job: status, rows, staged, need attention, the validation report and the error file", async ({ browser }) => {
  const { member, name, brand } = await manufacturerMember("upload");
  const good = gtin13();
  const bad = wrongCheckDigit(gtin13());
  const fileName = `qa-catalogue-${RUN}.csv`;
  const csv = `GTIN,Product Name,Brand,MRP,Pack Size\r\n${good},QA Mfr Butter ${RUN} 100 g,${brand},62.00,100 g\r\n${bad},QA Mfr Bad GTIN ${RUN},${brand},10.00,1 pc\r\n`;
  const { context, page } = await browserWithCookie(browser, member.cookie);
  try {
    await page.goto("/manufacturer");
    await expect(page.locator('[data-tile-board="manufacturer"]'), "the member's Tile Board").toBeVisible();
    await expect(page.getByText(name).first()).toBeVisible();

    await page.goto("/manufacturer/upload");
    await expect(page.getByRole("heading", { name: "Upload your catalogue" })).toBeVisible();
    await page.locator('input[name="file"]').setInputFiles({ name: fileName, mimeType: "text/csv", buffer: Buffer.from(csv, "utf8") });
    await page.getByRole("button", { name: "Upload" }).click();
    await page.waitForURL(/\/manufacturer\/jobs\/[0-9a-f-]{36}$/, { timeout: 60_000 });
    const jobId = new URL(page.url()).pathname.split("/").pop()!;

    await expect(page.getByRole("heading", { name: "Import progress" })).toBeVisible();
    const progress = page.getByTestId("job-progress");
    await expect(progress).toContainText(fileName);
    await expect(progress.getByText(/^(QUEUED|RUNNING|SUCCEEDED|PARTIAL)$/), "the job's status").toBeVisible();
    await expect(progress.getByRole("progressbar")).toBeVisible();
    await expect(progress).toContainText(/Rows\s*2/);
    await expect(progress).toContainText(/Need attention\s*1/);
    await expect(progress.getByText("GTIN_CHECK_DIGIT: 1"), "the validation report").toBeVisible();
    const errorLink = progress.getByRole("link", { name: "Download error file (CSV)" });
    await expect(errorLink).toHaveAttribute("href", `/api/pmd/jobs/${jobId}/errors`);
    const errors = await call(member.ctx, "GET", `/api/pmd/jobs/${jobId}/errors`);
    expectStatus(errors, 200, "the error file");
    expect(errors.headers["content-type"]).toMatch(/text\/csv/);
    expect(errors.text, "the refused row with its reason").toContain(bad);
    expect(errors.text).toContain("wrong check digit");
    expect(errors.text, "the good row is not in the error file").not.toContain(good);
    const status = (await progress.getByText(/^(QUEUED|RUNNING|SUCCEEDED|PARTIAL)$/).innerText()).trim();

    await page.goto("/manufacturer/jobs");
    await expect(page.getByRole("heading", { name: "My imports" })).toBeVisible();
    const listed = page.getByRole("link").filter({ hasText: fileName });
    await expect(listed).toBeVisible();
    await expect(listed).toContainText(/\d+\/2 staged · 1 need attention/);
    await expect(listed).toContainText(/(QUEUED|RUNNING|SUCCEEDED|PARTIAL) \d+%/);
    await listed.click();
    await page.waitForURL((url) => url.pathname === `/manufacturer/jobs/${jobId}`);

    const api = await call(member.ctx, "GET", "/api/pmd/manufacturer/uploads");
    expectStatus(api, 200, "the member's imports");
    const job = (api.body.jobs as { id: string; totalRows: number; invalidRows: number }[]).find((j) => j.id === jobId);
    expect(job?.totalRows).toBe(2);
    expect(job?.invalidRows).toBe(1);
    return `${fileName} (1 good, 1 bad GTIN) → /manufacturer/jobs/${jobId.slice(0, 8)}…: ${status}, Rows 2, Need attention 1, "GTIN_CHECK_DIGIT: 1", error CSV names ${bad} "wrong check digit"; listed on My imports`;
  } finally {
    await context.close();
    await member.ctx.dispose();
  }
}, local);

qa("TC-MFR-003", "a manufacturer creates an API key (shown once), it works for the bulk upload API, and after Revoke it is refused", async ({ browser }) => {
  const { member, brand } = await manufacturerMember("keys");
  const { context, page } = await browserWithCookie(browser, member.cookie);
  const outside = await anonymous();
  try {
    await page.goto("/manufacturer/keys");
    await expect(page.getByRole("heading", { name: "API keys" })).toBeVisible();
    await page.getByPlaceholder("Label (e.g. ERP export)").fill(`QA ERP ${RUN}`);
    await page.getByRole("button", { name: "New API key" }).click();
    await expect(page.getByText("Copy this key now — it is shown only once")).toBeVisible();
    const key = (await page.getByTestId("new-api-key").innerText()).trim();
    expect(key, "the key").toMatch(/^gkm_[A-Za-z0-9_-]{20,}$/);
    const prefix = key.slice(0, 10);
    await expect(page.getByText(`${prefix}…`)).toBeVisible();
    await page.reload();
    await expect(page.getByTestId("new-api-key"), "never shown again").toHaveCount(0);
    await expect(page.getByText(`${prefix}…`), "only its prefix is listed").toBeVisible();
    await expect(page.locator("body")).not.toContainText(key);

    const auth = { authorization: `Bearer ${key}` };
    const product = { GTIN: gtin13(), "Product Name": `QA Mfr API ${RUN}`, Brand: brand };
    const used = await call(outside, "POST", "/api/pmd/v1/manufacturer/products", { products: [product] }, { headers: auth });
    expectStatus(used, 202, "the bulk upload API with the new key");
    const jobId = String(used.body.job.id);
    expectStatus(await call(outside, "GET", `/api/pmd/v1/manufacturer/jobs/${jobId}`, undefined, { headers: auth }), 200, "the job by the key");

    await page.reload();
    await page.getByRole("button", { name: "Revoke" }).click();
    await expect(page.getByText("Revoked", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Revoke" })).toHaveCount(0);

    const refused = await call(outside, "POST", "/api/pmd/v1/manufacturer/products", { products: [{ ...product, GTIN: gtin13() }] }, { headers: auth });
    expect(refused.status, "the revoked key").toBe(401);
    expect(refused.body?.error?.message).toBe(KEY_REFUSED);
    const read = await call(outside, "GET", `/api/pmd/v1/manufacturer/jobs/${jobId}`, undefined, { headers: auth });
    expect(read.status, "reading a job with the revoked key").toBe(401);
    return `key ${prefix}… shown once ("Copy this key now — it is shown only once"), only the prefix after a reload; POST /api/pmd/v1/manufacturer/products → 202 (job ${jobId.slice(0, 8)}…); Revoke → "Revoked"; then → 401 "${KEY_REFUSED}"`;
  } finally {
    await context.close();
    await outside.dispose();
    await member.ctx.dispose();
  }
}, local);
