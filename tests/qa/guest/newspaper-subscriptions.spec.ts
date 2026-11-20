/**
 * Newspaper and periodical subscriptions (docs/newspaper-subscriptions-2026-11)
 * as a guest sees them — production-safe: the title list is public, finding
 * vendors and subscribing refuse a caller without a session (401) before
 * reading the request, and the page sends a guest to sign-in. Only GETs and
 * requests the server must refuse; nothing here creates anything.
 */
import { anonymous, call, expectStatus, pace } from "../lib/http";
import { expect, qa } from "../lib/record";
import { NO_SUCH_ID } from "../lib/routes";

interface Title {
  productId: string;
  name: string;
  kind: "NEWSPAPER" | "MAGAZINE";
  language: string;
  publication: "DAILY" | "WEEKLY" | "FORTNIGHTLY" | "MONTHLY";
  defaultSchedule: { frequency: string; weekdays: number[]; monthDays: number[] };
}

qa("TC-SUB-020", "the newspaper and magazine list is public, newspapers first, each with its default schedule", async () => {
  const guest = await anonymous();
  try {
    const res = await call(guest, "GET", "/api/subscriptions/newspapers");
    expectStatus(res, 200, "GET /api/subscriptions/newspapers");
    const titles = res.body as Title[];
    expect(Array.isArray(titles), "a list of titles").toBe(true);

    const papers = titles.filter((t) => t.kind === "NEWSPAPER");
    const mags = titles.filter((t) => t.kind === "MAGAZINE");
    expect(papers.length, "newspapers listed").toBeGreaterThan(0);
    expect(mags.length, "magazines listed").toBeGreaterThan(0);
    // Newspapers first.
    expect(titles.findIndex((t) => t.kind === "MAGAZINE"), "first magazine comes after every newspaper").toBe(papers.length);
    const languages = new Set(papers.map((t) => t.language));
    for (const language of ["English", "Hindi", "Marathi"]) expect([...languages], `a ${language} daily`).toContain(language);

    // The default schedule follows the publication.
    const bad = titles.filter((t) => {
      const s = t.defaultSchedule;
      switch (t.publication) {
        case "DAILY":
          return s.frequency !== "DAILY";
        case "WEEKLY":
          return s.frequency !== "WEEKLY" || s.weekdays.length !== 1;
        case "FORTNIGHTLY":
          return s.frequency !== "MONTHLY" || s.monthDays.length < 2;
        case "MONTHLY":
          return s.frequency !== "MONTHLY" || s.monthDays.length < 1;
      }
    });
    expect(bad.map((t) => `${t.name}: ${t.publication} → ${JSON.stringify(t.defaultSchedule)}`), "titles whose default schedule does not fit").toEqual([]);
    expect(mags.some((t) => t.publication === "WEEKLY"), "a weekly magazine").toBe(true);
    expect(mags.some((t) => t.publication === "MONTHLY"), "a monthly magazine").toBe(true);
    return `${titles.length} titles (${papers.length} newspapers in ${languages.size} languages, ${mags.length} magazines)`;
  } finally {
    await guest.dispose();
  }
});

qa("TC-SUB-021", "finding vendors and subscribing answer 401 to a caller without a session", async () => {
  const guest = await anonymous();
  const seen: string[] = [];
  try {
    const vendors = await call(guest, "GET", `/api/subscriptions/newspapers/vendors?addressId=${NO_SUCH_ID}&productIds=${NO_SUCH_ID}`);
    await pace();
    const subscribe = await call(guest, "POST", "/api/subscriptions/newspapers", {
      shopId: NO_SUCH_ID,
      addressId: NO_SUCH_ID,
      startDate: "2099-01-01",
      items: [{ shopProductId: NO_SUCH_ID, copies: 1, frequency: "DAILY" }],
    });
    for (const [what, res] of [["GET vendors", vendors], ["POST subscribe", subscribe]] as const) {
      expect(res.status, `${what} answered ${res.status}`).toBe(401);
      expect(res.body?.error?.code, `${what} error code`).toBe("UNAUTHENTICATED");
      seen.push(`${what} → 401`);
    }
  } finally {
    await guest.dispose();
  }
  return seen.join("; ");
});

qa("TC-SUB-022", "a guest opening Newspapers & magazines is sent to sign-in", async ({ page }) => {
  await page.goto("/subscriptions/newspapers");
  await expect(page).toHaveURL(/\/signin\b/);
  await expect(page.getByRole("heading", { name: "Newspapers & magazines" })).toHaveCount(0);
  return `lands on ${new URL(page.url()).pathname}${new URL(page.url()).search}`;
}, { mobile: true });
