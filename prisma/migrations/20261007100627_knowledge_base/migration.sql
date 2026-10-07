-- Enable pgvector. Prisma cannot express extensions, so this line is added by hand (reviewed).
-- Supabase: the extension may already be enabled (dashboard installs it into the "extensions"
-- schema); IF NOT EXISTS then does nothing and vector(768) resolves through the role's search_path.
CREATE EXTENSION IF NOT EXISTS vector;

-- CreateEnum
CREATE TYPE "KnowledgeDocumentStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'ARCHIVED');

-- AlterTable
ALTER TABLE "messages" ADD COLUMN     "metadata" JSONB;

-- CreateTable
CREATE TABLE "knowledge_documents" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "content" TEXT NOT NULL,
    "status" "KnowledgeDocumentStatus" NOT NULL DEFAULT 'DRAFT',
    "contentVersion" INTEGER NOT NULL DEFAULT 1,
    "publishedAt" TIMESTAMP(3),
    "createdByUserId" UUID,
    "updatedByUserId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "knowledge_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "knowledge_document_chunks" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "documentId" UUID NOT NULL,
    "chunkIndex" INTEGER NOT NULL,
    "content" TEXT NOT NULL,
    "estimatedTokens" INTEGER NOT NULL,
    "contentVersion" INTEGER NOT NULL,
    "embedding" vector(768) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "knowledge_document_chunks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "knowledge_documents_organizationId_status_updatedAt_idx" ON "knowledge_documents"("organizationId", "status", "updatedAt" DESC);

-- CreateIndex
CREATE INDEX "knowledge_documents_organizationId_updatedAt_idx" ON "knowledge_documents"("organizationId", "updatedAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "knowledge_documents_id_organizationId_key" ON "knowledge_documents"("id", "organizationId");

-- CreateIndex
CREATE INDEX "knowledge_document_chunks_organizationId_documentId_idx" ON "knowledge_document_chunks"("organizationId", "documentId");

-- CreateIndex
CREATE UNIQUE INDEX "knowledge_document_chunks_documentId_chunkIndex_key" ON "knowledge_document_chunks"("documentId", "chunkIndex");

-- AddForeignKey
ALTER TABLE "knowledge_documents" ADD CONSTRAINT "knowledge_documents_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "knowledge_documents" ADD CONSTRAINT "knowledge_documents_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "knowledge_documents" ADD CONSTRAINT "knowledge_documents_updatedByUserId_fkey" FOREIGN KEY ("updatedByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "knowledge_document_chunks" ADD CONSTRAINT "knowledge_document_chunks_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "knowledge_document_chunks" ADD CONSTRAINT "knowledge_document_chunks_documentId_organizationId_fkey" FOREIGN KEY ("documentId", "organizationId") REFERENCES "knowledge_documents"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;
