import Link from "next/link";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatDateTime } from "@/lib/format";
import type { KnowledgeDocumentListItem } from "@/server/repositories/knowledge-documents";
import { KnowledgeStatusBadge } from "./knowledge-status-badge";

export function KnowledgeTable({ documents }: { documents: KnowledgeDocumentListItem[] }) {
  return (
    <div className="border-border bg-card overflow-x-auto rounded-xl border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Title</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Updated</TableHead>
            <TableHead>Created by</TableHead>
            <TableHead className="text-right">Chunks</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {documents.map((document) => (
            <TableRow key={document.id}>
              <TableCell className="max-w-md">
                <Link
                  href={`/dashboard/knowledge/${document.id}`}
                  className="hover:text-primary focus-visible:ring-ring rounded-sm font-medium outline-none focus-visible:ring-2"
                >
                  {document.title}
                </Link>
                {document.description ? (
                  <p className="text-muted-foreground truncate text-xs">{document.description}</p>
                ) : null}
              </TableCell>
              <TableCell>
                <KnowledgeStatusBadge status={document.status} />
              </TableCell>
              <TableCell className="text-muted-foreground whitespace-nowrap">
                {formatDateTime(document.updatedAt)}
              </TableCell>
              <TableCell className="text-muted-foreground">
                {document.createdBy?.name ?? document.createdBy?.email ?? "Former member"}
              </TableCell>
              <TableCell className="text-right tabular-nums">{document.chunkCount}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
