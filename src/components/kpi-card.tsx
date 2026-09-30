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

const colorClasses = {
  blue: "from-blue-50 to-cyan-50",
  green: "from-green-50 to-emerald-50",
  purple: "from-purple-50 to-pink-50",
  orange: "from-orange-50 to-amber-50",
  red: "from-red-50 to-rose-50",
};

const valueClasses = {
  blue: "text-blue-600",
  green: "text-green-600",
  purple: "text-purple-600",
  orange: "text-orange-600",
  red: "text-red-600",
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
          <p className="text-sm text-gray-600 font-medium">{title}</p>
          <div className={`text-3xl font-bold ${valueClasses[color]} mt-2`}>{value}</div>
          {subtitle ? <p className="text-xs text-gray-600 mt-2">{subtitle}</p> : null}
        </div>
        {icon ? <div className="text-3xl ml-4">{icon}</div> : null}
      </div>
    </Card>
  );
}
