/**
 * NEW-007: the order's invoice — issued on first request for an order
 * delivered before invoicing was switched on. Customer of the order, its
 * shop's owner, or operations.
 */
import { NextResponse, type NextRequest } from "next/server";

import { forbidden, notFound } from "@/lib/errors";
import { ok, route, type RouteContext } from "@/server/api/handler";
import { requireUser } from "@/server/authz/guards";
import { db } from "@/server/db";
import { canViewInvoice, issueInvoiceForOrder } from "@/server/services/invoices";

export const dynamic = "force-dynamic";

async function issueFor(id: string) {
  const user = await requireUser();
  const order = await db.query.orders.findFirst({ where: (o, { eq }) => eq(o.id, id) });
  if (!order) throw notFound("Order");
  const shop = await db.query.shops.findFirst({ where: (s, { eq }) => eq(s.id, order.shopId) });
  const allowed = user.role === "ADMIN" || user.role === "OPERATOR" || order.userId === user.id || shop?.ownerId === user.id;
  if (!allowed) throw forbidden("This order is not yours.");
  const invoice = await issueInvoiceForOrder(id);
  if (!invoice) throw notFound("Invoice");
  if (!(await canViewInvoice(invoice, user))) throw forbidden("This order is not yours.");
  return invoice;
}

export const POST = route(async (_request: NextRequest, context: RouteContext<{ id: string }>) => {
  const invoice = await issueFor((await context.params).id);
  return ok({ id: invoice.id, invoiceNumber: invoice.invoiceNumber, url: `/invoices/${invoice.id}`, pdfUrl: `/api/invoices/${invoice.id}/pdf` });
});

/** Links from order lists: issue if needed, then open the invoice. */
export const GET = route(async (_request: NextRequest, context: RouteContext<{ id: string }>) => {
  const invoice = await issueFor((await context.params).id);
  // Relative Location: behind the host's proxy request.url carries the
  // internal host (same as the referral link, /r/[code]).
  return new NextResponse(null, { status: 303, headers: { Location: `/invoices/${invoice.id}` } });
});
