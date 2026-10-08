/**
 * Administrator's manual shop wallet entry: a credit (a recharge paid in cash
 * or by bank transfer) or a debit (a correction). It is a ledger entry like
 * any other — the balance is never edited directly — never overdraws, is
 * audited, and the shop's owner is told.
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route, type RouteContext } from "@/server/api/handler";
import { RATE_LIMITS, enforceRateLimit } from "@/server/api/rate-limit";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { adjustShopWallet } from "@/server/services/shop-wallet";

const schema = z.object({
  direction: z.enum(["CREDIT", "DEBIT"]),
  amountPaise: z.number().int().positive().max(100_000_000),
  reason: z.string().min(3).max(300),
  /** Client-generated, so a double submit cannot adjust twice. */
  requestId: z.string().min(8).max(64),
});

export const POST = route(async (request: NextRequest, context: RouteContext<{ id: string }>) => {
  const admin = await requirePermission(PERMISSIONS.WALLET_ADJUST);
  enforceRateLimit(`shop-wallet-adjust:${admin.id}`, RATE_LIMITS.MUTATION);
  const { id } = await context.params;
  const body = await parseBody(request, schema);
  const result = await adjustShopWallet({ shopId: id, ...body }, admin);
  return ok({ balancePaise: result.balancePaise, deduplicated: result.deduplicated, entryId: result.transaction.id });
});
