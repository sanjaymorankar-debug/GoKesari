/**
 * Dealership & Franchise Platform phase 5 (docs/dealer-platform/PHASE_5_CUSTOM_FIELDS.md):
 *   - terms with custom fields validate: unknown cf_ variables, a condition on a later field and missing choices
 *     are refused
 *   - an applicant answers the scheme's questions; a wrong choice is refused; submit needs the required answers,
 *     the required file and the eligibility rule; then it goes through and staff see the answers
 *   - commission formulas use the dealer's answers (cf_<key>)
 */
import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { UserRole } from "@/server/db/schema";

const state = vi.hoisted(() => ({
  session: null as null | { user: { id: string; email: string; name: string | null; image: null; role: UserRole; status: "ACTIVE" } },
}));

vi.mock("@/server/auth", () => ({
  auth: async () => state.session,
  handlers: {},
  signIn: async () => {},
  signOut: async () => {},
}));

import { PUT as appPut } from "@/app/api/dealer/application/route";
import { PUT as customPut } from "@/app/api/dealer/application/custom-fields/route";
import { POST as filePost } from "@/app/api/dealer/application/custom-fields/file/route";
import { GET as schemeGet, POST as schemePost } from "@/app/api/dealer/application/scheme/route";
import { POST as submitPost } from "@/app/api/dealer/application/submit/route";
import { componentAmount, ZERO_BASIS } from "@/lib/dealer-scheme-math";
import { customVariables, schemeTermsSchema, type SchemeTerms } from "@/lib/dealer-schemes";
import { DEALER_AGREEMENT_VERSION, type DealerDocType } from "@/lib/dealers";
import { resetRateLimits } from "@/server/api/rate-limit";
import { db } from "@/server/db";
import { dealers } from "@/server/db/schema";
import { reportableAnswers, dealerCustomFilesFor } from "@/server/dealers/custom-fields";
import { blankTerms, createScheme, publishVersion, saveDraft } from "@/server/dealers/scheme-admin";
import { uploadDealerDocument } from "@/server/dealers/service";
import { setFeatureFlag } from "@/server/services/feature-flags";
import { call } from "../helpers/http";
import { createUser, resetDatabase, uniqueMobile } from "../helpers/fixtures";
import { resetSchemes } from "../helpers/schemes";

type U = { id: string; email: string; name: string | null };
let admin: { id: string; role: "ADMIN" };

function signIn(user: U, role: UserRole) {
  state.session = { user: { id: user.id, email: user.email, name: user.name, image: null, role, status: "ACTIVE" } };
}

const PDF = Buffer.from("%PDF-1.4\n% test document\n");

function termsWithFields(): SchemeTerms {
  return {
    ...blankTerms("DEALERSHIP"),
    summary: "Retail Partner: for established shopkeepers.",
    customFields: [
      { key: "years", label: "Years in business", type: "NUMBER", required: true, useIn: { registration: true, eligibility: true, calculation: true, reports: true } },
      { key: "segment", label: "Segment", type: "DROPDOWN", required: true, options: ["Grocery", "Pharmacy"], useIn: { registration: true, eligibility: false, calculation: false, reports: true } },
      { key: "drug_licence", label: "Drug licence", type: "FILE", required: true, showWhen: { field: "segment", equals: "Pharmacy" }, useIn: { registration: true, eligibility: false, calculation: false, reports: true } },
      { key: "bonus_bp", label: "Experience bonus", type: "FORMULA", required: false, formula: "MIN(cf_years * 100, 500)", useIn: { registration: false, eligibility: false, calculation: true, reports: true } },
    ],
    eligibilityRules: [{ formula: "cf_years >= 2", message: "At least 2 years in business." }],
    components: [{ id: "registration", label: "Registration commission", kind: "ONE_TIME", basis: "FORMULA", formula: "PERCENT(shopRegistrationFeePaise, 2000 + cf_bonus_bp)", frequency: "ONCE", shopScope: "OWN", durationMonths: null }],
  };
}

beforeEach(async () => {
  await resetDatabase();
  await db.execute(sql`TRUNCATE TABLE payment_intents CASCADE`);
  await resetSchemes(["FREE"]);
  resetRateLimits();
  state.session = null;
  const a = await createUser({ role: "ADMIN" });
  admin = { id: a.id, role: "ADMIN" };
  await setFeatureFlag("dealer_programme_enabled", { enabled: true, districtCodes: ["MH-PUN"] }, "Pune pilot (test)", admin);
});

