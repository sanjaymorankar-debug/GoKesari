/**
 * Get or update user profile information.
 * GET returns user details
 * PUT updates user details (except email, which requires OTP verification)
 */
import type { NextRequest } from "next/server";
import { z } from "zod";
import { eq, isNull } from "drizzle-orm";

import { ok, parseBody, route } from "@/server/api/handler";
import { getCurrentUser } from "@/server/authz/guards";
import { db } from "@/server/db";
import { users } from "@/server/db/schema";

export const dynamic = "force-dynamic";

export const GET = route(async () => {
  const user = await getCurrentUser();
  if (!user) return ok({ error: "Unauthorized" }, { status: 401 });

  return ok({
    id: user.id,
    name: user.name,
    email: user.email,
    phone: user.phone,
    phoneE164: user.phoneE164,
    image: user.image,
    gender: user.gender,
    profileCompletedAt: user.profileCompletedAt,
    emailVerified: user.emailVerified,
    phoneVerified: user.phoneVerifiedAt,
    createdAt: user.createdAt,
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
  if (!user) return ok({ error: "Unauthorized" }, { status: 401 });

  const body = await parseBody(request, updateSchema);
  const updateData: any = { updatedAt: new Date() };

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
      return ok({ error: parsed.error }, { status: 400 });
    }

    const [taken] = await db
      .select({ id: users.id })
      .from(users)
      .where(
        (q: any) => q.and(
          q.eq(users.phoneE164, parsed.e164),
          q.ne(users.id, user.id),
          q.isNull(users.deletedAt)
        )
      );

    if (taken) {
      return ok(
        { error: "That mobile number is already linked to another account." },
        { status: 409 }
      );
    }

    updateData.phoneE164 = parsed.e164;
    updateData.phone = parsed.national;
    updateData.phoneVerifiedAt = null; // Reset verification
  }

  await db.update(users).set(updateData).where(eq(users.id, user.id));

  return ok({ message: "Profile updated successfully" });
});
