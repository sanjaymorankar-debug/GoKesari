import type { EarningsSummary, RiderRating } from "@/components/delivery-partner-dashboard";
import { Card, Money } from "@/components/ui";

export function GigEarningsCard({ earnings, rating }: { earnings: EarningsSummary; rating: RiderRating }) {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      <Card className="p-4">
        <p className="text-xs text-ink-500">Today</p>
        <p className="mt-1 text-lg font-bold text-ink-900">
          <Money paise={earnings.todayPaise} />
        </p>
      </Card>
      <Card className="p-4">
        <p className="text-xs text-ink-500">Total earned</p>
        <p className="mt-1 text-lg font-bold text-ink-900">
          <Money paise={earnings.totalPaise} />
        </p>
      </Card>
      <Card className="p-4">
        <p className="text-xs text-ink-500">Deliveries</p>
        <p className="mt-1 text-lg font-bold text-ink-900">{earnings.deliveryCount}</p>
      </Card>
      <Card className="p-4">
        <p className="text-xs text-ink-500">Rating</p>
        {rating.count > 0 ? (
          <>
            <p className="mt-1 text-lg font-bold text-ink-900">{(rating.avgX100 / 100).toFixed(1)}★</p>
            <p className="text-xs text-ink-500">
              from {rating.count} rating{rating.count === 1 ? "" : "s"}
            </p>
          </>
        ) : (
          <p className="mt-1 text-sm text-ink-500">No ratings yet</p>
        )}
      </Card>
    </div>
  );
}
