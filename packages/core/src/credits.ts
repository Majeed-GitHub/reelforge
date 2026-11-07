import { PLAN } from './config.ts';

const round3 = (n: number) => Math.round(n * 1000) / 1000;

/**
 * Director's metering model, reproduced: 1 credit = 1 minute of *finished*
 * video, billed by the second to 3 decimals, with a 15-second minimum for any
 * demo that produces video. A 45-second demo is 0.75 credits, not 1.
 */
export function creditsForDuration(durationMs: number): number {
  const seconds = Math.max(PLAN.minBillableSeconds, durationMs / 1000);
  return round3(seconds / 60);
}

export function billableSeconds(durationMs: number): number {
  return round3(Math.max(PLAN.minBillableSeconds, durationMs / 1000));
}

/** Formats credits the way the dashboard shows them. */
export function formatCredits(credits: number): string {
  return `${(Math.round(credits * 1000) / 1000).toFixed(3).replace(/0+$/, '').replace(/\.$/, '')} credits`;
}

export function remainingSeconds(usedSeconds: number, grantedMinutes = PLAN.freeMinutesPerMonth): number {
  return Math.max(0, grantedMinutes * 60 - usedSeconds);
}
