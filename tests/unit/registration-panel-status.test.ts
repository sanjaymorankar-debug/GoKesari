/**
 * P2-D5 (staging re-test, 15-Nov-2026): "Registration and fee" showed "Shop status: pending approval"
 * for a shop whose fee was still unpaid. It now says "payment pending", as the header does (P2-D1).
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { RegistrationPanel, type RegistrationDetails } from "@/components/registration-panel";

const details = (over: Partial<RegistrationDetails>): RegistrationDetails => ({
  registrationNumber: "BKS-000051",
  registrationDate: null,
  shopName: "QA P2 Retest",
  ownerName: "Owner",
  phone: "9000000000",
  email: null,
  address: "Laxmi Road, Pune, 411030",
  shopType: "GENERAL_TRADING",
  classification: null,
  status: "PENDING_APPROVAL",
  referralCode: null,
  registrationFeePaise: 117_882,
  amountPaidPaise: 0,
  feePaymentStatus: "PENDING",
  ...over,
});

const shopStatus = (over: Partial<RegistrationDetails>) => {
  const html = renderToStaticMarkup(createElement(RegistrationPanel, { details: details(over), payments: [] }));
  return html.split("Shop status</dt>")[1].split("</dd>")[0];
};

describe("registration panel shop status (P2-D5)", () => {
  it("says payment pending while the fee is unpaid", () => {
    expect(shopStatus({ feeDue: true })).toContain("payment pending");
    expect(shopStatus({ feeDue: true })).not.toContain("approval");
  });

  it("keeps the real status otherwise", () => {
    expect(shopStatus({ feeDue: false })).toContain("pending approval");
    expect(shopStatus({ status: "APPROVED", feeDue: false })).toContain("approved");
    expect(shopStatus({ status: "SUSPENDED", feeDue: true })).toContain("suspended");
  });
});
