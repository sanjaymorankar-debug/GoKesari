/**
 * Complete user profile after OTP verification (first-time login).
 * PUT/PATCH { name, gender?, deliveryAddress: {...}, latitude?, longitude? }
 */
import type { NextRequest } from "next/server";
import { z } from "zod";
import { eq } from "drizzle-orm";

import { ok, parseBody, route } from "@/server/api/handler";
import { getCurrentUser } from "@/server/authz/guards";
import { db } from "@/server/db";
import { users, addresses } from "@/server/db/schema";

export const dynamic = "force-dynamic";

const schema = z.object({
  name: z.string().min(1).max(255),
  gender: z.enum(["MALE", "FEMALE", "OTHER"]).optional(),
  mobileNumber: z.string().min(10).max(20).optional(),
  deliveryAddress: z.object({
    label: z.string().max(50).optional(),
    line1: z.string().min(1).max(255),
    line2: z.string().max(255).optional(),
    area: z.string().max(100).optional(),
    city: z.string().min(1).max(100),
    state: z.string().max(50).optional(),
    pincode: z.string().min(6).max(10),
    latitude: z.string().optional(),
    longitude: z.string().optional(),
    landmark: z.string().max(255).optional(),
    recipientName: z.string().max(255).optional(),
    recipientPhone: z.string().max(20).optional(),
  }).optional(),
  skip: z.boolean().optional(),
});

export const PUT = route(async (request: NextRequest) => {
  const user = await getCurrentUser();
  if (!user) return ok({ error: "Unauthorized" }, { status: 401 });

  const body = await parseBody(request, schema);

  if (body.skip) {
    // Just mark profile as needing completion later
    await db
      .update(users)
      .set({ updatedAt: new Date() })
      .where(eq(users.id, user.id));
    return ok({ message: "Profile skipped. You can complete it later." });
  }

  // Validate name is provided if not skipping
  if (!body.name) {
    return ok({ error: "Name is required" }, { status: 400 });
  }

  const updateData: any = {
    name: body.name,
    profileCompletedAt: new Date(),
    updatedAt: new Date(),
  };

  if (body.gender) {
    updateData.gender = body.gender;
  }

  if (body.mobileNumber) {
    const { parsePhone } = await import("@/lib/phone");
    const parsed = parsePhone("+91", body.mobileNumber);
    if (!parsed.ok) {
      return ok({ error: parsed.error }, { status: 400 });
    }
    const taken = await db
      .select({ id: users.id })
      .from(users)
      .where(
        (q: any) => q.and(
          q.eq(users.phoneE164, parsed.e164),
          q.ne(users.id, user.id)
        )
      );
    if (taken.length > 0) {
      return ok({ error: "That mobile number is already linked to another account." }, { status: 409 });
    }
    updateData.phoneE164 = parsed.e164;
    updateData.phone = parsed.national;
  }

  await db.transaction(async (tx) => {
    await tx.update(users).set(updateData).where(eq(users.id, user.id));

    if (body.deliveryAddress) {
      const [existingDefault] = await tx
        .select({ id: addresses.id })
        .from(addresses)
        .where(
          (q: any) => q.and(
            q.eq(addresses.userId, user.id),
            q.eq(addresses.isDefault, true),
            q.isNull(addresses.deletedAt)
          )
        );

      const addressData: any = {
        userId: user.id,
        label: body.deliveryAddress.label || "Home",
        line1: body.deliveryAddress.line1,
        line2: body.deliveryAddress.line2,
        area: body.deliveryAddress.area,
        city: body.deliveryAddress.city,
        state: body.deliveryAddress.state,
        pincode: body.deliveryAddress.pincode,
        latitude: body.deliveryAddress.latitude,
        longitude: body.deliveryAddress.longitude,
        landmark: body.deliveryAddress.landmark,
        recipientName: body.deliveryAddress.recipientName,
        recipientPhone: body.deliveryAddress.recipientPhone,
        addressType: "HOME",
        isDefault: true,
        locationSource: body.deliveryAddress.latitude ? "MANUAL_ENTRY" : undefined,
      };

      if (existingDefault) {
        await tx
          .update(addresses)
          .set({ isDefault: false })
          .where(eq(addresses.id, existingDefault.id));
      }

      await tx.insert(addresses).values(addressData);
    }
  });

  return ok({
    message: "Profile completed successfully",
    user: { name: body.name, gender: body.gender },
  });
};

export const PATCH = PUT;
