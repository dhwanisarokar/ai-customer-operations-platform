import { Badge } from "@/components/ui/badge";

const CONFIG = {
  ACTIVE: { label: "Active", variant: "default" },
  INACTIVE: { label: "Inactive", variant: "secondary" },
  ARCHIVED: { label: "Archived", variant: "outline" },
} as const;

export function CustomerStatusBadge({ status }: { status: keyof typeof CONFIG }) {
  const { label, variant } = CONFIG[status];
  return <Badge variant={variant}>{label}</Badge>;
}
