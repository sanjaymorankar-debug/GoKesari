/**
 * SMSFortius (docs/sms-2fa-2026-11): one-time codes by SMS in India, the owner's DLT-registered vendor
 * (26-Nov-2026). Indian SMS must use a DLT-registered sender header and content template (TRAI TCCCPR 2018);
 * the text sent here is exactly the registered template (smsOtpText), with its two {#var#} filled in; any other
 * wording is rejected by the operator (SMSFortius error 633).
 *
 *   GET {SMSFORTIUS_API_URL}?apikey=…&senderid=GOKSRI&templateid=<DLT template id>&number=9XXXXXXXXX&message=<text>
 *
 * The API key comes from the server environment only and is never logged (the URL carries it, so the URL is
 * never logged either); numbers are masked to their last four digits and the code is never logged.
 */
import { getEnv, smsFortiusConfigProblem, type ServerEnv } from "@/lib/env";
import { maskPhone } from "@/lib/phone";

export const SMSFORTIUS_TIMEOUT_MS = 10_000;

export class SmsFortiusError extends Error {}

export function isSmsFortiusAvailable(env: ServerEnv = getEnv()): boolean {
  return smsFortiusConfigProblem(env) === null;
}

/** The URL SMSFortius is called with for one message. `toE164` must be an Indian mobile (+91XXXXXXXXXX). */
export function buildSmsFortiusUrl(input: { toE164: string; text: string }, env: ServerEnv = getEnv()): string {
  const problem = smsFortiusConfigProblem(env);
  if (problem) throw new SmsFortiusError(`SMSFortius is not set up: ${problem}`);
  if (!/^\+91[6-9]\d{9}$/.test(input.toE164)) throw new SmsFortiusError(`SMSFortius sends to Indian mobile numbers only (${maskPhone(input.toE164)}).`);
  const url = new URL(env.SMSFORTIUS_API_URL);
  url.searchParams.set("apikey", env.SMSFORTIUS_API_KEY!.trim());
  url.searchParams.set("senderid", env.SMSFORTIUS_SENDER_ID!.trim().toUpperCase());
  url.searchParams.set("templateid", env.SMSFORTIUS_OTP_TEMPLATE_ID!.trim());
  url.searchParams.set("number", input.toE164.slice(3));
  url.searchParams.set("message", input.text);
  // Spaces as %20 rather than "+": DLT matching compares the text word for word, so it must reach the operator
  // exactly as written whichever way the vendor decodes the query.
  return url.toString().replace(/\+/g, "%20");
}

/**
 * Whether SMSFortius accepted the message. Its V2 API answers HTTP 200 with a short JSON or text status; an
 * answer that mentions an error, an invalid field, a failure or a low balance is a refusal.
 */
export function smsFortiusAccepted(status: number, body: string): boolean {
  if (status < 200 || status >= 300) return false;
  return !/\b(error|invalid|fail(ed|ure)?|denied|unauthori[sz]ed|insufficient|blocked|not\s+allowed)\b/i.test(body);
}

/** Sends one text. Throws SmsFortiusError on a refusal, a timeout or a network failure. */
export async function sendSmsFortiusText(
  input: { toE164: string; text: string },
  options: { env?: ServerEnv; fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<{ providerRef: string }> {
  const url = buildSmsFortiusUrl(input, options.env ?? getEnv());
  const doFetch = options.fetchImpl ?? fetch;
  const masked = maskPhone(input.toE164);
  let response: Response;
  try {
    response = await doFetch(url, { method: "GET", signal: AbortSignal.timeout(options.timeoutMs ?? SMSFORTIUS_TIMEOUT_MS) });
  } catch (error) {
    const reason = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError") ? "timed out" : "network error";
    console.error(`[smsfortius] send to ${masked} failed: ${reason}`);
    throw new SmsFortiusError(`SMSFortius ${reason}.`);
  }
  const body = (await response.text().catch(() => "")).slice(0, 300);
  if (!smsFortiusAccepted(response.status, body)) {
    // The answer never contains the code or the key; it is shortened all the same.
    console.error(`[smsfortius] send to ${masked} refused: HTTP ${response.status} ${body.slice(0, 120)}`);
    throw new SmsFortiusError(`SMSFortius refused the message (HTTP ${response.status}).`);
  }
  console.info(`[smsfortius] sent to ${masked}: ${body.slice(0, 80)}`);
  return { providerRef: `smsfortius:${body.replace(/\s+/g, " ").slice(0, 64)}` };
}
