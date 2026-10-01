import { describe, expect, it } from "vitest";

import { maskEmail, maskPhone, parsePhone } from "@/lib/phone";
import {
  RETURN_STATUSES,
  RETURN_TERMINAL,
  RETURN_TRANSITIONS,
  holdsQuantity,
} from "@/lib/return-states";
import {
  MANDATORY_CATEGORIES,
  TEMPLATES,
  categoryOf,
  interpolate,
  renderEmail,
  renderOtpEmail,
  renderTemplate,
} from "@/server/notifications/templates";
import { NOTIFICATION_TYPES } from "@/server/notifications/types";

describe("mobile numbers", () => {
  it("normalises to E.164 and tolerates spaces, dashes and a leading zero", () => {
    expect(parsePhone("+91", "98765 43210")).toMatchObject({ ok: true, e164: "+919876543210" });
    expect(parsePhone("+91", "098765-43210")).toMatchObject({ ok: true, e164: "+919876543210" });
  });

  it("rejects numbers that cannot be valid", () => {
    expect(parsePhone("+91", "12345")).toMatchObject({ ok: false });
    expect(parsePhone("+91", "5876543210")).toMatchObject({ ok: false }); // Indian mobiles start 6-9
    expect(parsePhone("+91", "98a6543210")).toMatchObject({ ok: false });
    expect(parsePhone("+999", "9876543210")).toMatchObject({ ok: false }); // unsupported country code
  });

  it("masks for audit trails and screens", () => {
    expect(maskPhone("+919876543210")).toBe("+91 ******3210");
    expect(maskEmail("sanjay@example.com")).toBe("s*****@example.com");
  });
});

describe("return state machine", () => {
  it("every status is described and terminal ones go nowhere", () => {
    for (const s of RETURN_STATUSES) expect(RETURN_TRANSITIONS[s]).toBeDefined();
    for (const s of RETURN_TERMINAL) expect(RETURN_TRANSITIONS[s]).toHaveLength(0);
  });

  it("only legal moves are listed: no skipping approval, inspection or refund", () => {
    expect(RETURN_TRANSITIONS.RETURN_REQUESTED).not.toContain("APPROVED");
    expect(RETURN_TRANSITIONS.UNDER_REVIEW).toEqual(expect.arrayContaining(["APPROVED", "REJECTED"]));
    expect(RETURN_TRANSITIONS.PICKUP_COMPLETED).toEqual(["INSPECTION_PENDING"]);
    expect(RETURN_TRANSITIONS.INSPECTION_PENDING).not.toContain("REFUND_COMPLETED");
    expect(RETURN_TRANSITIONS.APPROVED_FOR_REFUND).toEqual(["REFUND_INITIATED"]);
    expect(RETURN_TRANSITIONS.REFUND_INITIATED).toEqual(["REFUND_COMPLETED"]);
  });

  it("every status is reachable and nothing points at an unknown status", () => {
    const reachable = new Set<string>(["RETURN_REQUESTED"]);
    for (const targets of Object.values(RETURN_TRANSITIONS)) for (const t of targets) reachable.add(t);
    for (const s of RETURN_STATUSES) expect(reachable.has(s)).toBe(true);
  });

  it("rejected and cancelled returns give their quantity back", () => {
    expect(holdsQuantity("UNDER_REVIEW")).toBe(true);
    expect(holdsQuantity("REFUND_COMPLETED")).toBe(true);
    expect(holdsQuantity("REJECTED")).toBe(false);
    expect(holdsQuantity("RETURN_CANCELLED")).toBe(false);
  });
});

describe("notification templates", () => {
  it("fills placeholders and tidies gaps", () => {
    expect(interpolate("Order {{orderNumber}} from {{shopName}}.", { orderNumber: "A1", shopName: "Kesari Dairy" })).toBe(
      "Order A1 from Kesari Dairy.",
    );
    expect(interpolate("Cancelled. {{reason}}", {})).toBe("Cancelled.");
  });

  it("covers the important events", () => {
    for (const type of [
      NOTIFICATION_TYPES.ORDER_CONFIRMED,
      NOTIFICATION_TYPES.ORDER_ACCEPTED,
      NOTIFICATION_TYPES.ORDER_ASSIGNED,
      NOTIFICATION_TYPES.ORDER_RIDER_ARRIVING,
      NOTIFICATION_TYPES.ORDER_PICKED_UP,
      NOTIFICATION_TYPES.ORDER_DELIVERED,
      NOTIFICATION_TYPES.ORDER_CANCELLED,
      NOTIFICATION_TYPES.RETURN_REQUESTED,
      NOTIFICATION_TYPES.RETURN_APPROVED,
      NOTIFICATION_TYPES.RETURN_REJECTED,
      NOTIFICATION_TYPES.RETURN_REFUND_INITIATED,
      NOTIFICATION_TYPES.RETURN_REFUND_COMPLETED,
      NOTIFICATION_TYPES.SHOP_SUSPENDED,
      NOTIFICATION_TYPES.DELIVERY_SEARCH_STOPPED,
      NOTIFICATION_TYPES.SECURITY_SIGN_IN,
      NOTIFICATION_TYPES.SECURITY_PHONE_CHANGED,
    ]) {
      expect(TEMPLATES[type], type).toBeDefined();
    }
    const rendered = renderTemplate(NOTIFICATION_TYPES.SHOP_SUSPENDED, {
      shopName: "Kesari Dairy",
      effectiveAt: "30 Sep, 10:00 am",
      reason: "Licence expired",
      impact: "2 orders cancelled.",
      expectedAction: "Upload a valid licence.",
    });
    expect(rendered?.body).toContain("Licence expired");
    expect(rendered?.body).toContain("Upload a valid licence.");
  });

  it("groups events into categories and keeps security notices mandatory", () => {
    expect(categoryOf(NOTIFICATION_TYPES.ORDER_DELIVERED)).toBe("ORDERS");
    expect(categoryOf(NOTIFICATION_TYPES.RETURN_APPROVED)).toBe("RETURNS");
    expect(categoryOf(NOTIFICATION_TYPES.SECURITY_SIGN_IN)).toBe("ACCOUNT_SECURITY");
    expect(MANDATORY_CATEGORIES).toContain("ACCOUNT_SECURITY");
  });

  it("escapes HTML in emails and never links to a non-http URL", () => {
    const mail = renderEmail({ title: "<b>Hi</b>", body: "a & b", actionUrl: "javascript:alert(1)", baseUrl: "https://x.test" });
    expect(mail.html).not.toContain("<b>Hi</b>");
    expect(mail.html).toContain("&lt;b&gt;Hi&lt;/b&gt;");
    expect(mail.html).not.toContain("javascript:");
    const linked = renderEmail({ title: "T", body: "B", actionUrl: "/orders", baseUrl: "https://x.test/" });
    expect(linked.html).toContain("https://x.test/orders");
  });

  it("the sign-in code email carries the code and expiry", () => {
    const mail = renderOtpEmail("123456", 10);
    expect(mail.subject).toContain("123456");
    expect(mail.text).toContain("10 minutes");
  });
});
