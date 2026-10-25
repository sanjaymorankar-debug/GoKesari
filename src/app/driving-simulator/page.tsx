import { Card, PageHeader } from "@/components/ui";

export const metadata = { title: "Driving Simulator" };

export default function DrivingSimulatorPage() {
  return (
    <>
      <PageHeader title="Driving Simulator" />
      <Card className="p-6">
        <p
          className="text-center text-lg font-semibold text-ink-900"
          data-testid="driving-simulator-status"
        >
          Site in progress
        </p>
        <p className="mt-2 text-center text-sm text-ink-600">
          This page is under construction. Please check back soon.
        </p>
      </Card>
    </>
  );
}
