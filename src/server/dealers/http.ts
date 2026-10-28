/**
 * Small helpers the dealer routes share (docs/dealer-programme).
 */
import { requestHost } from "@/lib/deep-links";
import { isTextChannelAvailable } from "@/server/messaging/sms-whatsapp";
import { requireFeature } from "@/server/services/feature-flags";

/** Every dealer route: the programme must be on somewhere, or the route does not exist (404). */
export function requireDealerProgramme(): Promise<void> {
  return requireFeature("dealer_programme_enabled");
}

/** https://<host the request came to> — for share links and QR codes. */
export function originOf(request: Request): string {
  return originFromHeaders(request.headers);
}

/** The same from a page's headers() (server components have no Request). */
export function originFromHeaders(headers: Headers): string {
  const host = requestHost({ headers } as Request);
  const proto = headers.get("x-forwarded-proto")?.split(",")[0]?.trim() ?? (host.startsWith("localhost") || host.startsWith("127.") ? "http" : "https");
  return `${proto}://${host}`;
}

export function smsAvailable(): boolean {
  return isTextChannelAvailable("SMS");
}
