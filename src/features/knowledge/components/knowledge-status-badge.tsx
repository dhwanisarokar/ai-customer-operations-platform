import { Badge } from "@/components/ui/badge";

const CONFIG = {
  DRAFT: { label: "Draft", variant: "secondary" },
  PUBLISHED: { label: "Published", variant: "default" },
  ARCHIVED: { label: "Archived", variant: "outline" },
} as const;

export function KnowledgeStatusBadge({ status }: { status: keyof typeof CONFIG }) {
  const { label, variant } = CONFIG[status];
  return <Badge variant={variant}>{label}</Badge>;
}
