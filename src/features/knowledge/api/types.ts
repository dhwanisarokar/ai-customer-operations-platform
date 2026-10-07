import type { Serialized } from "@/lib/query/serialize";
import type { Page } from "@/server/http/pagination";
import type {
  KnowledgeDocumentDetail,
  KnowledgeDocumentListItem,
} from "@/server/repositories/knowledge-documents";

export type KnowledgeListResponse = Serialized<Page<KnowledgeDocumentListItem>>;
export type KnowledgeDocumentResponse = { document: Serialized<KnowledgeDocumentDetail> };
export type KnowledgeDocumentJson = KnowledgeDocumentResponse["document"];

export type KnowledgeFormValues = { title: string; description: string; content: string };
