/**
 * GoKesari Health live stream (server-sent events): pushes health and appointment events to the signed-in
 * user's open screens — the doctor's Today list, the store's prescription inbox, the patient's record and
 * queue position — the moment they happen (docs/health/README.md "Events and real time"). Events carry ids
 * and statuses only; screens reload their data from the normal APIs.
 */
import { requireUser } from "@/server/authz/guards";
import { shopsOfUser } from "@/server/health/access";
import { subscribeHealth, type HealthLiveEvent } from "@/server/health/events";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const HEARTBEAT_MS = 25_000;

export async function GET(request: Request): Promise<Response> {
  let user;
  try {
    user = await requireUser();
  } catch {
    return new Response("Sign in to see live updates.", { status: 401 });
  }
  const shopIds = await shopsOfUser(user.id);
  const encoder = new TextEncoder();
  let cleanup: () => void = () => {};
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (chunk: string) => {
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          cleanup();
        }
      };
      send(`retry: 3000\nevent: ready\ndata: ${JSON.stringify({ shops: shopIds.length })}\n\n`);
      const unsubscribe = subscribeHealth({ userId: user.id, shopIds }, (event: HealthLiveEvent) => {
        send(`id: ${event.id}\nevent: health\ndata: ${JSON.stringify(event)}\n\n`);
      });
      const timer = setInterval(() => send(`: ping ${Date.now()}\n\n`), HEARTBEAT_MS);
      cleanup = () => {
        clearInterval(timer);
        unsubscribe();
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };
      request.signal.addEventListener("abort", () => cleanup());
    },
    cancel() {
      cleanup();
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "private, no-store, no-transform",
      Connection: "keep-alive",
      // nginx / proxies: do not buffer the stream.
      "X-Accel-Buffering": "no",
    },
  });
}
