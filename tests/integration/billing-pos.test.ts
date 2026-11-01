/**
 * Billing v2 phase 8 (docs/billing §4.7; §13 scenario 16): bills made on the
 * counter POS while offline reach GoKesari later — numbered in the order they
 * were made with no gaps, never twice (a re-send or a parallel sync returns the
 * same invoice), with what changed meanwhile reported per bill. Both layouts.
 */
import { NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

const session = vi.hoisted(() => ({ user: null as null | { id: string; email: string; name: string | null; image: null; role: string; status: string } }));
vi.mock("@/server/auth", () => ({ auth: async () => (session.user ? { user: session.user } : null), handlers: {}, signIn: async () => {}, signOut: async () => {} }));

import { GET, POST } from "@/app/api/shops/[id]/accounts/[...path]/route";
import { db } from "@/server/db";
import { accSalesInvoices, featureFlags, shopProducts } from "@/server/db/schema";
import { posItems, syncPosBills, type PosBill } from "@/server/accounts/pos";
import { gstShop, resetBatchE } from "../helpers/batch-e";
import { createUser, resetDatabase } from "../helpers/fixtures";

async function flag(enabled: boolean) {
  await db.insert(featureFlags).values({ key: "billing_v2", enabled }).onConflictDoUpdate({ target: featureFlags.key, set: { enabled } });
}

const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
const bill = (ref: string, at: string, lines: PosBill["lines"], paymentMode: PosBill["paymentMode"] = "CASH"): PosBill => ({ clientRef: `pos-${ref}-0000`, createdAt: at, paymentMode, lines });
const seq = (no: string) => Number(/(\d+)$/.exec(no)![1]);

beforeEach(async () => {
  await resetDatabase();
  await resetBatchE();
  await createUser({ role: "ADMIN" });
  await flag(true);
  session.user = null;
});

describe("offline counter bills", () => {
  it("numbers bills in the order they were made, with no gaps, and never issues one twice", async () => {
    const s = await gstShop();
    const items = await posItems(s.shop.id);
    const milk = items.find((i) => i.id === s.milkSp.id)!;
    expect(milk).toMatchObject({ name: "Cow Milk", pricePaise: 10_500, gstRateBp: 500 });
    const line = (qty: number) => [{ shopProductId: milk.id, name: milk.name, qtyMilli: qty * 1000, pricePaise: milk.pricePaise!, gstRateBp: milk.gstRateBp }];

    // Three bills made offline, sent out of order.
    const bills = [bill("c", minutesAgo(10), line(3)), bill("a", minutesAgo(30), line(1)), bill("b", minutesAgo(20), line(2), "UPI")];
    const first = await syncPosBills(s.shop.id, bills, s.owner);
    expect(first.map((r) => [r.clientRef, r.status])).toEqual([
      ["pos-a-0000", "CREATED"],
      ["pos-b-0000", "CREATED"],
      ["pos-c-0000", "CREATED"],
    ]);
    const numbers = first.map((r) => seq(r.invoiceNo!));
    expect(numbers).toEqual([numbers[0], numbers[0] + 1, numbers[0] + 2]);
    expect(first[0].totalPaise).toBe(10_500);

    // The device did not hear back and sends the queue again, twice at once.
    const [again, twice] = await Promise.all([syncPosBills(s.shop.id, bills, s.owner), syncPosBills(s.shop.id, bills, s.owner)]);
    for (const r of [...again, ...twice]) expect(r.status).toBe("DUPLICATE");
    expect(again.map((r) => r.invoiceId)).toEqual(first.map((r) => r.invoiceId));
    expect(await db.select().from(accSalesInvoices).where(eq(accSalesInvoices.shopId, s.shop.id))).toHaveLength(3);

    // A fresh bill sent twice at once is issued once.
    const d = bill("d", minutesAgo(1), line(1));
    const [x, y] = await Promise.all([syncPosBills(s.shop.id, [d], s.owner), syncPosBills(s.shop.id, [d], s.owner)]);
    expect([x[0].status, y[0].status].sort()).toEqual(["CREATED", "DUPLICATE"]);
    expect(x[0].invoiceId).toBe(y[0].invoiceId);
    expect(seq(x[0].invoiceNo!)).toBe(numbers[2] + 1);
  });

  it("rejects a bill whose item left the shop, warns about price and stock, and keeps the series gapless", async () => {
    const s = await gstShop();
    const [milk, ghee] = [s.milkSp.id, s.gheeSp.id];
    await db.update(shopProducts).set({ isActive: false }).where(eq(shopProducts.id, ghee));
    await db.update(shopProducts).set({ onlinePricePaise: 11_000, onlineStock: 1 }).where(eq(shopProducts.id, milk));

    const out = await syncPosBills(
      s.shop.id,
      [
        bill("g", minutesAgo(5), [{ shopProductId: ghee, name: "Ghee 500ml", qtyMilli: 1000, pricePaise: 33_600, gstRateBp: 1200 }]),
        bill("m", minutesAgo(4), [{ shopProductId: milk, name: "Cow Milk", qtyMilli: 2000, pricePaise: 10_500, gstRateBp: 500 }]),
        bill("n", minutesAgo(3), [{ shopProductId: milk, name: "Cow Milk", qtyMilli: 1000, pricePaise: 11_000, gstRateBp: 500 }]),
      ],
      s.owner,
    );
    expect(out[0]).toMatchObject({ status: "REJECTED" });
    expect(out[0].reason).toContain("Ghee 500ml");
    expect(out[1].status).toBe("CREATED");
    expect(out[1].warnings.join(" ")).toMatch(/price is now ₹110\.00/);
    expect(out[1].warnings.join(" ")).toMatch(/stock goes below zero/);
    expect(out[1].totalPaise).toBe(21_000);
    expect(out[2]).toMatchObject({ status: "CREATED", warnings: [] });
    expect(seq(out[2].invoiceNo!)).toBe(seq(out[1].invoiceNo!) + 1);

    // A bill made yesterday offline carries yesterday's date.
    const old = await syncPosBills(s.shop.id, [bill("y", minutesAgo(26 * 60), [{ shopProductId: milk, name: "Cow Milk", qtyMilli: 1000, pricePaise: 11_000, gstRateBp: 500 }])], s.owner);
    const [row] = await db.select().from(accSalesInvoices).where(eq(accSalesInvoices.id, old[0].invoiceId!));
    expect(String(row.invoiceDate)).toBe(new Date(Date.now() - 26 * 3600_000 + 330 * 60_000).toISOString().slice(0, 10));
  });

  it("serves the item list and takes the queue through the shop's accounts API (billing_v2 only)", async () => {
    const s = await gstShop();
    session.user = { id: s.owner.id, email: s.owner.email, name: s.owner.name, image: null, role: s.owner.role, status: "ACTIVE" };
    const call = async (method: "GET" | "POST", path: string[], body?: unknown) => {
      const handler = method === "GET" ? GET : POST;
      const res = await (handler as unknown as (r: NextRequest, c: { params: Promise<{ id: string; path: string[] }> }) => Promise<Response>)(
        new NextRequest(`http://localhost/api/shops/${s.shop.id}/accounts/${path.join("/")}`, { method, headers: body ? { "content-type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined }),
        { params: Promise.resolve({ id: s.shop.id, path }) },
      );
      return { status: res.status, json: (await res.json()) as { data?: unknown } };
    };
    const items = await call("GET", ["pos", "items"]);
    expect(items.status).toBe(200);
    expect(JSON.stringify(items.json)).toContain(s.milkSp.id);
    const sent = await call("POST", ["pos", "sync"], { bills: [bill("r", minutesAgo(2), [{ shopProductId: s.milkSp.id, name: "Cow Milk", qtyMilli: 1000, pricePaise: 10_500, gstRateBp: 500 }])] });
    expect(sent.status).toBe(200);
    expect(JSON.stringify(sent.json)).toContain('"status":"CREATED"');

    await flag(false);
    expect((await call("GET", ["pos", "items"])).status).toBe(404);
  });
});
