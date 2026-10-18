/**
 * batch-2026-10 WS-C — F6.3.3 (SM-006): help desk and grievance portal.
 * Ticket state machine, SLA escalation, internal notes, canned replies, CSAT,
 * who may see what, the grievance link and the Grievance Officer setting.
 */
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { UserRole } from "@/server/db/schema";

const state = vi.hoisted(() => ({
  session: null as null | { user: { id: string; email: string; name: string | null; image: null; role: UserRole; status: "ACTIVE" } },
}));
vi.mock("@/server/auth", () => ({ auth: async () => state.session, handlers: {}, signIn: async () => {}, signOut: async () => {} }));

import { GET as ticketGet } from "@/app/api/support/tickets/[id]/route";
import { GET as ticketsList, POST as ticketsCreate } from "@/app/api/support/tickets/route";
import { POST as attachmentPost } from "@/app/api/support/tickets/[id]/attachments/route";
import { POST as grievancePost } from "@/app/api/grievances/route";
import { POST as cronAftercare } from "@/app/api/cron/aftercare/route";
import { db } from "@/server/db";
import {
  domainEvents,
  grievances,
  notificationDeliveries,
  notifications,
  supportTicketEvents,
  supportTickets,
} from "@/server/db/schema";
import { getGrievanceOfficer } from "@/server/aftercare/grievance-officer";
import {
  assignTicket,
  changeTicketStatus,
  createCannedReply,
  createTicket,
  deleteCannedReply,
  escalateTicket,
  getTicketDetail,
  listCannedReplies,
  listShopTickets,
  listTicketQueue,
  readTicketAttachment,
  replyToTicket,
  runHelpdeskSlaSweep,
  submitCsat,
  addTicketAttachment,
} from "@/server/aftercare/support-tickets";
import { getComplianceChecklist } from "@/server/services/compliance";
import { lookupGrievance } from "@/server/services/grievances";
import { setRule } from "@/server/services/settings";
import { call } from "../helpers/http";
import { createShop, createUser, resetDatabase } from "../helpers/fixtures";
import { clearBatchCRules, paidOrderAt, setRuleRaw } from "../helpers/batch-c";

const signInAs = (u: { id: string; email: string; name: string | null; role: UserRole }) => {
  state.session = { user: { id: u.id, email: u.email, name: u.name, image: null, role: u.role, status: "ACTIVE" } };
};
const HOUR = 3_600_000;
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]),
  Buffer.from("IHDR"),
  Buffer.from([0, 0, 0, 64, 0, 0, 0, 64, 8, 2, 0, 0, 0]),
  Buffer.alloc(16),
]);

beforeEach(async () => {
  state.session = null;
  await resetDatabase();
  await clearBatchCRules();
});
afterEach(clearBatchCRules);

async function ticketOnOrder() {
  const s = await paidOrderAt("DELIVERED");
  const ticket = await createTicket(
    { category: "PRODUCT_QUALITY", subject: "Milk was sour", description: "The milk delivered this morning was sour.", orderId: s.order.id },
    s.customer,
  );
  return { ...s, ticket };
}

