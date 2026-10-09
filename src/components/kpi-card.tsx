import type { ReactNode } from "react";

import { Card } from "@/components/ui";

interface KPICardProps {
  title: string;
  value: ReactNode;
  subtitle?: ReactNode;
  icon?: ReactNode;
  className?: string;
  color?: "blue" | "green" | "purple" | "orange" | "red";
}

// One calm look for every figure (Tile Board design system): colour is kept
// for meaning only — red is "needs attention". The old pastel set (blue,
// green, purple, orange tiles with no meaning behind the colour) also put
// some numbers under 4.5:1 contrast.
const colorClasses = {
  blue: "from-white to-white",
  green: "from-white to-white",
  purple: "from-white to-white",
  orange: "from-white to-white",
  red: "from-red-50 to-white",
};

const valueClasses = {
  blue: "text-ink-900",
  green: "text-ink-900",
  purple: "text-ink-900",
  orange: "text-ink-900",
  red: "text-red-700",
};

export function KPICard({
  title,
  value,
  subtitle,
  icon,
  className = "",
  color = "blue",
}: KPICardProps) {
  return (
    <Card className={`p-6 bg-gradient-to-br ${colorClasses[color]} ${className}`}>
      <div className="flex items-start justify-between">
        <div className="flex-1">
          <p className="text-sm text-ink-700 font-medium">{title}</p>
          <div className={`text-3xl font-bold ${valueClasses[color]} mt-2`}>{value}</div>
          {subtitle ? <p className="text-sm text-ink-600 mt-2">{subtitle}</p> : null}
        </div>
        {icon ? <div className="text-3xl ml-4">{icon}</div> : null}
      </div>
    </Card>
  );
}
