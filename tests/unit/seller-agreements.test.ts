/**
 * Seller agreements (docs/seller-agreements-2026-11) — the pure parts: the strict template language, the
 * bundled v1.0 templates and their Marathi / Hindi drafts, the localised data, the generated blocks
 * (Annexure A, licence schedule, signatures), the Annexure fingerprint and the user-agent platform.
 */
import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { canonicalJson, localise, materialFingerprint, percent, rupees, sha256Hex } from "@/server/legal-agreements/data";
import { calendarDate, dateTimeIst, longDate } from "@/server/legal-agreements/i18n";
import { buildPartials } from "@/server/legal-agreements/partials";
import { renderAgreementHtml, renderCertificateHtml } from "@/server/legal-agreements/render";
import { sampleSnapshot } from "@/server/legal-agreements/sample";
import { TemplateSyntaxError, parseTemplate, renderTemplate, templateTokens, unsafeTemplateHtml } from "@/server/legal-agreements/template-engine";

const TEMPLATES = path.join(process.cwd(), "src/server/legal-agreements/templates");
const read = (doc: string, lang: string) => fs.readFileSync(path.join(TEMPLATES, doc, `v1.0.${lang}.html`), "utf8");
const DOCS = ["seller-sla", "medical-onboarding"] as const;
const LANGS = ["en", "mr", "hi"] as const;

describe("template engine", () => {
  it("escapes values, fills conditions and reports missing fields instead of printing them", () => {
    const r = renderTemplate("<p>{{a.b}} {{#if c}}yes{{else}}no{{/if}} {{missing.x}} {{> blk}}</p>", { a: { b: "<b>&" }, c: "" }, { blk: () => "<i>block</i>" });
    expect(r.html).toBe("<p>&lt;b&gt;&amp; no  <i>block</i></p>");
    expect(r.missing).toEqual(["missing.x"]);
    expect(r.html).not.toMatch(/null|undefined/);
  });

  it("refuses unbalanced or unknown tags", () => {
    expect(() => parseTemplate("{{#if a}} open")).toThrow(TemplateSyntaxError);
    expect(() => parseTemplate("{{/if}}")).toThrow(TemplateSyntaxError);
    expect(() => parseTemplate("{{ weird tag }}")).toThrow(TemplateSyntaxError);
  });

  it("reports unknown blocks", () => {
    expect(renderTemplate("{{> nope}}", {}, {}).unknownPartials).toEqual(["nope"]);
  });

  it("flags unsafe template HTML", () => {
    expect(unsafeTemplateHtml("<p>ok</p>")).toEqual([]);
    expect(unsafeTemplateHtml('<script>alert(1)</script>').length).toBeGreaterThan(0);
    expect(unsafeTemplateHtml('<p onclick="x()">a</p>').length).toBeGreaterThan(0);
    expect(unsafeTemplateHtml('<img src="https://evil.example/x.png">').length).toBeGreaterThan(0);
    expect(unsafeTemplateHtml('<a href="javascript:alert(1)">a</a>').length).toBeGreaterThan(0);
  });
});

