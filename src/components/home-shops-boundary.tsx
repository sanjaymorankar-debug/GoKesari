"use client";

import { catchError, type ErrorInfo } from "next/error";

import { Button, Card } from "@/components/ui";

/**
 * Error boundary for the home page's streamed shop lists. If their part of
 * the page fails (a database error, or the connection dropping before they
 * arrive), only this section is replaced, and the header, search and
 * "Deliver to" block stay usable. Without it Next swaps the whole page for its
 * "This page couldn't load" screen.
 */
function HomeShopsError(_props: object, { retry }: ErrorInfo) {
  return (
    <Card className="mb-10 p-6 text-center" role="alert">
      <p className="text-base font-medium text-ink-700">We couldn&apos;t load the shops just now.</p>
      <p className="mt-1 text-sm text-ink-500">Check your connection and try again.</p>
      <Button variant="secondary" className="tap-target mt-4" onClick={() => retry()}>
        Try again
      </Button>
    </Card>
  );
}

export const HomeShopsBoundary = catchError(HomeShopsError);
