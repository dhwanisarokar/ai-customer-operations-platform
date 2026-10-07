import type { Serialized } from "@/lib/query/serialize";
import type { Page } from "@/server/http/pagination";
import type { ActivityRecord } from "@/server/repositories/customer-activities";
import type { NoteRecord } from "@/server/repositories/customer-notes";
import type { CustomerListItem } from "@/server/repositories/customers";
import type { TagRecord, TagWithUsage } from "@/server/repositories/tags";
import type { getCustomer360 } from "@/server/services/customers";

/** Response types are the server's own types as they look after JSON (Dates become strings). */
export type CustomerListResponse = Serialized<Page<CustomerListItem>>;
export type CustomerRow = CustomerListResponse["items"][number];
export type Customer360Response = Serialized<Awaited<ReturnType<typeof getCustomer360>>>;
export type CustomerActivitiesResponse = Serialized<Page<ActivityRecord>>;
export type CustomerNotesResponse = Serialized<Page<NoteRecord>>;
export type CustomerNote = CustomerNotesResponse["items"][number];
export type CustomerTagsResponse = { tags: Serialized<TagRecord>[] };
export type OrganizationTagsResponse = { tags: Serialized<TagWithUsage>[] };

/** The create/edit form's values (strings; blanks are normalized to null by the server schema). */
export type CustomerFormValues = {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  company: string;
  jobTitle: string;
  source: string;
  status: "ACTIVE" | "INACTIVE";
};
