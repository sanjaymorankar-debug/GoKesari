import Link from "next/link";

import { Card } from "@/components/ui";

export interface ChartDataPoint {
  label: string;
  value: number;
  percentage?: number;
  href?: string;
}

interface AnalyticsChartProps {
  title: string;
  data: ChartDataPoint[];
  type?: "bar" | "trend";
  color?: "blue" | "green" | "purple" | "orange";
  emptyMessage?: string;
}

const barClasses = {
  blue: "from-blue-500 to-blue-400",
  green: "from-green-500 to-green-400",
  purple: "from-purple-500 to-purple-400",
  orange: "from-orange-500 to-orange-400",
};

function PointLabel({ point }: { point: ChartDataPoint }) {
  return point.href ? (
    <Link href={point.href} className="text-gray-700 font-medium hover:underline">
      {point.label}
    </Link>
  ) : (
    <span className="text-gray-700 font-medium">{point.label}</span>
  );
}

export function AnalyticsChart({
  title,
  data,
  type = "bar",
  color = "blue",
  emptyMessage = "No data yet.",
}: AnalyticsChartProps) {
  const maxValue = Math.max(0, ...data.map((d) => d.value));
  const widthPercent = (value: number) => (maxValue > 0 ? (value / maxValue) * 100 : 0);

  if (data.length === 0) {
    return (
      <Card className="p-6">
        <h3 className="font-semibold text-lg mb-4">{title}</h3>
        <p className="text-sm text-gray-600">{emptyMessage}</p>
      </Card>
    );
  }

  if (type === "trend") {
    return (
      <Card className="p-6">
        <h3 className="font-semibold text-lg mb-4">{title}</h3>
        <div className="space-y-3">
          {data.map((point) => (
            <div key={point.label}>
              <div className="flex justify-between text-sm mb-1">
                <PointLabel point={point} />
                <span className="text-gray-600">{point.value}</span>
              </div>
              <div className="w-full bg-gray-200 rounded-full h-2">
                <div
                  className={`bg-gradient-to-r ${barClasses[color]} h-2 rounded-full transition-all`}
                  style={{ width: `${widthPercent(point.value)}%` }}
                />
              </div>
            </div>
          ))}
        </div>
      </Card>
    );
  }

  return (
    <Card className="p-6">
      <h3 className="font-semibold text-lg mb-4">{title}</h3>
      <div className="space-y-4">
        {data.map((point) => (
          <div key={point.label}>
            <div className="flex justify-between text-sm mb-2">
              <PointLabel point={point} />
              <span className="text-gray-900 font-semibold">{point.value}</span>
            </div>
            <div className="flex items-center gap-2">
              <div className="flex-1 bg-gray-200 rounded h-8">
                <div
                  className={`bg-gradient-to-r ${barClasses[color]} h-8 rounded transition-all`}
                  style={{ width: `${widthPercent(point.value)}%` }}
                />
              </div>
              {point.percentage != null ? (
                <span className="text-gray-600 text-xs w-12 text-right">{point.percentage}%</span>
              ) : null}
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}
