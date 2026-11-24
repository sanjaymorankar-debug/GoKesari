/**
 * GA-005 — a batched rider's trip: every pickup, then every drop, in the
 * order to do them, with arrival estimates. The main delivery card above
 * always holds the stop marked "Next"; each order keeps its own status and
 * handover codes.
 */
import { Badge, Card } from "@/components/ui";
import { L, tr, type Lang } from "@/lib/board/i18n";

/** Module 6 (docs/hindi-marathi-2026-11/). */
const T = {
  title: L("Your trip — {n} orders", "आपकी ट्रिप — {n} ऑर्डर", "तुमची ट्रिप — {n} ऑर्डर"),
  hint: L(
    "Collect every order first, then drop them in this order.",
    "पहले सभी ऑर्डर उठाएँ, फिर इसी क्रम में पहुँचाएँ।",
    "आधी सर्व ऑर्डर उचला, मग याच क्रमाने पोहोचवा.",
  ),
  pickUp: L("Pick up", "पिकअप", "पिकअप"),
  drop: L("Drop", "ड्रॉप", "ड्रॉप"),
  next: L("Next", "अगला", "पुढचा"),
  done: L("Done", "पूरा", "पूर्ण"),
  late: L("Running late", "देर हो रही है", "उशीर होत आहे"),
  about: L(" · about {t}", " · लगभग {t}", " · सुमारे {t}"),
} as const;

export interface TripStopView {
  kind: "PICKUP" | "DROP";
  deliveryOrderId: string;
  orderNumber: string;
  label: string;
  done: boolean;
  current: boolean;
  eta: string | null;
  late: boolean;
}

const time = (iso: string) =>
  new Date(iso).toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit", timeZone: "Asia/Kolkata" });

export function RiderTripCard({ stops, lang = "en" }: { stops: TripStopView[]; lang?: Lang }) {
  const orders = new Set(stops.map((s) => s.orderNumber)).size;
  return (
    <Card className="mt-4 p-4" data-testid="rider-trip">
      <p className="font-semibold text-ink-900">{tr(T.title, lang).replace("{n}", String(orders))}</p>
      <p className="text-xs text-ink-500">{tr(T.hint, lang)}</p>
      <ol className="mt-3 space-y-2 text-sm">
        {stops.map((stop, i) => (
          <li
            key={`${stop.kind}-${stop.deliveryOrderId}`}
            className={stop.current ? "rounded-lg bg-kesari-50 p-2" : "p-2"}
            data-testid={`trip-stop-${i}`}
          >
            <span className="flex flex-wrap items-center gap-2">
              <span className={stop.done ? "text-ink-500 line-through" : "font-medium text-ink-900"}>
                {i + 1}. {tr(stop.kind === "PICKUP" ? T.pickUp : T.drop, lang)} {stop.orderNumber}
              </span>
              {stop.current ? <Badge tone="warning">{tr(T.next, lang)}</Badge> : null}
              {stop.done ? <Badge tone="success">{tr(T.done, lang)}</Badge> : null}
              {stop.late ? <Badge tone="danger">{tr(T.late, lang)}</Badge> : null}
            </span>
            <span className="block text-xs text-ink-500">
              {stop.label}
              {stop.eta && !stop.done ? tr(T.about, lang).replace("{t}", time(stop.eta)) : ""}
            </span>
          </li>
        ))}
      </ol>
    </Card>
  );
}
