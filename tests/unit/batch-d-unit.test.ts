/** batch-2026-10 WS-D — pure pieces: template validation, source mappings, object store keys / signing, board menus. */
import { describe, expect, it, vi } from "vitest";

import { MANUFACTURER_MENUS, OPERATOR_LIMITED_MENUS, PRODUCT_BROWSER_MENUS } from "@/lib/board/batch-d-menus";
import { boardRoleFor, visibleMenus } from "@/lib/board/menus";
import { GS1_MOCK_RECORDS, gs1RecordToStaged } from "@/server/pmd/data-sources/gs1-datakart";
import { missingRequiredHeadings, toTemplateRow, validateTemplateRow } from "@/server/pmd/data-sources/manufacturer";
import { apiProductToRow } from "@/server/pmd/data-sources/open-food-facts";
import { analyzeGtin, gs1CheckDigit } from "@/server/pmd/normalize/identifiers";
import { newObjectKey, S3ObjectStore, s3ConfigFromEnv } from "@/server/pmd/object-store";

const valid = (body12: string) => body12 + gs1CheckDigit(body12);

describe("manufacturer template (F9.1.2)", () => {
  it("TC-B26-D-032 a good row becomes a staged record: GTIN-14, MRP offer, HSN, GST, images", () => {
    const g = valid("890705800000");
    const r = validateTemplateRow({ gtin: g, name: "Butter 100 g", brand: "Amul", mrp: "₹ 62.00", gstRate: "12%", hsn: "0405 1000", images: "https://a.example.com/1.jpg|https://a.example.com/2.jpg", packSize: "100 g" });
    expect(r.ok).toBe(true);
    expect(r.gtin14).toBe(`0${g}`);
    expect(r.staged).toMatchObject({ gtin: `0${g}`, hsnCode: "04051000", gstRate: 12, quantityText: "100 g", offer: { mrp: 62, currency: "INR" } });
    expect(r.staged?.images).toHaveLength(2);
  });

  it("TC-B26-D-033 refuses a wrong check digit, an in-store code, a missing brand (unless the account has one), bad MRP / HSN / GST / image address", () => {
    const g = valid("890705800001");
    const wrong = g.slice(0, 12) + ((Number(g[12]) + 1) % 10);
    expect(validateTemplateRow({ gtin: wrong, name: "x", brand: "y" }).errorCode).toBe("GTIN_CHECK_DIGIT");
    expect(validateTemplateRow({ gtin: valid("200000000001"), name: "x", brand: "y" }).errorCode).toBe("GTIN_RESTRICTED");
    expect(validateTemplateRow({ gtin: g, name: "x" }).errorCode).toBe("BRAND_MISSING");
    expect(validateTemplateRow({ gtin: g, name: "x" }, { brand: "Gokul" }).ok).toBe(true);
    expect(validateTemplateRow({ gtin: g, name: "x", brand: "y", mrp: "-1" }).errorCode).toBe("MRP_INVALID");
    expect(validateTemplateRow({ gtin: g, name: "x", brand: "y", hsn: "123" }).errorCode).toBe("HSN_INVALID");
    expect(validateTemplateRow({ gtin: g, name: "x", brand: "y", gstRate: "13" }).errorCode).toBe("GST_INVALID");
    expect(validateTemplateRow({ gtin: g, name: "x", brand: "y", images: "file:///etc/passwd" }).errorCode).toBe("IMAGE_URL_INVALID");
    expect(validateTemplateRow({ gtin: g, name: "x", brand: "y", images: "http://localhost/a.png" }).errorCode).toBe("IMAGE_URL_INVALID");
  });

  it("TC-B26-D-034 reads the template's headings and their common aliases; reports missing required columns", () => {
    expect(toTemplateRow({ "Barcode (EAN)": "1", "MRP (₹)": "5", "HSN Code": "0401", Title: "Milk", gstRate: "5", itemCode: "A1" })).toEqual({ gtin: "1", mrp: "5", hsn: "0401", name: "Milk", gstRate: "5", itemCode: "A1" });
    expect(missingRequiredHeadings(["EAN", "Name"])).toEqual(["Brand"]);
  });
});

