import {
  ArchiveIcon,
  PencilIcon,
  StickyNoteIcon,
  TagIcon,
  UserPlusIcon,
  type LucideIcon,
} from "lucide-react";
import { dayLabel, formatTime } from "@/lib/format";

export type TimelineActivity = {
  id: string;
  type: string;
  title: string;
  description: string | null;
  createdAt: Date | string;
};

// New activity types (conversations, emails, workflows...) only need an entry here; unknown types
// fall back to a generic dot so the timeline never breaks on newer data.
const ICONS: Record<string, LucideIcon> = {
  CUSTOMER_CREATED: UserPlusIcon,
  CUSTOMER_UPDATED: PencilIcon,
  CUSTOMER_ARCHIVED: ArchiveIcon,
  TAG_ADDED: TagIcon,
  TAG_REMOVED: TagIcon,
  NOTE_ADDED: StickyNoteIcon,
};

/** Reusable, data-driven timeline: newest first, grouped by day. */
export function ActivityTimeline({
  activities,
  emptyLabel = "No activity yet.",
}: {
  activities: TimelineActivity[];
  emptyLabel?: string;
}) {
  if (activities.length === 0) {
    return <p className="text-muted-foreground text-sm">{emptyLabel}</p>;
  }

  const groups = new Map<string, TimelineActivity[]>();
  for (const activity of activities) {
    const label = dayLabel(activity.createdAt);
    groups.set(label, [...(groups.get(label) ?? []), activity]);
  }

  return (
    <div className="flex flex-col gap-5">
      {[...groups.entries()].map(([label, items]) => (
        <section key={label} aria-label={label}>
          <h3 className="text-muted-foreground mb-2 text-xs font-medium tracking-wide uppercase">
            {label}
          </h3>
          <ol className="border-border ml-3 flex flex-col gap-4 border-l pl-5">
            {items.map((activity) => {
              const Icon = ICONS[activity.type];
              return (
                <li key={activity.id} className="relative">
                  <span className="bg-card border-border absolute top-0.5 -left-[2.1rem] flex size-6 items-center justify-center rounded-full border">
                    {Icon ? (
                      <Icon className="text-muted-foreground size-3" aria-hidden="true" />
                    ) : (
                      <span className="bg-muted-foreground size-1.5 rounded-full" />
                    )}
                  </span>
                  <p className="text-sm font-medium">{activity.title}</p>
                  {activity.description ? (
                    <p className="text-muted-foreground text-sm break-words">
                      {activity.description}
                    </p>
                  ) : null}
                  <time
                    dateTime={new Date(activity.createdAt).toISOString()}
                    className="text-muted-foreground text-xs"
                  >
                    {formatTime(activity.createdAt)}
                  </time>
                </li>
              );
            })}
          </ol>
        </section>
      ))}
    </div>
  );
}
