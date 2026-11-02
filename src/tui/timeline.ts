/**
 * machine_code — timeline selection helpers.
 *
 * Streaming deltas are coalesced into the thinking/model sections and render
 * no timeline row, so the cursor must skip them rather than landing on an
 * invisible event.
 */
export interface TimelineEventLike {
  type?: unknown;
}

export function isTimelineEvent(event: TimelineEventLike | undefined): boolean {
  if (!event) return false;
  return String(event.type) !== "model_delta";
}

export function stepTimelineSelection(
  events: readonly TimelineEventLike[],
  current: number,
  direction: -1 | 1,
): number {
  let next = current + direction;
  while (next >= 0 && next < events.length && !isTimelineEvent(events[next])) next += direction;
  return next >= 0 && next < events.length ? next : current;
}