describe("GS1 DataKart mock and Open Food Facts mapping (F9.1.2)", () => {
  it("TC-B26-D-035 every mock record carries a valid GS1 India GTIN and maps to the staged vocabulary", () => {
    for (const r of GS1_MOCK_RECORDS) {
      const g = analyzeGtin(r.gtin)!;
      expect(g.checkDigitValid && g.usableForMatching).toBe(true);
      expect(r.gtin.startsWith("890")).toBe(true);
    }
    const staged = gs1RecordToStaged(GS1_MOCK_RECORDS[0]);
    expect(staged).toMatchObject({ brand: "Amul", quantityText: "100 g", hsnCode: "04051000", offer: { mrp: 62 } });
    expect(staged.attributes?.map((a) => a.key)).toEqual(["brand_owner_gln", "gpc_brick_code", "gpc_brick_name"]);
  });

  it("TC-B26-D-036 an Open Food Facts API product is flattened like a dump row, without contributor names", () => {
    const row = apiProductToRow({ code: "123", categories_tags: ["en:milks", "en:dairies"], nutriments: { "proteins_100g": 3.2, energy: 10 }, creator: "x", last_editor: "y" });
    expect(row).toEqual({ code: "123", categories_tags: "en:milks,en:dairies", proteins_100g: 3.2 });
  });
});

describe("object store (F9.1.4)", () => {
  it("TC-B26-D-037 keys are generated, never taken from input; S3 needs every OBJECT_STORE_* value and signs with SigV4", async () => {
    expect(newObjectKey("pmd/images/mfr_x", "webp")).toMatch(/^pmd\/images\/mfr_x\/[0-9a-f]{2}\/[0-9a-f]{32}\.webp$/);
    expect(newObjectKey("../../etc", "webp")).not.toContain("..");
    expect(s3ConfigFromEnv({ OBJECT_STORE_BUCKET: "b" } as unknown as NodeJS.ProcessEnv)).toBeNull();
    const cfg = s3ConfigFromEnv({ OBJECT_STORE_ENDPOINT: "https://s3.example.test", OBJECT_STORE_BUCKET: "b", OBJECT_STORE_ACCESS_KEY_ID: "AK", OBJECT_STORE_SECRET_ACCESS_KEY: "SK" } as unknown as NodeJS.ProcessEnv);
    expect(cfg).toMatchObject({ region: "auto", bucket: "b" });
    const fetchStub = vi.fn(async (...args: [string, RequestInit?]) => (args.length ? new Response(null, { status: 200 }) : new Response(null)));
    const store = new S3ObjectStore(cfg, fetchStub as unknown as typeof fetch);
    expect(store.isConfigured()).toBe(true);
    const put = await store.put({ prefix: "pmd/images", bytes: Buffer.from("x"), contentType: "image/webp", extension: "webp" });
    const [url, init] = fetchStub.mock.calls[0];
    expect(url).toBe(`https://s3.example.test/b/${put.key}`);
    expect((init!.headers as Record<string, string>).authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AK\/\d{8}\/auto\/s3\/aws4_request, SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/);
    expect(new S3ObjectStore(null).isConfigured()).toBe(false);
  });
});

describe("boards (F8.4.2 / F9.1.4)", () => {
  it("TC-B26-D-038 the Operator-Limited board shows its four tiles only to that role; other boards are unchanged", () => {
    expect(visibleMenus(OPERATOR_LIMITED_MENUS, "OPERATOR_LIMITED").map((m) => m.key)).toEqual(["onboard", "myShops", "documents", "payments"]);
    expect(visibleMenus(OPERATOR_LIMITED_MENUS, "OPERATOR")).toEqual([]);
    expect(visibleMenus(OPERATOR_LIMITED_MENUS, "CUSTOMER")).toEqual([]);
    expect(boardRoleFor("OPERATOR_LIMITED")).toBe("customer");
    expect(boardRoleFor("OPERATOR")).toBe("operator");
    expect(visibleMenus(PRODUCT_BROWSER_MENUS, "OPERATOR").map((m) => m.key)).toEqual(["browse", "duplicates"]);
    expect(visibleMenus(PRODUCT_BROWSER_MENUS, "ADMIN").map((m) => m.key)).toEqual(["browse", "duplicates", "jobs", "sources", "manufacturers"]);
    expect(visibleMenus(PRODUCT_BROWSER_MENUS, "OPERATOR_LIMITED")).toEqual([]);
    expect(visibleMenus(MANUFACTURER_MENUS, "CUSTOMER").map((m) => m.key)).toEqual(["upload", "jobs", "keys"]);
  });
});
