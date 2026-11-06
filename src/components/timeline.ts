export interface TimelineItem {
  /** ISO date (YYYY-MM-DD or timestamp). */
  date: string
  label: string
  detail?: string
}

/** Newest first; stable for equal dates (original order kept). Does not mutate the input. */
export function sortTimeline(items: TimelineItem[]): TimelineItem[] {
  return items
    .map((item, i) => ({ item, i }))
    .sort((a, b) => (a.item.date < b.item.date ? 1 : a.item.date > b.item.date ? -1 : a.i - b.i))
    .map((x) => x.item)
}
