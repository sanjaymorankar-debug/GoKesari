/**
 * Voucher preview (§18) — computes the bonus without creating a payment
 * order or moving anything. Distinct from `/api/wallet/topup`'s own
 * (authoritative) recomputation, which happens again independently when the
 * customer actually proceeds — this endpoint exists purely so the UI can show
 * "Bonus ₹100, Total credit ₹1,100" before committing to a payment.
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route } from "@/server/api/handler";
import { RATE_LIMITS, enforceRateLimit } from "@/server/api/rate-limit";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { previewVoucher } from "@/server/services/vouchers";

const schema = z.object({
  code: z.string().min(1).max(32),
  amountPaise: z.number().int().positive(),
});

export const POST = route(async (request: NextRequest) => {
  const user = await requirePermission(PERMISSIONS.WALLET_TOPUP_OWN);
  enforceRateLimit(`voucher-preview:${user.id}`, RATE_LIMITS.VOUCHER_PREVIEW);

  const { code, amountPaise } = await parseBody(request, schema);
  return ok(await previewVoucher(code, amountPaise, user.id));
});