describe("F6.3.3 raising a ticket", () => {
  it("TC-B26-C-029 a customer raises a ticket on their order: TKT number, SLA 48 h / 30 days, requester + support told", async () => {
    const s = await ticketOnOrder();
    expect(s.ticket.ticketNumber).toMatch(/^TKT-\d{6}$/);
    expect(s.ticket.status).toBe("OPEN");
    expect(s.ticket.shopId).toBe(s.shop.id);
    expect(s.ticket.acknowledgeBy.getTime() - s.ticket.createdAt.getTime()).toBe(48 * HOUR);
    expect(s.ticket.resolveBy.getTime() - s.ticket.createdAt.getTime()).toBe(30 * 24 * HOUR);
    const toRequester = await db.select().from(notifications).where(and(eq(notifications.userId, s.customer.id), eq(notifications.type, "ticket.received")));
    expect(toRequester).toHaveLength(1);
    const toSupport = await db.select().from(notifications).where(eq(notifications.type, "support.ticket_new"));
    expect(toSupport.map((n) => n.userId).sort()).toEqual([s.admin.id, s.operator.id].sort());
  });

  it("TC-B26-C-030 nobody can raise a ticket on someone else's order; a shop owner can on their shop's order", async () => {
    const s = await paidOrderAt("DELIVERED");
    const stranger = await createUser();
    await expect(
      createTicket({ category: "ORDER", subject: "Hello", description: "Something about this order.", orderId: s.order.id }, { id: stranger.id, role: "CUSTOMER" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    const byShop = await createTicket({ category: "ORDER", subject: "Customer unreachable", description: "Could not reach the customer.", orderId: s.order.id }, s.owner);
    expect(byShop.requesterRole).toBe("SHOP_OWNER");
  });

  it("TC-B26-C-031 the create route validates input and the list route returns only the caller's own tickets", async () => {
    const s = await ticketOnOrder();
    const other = await createUser();
    signInAs({ ...other, role: "CUSTOMER" });
    const bad = await call(ticketsCreate, "/api/support/tickets", { method: "POST", body: { category: "NOPE", subject: "x", description: "y" } });
    expect(bad.status).toBe(422);
    const created = await call(ticketsCreate, "/api/support/tickets", { method: "POST", body: { category: "ACCOUNT", subject: "Cannot change my number", description: "The profile page refuses my new number." } });
    expect(created.status).toBe(201);
    const mine = await call(ticketsList, "/api/support/tickets");
    expect(mine.body.tickets.map((t: { id: string }) => t.id)).toEqual([created.body.id]);
    expect(mine.body.tickets.map((t: { id: string }) => t.id)).not.toContain(s.ticket.id);
    const queue = await call(ticketsList, "/api/support/tickets?scope=queue");
    expect(queue.status).toBe(403);
  });
});

describe("F6.3.3 state machine", () => {
  it("TC-B26-C-032 legal moves go through with timestamps; illegal ones are refused", async () => {
    const s = await ticketOnOrder();
    await expect(changeTicketStatus(s.ticket.id, "CLOSED", s.admin)).rejects.toMatchObject({ code: "CONFLICT" });
    let t = await changeTicketStatus(s.ticket.id, "ACKNOWLEDGED", s.admin);
    expect(t.acknowledgedAt).not.toBeNull();
    t = await changeTicketStatus(s.ticket.id, "IN_PROGRESS", s.admin);
    t = await changeTicketStatus(s.ticket.id, "AWAITING_SHOP", s.admin, "Asking the shop.");
    await expect(changeTicketStatus(s.ticket.id, "ACKNOWLEDGED", s.admin)).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(changeTicketStatus(s.ticket.id, "RESOLVED", s.admin)).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    t = await changeTicketStatus(s.ticket.id, "RESOLVED", s.admin, "Refunded the milk.");
    expect(t.resolvedAt).not.toBeNull();
    // Every move is a checked domain event.
    const events = await db.select().from(domainEvents).where(eq(domainEvents.subjectId, s.ticket.id));
    expect(events.filter((e) => e.type === "support_ticket.status_changed").map((e) => e.toStatus)).toEqual([
      "ACKNOWLEDGED",
      "IN_PROGRESS",
      "AWAITING_SHOP",
      "RESOLVED",
    ]);
  });

  it("TC-B26-C-033 the requester may only close or reopen a resolved ticket; reopening needs a reason", async () => {
    const s = await ticketOnOrder();
    await expect(changeTicketStatus(s.ticket.id, "IN_PROGRESS", s.customer)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await changeTicketStatus(s.ticket.id, "RESOLVED", s.admin, "Done.");
    await expect(changeTicketStatus(s.ticket.id, "REOPENED", s.customer)).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    const reopened = await changeTicketStatus(s.ticket.id, "REOPENED", s.customer, "Still sour.");
    expect(reopened).toMatchObject({ status: "REOPENED", reopenCount: 1, resolvedAt: null });
    await changeTicketStatus(s.ticket.id, "RESOLVED", s.admin, "Replaced.");
    const closed = await changeTicketStatus(s.ticket.id, "CLOSED", s.customer);
    expect(closed.closedAt).not.toBeNull();
    await expect(changeTicketStatus(s.ticket.id, "REOPENED", s.customer, "again")).rejects.toThrow();
  });

  it("TC-B26-C-034 every state change notifies the requester; AWAITING_SHOP notifies the shop owner; assignment notifies the assignee", async () => {
    const s = await ticketOnOrder();
    await assignTicket(s.ticket.id, s.operator.id, s.admin);
    expect(await db.select().from(notifications).where(and(eq(notifications.userId, s.operator.id), eq(notifications.type, "support.ticket_assigned")))).toHaveLength(1);
    await changeTicketStatus(s.ticket.id, "AWAITING_SHOP", s.admin, "Need the shop's side.");
    const toShop = await db.select().from(notifications).where(and(eq(notifications.userId, s.owner.id), eq(notifications.type, "shop.ticket_awaiting")));
    expect(toShop).toHaveLength(1);
    const toRequester = await db.select().from(notifications).where(and(eq(notifications.userId, s.customer.id), eq(notifications.type, "ticket.status_changed")));
    expect(toRequester.length).toBeGreaterThanOrEqual(2); // ACKNOWLEDGED (on assignment) + AWAITING_SHOP
    const pushes = await db.select().from(notificationDeliveries).where(and(eq(notificationDeliveries.userId, s.customer.id), eq(notificationDeliveries.channel, "PUSH")));
    expect(pushes.length).toBeGreaterThan(0);
  });
});

describe("F6.3.3 replies, notes, canned replies, files", () => {
  it("TC-B26-C-035 internal notes and staff-only files are never shown to the requester or the shop", async () => {
    const s = await ticketOnOrder();
    await replyToTicket(s.ticket.id, s.admin, { body: "Customer has 3 earlier complaints — check.", internal: true });
    await replyToTicket(s.ticket.id, s.admin, { body: "Sorry about that — looking into it.", thenStatus: "AWAITING_SHOP" });
    await addTicketAttachment(s.ticket.id, s.admin, { name: "internal.png", bytes: PNG }, { internal: true });
    const asCustomer = await getTicketDetail(s.ticket.id, s.customer);
    expect(asCustomer.messages.map((m) => m.body)).toEqual(["Sorry about that — looking into it."]);
    expect(asCustomer.attachments).toHaveLength(0);
    expect(asCustomer.events.some((e) => e.kind === "NOTE")).toBe(false);
    const asShop = await getTicketDetail(s.ticket.id, s.owner);
    expect(asShop.access).toBe("SHOP");
    expect(asShop.messages.some((m) => m.internal)).toBe(false);
    const asStaff = await getTicketDetail(s.ticket.id, s.operator);
    expect(asStaff.messages).toHaveLength(2);
    expect(asStaff.attachments).toHaveLength(1);
    const fileId = asStaff.attachments[0].id;
    await expect(readTicketAttachment(s.ticket.id, fileId, s.customer)).rejects.toMatchObject({ code: "NOT_FOUND" });
    // A requester may not post an internal note.
    await expect(replyToTicket(s.ticket.id, s.customer, { body: "secret", internal: true })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("TC-B26-C-036 a canned reply is inserted with its placeholders filled; only an admin manages the list", async () => {
    const s = await ticketOnOrder();
    await expect(createCannedReply({ title: "Sorry", body: "Hello {{name}}" }, s.operator)).rejects.toMatchObject({ code: "FORBIDDEN" });
    const canned = await createCannedReply({ title: "Apology", body: "Hello {{name}}, about ticket {{ticketNumber}} for order {{orderNumber}}: we're sorry." }, s.admin);
    expect((await listCannedReplies(s.operator)).map((c) => c.id)).toEqual([canned.id]);
    const { message } = await replyToTicket(s.ticket.id, s.operator, { cannedReplyId: canned.id, body: "A refund is on its way." });
    expect(message.body).toBe(`Hello Test User, about ticket ${s.ticket.ticketNumber} for order ${s.order.orderNumber}: we're sorry.\n\nA refund is on its way.`);
    expect(message.cannedReplyId).toBe(canned.id);
    await expect(replyToTicket(s.ticket.id, s.customer, { cannedReplyId: canned.id })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await deleteCannedReply(canned.id, s.admin);
    expect(await listCannedReplies(s.operator)).toHaveLength(0);
  });

  it("TC-B26-C-037 the shop replies only while AWAITING_SHOP, which hands the ticket back to support", async () => {
    const s = await ticketOnOrder();
    await expect(getTicketDetail(s.ticket.id, s.owner)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await listShopTickets(s.owner)).toHaveLength(0);
    await changeTicketStatus(s.ticket.id, "AWAITING_SHOP", s.admin, "Shop please check.");
    expect((await listShopTickets(s.owner)).map((t) => t.id)).toEqual([s.ticket.id]);
    const { ticket } = await replyToTicket(s.ticket.id, s.owner, { body: "Batch was fine; will replace." });
    expect(ticket.status).toBe("IN_PROGRESS");
    await expect(replyToTicket(s.ticket.id, s.owner, { body: "again" })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("TC-B26-C-038 a requester's reply to AWAITING_CUSTOMER puts the ticket back in progress; files are type-checked", async () => {
    const s = await ticketOnOrder();
    await replyToTicket(s.ticket.id, s.admin, { body: "Can you share a photo?", thenStatus: "AWAITING_CUSTOMER" });
    const { ticket } = await replyToTicket(s.ticket.id, s.customer, { body: "Photo attached." });
    expect(ticket.status).toBe("IN_PROGRESS");
    await expect(addTicketAttachment(s.ticket.id, s.customer, { name: "x.exe", bytes: Buffer.from("MZ not an image at all") })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    const ok = await addTicketAttachment(s.ticket.id, s.customer, { name: "photo.png", bytes: PNG });
    expect((await readTicketAttachment(s.ticket.id, ok.id, s.customer)).contentType).toBe("image/png");
  });
});

describe("F6.3.3 authorization", () => {
  it("TC-B26-C-039 a customer cannot read another's ticket (404); an operator can; routes agree", async () => {
    const s = await ticketOnOrder();
    const other = await createUser();
    await expect(getTicketDetail(s.ticket.id, { id: other.id, role: "CUSTOMER" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect((await getTicketDetail(s.ticket.id, s.operator)).access).toBe("STAFF");
    signInAs({ ...other, role: "CUSTOMER" });
    expect((await call(ticketGet, `/api/support/tickets/${s.ticket.id}`, { params: { id: s.ticket.id } })).status).toBe(404);
    const form = new FormData();
    form.append("file", new Blob([PNG], { type: "image/png" }), "a.png");
    signInAs(s.operator);
    expect((await call(ticketGet, `/api/support/tickets/${s.ticket.id}`, { params: { id: s.ticket.id } })).status).toBe(200);
    // Another shop's owner never sees it, even while it waits for a shop.
    await changeTicketStatus(s.ticket.id, "AWAITING_SHOP", s.admin, "Shop please check.");
    const otherOwner = await createUser({ role: "SHOP_OWNER" });
    await createShop(otherOwner.id);
    await expect(getTicketDetail(s.ticket.id, { id: otherOwner.id, role: "SHOP_OWNER" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(attachmentPost).toBeTypeOf("function");
  });

  it("TC-B26-C-040 only support works tickets: assignment, escalation and queues are refused to customers and shops", async () => {
    const s = await ticketOnOrder();
    await expect(assignTicket(s.ticket.id, s.operator.id, s.customer)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(escalateTicket(s.ticket.id, s.owner, "Because")).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(listTicketQueue(s.customer)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(assignTicket(s.ticket.id, s.customer.id, s.admin)).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });
});

describe("F6.3.3 SLA and escalation", () => {
  it("TC-B26-C-041 the SLA job escalates a ticket not acknowledged within 48 h, once, and alerts administrators", async () => {
    const s = await ticketOnOrder();
    const later = new Date(Date.now() + 49 * HOUR);
    const first = await runHelpdeskSlaSweep(later);
    expect(first).toMatchObject({ ackBreaches: 1, escalated: 1 });
    const [t] = await db.select().from(supportTickets).where(eq(supportTickets.id, s.ticket.id));
    expect(t).toMatchObject({ status: "ESCALATED", escalationLevel: 1 });
    expect(t.ackBreachedAt).not.toBeNull();
    const alerts = await db.select().from(notifications).where(eq(notifications.type, "support.ticket_escalated"));
    expect(alerts.map((a) => a.userId)).toEqual([s.admin.id]);
    expect(await runHelpdeskSlaSweep(later)).toMatchObject({ ackBreaches: 0, escalated: 0 });
    // The breached queue shows it.
    expect((await listTicketQueue(s.admin, { queue: "breached" })).map((r) => r.id)).toEqual([s.ticket.id]);
  });

  it("TC-B26-C-042 a resolution breach after 30 days escalates; acknowledged tickets are not ack-breached; the cron route runs it", async () => {
    const s = await ticketOnOrder();
    await changeTicketStatus(s.ticket.id, "IN_PROGRESS", s.admin);
    expect(await runHelpdeskSlaSweep(new Date(Date.now() + 49 * HOUR))).toMatchObject({ ackBreaches: 0, escalated: 0 });
    await db.update(supportTickets).set({ resolveBy: new Date(Date.now() - HOUR) }).where(eq(supportTickets.id, s.ticket.id));
    const res = await call(cronAftercare, "/api/cron/aftercare", { method: "POST" });
    expect([401, 403]).toContain(res.status);
    const { NextRequest } = await import("next/server");
    const authed = await cronAftercare(new NextRequest("http://localhost/api/cron/aftercare", { method: "POST", headers: { authorization: `Bearer ${process.env.CRON_SECRET}` } }));
    const body = await authed.json();
    expect(body.helpdesk).toMatchObject({ resolveBreaches: 1, escalated: 1 });
    const breach = await db.select().from(supportTicketEvents).where(and(eq(supportTicketEvents.ticketId, s.ticket.id), eq(supportTicketEvents.kind, "SLA_BREACH")));
    expect(breach).toHaveLength(1);
  });

  it("TC-B26-C-043 escalation on breach can be switched off; resolved tickets close themselves after the set days", async () => {
    await setRuleRaw("helpdesk", { escalateOnBreach: false, autoCloseResolvedAfterDays: 7 });
    const s = await ticketOnOrder();
    expect(await runHelpdeskSlaSweep(new Date(Date.now() + 49 * HOUR))).toMatchObject({ ackBreaches: 1, escalated: 0 });
    expect((await db.select().from(supportTickets).where(eq(supportTickets.id, s.ticket.id)))[0].status).toBe("OPEN");
    await changeTicketStatus(s.ticket.id, "RESOLVED", s.admin, "Fixed.");
    const result = await runHelpdeskSlaSweep(new Date(Date.now() + 8 * 24 * HOUR));
    expect(result.autoClosed).toBe(1);
    expect((await db.select().from(supportTickets).where(eq(supportTickets.id, s.ticket.id)))[0].status).toBe("CLOSED");
  });

  it("TC-B26-C-044 manual escalation by support", async () => {
    const s = await ticketOnOrder();
    const t = await escalateTicket(s.ticket.id, s.operator, "Customer threatens consumer forum");
    expect(t.status).toBe("ESCALATED");
    await expect(escalateTicket(s.ticket.id, s.operator, "x")).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });
});

describe("F6.3.3 CSAT", () => {
  it("TC-B26-C-045 a rating is accepted only after the ticket is closed, only from the requester, only once", async () => {
    const s = await ticketOnOrder();
    await expect(submitCsat(s.ticket.id, s.customer, { rating: 5 })).rejects.toMatchObject({ code: "CONFLICT" });
    await changeTicketStatus(s.ticket.id, "RESOLVED", s.admin, "Replaced the milk.");
    await expect(submitCsat(s.ticket.id, s.customer, { rating: 5 })).rejects.toMatchObject({ code: "CONFLICT" });
    await changeTicketStatus(s.ticket.id, "CLOSED", s.customer);
    expect(await db.select().from(notifications).where(and(eq(notifications.userId, s.customer.id), eq(notifications.type, "ticket.csat_requested")))).toHaveLength(1);
    await expect(submitCsat(s.ticket.id, s.admin, { rating: 1 })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(submitCsat(s.ticket.id, s.customer, { rating: 6 })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    const row = await submitCsat(s.ticket.id, s.customer, { rating: 4, comment: "Quick" });
    expect(row.rating).toBe(4);
    await expect(submitCsat(s.ticket.id, s.customer, { rating: 5 })).rejects.toMatchObject({ code: "CONFLICT" });
    expect((await getTicketDetail(s.ticket.id, s.customer)).csat).toEqual({ rating: 4, comment: "Quick" });
  });
});

describe("F6.3.3 grievances and the Grievance Officer", () => {
  it("TC-B26-C-046 a grievance still gets its GRV number and also opens a linked ticket whose status flows back", async () => {
    const admin = await createUser({ role: "ADMIN" });
    const res = await call(grievancePost, "/api/grievances", {
      method: "POST",
      body: { name: "Asha", email: "asha@test.local", category: "ORDER", subject: "Wrong item", description: "I received the wrong item twice." },
    });
    expect(res.status).toBe(201);
    expect(res.body.ticketNumber).toMatch(/^GRV-\d{6}$/);
    const [ticket] = await db.select().from(supportTickets);
    expect(ticket.subject.startsWith(res.body.ticketNumber)).toBe(true);
    expect(ticket.category).toBe("GRIEVANCE");
    await changeTicketStatus(ticket.id, "IN_PROGRESS", { id: admin.id, role: "ADMIN" });
    await changeTicketStatus(ticket.id, "RESOLVED", { id: admin.id, role: "ADMIN" }, "Replacement delivered.");
    const grievance = await lookupGrievance(res.body.ticketNumber, "asha@test.local");
    expect(grievance).toMatchObject({ status: "RESOLVED", resolutionNotes: "Replacement delivered." });
    const [row] = await db.select().from(grievances);
    expect(row.status).toBe("RESOLVED");
  });

  it("TC-B26-C-047 with ticketForGrievances off, a grievance opens no ticket (original behaviour)", async () => {
    await setRuleRaw("helpdesk", { ticketForGrievances: false });
    const res = await call(grievancePost, "/api/grievances", {
      method: "POST",
      body: { name: "Ravi", email: "ravi@test.local", category: "OTHER", subject: "Question", description: "A question about the platform." },
    });
    expect(res.status).toBe(201);
    expect(await db.select().from(supportTickets)).toHaveLength(0);
  });

  it("TC-B26-C-048 the Grievance Officer comes from the admin rule (fallback: the legal-docs constant) and reaches the compliance check", async () => {
    const defaults = await getGrievanceOfficer();
    expect(defaults.name).toBe("Sonali");
    const admin = await createUser({ role: "ADMIN" });
    await setRule("grievanceOfficer", { name: "Meera Joshi", email: "officer@gokesari.com", phone: "", hours: "Mon–Fri 9–5" }, { id: admin.id, role: "ADMIN" });
    const officer = await getGrievanceOfficer();
    expect(officer).toMatchObject({ name: "Meera Joshi", email: "officer@gokesari.com", phone: "9175193009", hours: "Mon–Fri 9–5" });
    await setRule("grievanceOfficer", { name: "[PLACEHOLDER officer]" }, { id: admin.id, role: "ADMIN" });
    const checklist = await getComplianceChecklist();
    expect(checklist.find((i) => i.area === "Grievance Officer details")?.status).toBe("MISSING");
  });

  it("TC-B26-C-049 the help desk switched off refuses new tickets", async () => {
    await setRuleRaw("helpdesk", { enabled: false });
    const s = await paidOrderAt("DELIVERED");
    await expect(
      createTicket({ category: "ORDER", subject: "Hello", description: "Something about this order.", orderId: s.order.id }, s.customer),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });
});
