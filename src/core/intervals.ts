import type { Interval } from "./model.js";

export function normalizeInterval(interval: Interval): Interval | null {
  if (
    !Number.isSafeInteger(interval.start_ms) ||
    !Number.isSafeInteger(interval.end_ms) ||
    interval.start_ms >= interval.end_ms
  ) {
    return null;
  }

  return { start_ms: interval.start_ms, end_ms: interval.end_ms };
}

export function unionIntervals(intervals: readonly Interval[]): Interval[] {
  const sorted = intervals
    .map(normalizeInterval)
    .filter((interval): interval is Interval => interval !== null)
    .sort(
      (left, right) =>
        left.start_ms - right.start_ms || left.end_ms - right.end_ms,
    );
  const first = sorted[0];

  if (first === undefined) {
    return [];
  }

  const result: Interval[] = [{ ...first }];

  for (const interval of sorted.slice(1)) {
    const previous = result[result.length - 1];

    if (previous === undefined) {
      continue;
    }

    if (interval.start_ms <= previous.end_ms) {
      previous.end_ms = Math.max(previous.end_ms, interval.end_ms);
    } else {
      result.push({ ...interval });
    }
  }

  return result;
}

export function intersectIntervals(
  leftIntervals: readonly Interval[],
  rightIntervals: readonly Interval[],
): Interval[] {
  const left = unionIntervals(leftIntervals);
  const right = unionIntervals(rightIntervals);
  const result: Interval[] = [];
  let leftIndex = 0;
  let rightIndex = 0;

  while (leftIndex < left.length && rightIndex < right.length) {
    const leftInterval = left[leftIndex];
    const rightInterval = right[rightIndex];

    if (leftInterval === undefined || rightInterval === undefined) {
      break;
    }

    const start_ms = Math.max(leftInterval.start_ms, rightInterval.start_ms);
    const end_ms = Math.min(leftInterval.end_ms, rightInterval.end_ms);

    if (start_ms < end_ms) {
      result.push({ start_ms, end_ms });
    }

    if (leftInterval.end_ms <= rightInterval.end_ms) {
      leftIndex += 1;
    }
    if (rightInterval.end_ms <= leftInterval.end_ms) {
      rightIndex += 1;
    }
  }

  return result;
}

export function subtractIntervals(
  intervals: readonly Interval[],
  subtractions: readonly Interval[],
): Interval[] {
  const base = unionIntervals(intervals);
  const cuts = unionIntervals(subtractions);
  const result: Interval[] = [];

  for (const interval of base) {
    let cursor = interval.start_ms;

    for (const cut of cuts) {
      if (cut.end_ms <= cursor) {
        continue;
      }
      if (cut.start_ms >= interval.end_ms) {
        break;
      }
      if (cut.start_ms > cursor) {
        result.push({
          start_ms: cursor,
          end_ms: Math.min(cut.start_ms, interval.end_ms),
        });
      }

      cursor = Math.max(cursor, cut.end_ms);

      if (cursor >= interval.end_ms) {
        break;
      }
    }

    if (cursor < interval.end_ms) {
      result.push({ start_ms: cursor, end_ms: interval.end_ms });
    }
  }

  return result;
}

export function overlapsAny(
  leftIntervals: readonly Interval[],
  rightIntervals: readonly Interval[],
): boolean {
  return intersectIntervals(leftIntervals, rightIntervals).length > 0;
}

export function durationMs(intervals: readonly Interval[]): number {
  return unionIntervals(intervals).reduce(
    (total, interval) => total + interval.end_ms - interval.start_ms,
    0,
  );
}

export function roundMinutes(ms: number): number {
  if (!(ms > 0)) {
    return 0;
  }

  const rounded = Math.round(ms / 600) / 100;
  return Object.is(rounded, -0) ? 0 : rounded;
}
