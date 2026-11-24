import type { EarningsSummary, RiderRating } from "@/components/delivery-partner-dashboard";
import { Card, Money } from "@/components/ui";
import { L, tr, type Lang } from "@/lib/board/i18n";

const T = {
  today: L("Today", "आज", "आज"),
  total: L("Total earned", "कुल कमाई", "एकूण कमाई"),
  deliveries: L("Deliveries", "डिलीवरी", "डिलिव्हऱ्या"),
  rating: L("Rating", "रेटिंग", "रेटिंग"),
  fromOne: L("from 1 rating", "1 रेटिंग से", "1 रेटिंगवरून"),
  fromMany: L("from {n} ratings", "{n} रेटिंग से", "{n} रेटिंगवरून"),
  none: L("No ratings yet", "अभी कोई रेटिंग नहीं", "अजून रेटिंग नाही"),
} as const;

export function GigEarningsCard({
  earnings,
  rating,
  lang = "en",
}: {
  earnings: EarningsSummary;
  rating: RiderRating;
  lang?: Lang;
}) {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      <Card className="p-4">
        <p className="text-xs text-ink-500">{tr(T.today, lang)}</p>
        <p className="mt-1 text-lg font-bold text-ink-900">
          <Money paise={earnings.todayPaise} />
        </p>
      </Card>
      <Card className="p-4">
        <p className="text-xs text-ink-500">{tr(T.total, lang)}</p>
        <p className="mt-1 text-lg font-bold text-ink-900">
          <Money paise={earnings.totalPaise} />
        </p>
      </Card>
      <Card className="p-4">
        <p className="text-xs text-ink-500">{tr(T.deliveries, lang)}</p>
        <p className="mt-1 text-lg font-bold text-ink-900">{earnings.deliveryCount}</p>
      </Card>
      <Card className="p-4">
        <p className="text-xs text-ink-500">{tr(T.rating, lang)}</p>
        {rating.count > 0 ? (
          <>
            <p className="mt-1 text-lg font-bold text-ink-900">{(rating.avgX100 / 100).toFixed(1)}★</p>
            <p className="text-xs text-ink-500">
              {rating.count === 1 ? tr(T.fromOne, lang) : tr(T.fromMany, lang).replace("{n}", String(rating.count))}
            </p>
          </>
        ) : (
          <p className="mt-1 text-sm text-ink-500">{tr(T.none, lang)}</p>
        )}
      </Card>
    </div>
  );
}
