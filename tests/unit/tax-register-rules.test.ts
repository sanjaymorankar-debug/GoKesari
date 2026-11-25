/** docs/tax-register: the pure rules — tax fields, who decides, CA item statuses, switch clearance. */
import { describe, expect, it } from "vitest";

import { changedTaxFields, decisionRefusal, isTaxRuleField, isTaxRuleKey, nextCaItemStatus, sameValue, stableJson, switchClearance } from "@/server/tax-register/rules";

describe("tax fields of the settings", () => {
  it("knows which fields are tax fields", () => {
    expect(isTaxRuleKey("riderPayouts")).toBe(true);
    expect(isTaxRuleKey("otp")).toBe(false);
    expect(isTaxRuleField("riderPayouts", "tdsRatePanBp")).toBe(true);
    expect(isTaxRuleField("riderPayouts", "withdrawalFeePaise")).toBe(false);
  });

  it("finds only the tax fields a write changes", () => {
    const current = { tdsRatePanBp: 100, tdsRateNoPanBp: 2000, withdrawalFeePaise: 0 };
    expect(changedTaxFields("riderPayouts", current, { ...current, withdrawalFeePaise: 500 })).toEqual([]);
    expect(changedTaxFields("riderPayouts", current, { ...current, tdsRatePanBp: 200 })).toEqual(["tdsRatePanBp"]);
    expect(changedTaxFields("platformTaxProfile", { sacCodes: { A: "1", B: "2" } }, { sacCodes: { B: "2", A: "1" } })).toEqual([]);
  });

  it("compares values whatever the key order", () => {
    expect(stableJson({ b: 1, a: [2, { d: 1, c: 2 }] })).toBe('{"a":[2,{"c":2,"d":1}],"b":1}');
    expect(sameValue({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true);
    expect(sameValue(100, 200)).toBe(false);
    expect(sameValue(null, undefined)).toBe(true);
  });
});

describe("who decides", () => {
  it("only the CA, never on their own proposal or answer", () => {
    expect(decisionRefusal({ id: "a", role: "ADMIN" }, "b")).toMatch(/Only the CA/);
    expect(decisionRefusal({ id: "a", role: "ACCOUNTANT" }, "b")).toMatch(/Only the CA/);
    expect(decisionRefusal({ id: "c", role: "CA" }, "c")).toMatch(/your own/);
    expect(decisionRefusal({ id: "c", role: "CA" }, "b")).toBeNull();
    expect(decisionRefusal({ id: "c", role: "CA" }, null)).toBeNull();
  });
});

describe("CA item statuses", () => {
  it("moves OPEN → SUBMITTED → APPROVED, and back on a send-back", () => {
    expect(nextCaItemStatus("OPEN", "SUBMIT")).toBe("SUBMITTED");
    expect(nextCaItemStatus("SUBMITTED", "APPROVE")).toBe("APPROVED");
    expect(nextCaItemStatus("SUBMITTED", "SEND_BACK")).toBe("NEEDS_INFO");
    expect(nextCaItemStatus("APPROVED", "SEND_BACK")).toBe("NEEDS_INFO");
    expect(nextCaItemStatus("NEEDS_INFO", "SUBMIT")).toBe("SUBMITTED");
  });

  it("refuses what makes no sense", () => {
    expect(nextCaItemStatus("OPEN", "APPROVE")).toBeNull();
    expect(nextCaItemStatus("APPROVED", "APPROVE")).toBeNull();
    expect(nextCaItemStatus("CLOSED", "SUBMIT")).toBeNull();
    expect(nextCaItemStatus("CLOSED", "CLOSE")).toBeNull();
    expect(nextCaItemStatus("OPEN", "REOPEN")).toBeNull();
    expect(nextCaItemStatus("CLOSED", "REOPEN")).toBe("OPEN");
  });
});

describe("switch clearance", () => {
  it("clears a switch only when every item naming it is approved; closed items do not count", () => {
    const s = switchClearance([
      { ref: "GST-01", status: "APPROVED", blocks: ["tcs_engine"] },
      { ref: "GST-02", status: "SUBMITTED", blocks: ["tcs_engine", "payouts"] },
      { ref: "GST-09", status: "APPROVED", blocks: ["documentNumbering:GST16"] },
      { ref: "GST-11", status: "CLOSED", blocks: ["documentNumbering:GST16"] },
    ]);
    const by = Object.fromEntries(s.map((x) => [x.key, x]));
    expect(by.tcs_engine).toMatchObject({ cleared: false, waitingOn: ["GST-02"], approvedBy: ["GST-01"] });
    expect(by.payouts).toMatchObject({ cleared: false, waitingOn: ["GST-02"] });
    expect(by["documentNumbering:GST16"]).toMatchObject({ cleared: true, approvedBy: ["GST-09"] });
    // Waiting switches first.
    expect(s[s.length - 1].cleared).toBe(true);
  });
});
