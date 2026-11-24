/**
 * docs/tax-register (0186): the Accountant proposes tax-setting changes and answers CA items;
 * the CA approves (never their own) and the change is applied through the setting's own service.
 */
import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { db } from "@/server/db";
import { featureFlags, statutoryRates, type UserRole } from "@/server/db/schema";
import { clearFeatureFlagCache } from "@/server/services/feature-flags";
import { getRule, setRule } from "@/server/services/settings";
import { actOnCaItem, caSwitchClearance, createCaItem, importCaItems, listCaItems, updateCaItem } from "@/server/tax-register/ca-items";
import {
  approveTaxChange,
  listTaxParameters,
  proposeTaxChange,
  refuseDirectTaxEdit,
  resubmitTaxChange,
  sendBackTaxChange,
  withdrawTaxChange,
} from "@/server/tax-register/changes";
import { resetBatchE } from "../helpers/batch-e";
import { createUser, resetDatabase } from "../helpers/fixtures";

vi.mock("@/server/email/transport", () => ({ sendEmail: vi.fn(async () => undefined) }));

type A = { id: string; role: UserRole };
let accountant: A;
let ca: A;
let admin: A;

beforeEach(async () => {
  await resetDatabase();
  await resetBatchE();
  clearFeatureFlagCache();
  accountant = { id: (await createUser({ role: "ACCOUNTANT" })).id, role: "ACCOUNTANT" };
  ca = { id: (await createUser({ role: "CA" })).id, role: "CA" };
  admin = { id: (await createUser({ role: "ADMIN" })).id, role: "ADMIN" };
});

const riderTds = (rateBp: number) => ({ kind: "RULE_FIELDS" as const, payload: { ruleKey: "riderPayouts", values: { tdsRatePanBp: rateBp } }, reason: "CA advice on 194C" });

describe("change requests", () => {
  it("the Accountant proposes, the CA approves and it is applied and marked approved", async () => {
    const before = await getRule("riderPayouts");
    const req = await proposeTaxChange(riderTds(150), accountant);
    expect(req).toMatchObject({ status: "SUBMITTED", targetKeys: ["rule:riderPayouts.tdsRatePanBp"], currentValue: { tdsRatePanBp: before.tdsRatePanBp } });
    // Not applied yet.
    expect((await getRule("riderPayouts")).tdsRatePanBp).toBe(before.tdsRatePanBp);

    const done = await approveTaxChange(req.id, ca);
    expect(done.status).toBe("APPLIED");
    expect((await getRule("riderPayouts")).tdsRatePanBp).toBe(150);
    const p = (await listTaxParameters()).find((x) => x.key === "rule:riderPayouts.tdsRatePanBp")!;
    expect(p).toMatchObject({ value: 150, approved: true });

    // Changed outside the register: no longer approved.
    await setRule("riderPayouts", { ...(await getRule("riderPayouts")), tdsRatePanBp: 175 }, admin as { id: string; role: "ADMIN" });
    expect((await listTaxParameters()).find((x) => x.key === "rule:riderPayouts.tdsRatePanBp")).toMatchObject({ value: 175, approved: false });
  });

  it("only the CA approves: not the Accountant, not an admin, and the CA cannot propose", async () => {
    const req = await proposeTaxChange(riderTds(150), accountant);
    await expect(approveTaxChange(req.id, accountant)).rejects.toThrow(/Only the CA/);
    await expect(approveTaxChange(req.id, admin)).rejects.toThrow(/Only the CA/);
    await expect(proposeTaxChange(riderTds(150), ca)).rejects.toThrow(/Accountant or an admin/);
  });

  it("refuses a field that is not a tax field", async () => {
    await expect(proposeTaxChange({ kind: "RULE_FIELDS", payload: { ruleKey: "riderPayouts", values: { withdrawalFeePaise: 500 } }, reason: "not a tax field" }, accountant)).rejects.toThrow(/Not a tax field/);
  });

  it("send back, edit and submit again, then approve", async () => {
    const req = await proposeTaxChange(riderTds(150), accountant);
    await expect(sendBackTaxChange(req.id, "", ca)).rejects.toThrow(/Say what/);
    expect((await sendBackTaxChange(req.id, "Use 1% as notified", ca)).status).toBe("SENT_BACK");
    await expect(resubmitTaxChange(req.id, riderTds(100), admin)).rejects.toThrow(/Only the person/);
    const again = await resubmitTaxChange(req.id, { ...riderTds(100), reason: "As the CA said: 1%" }, accountant);
    expect(again.status).toBe("SUBMITTED");
    expect((await approveTaxChange(req.id, ca)).status).toBe("APPLIED");
    expect((await getRule("riderPayouts")).tdsRatePanBp).toBe(100);
  });

  it("a withdrawn request cannot be approved", async () => {
    const req = await proposeTaxChange(riderTds(150), accountant);
    await withdrawTaxChange(req.id, accountant);
    await expect(approveTaxChange(req.id, ca)).rejects.toThrow(/Only a submitted/);
  });

  it("a new statutory row is added and confirmed by the CA; a clash leaves the request APPLY_FAILED", async () => {
    const from = "2031-04-01";
    const body = { kind: "STATUTORY_ROW" as const, payload: { key: "GST_TCS_SEC52", label: "TCS u/s 52", enabled: true, rateBp: 50, params: {}, effectiveFrom: from }, reason: "Notified rate" };
    const req = await proposeTaxChange(body, accountant);
    expect((await approveTaxChange(req.id, ca)).status).toBe("APPLIED");
    const [row] = await db.select().from(statutoryRates).where(and(eq(statutoryRates.key, "GST_TCS_SEC52"), eq(statutoryRates.effectiveFrom, from)));
    expect(row).toMatchObject({ rateBp: 50, confirmedByCa: true, confirmedBy: ca.id });

    const clash = await proposeTaxChange(body, accountant);
    const failed = await approveTaxChange(clash.id, ca);
    expect(failed.status).toBe("APPLY_FAILED");
    expect(failed.applyError).toMatch(/already starts on that day/);
  });

  it("the CA approves current values as they are", async () => {
    const key = "rule:invoicing.defaultGstRateBp";
    expect((await listTaxParameters()).find((x) => x.key === key)!.approved).toBe(false);
    const req = await proposeTaxChange({ kind: "APPROVE_CURRENT", payload: { paramKeys: [key, "statutory:IT_TDS_194O"] }, reason: "Reviewed with the CA" }, accountant);
    expect((await approveTaxChange(req.id, ca)).status).toBe("APPLIED");
    const params = await listTaxParameters();
    expect(params.find((x) => x.key === key)!.approved).toBe(true);
    expect(params.find((x) => x.key === "statutory:IT_TDS_194O")!.approved).toBe(true);
  });
});

