/**
 * Build the authoritative rolling-window query used by usage scanners.
 *
 * The v1 task API accepts second-precision boundaries while the local ledger
 * uses milliseconds. Widen the upstream interval by one second on each side,
 * then keep the existing exact [startAt, endAt) filtering locally.
 */
export function buildRollingUsageTaskParams(input: {
  limit: number;
  startAt: number;
  endAt: number;
  after?: string;
}) {
  const params = new URLSearchParams({
    limit: String(input.limit),
    order: "desc",
    orderBy: "created_at",
    createdAfter: String(Math.max(0, Math.floor(input.startAt / 1_000) - 1)),
    createdBefore: String(Math.ceil(input.endAt / 1_000) + 1),
  });
  if (input.after) params.set("after", input.after);
  return params;
}

/**
 * A single out-of-order task is not a safe pagination sentinel. A complete
 * page whose every dated task is before the window is the minimum safe signal
 * that the descending scan has crossed the rolling-window boundary.
 */
export function usagePageReachedCutoff(input: {
  complete: boolean;
  datedTaskCount: number;
  expiredTaskCount: number;
}) {
  return (
    input.complete &&
    input.datedTaskCount > 0 &&
    input.expiredTaskCount === input.datedTaskCount
  );
}
