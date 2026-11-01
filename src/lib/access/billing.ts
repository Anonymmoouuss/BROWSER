export const PAYMENT_AMOUNT_CENTS = 500;
export type BillingPeriod = { period: number; start: string; end: string };

/** Calendar months anchored to registration in UTC, clamped at month end.
 *  Direct port of SCRM auth/billing.ts. */
export function billingPeriodAt(
  registered: string | Date,
  period: number,
): BillingPeriod {
  const anchor = new Date(registered);
  if (
    !Number.isFinite(anchor.getTime()) ||
    !Number.isSafeInteger(period) ||
    period < 0 ||
    period > 120_000
  )
    throw new Error("Invalid billing period.");
  const anniversary = (offset: number) => {
    const month = new Date(
      Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth() + offset, 1),
    );
    const lastDay = new Date(
      Date.UTC(month.getUTCFullYear(), month.getUTCMonth() + 1, 0),
    ).getUTCDate();
    month.setUTCDate(Math.min(anchor.getUTCDate(), lastDay));
    month.setUTCHours(
      anchor.getUTCHours(),
      anchor.getUTCMinutes(),
      anchor.getUTCSeconds(),
      anchor.getUTCMilliseconds(),
    );
    return month.toISOString();
  };
  return { period, start: anniversary(period), end: anniversary(period + 1) };
}

export function billingPeriod(
  registered: string | Date,
  now = new Date(),
): BillingPeriod {
  const anchor = new Date(registered);
  let period = Math.max(
    0,
    (now.getUTCFullYear() - anchor.getUTCFullYear()) * 12 +
      now.getUTCMonth() -
      anchor.getUTCMonth(),
  );
  if (period > 0 && new Date(billingPeriodAt(anchor, period).start) > now)
    period--;
  return billingPeriodAt(anchor, period);
}
