/**
 * MSG91 (docs/sms-2fa-2026-11): one-time codes by SMS in India.
 *
 * Indian SMS must use a DLT-registered sender header and content template
 * (TRAI TCCCPR 2018). The OTP text is registered once on a DLT portal and
 * linked to a template (flow) in MSG91; this module only fills its two
 * variables, ##otp## and ##minutes##, through MSG91's flow API:
 *
 *   POST {MSG91_API_URL}            (https://control.msg91.com/api/v5/flow)
 *   authkey: {MSG91_AUTH_KEY}
 *   { template_id, sender, short_url: "0", recipients: [{ mobiles: "91XXXXXXXXXX", otp, minutes }] }
 *   → { type: "success", message: "<request id>" } | { type: "error", message }
 *
 * Keys come from the environment only. The code and the full number are
 * never logged (numbers are masked to their last four digits).
 */
import { getEnv, msg91ConfigProblem, type ServerEnv } from "@/lib/env";
import { maskPhone } from "@/lib/phone";

export const MSG91_TIMEOUT_MS = 10_000;

export class Msg91Error extends Error {}

export interface Msg91Request {
  url: string;
  headers: Record<string, string>;
  body: {
    template_id: string;
    sender: string;
    short_url: "0";
    DLT_TE_ID?: string;
    recipients: { mobiles: string; otp: string; minutes: string }[];
  };
}

export function isMsg91Available(env: ServerEnv = getEnv()): boolean {
  return msg91ConfigProblem(env) === null;
}

/** The request MSG91 is sent for one code. `toE164` must be an Indian number (+91XXXXXXXXXX). */
export function buildMsg91OtpRequest(
  input: { toE164: string; code: string; expiryMinutes: number },
  env: ServerEnv = getEnv(),
): Msg91Request {
  const problem = msg91ConfigProblem(env);
  if (problem) throw new Msg91Error(`MSG91 is not set up: ${problem}`);
  if (!/^\+91[6-9]\d{9}$/.test(input.toE164)) throw new Msg91Error(`MSG91 sends to Indian mobile numbers only (${maskPhone(input.toE164)}).`);
  if (!/^\d{4,8}$/.test(input.code)) throw new Msg91Error("The one-time code must be 4 to 8 digits.");
  const dltTeId = env.MSG91_DLT_TE_ID?.trim();
  return {
    url: env.MSG91_API_URL,
    headers: { authkey: env.MSG91_AUTH_KEY!.trim(), "content-type": "application/json", accept: "application/json" },
    body: {
      template_id: env.MSG91_OTP_TEMPLATE_ID!.trim(),
      sender: env.MSG91_SENDER_ID!.trim().toUpperCase(),
      short_url: "0",
      ...(dltTeId ? { DLT_TE_ID: dltTeId } : {}),
      recipients: [{ mobiles: input.toE164.slice(1), otp: input.code, minutes: String(input.expiryMinutes) }],
    },
  };
}

/** Sends one code. Throws Msg91Error on a refusal, a timeout or a network failure; returns MSG91's request id. */
export async function sendMsg91Otp(
  input: { toE164: string; code: string; expiryMinutes: number },
  options: { env?: ServerEnv; fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<{ providerRef: string }> {
  const request = buildMsg91OtpRequest(input, options.env ?? getEnv());
  const doFetch = options.fetchImpl ?? fetch;
  const masked = maskPhone(input.toE164);
  let response: Response;
  try {
    response = await doFetch(request.url, {
      method: "POST",
      headers: request.headers,
      body: JSON.stringify(request.body),
      signal: AbortSignal.timeout(options.timeoutMs ?? MSG91_TIMEOUT_MS),
    });
  } catch (error) {
    const reason = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError") ? "timed out" : "network error";
    console.error(`[msg91] send to ${masked} failed: ${reason}`);
    throw new Msg91Error(`MSG91 ${reason}.`);
  }
  const payload = (await response.json().catch(() => null)) as { type?: string; message?: string } | null;
  if (!response.ok || payload?.type !== "success") {
    // MSG91's message never contains the code; it is shortened all the same.
    const said = String(payload?.message ?? "").slice(0, 120);
    console.error(`[msg91] send to ${masked} refused: HTTP ${response.status} ${said}`);
    throw new Msg91Error(`MSG91 refused the message (HTTP ${response.status}).`);
  }
  return { providerRef: `msg91:${String(payload.message ?? "").slice(0, 64)}` };
}
