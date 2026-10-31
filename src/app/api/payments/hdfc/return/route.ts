/**
 * Where HDFC SmartGateway sends the customer back after the payment page:
 *   GET | POST /api/payments/hdfc/return?to=<our page>
 * The bank may come back with a form POST, which our pages cannot take, so
 * this forwards (303) to the page the payment was started from. Nothing is
 * decided here: that page asks the gateway for the state (fetchOrder). A bad
 * signature is only logged.
 */
import { NextResponse, type NextRequest } from "next/server";

import { getEnv } from "@/lib/env";
import { paymentBaseUrl } from "@/server/payments/gateway/common";
import { verifyReturnSignature } from "@/server/payments/gateway/hdfc";

export const dynamic = "force-dynamic";

/** Only a path on this site: no other host, no protocol-relative "//". */
function safeTarget(to: string | null): string {
  return to && to.startsWith("/") && !to.startsWith("//") && !to.startsWith("/\\") ? to : "/";
}

function forward(request: NextRequest, params: Record<string, string>): NextResponse {
  if (params.signature && !verifyReturnSignature(params, getEnv().HDFC_RESPONSE_KEY)) {
    console.warn("[payments:hdfc] return signature did not match", params.order_id ?? "?");
  }
  const target = new URL(safeTarget(request.nextUrl.searchParams.get("to")), paymentBaseUrl());
  return NextResponse.redirect(target, 303);
}

function queryParams(request: NextRequest): Record<string, string> {
  const params: Record<string, string> = {};
  for (const [key, value] of request.nextUrl.searchParams) if (key !== "to") params[key] = value;
  return params;
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  return forward(request, queryParams(request));
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const params = queryParams(request);
  try {
    const form = await request.formData();
    for (const [key, value] of form) if (typeof value === "string") params[key] = value;
  } catch {
    // Not a form body: forward anyway.
  }
  return forward(request, params);
}
