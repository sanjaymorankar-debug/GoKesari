/**
 * batch-2026-10 WS-C — pure parts: the ticket state machine (registered in
 * the shared registry), fee arithmetic, SLA view, canned-reply placeholders,
 * rule bounds and permissions.
 */
import { describe, expect, it } from "vitest";

import { canMove } from "@/lib/state-machines";
import { canMoveTicket, TICKET_STATUSES, TICKET_TRANSITIONS } from "@/lib/support-ticket-states";
import { can, PERMISSIONS } from "@/server/authz/permissions";
import { RULES } from "@/server/config/rules";
import { feeFor } from "@/server/aftercare/cancellation-fee";
import { renderCannedReply, slaFor } from "@/server/aftercare/support-tickets";

describe("ticket state machine", () => {
  it("TC-B26-C-050 the approved path is legal end to end, through the shared registry", () => {
    const path = ["OPEN", "ACKNOWLEDGED", "IN_PROGRESS", "AWAITING_CUSTOMER", "IN_PROGRESS", "AWAITING_SHOP", "RESOLVED", "CLOSED"] as const;
    for (let i = 1; i < path.length; i += 1) {
      expect(canMoveTicket(path[i - 1], path[i]), `${path[i - 1]} → ${path[i]}`).toBe(true);
      expect(canMove("support_ticket", path[i - 1], path[i])).toBe(true);
    }
    expect(canMoveTicket("RESOLVED", "REOPENED")).toBe(true);
    expect(canMoveTicket("REOPENED", "IN_PROGRESS")).toBe(true);
    expect(canMoveTicket("IN_PROGRESS", "ESCALATED")).toBe(true);
    expect(canMoveTicket("ESCALATED", "RESOLVED")).toBe(true);
  });

  it("TC-B26-C-051 illegal moves are refused: CLOSED is final, CLOSED only after RESOLVED, no going back to OPEN", () => {
    expect(TICKET_TRANSITIONS.CLOSED).toEqual([]);
    for (const from of TICKET_STATUSES) {
      if (from !== "RESOLVED") expect(canMoveTicket(from, "CLOSED"), from).toBe(false);
      expect(canMoveTicket(from, "OPEN"), from).toBe(false);
    }
    expect(canMoveTicket("OPEN", "REOPENED")).toBe(false);
    expect(canMoveTicket("RESOLVED", "IN_PROGRESS")).toBe(false);
    expect(canMove("support_ticket", "CLOSED", "REOPENED")).toBe(false);
  });
});

describe("fee arithmetic and SLA", () => {
  const policy = { active: true, feeType: "PERCENT" as const, feePaise: 0, feeBp: 1_000, capPaise: 3_000, source: "SHOP" as const };

  it("TC-B26-C-052 a percentage fee is rounded, capped, and never more than paid; an inactive policy charges nothing", () => {
    expect(feeFor(policy, { subtotalPaise: 12_345, paidPaise: 20_000 }).amountPaise).toBe(1_235);
    expect(feeFor(policy, { subtotalPaise: 100_000, paidPaise: 200_000 }).amountPaise).toBe(3_000);
    expect(feeFor({ ...policy, feeType: "FLAT", feePaise: 5_000 }, { subtotalPaise: 1_000, paidPaise: 4_000 })).toMatchObject({
      amountPaise: 4_000,
      basis: { limitedToPaid: true },
    });
    expect(feeFor({ ...policy, active: false }, { subtotalPaise: 100_000, paidPaise: 100_000 }).amountPaise).toBe(0);
  });

  it("TC-B26-C-053 the SLA view reports time left and breaches", () => {
    const created = new Date("2026-10-01T00:00:00Z");
    const ticket = {
      acknowledgeBy: new Date(created.getTime() + 48 * 3_600_000),
      resolveBy: new Date(created.getTime() + 30 * 86_400_000),
      acknowledgedAt: null,
      resolvedAt: null,
      status: "OPEN",
    };
    const early = slaFor(ticket, new Date(created.getTime() + 47 * 3_600_000));
    expect(early).toMatchObject({ ackBreached: false, resolveBreached: false, ackRemainingMs: 3_600_000 });
    const late = slaFor(ticket, new Date(created.getTime() + 49 * 3_600_000));
    expect(late.ackBreached).toBe(true);
    const acked = slaFor({ ...ticket, acknowledgedAt: new Date(created.getTime() + 3_600_000) }, new Date(created.getTime() + 49 * 3_600_000));
    expect(acked).toMatchObject({ acknowledged: true, ackBreached: false, ackRemainingMs: null });
  });

  it("TC-B26-C-054 canned reply placeholders are filled, with safe fallbacks", () => {
    expect(renderCannedReply("Hi {{name}}, {{ticketNumber}} / {{ orderNumber }}", { ticketNumber: "TKT-000001", name: "Asha", orderNumber: "GK-1" })).toBe(
      "Hi Asha, TKT-000001 / GK-1",
    );
    expect(renderCannedReply("Hi {{name}} re {{orderNumber}}", { ticketNumber: "TKT-1" })).toBe("Hi there re your order");
  });
});

describe("rules and permissions", () => {
  it("TC-B26-C-055 defaults: after-packing fee OFF, original-method refunds OFF, help desk SLA 48 h / 30 days and cannot be loosened", () => {
    expect(RULES.afterPackingCancellation.defaults.enabled).toBe(false);
    expect(RULES.refundChoice.defaults.originalMethodEnabled).toBe(false);
    expect(RULES.helpdesk.defaults).toMatchObject({ acknowledgeWithinHours: 48, resolveWithinDays: 30, escalateOnBreach: true, csatEnabled: true });
    expect(RULES.helpdesk.schema.safeParse({ ...RULES.helpdesk.defaults, acknowledgeWithinHours: 49 }).success).toBe(false);
    expect(RULES.helpdesk.schema.safeParse({ ...RULES.helpdesk.defaults, resolveWithinDays: 31 }).success).toBe(false);
    expect(RULES.grievanceOfficer.schema.safeParse(RULES.grievanceOfficer.defaults).success).toBe(true);
  });

  it("TC-B26-C-056 permissions: customers and shop owners raise tickets; operators work them; only admins manage canned replies; only shop owners set their fee", () => {
    expect(can("CUSTOMER", PERMISSIONS.SUPPORT_TICKET_RAISE)).toBe(true);
    expect(can("SHOP_OWNER", PERMISSIONS.SUPPORT_TICKET_RAISE)).toBe(true);
    expect(can("CUSTOMER", PERMISSIONS.SUPPORT_TICKET_MANAGE)).toBe(false);
    expect(can("SHOP_OWNER", PERMISSIONS.SUPPORT_TICKET_MANAGE)).toBe(false);
    expect(can("OPERATOR", PERMISSIONS.SUPPORT_TICKET_MANAGE)).toBe(true);
    expect(can("OPERATOR", PERMISSIONS.SUPPORT_CANNED_REPLY_MANAGE)).toBe(false);
    expect(can("ADMIN", PERMISSIONS.SUPPORT_CANNED_REPLY_MANAGE)).toBe(true);
    expect(can("SHOP_OWNER", PERMISSIONS.SHOP_CANCELLATION_FEE_MANAGE_OWN)).toBe(true);
    expect(can("CUSTOMER", PERMISSIONS.SHOP_CANCELLATION_FEE_MANAGE_OWN)).toBe(false);
  });
});
