/**
 * The mock DigiLocker consent page's buttons (gig worker flow; local work, CI
 * and test.gokesari.com). Refused on gokesari.com and for a session the mock
 * did not start. Returns where to send the partner: the return link DigiLocker
 * would have used.
 */
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { isProductionSite } from "@/lib/env";
import { decideMockDigilocker, MOCK_DIGILOCKER_DECISIONS } from "@/server/kyc/adapters/mock";

export const dynamic = "force-dynamic";

const schema = z.object({ session: z.string().min(8).max(80), decision: z.enum(MOCK_DIGILOCKER_DECISIONS) });

export async function POST(request: NextRequest): Promise<NextResponse> {
  if (isProductionSite()) return NextResponse.json({ error: "Not available" }, { status: 404 });
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Bad request" }, { status: 400 });
  const redirectUrl = decideMockDigilocker(parsed.data.session, parsed.data.decision);
  if (!redirectUrl) return NextResponse.json({ error: "Unknown or forgotten mock session — start again." }, { status: 404 });
  return NextResponse.json({ redirectUrl });
}