describe("custom fields (phase 5)", () => {
  it("refuses terms that use unknown fields or conditions on later fields", () => {
    const t = termsWithFields();
    expect(schemeTermsSchema.safeParse(t).success).toBe(true);
    expect(schemeTermsSchema.safeParse({ ...t, eligibilityRules: [{ formula: "cf_unknown > 1", message: "x x x" }] }).success).toBe(false);
    expect(schemeTermsSchema.safeParse({ ...t, customFields: [{ ...t.customFields[2] }, ...t.customFields] }).success).toBe(false); // showWhen on a later field
    expect(schemeTermsSchema.safeParse({ ...t, customFields: [{ ...t.customFields[1], options: [] }] }).success).toBe(false);
    // Earlier terms without custom fields still parse (defaults).
    const old: Record<string, unknown> = { ...blankTerms("DEALERSHIP") };
    delete old.customFields;
    delete old.eligibilityRules;
    expect(schemeTermsSchema.parse(old)).toMatchObject({ customFields: [], eligibilityRules: [] });
  });

  it("formulas use the dealer's answers", () => {
    const t = schemeTermsSchema.parse(termsWithFields());
    const vars = customVariables(t.customFields, { years: 3, segment: "Grocery" });
    expect(vars).toMatchObject({ cf_years: 3, cf_bonus_bp: 300 });
    expect(componentAmount(t.components[0], { ...ZERO_BASIS, shopRegistrationFeePaise: 100_000 }, vars)).toBe(23_000); // 20% + 3%
  });

  it("asks the questions on the application and checks them on submit", async () => {
    const { scheme, version } = await createScheme(admin, { code: "RETAIL_PARTNER", name: "Retail Partner", category: "DEALERSHIP", reason: "custom fields test" });
    await saveDraft(admin, scheme.id, { versionId: version.id, terms: termsWithFields(), reason: "custom fields test" });
    await publishVersion(admin, version.id, { reason: "custom fields test" });

    const u = await createUser();
    signIn(u, "CUSTOMER");
    const saved = await call(appPut, "/api/dealer/application", {
      method: "PUT",
      body: { legalName: "Shree Sai Medicals", contactName: "Sai Patil", dealerType: "PROPRIETORSHIP", mobile: uniqueMobile(), pan: "ABCPS1234K", gstin: null, addressLine1: "12 Laxmi Road", city: "Pune", pincode: "411030", territories: ["MH-PUN"], bank: { holderName: "Sai Patil", accountNumber: "026291800001191", ifsc: "YESB0000262" } },
    });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    const [dealer] = await db.select().from(dealers).where(eq(dealers.userId, u.id));
    for (const t of saved.body.dealer.requirements.filter((r: { required: boolean }) => r.required).map((r: { docType: DealerDocType }) => r.docType) as DealerDocType[]) await uploadDealerDocument({ id: u.id, role: "CUSTOMER" }, t, { name: `${t}.pdf`, bytes: PDF });
    await db.update(dealers).set({ mobileVerifiedAt: new Date(), mobileVerificationMethod: "OTP" }).where(eq(dealers.id, dealer.id));

    const offer = (await call(schemeGet, "/api/dealer/application/scheme")).body.schemes.find((s: { code: string }) => s.code === "RETAIL_PARTNER");
    expect((await call(schemePost, "/api/dealer/application/scheme", { method: "POST", body: { versionId: offer.versionId } })).status).toBe(200);
    const submit = () => call(submitPost, "/api/dealer/application/submit", { method: "POST", body: { agreementVersion: DEALER_AGREEMENT_VERSION, termsHash: offer.termsHash } });

    expect((await call(customPut, "/api/dealer/application/custom-fields", { method: "PUT", body: { values: { years: 1, segment: "Bakery" } } })).status).toBe(422);
    expect((await call(customPut, "/api/dealer/application/custom-fields", { method: "PUT", body: { values: { years: 1, segment: "Pharmacy" } } })).status).toBe(200);
    let res = await submit();
    expect(res.status).toBe(422);
    expect(res.body.error.message).toMatch(/Upload Drug licence/);

    const form = new FormData();
    form.append("key", "drug_licence");
    form.append("file", new Blob([new Uint8Array(PDF)], { type: "application/pdf" }), "licence.pdf");
    const up = await filePost(new Request("http://x/api/dealer/application/custom-fields/file", { method: "POST", body: form }) as never);
    expect(up.status).toBe(201);
    res = await submit();
    expect(res.status).toBe(422);
    expect(res.body.error.message).toMatch(/At least 2 years in business/);

    await call(customPut, "/api/dealer/application/custom-fields", { method: "PUT", body: { values: { years: 4, segment: "Pharmacy" } } });
    res = await submit();
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    const [after] = await db.select().from(dealers).where(eq(dealers.id, dealer.id));
    const answers = reportableAnswers(schemeTermsSchema.parse(termsWithFields()), after.customValues, await dealerCustomFilesFor(dealer.id));
    expect(answers.map((a) => [a.label, a.value])).toEqual([
      ["Years in business", "4"],
      ["Segment", "Pharmacy"],
      ["Drug licence", "licence.pdf"],
      ["Experience bonus", "400"],
    ]);
  });
});