describe("bundled v1.0 templates", () => {
  for (const doc of DOCS) {
    it(`${doc}: Marathi and Hindi carry exactly the English merge fields and blocks`, () => {
      const en = templateTokens(read(doc, "en"));
      for (const lang of ["mr", "hi"]) {
        const t = templateTokens(read(doc, lang));
        expect(t.fields, lang).toEqual(en.fields);
        expect(t.conditions, lang).toEqual(en.conditions);
        expect(t.partials, lang).toEqual(en.partials);
        const count = (s: string) => (s.match(/\{\{[^}]*\}\}/g) ?? []).length;
        expect(count(read(doc, lang)), lang).toBe(count(read(doc, "en")));
      }
    });

    it(`${doc}: every translation says the English version prevails and is marked pending legal review`, () => {
      for (const lang of ["mr", "hi"]) {
        const body = read(doc, lang);
        expect(body).toContain("In case of any difference between language versions, the English version shall prevail.");
        expect(body).toMatch(/Pending legal review/);
      }
    });

    it(`${doc}: the English master has no blank lines left from the Word document`, () => {
      expect(read(doc, "en")).not.toMatch(/…{2,}|\.{4,}/);
    });

    for (const lang of LANGS) {
      it(`${doc} (${lang}): fills completely from a shop snapshot, with no "null" anywhere`, () => {
        const r = renderAgreementHtml({ templateBody: read(doc, lang), title: doc, version: "1.0", language: lang }, sampleSnapshot(), {
          effectiveAt: new Date("2026-11-26T05:00:00Z"),
          signature: { signed: true, signerName: "Sample Owner Name", designation: "PROPRIETOR", signedAt: new Date("2026-11-26T05:00:00Z"), sealDataUrl: null },
          preview: false,
        });
        expect(r.missing).toEqual([]);
        expect(r.unknownPartials).toEqual([]);
        expect(r.html).not.toMatch(/\bnull\b|\bundefined\b|\{\{/);
        expect(r.html).toContain("Shree Sample Medical &amp; General Stores");
        expect(r.html).toContain("MH-PZ1-123456");
        expect(r.html).toContain("26-Nov-2026, 10.30 IST");
      });
    }
  }

  it("the SLA prints the configured figures, not the Word document's", () => {
    const snap = sampleSnapshot();
    snap.fees.commissionBp = 250;
    snap.fees.settlementDays = 2;
    snap.slaChargesPaise.lateReady = 2000;
    const r = renderAgreementHtml({ templateBody: read("seller-sla", "en"), title: "SLA", version: "1.0", language: "en" }, snap, { effectiveAt: new Date(), signature: { signed: false }, preview: true });
    expect(r.html).toContain("2.5% of the order value");
    expect(r.html).toContain("settled within 2 business days");
    expect(r.html).toContain("<td>₹20</td>");
    expect(r.html).toContain("PREVIEW – not signed");
  });

  it("the medical agreement leaves out optional figures that are not configured", () => {
    const r = renderAgreementHtml({ templateBody: read("medical-onboarding", "en"), title: "Medical", version: "1.0", language: "en" }, sampleSnapshot(), { effectiveAt: new Date(), signature: { signed: false }, preview: true });
    expect(r.html).toContain("As agreed separately");
    expect(r.html).not.toContain("per Order)");
    // Owner, 26-Nov-2026: e-signature and acceptance of terms; no stamp paper or stamp duty.
    expect(r.html).toContain("It is not executed on stamp paper.");
    expect(r.html).not.toMatch(/non-judicial stamp paper|data-legal-review/);
  });
});

describe("agreement data", () => {
  it("formats rupees and percentages the Indian way", () => {
    expect(rupees(100_000)).toBe("₹1,000");
    expect(rupees(25_000_000)).toBe("₹2,50,000");
    expect(rupees(1550)).toBe("₹15.50");
    expect(percent(200)).toBe("2%");
    expect(percent(250)).toBe("2.5%");
  });

  it("dates are IST", () => {
    const at = new Date("2026-11-25T20:00:00Z"); // 26-Nov 01.30 IST
    expect(dateTimeIst(at)).toBe("26-Nov-2026, 01.30 IST");
    expect(longDate(at, "en")).toBe("26 November 2026");
    expect(longDate(at, "mr")).toBe("26 नोव्हेंबर 2026");
    expect(longDate(at, "hi")).toBe("26 नवंबर 2026");
    expect(calendarDate("2029-03-31")).toBe("31-Mar-2029");
  });

  it("canonical JSON is independent of key order", () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: [3, { f: 1, e: 2 }] } })).toBe(canonicalJson({ a: { c: [3, { e: 2, f: 1 }], d: 2 }, b: 1 }));
    expect(sha256Hex("x")).toHaveLength(64);
  });

  it("Annexure A fingerprint: a licence change counts, a review status change does not", () => {
    const base = sampleSnapshot();
    const fp = materialFingerprint(base);
    const approved = sampleSnapshot();
    approved.licences = approved.licences.map((l) => ({ ...l, status: "VERIFIED" as const }));
    expect(materialFingerprint(approved)).toBe(fp);
    const renewed = sampleSnapshot();
    renewed.licences[0] = { ...renewed.licences[0], validUntil: "2034-03-31" };
    expect(materialFingerprint(renewed)).not.toBe(fp);
    const moved = sampleSnapshot();
    moved.seller.addressLine = "Elsewhere, Pune";
    expect(materialFingerprint(moved)).not.toBe(fp);
    const typedName = sampleSnapshot();
    typedName.owner.name = "Name as typed at signing";
    expect(materialFingerprint(typedName)).toBe(fp);
    const newOwner = sampleSnapshot({ ownerUserId: "00000000-0000-4000-8000-000000000099" });
    expect(materialFingerprint(newOwner)).not.toBe(fp);
  });

  it("localises constitution and designation per language", () => {
    const s = sampleSnapshot();
    expect((localise(s, "en", new Date(), { signed: false }).seller as Record<string, unknown>).constitution).toBe("sole proprietorship");
    expect((localise(s, "mr", new Date(), { signed: false }).owner as Record<string, unknown>).designation).toBe("मालक (प्रोप्रायटर)");
  });
});

