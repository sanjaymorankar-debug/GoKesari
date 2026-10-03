/**
 * Get or update user profile information.
 * GET returns user details
 * PUT updates user details (except email, which requires OTP verification)
 */
import type { NextRequest } from "next/server";
import { z } from "zod";
import { and, eq, isNull, ne } from "drizzle-orm";

import { ok, parseBody, route } from "@/server/api/handler";
import { getCurrentUser } from "@/server/authz/guards";
import { AppError, validationFailed } from "@/lib/errors";
import { db } from "@/server/db";
import { users } from "@/server/db/schema";

export const dynamic = "force-dynamic";

export const GET = route(async () => {
  const user = await getCurrentUser();
  if (!user) throw new AppError("UNAUTHENTICATED", "Not signed in", { status: 401 });

  return ok({
    id: user.id,
    name: user.name,
    email: user.email,
    image: user.image,
  });
});

const updateSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  gender: z.enum(["MALE", "FEMALE", "OTHER"]).optional(),
  image: z.string().url().optional(),
  mobileNumber: z.string().min(10).max(20).optional(),
});

export const PUT = route(async (request: NextRequest) => {
  const user = await getCurrentUser();
  if (!user) throw new AppError("UNAUTHENTICATED", "Not signed in", { status: 401 });

  const body = await parseBody(request, updateSchema);
  const updateData: Record<string, unknown> = { updatedAt: new Date() };

  if (body.name !== undefined) {
    updateData.name = body.name;
  }

  if (body.gender !== undefined) {
    updateData.gender = body.gender;
  }

  if (body.image !== undefined) {
    updateData.image = body.image;
  }

  if (body.mobileNumber !== undefined) {
    const { parsePhone } = await import("@/lib/phone");
    const parsed = parsePhone("+91", body.mobileNumber);
    if (!parsed.ok) {
      throw validationFailed(parsed.error);
    }

    const [taken] = await db
      .select({ id: users.id })
      .from(users)
      .where(
        and(
          eq(users.phoneE164, parsed.e164),
          ne(users.id, user.id),
          isNull(users.deletedAt)
        )
      );

    if (taken) {
      throw new AppError("CONFLICT", "That mobile number is already linked to another account.");
    }

    updateData.phoneE164 = parsed.e164;
    updateData.phone = parsed.national;
    updateData.phoneVerifiedAt = null; // Reset verification
  }

  await db.update(users).set(updateData).where(eq(users.id, user.id));

  return ok({ message: "Profile updated successfully" });
});