describe("flag tax_register", () => {
  it("refuses direct edits only while it is on", async () => {
    await expect(refuseDirectTaxEdit("A statutory setting")).resolves.toBeUndefined();
    await db.insert(featureFlags).values({ key: "tax_register", enabled: true }).onConflictDoUpdate({ target: featureFlags.key, set: { enabled: true } });
    clearFeatureFlagCache();
    await expect(refuseDirectTaxEdit("A statutory setting")).rejects.toThrow(/tax register/);
  });
});

describe("CA items", () => {
  const item = { ref: "GST-01", title: "TCS split", question: "Which split applies?", blocks: ["tcs_engine", "statutory:GST_TCS_SEC52"], priority: "HIGH" as const };

  it("Accountant answers, the CA approves, and the switch is cleared; a changed answer goes back to the CA", async () => {
    const it1 = await createCaItem(item, accountant);
    await expect(actOnCaItem(it1.id, "SUBMIT", accountant)).rejects.toThrow(/answer first/);
    await updateCaItem(it1.id, { answer: "CGST + SGST for intra-state" }, accountant);
    await actOnCaItem(it1.id, "SUBMIT", accountant);
    expect((await caSwitchClearance()).find((s) => s.key === "tcs_engine")).toMatchObject({ cleared: false, waitingOn: ["GST-01"] });

    await expect(actOnCaItem(it1.id, "APPROVE", admin)).rejects.toThrow(/Only the CA/);
    expect((await actOnCaItem(it1.id, "APPROVE", ca, "Agreed")).status).toBe("APPROVED");
    expect((await caSwitchClearance()).find((s) => s.key === "tcs_engine")).toMatchObject({ cleared: true });

    const edited = await updateCaItem(it1.id, { answer: "IGST for inter-state" }, accountant);
    expect(edited).toMatchObject({ status: "SUBMITTED", approvedBy: null });
    const { items } = await listCaItems(ca);
    expect(items[0].notes.map((n) => n.kind)).toEqual(["SUBMITTED", "APPROVED", "REOPENED"]);
  });

  it("a send-back needs a note; the CA cannot answer", async () => {
    const it1 = await createCaItem(item, accountant);
    await updateCaItem(it1.id, { answer: "x" }, accountant);
    await actOnCaItem(it1.id, "SUBMIT", accountant);
    await expect(actOnCaItem(it1.id, "SEND_BACK", ca)).rejects.toThrow(/missing/);
    expect((await actOnCaItem(it1.id, "SEND_BACK", ca, "Cite the notification")).status).toBe("NEEDS_INFO");
    await expect(updateCaItem(it1.id, { answer: "y" }, ca)).rejects.toThrow(/Accountant or an admin/);
  });

  it("loading from a file adds new refs and leaves existing ones alone", async () => {
    await createCaItem(item, accountant);
    const r = await importCaItems([item, { ...item, ref: "GST-02", title: "TCS base" }], accountant);
    expect(r).toEqual({ added: ["GST-02"], skipped: ["GST-01"] });
  });
});
