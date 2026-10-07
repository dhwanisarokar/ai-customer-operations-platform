import Link from "next/link";
import { ArrowDownIcon, ArrowUpIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatDate, formatDateTime } from "@/lib/format";
import type { CustomerRow } from "../api/types";
import { fullName } from "../normalize";
import { customersHref } from "../list-params";
import type { ListCustomersQuery } from "../schemas";
import { CustomerStatusBadge } from "./customer-status-badge";

type Props = {
  customers: CustomerRow[];
  sort: ListCustomersQuery["sort"];
  order: ListCustomersQuery["order"];
  /** Current URL params, used to keep filters when changing the sort. */
  params: Record<string, string>;
};

export function CustomersTable({ customers, sort, order, params }: Props) {
  return (
    <div className="border-border bg-card overflow-x-auto rounded-xl border">
      <Table>
        <TableHeader>
          <TableRow>
            <SortableHead field="name" label="Name" {...{ sort, order, params }} />
            <TableHead>Email</TableHead>
            <TableHead>Company</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Tags</TableHead>
            <SortableHead field="createdAt" label="Created" {...{ sort, order, params }} />
            <SortableHead
              field="lastActivityAt"
              label="Last activity"
              {...{ sort, order, params }}
            />
          </TableRow>
        </TableHeader>
        <TableBody>
          {customers.map((customer) => (
            <TableRow key={customer.id}>
              <TableCell className="font-medium">
                <Link
                  href={`/dashboard/customers/${customer.id}`}
                  className="hover:text-primary focus-visible:ring-ring rounded-sm outline-none focus-visible:ring-2"
                >
                  {fullName(customer)}
                </Link>
              </TableCell>
              <TableCell className="text-muted-foreground">{customer.email ?? "-"}</TableCell>
              <TableCell>{customer.company ?? "-"}</TableCell>
              <TableCell>
                <CustomerStatusBadge status={customer.status} />
              </TableCell>
              <TableCell>
                <div className="flex flex-wrap gap-1">
                  {customer.tags.map((tag) => (
                    <Badge key={tag.id} variant="outline">
                      {tag.name}
                    </Badge>
                  ))}
                </div>
              </TableCell>
              <TableCell className="text-muted-foreground whitespace-nowrap">
                {formatDate(customer.createdAt)}
              </TableCell>
              <TableCell className="text-muted-foreground whitespace-nowrap">
                {formatDateTime(customer.lastActivityAt)}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function SortableHead({
  field,
  label,
  sort,
  order,
  params,
}: {
  field: ListCustomersQuery["sort"];
  label: string;
} & Pick<Props, "sort" | "order" | "params">) {
  const active = sort === field;
  const nextOrder = active && order === "asc" ? "desc" : "asc";
  const Icon = order === "asc" ? ArrowUpIcon : ArrowDownIcon;
  return (
    <TableHead aria-sort={active ? (order === "asc" ? "ascending" : "descending") : "none"}>
      <Link
        href={customersHref(params, { sort: field, order: nextOrder, page: undefined })}
        className="hover:text-foreground inline-flex items-center gap-1"
      >
        {label}
        {active ? <Icon className="size-3.5" aria-hidden="true" /> : null}
      </Link>
    </TableHead>
  );
}
