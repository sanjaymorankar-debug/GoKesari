/**
 * F13.1.2: Expo push adapter (https://docs.expo.dev/push-notifications/sending-notifications/).
 *
 *   POST https://exp.host/--/api/v2/push/send          up to 100 messages → one ticket each
 *   POST https://exp.host/--/api/v2/push/getReceipts   up to 1000 ticket ids → receipts
 *
 * EXPO_ACCESS_TOKEN is sent as a bearer token when set (needed only when the
 * Expo project has "enhanced push security" on). `fetch` is injectable so the
 * adapter is tested without the network.
 */
import {
  PushTransientError,
  TRANSIENT_PUSH_ERRORS,
  type PushMessage,
  type PushProvider,
  type PushReceiptResult,
  type PushTicketResult,
} from "./types";

export const EXPO_PUSH_SEND_URL = "https://exp.host/--/api/v2/push/send";
export const EXPO_PUSH_RECEIPTS_URL = "https://exp.host/--/api/v2/push/getReceipts";
const SEND_CHUNK = 100;
const RECEIPT_CHUNK = 1000;

export type FetchLike = (
  input: string,
  init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export interface ExpoPushOptions {
  accessToken?: string | null;
  fetch?: FetchLike;
  timeoutMs?: number;
}

interface ExpoTicket {
  status?: "ok" | "error";
  id?: string;
  message?: string;
  details?: { error?: string };
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export function createExpoPushProvider(options: ExpoPushOptions = {}): PushProvider {
  const doFetch: FetchLike = options.fetch ?? ((input, init) => fetch(input, init));
  const timeoutMs = options.timeoutMs ?? 15_000;

  async function post(url: string, payload: unknown): Promise<unknown> {
    const headers: Record<string, string> = {
      accept: "application/json",
      "accept-encoding": "gzip, deflate",
      "content-type": "application/json",
    };
    if (options.accessToken) headers.authorization = `Bearer ${options.accessToken}`;
    let response: Awaited<ReturnType<FetchLike>>;
    try {
      response = await doFetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new PushTransientError(`Expo push service unreachable: ${error instanceof Error ? error.message : String(error)}`);
    }
    const body = (await response.json().catch(() => null)) as { data?: unknown; errors?: { code?: string; message?: string }[] } | null;
    if (!response.ok) {
      const detail = body?.errors?.map((e) => e.code ?? e.message).filter(Boolean).join(", ") || `HTTP ${response.status}`;
      // 429 and 5xx: try again later. Other 4xx (bad credentials, malformed request) are still retried by the
      // outbox and end DEAD with support alerted, which is what a configuration problem needs.
      if (response.status === 429 || response.status >= 500) throw new PushTransientError(`Expo push service busy (${detail}).`);
      throw new Error(`Expo push request refused (${detail}).`);
    }
    return body?.data;
  }

  return {
    name: "expo",

    async send(messages: PushMessage[]): Promise<PushTicketResult[]> {
      const results: PushTicketResult[] = [];
      for (const part of chunk(messages, SEND_CHUNK)) {
        const data = await post(
          EXPO_PUSH_SEND_URL,
          part.map((m) => ({
            to: m.to,
            title: m.title,
            body: m.body,
            data: m.data ?? {},
            sound: m.sound === undefined ? "default" : m.sound,
            ...(m.channelId ? { channelId: m.channelId } : {}),
            priority: "high",
          })),
        );
        const tickets = Array.isArray(data) ? (data as ExpoTicket[]) : [];
        part.forEach((message, index) => {
          const ticket = tickets[index];
          if (ticket?.status === "ok" && ticket.id) {
            results.push({ token: message.to, ok: true, ticketId: ticket.id });
          } else {
            results.push({
              token: message.to,
              ok: false,
              errorCode: ticket?.details?.error ?? (ticket ? "UnknownError" : "NoTicket"),
              errorMessage: (ticket?.message ?? "Expo returned no ticket for this message.").slice(0, 300),
            });
          }
        });
      }
      return results;
    },

    async getReceipts(ticketIds: string[]): Promise<Record<string, PushReceiptResult>> {
      const out: Record<string, PushReceiptResult> = {};
      for (const ids of chunk(ticketIds, RECEIPT_CHUNK)) {
        const data = (await post(EXPO_PUSH_RECEIPTS_URL, { ids })) as Record<string, ExpoTicket> | undefined;
        for (const [id, receipt] of Object.entries(data ?? {})) {
          out[id] =
            receipt?.status === "ok"
              ? { ok: true }
              : {
                  ok: false,
                  errorCode: receipt?.details?.error ?? "UnknownError",
                  errorMessage: (receipt?.message ?? "").slice(0, 300),
                };
        }
      }
      return out;
    },
  };
}

export function isTransientPushError(code: string | undefined): boolean {
  return Boolean(code && TRANSIENT_PUSH_ERRORS.includes(code));
}
