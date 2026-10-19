/**
 * Opens one notification (F3.3.2, deep link "notification" — F15.2.3): marks
 * it read for the signed-in person and goes to where it points (its
 * actionUrl), or back to the Notification Centre. Used by the bell panel, the
 * /notifications list and push taps; a link to someone else's notification
 * just lands on the centre.
 */
import { NextResponse, type NextRequest } from "next/server";

import { getCurrentUser } from "@/server/authz/guards";
import { getOwnNotification, safeActionUrl } from "@/server/notifications/centre";
import { markRead } from "@/server/services/notifications";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }): Promise<Response> {
  // Behind the host's proxy request.url can be the internal address; the site's own URL is AUTH_URL.
  const to = (path: string) =>
    NextResponse.redirect(new URL(path, (process.env.AUTH_URL ?? request.nextUrl.origin).replace(/\/$/, "")), 303);
  const user = await getCurrentUser();
  if (!user) return to("/signin");
  const { id } = await context.params;
  const notification = await getOwnNotification(user.id, id);
  if (!notification) return to("/notifications");
  await markRead(user.id, notification.id);
  return to(safeActionUrl(notification.actionUrl) ?? "/notifications");
}
