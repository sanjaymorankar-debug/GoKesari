/**
 * F13.1.2: mock push provider for the test site and development. Nothing
 * leaves the server: each push is written to the test outbox
 * (outbound_test_messages, channel PUSH) so testers can read it at
 * /admin/test-messages next to the mock SMS and WhatsApp messages.
 *
 * To rehearse failures without a phone, a token whose text contains an Expo
 * error code answers with that error, e.g. ExponentPushToken[DeviceNotRegistered-1]
 * (the token is then deactivated, as with Expo) or ExponentPushToken[MessageRateExceeded-1].
 */
import { sql } from "drizzle-orm";

import { db } from "@/server/db";
import { DEVICE_NOT_REGISTERED, type PushMessage, type PushProvider, type PushReceiptResult, type PushTicketResult } from "./types";

const SIMULATED_ERRORS = [DEVICE_NOT_REGISTERED, "MessageRateExceeded", "MessageTooBig", "InvalidCredentials"];

export function mockPushText(message: PushMessage): string {
  const url = message.data?.url ? ` ${message.data.url}` : "";
  return `${message.title} — ${message.body}${url}`.slice(0, 2000);
}

export function createMockPushProvider(): PushProvider {
  return {
    name: "mock",

    async send(messages: PushMessage[]): Promise<PushTicketResult[]> {
      const results: PushTicketResult[] = [];
      for (const message of messages) {
        const simulated = SIMULATED_ERRORS.find((code) => message.to.includes(code));
        if (simulated) {
          results.push({ token: message.to, ok: false, errorCode: simulated, errorMessage: `Simulated ${simulated} (mock push).` });
          continue;
        }
        // outbound_test_messages.channel is plain text in the database; PUSH is written with SQL so
        // the SMS/WhatsApp type of that table stays as it is.
        const [row] = await db.execute<{ id: string }>(sql`
          INSERT INTO outbound_test_messages (channel, to_address, body, purpose)
          VALUES ('PUSH', ${message.to}, ${mockPushText(message)}, 'notification')
          RETURNING id
        `);
        results.push({ token: message.to, ok: true, ticketId: `mock-${row?.id ?? "unknown"}` });
      }
      return results;
    },

    async getReceipts(ticketIds: string[]): Promise<Record<string, PushReceiptResult>> {
      return Object.fromEntries(ticketIds.map((id) => [id, { ok: true }]));
    },
  };
}
