const dateFormat = new Intl.DateTimeFormat("en", { dateStyle: "medium" });
const dateTimeFormat = new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" });
const timeFormat = new Intl.DateTimeFormat("en", { timeStyle: "short" });

export const formatDate = (value: Date | string) => dateFormat.format(new Date(value));
export const formatDateTime = (value: Date | string) => dateTimeFormat.format(new Date(value));
export const formatTime = (value: Date | string) => timeFormat.format(new Date(value));

/** Compact relative time for lists: "just now", "5 min ago", "3 h ago", "Yesterday", or a date. */
export function formatRelative(value: Date | string, now: Date = new Date()): string {
  const date = new Date(value);
  const minutes = Math.floor((now.getTime() - date.getTime()) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  if (minutes < 60 * 24 && dayLabel(date, now) === "Today")
    return `${Math.floor(minutes / 60)} h ago`;
  return dayLabel(date, now);
}

/** "Today", "Yesterday" or a medium date, relative to `now`. */
export function dayLabel(value: Date | string, now: Date = new Date()): string {
  const date = new Date(value);
  const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const diffDays = Math.round((startOfDay(now) - startOfDay(date)) / 86_400_000);
  if (diffDays === 0) return "Today";
  if (diffDays === 1) return "Yesterday";
  return formatDate(date);
}
