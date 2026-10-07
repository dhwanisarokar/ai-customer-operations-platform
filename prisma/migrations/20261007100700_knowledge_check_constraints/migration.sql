-- Hand-written: Prisma schema language cannot express CHECK constraints.
-- Defense-in-depth for rules enforced in src/server/services/knowledge*.ts.
ALTER TABLE "knowledge_documents"
  ADD CONSTRAINT "knowledge_documents_title_not_blank" CHECK (length(btrim("title")) > 0),
  ADD CONSTRAINT "knowledge_documents_content_version_positive" CHECK ("contentVersion" >= 1),
  -- A published document always records when it was published.
  ADD CONSTRAINT "knowledge_documents_published_at_consistent" CHECK ("status" <> 'PUBLISHED' OR "publishedAt" IS NOT NULL);

ALTER TABLE "knowledge_document_chunks"
  ADD CONSTRAINT "knowledge_chunks_content_not_blank" CHECK (length(btrim("content")) > 0),
  ADD CONSTRAINT "knowledge_chunks_index_nonnegative" CHECK ("chunkIndex" >= 0),
  ADD CONSTRAINT "knowledge_chunks_tokens_positive" CHECK ("estimatedTokens" > 0);