describe("generated blocks", () => {
  it("the licence schedule lists only what the shop holds, never empty cells", () => {
    const s = sampleSnapshot({ licences: [] });
    const p = buildPartials(s, "en", { signed: false });
    expect(p.licence_schedule({})).toContain("No licence or registration is on file");
    const full = buildPartials(sampleSnapshot(), "hi", { signed: false }).licence_schedule({});
    expect(full).toContain("खुदरा औषधि अनुज्ञप्ति");
    expect(full).not.toMatch(/<td><\/td>|null/);
  });

  it("Annexure A leaves out rows the shop has no data for", () => {
    const s = sampleSnapshot({ ids: { pan: "ABCDE1234F", gstin: null, shopAct: null, udyam: null, fssai: null }, bankLast4: null, pharmacist: null });
    const html = buildPartials(s, "en", { signed: false }).seller_details({});
    expect(html).toContain("ABCDE1234F");
    expect(html).not.toContain("GSTIN");
    expect(html).not.toContain("Bank account");
    expect(html).not.toContain("pharmacist");
  });

  it("the signed signature block says how and when it was signed", () => {
    const at = new Date("2026-11-26T09:05:00Z");
    const html = buildPartials(sampleSnapshot(), "en", { signed: true, signerName: "Sample Owner Name", designation: "PROPRIETOR", signedAt: at, sealDataUrl: null }).signatures({});
    expect(html).toContain("Digitally signed and accepted via OTP");
    expect(html).toContain("26-Nov-2026, 14.35 IST");
    expect(html).toContain("Sonali Sanjay Morankar");
  });

  it("the acceptance certificate lists every language hash and the verify link", () => {
    const html = renderCertificateHtml({
      lang: "en",
      docTitle: "Seller Service Level Agreement",
      version: "1.0",
      snapshot: sampleSnapshot(),
      snapshotSha256: "a".repeat(64),
      signerName: "Sample Owner Name",
      designationLabel: "Proprietor",
      acceptedAt: new Date("2026-11-26T09:05:00Z"),
      ip: "203.0.113.9",
      platform: "android",
      otpRef: "11111111-2222-3333-4444-555555555555",
      mobileMasked: "+91 ******3210",
      signedHashes: { en: "b".repeat(64), mr: "c".repeat(64), hi: "d".repeat(64) },
      verifyUrl: "https://test.gokesari.com/agreements/verify/GKA-ABCDEFGHJK",
      registeredBy: null,
    });
    for (const h of ["b", "c", "d"]) expect(html).toContain(h.repeat(64));
    expect(html).toContain("Android app");
    expect(html).toContain("26-Nov-2026, 14.35 IST");
    expect(html).toContain("GKA-ABCDEFGHJK");
  });
});
