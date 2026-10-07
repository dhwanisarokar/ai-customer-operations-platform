-- CreateEnum
CREATE TYPE "CustomerStatus" AS ENUM ('ACTIVE', 'INACTIVE', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "ActivityType" AS ENUM ('CUSTOMER_CREATED', 'CUSTOMER_UPDATED', 'CUSTOMER_ARCHIVED', 'TAG_ADDED', 'TAG_REMOVED', 'NOTE_ADDED');

-- CreateEnum
CREATE TYPE "ActivityActorType" AS ENUM ('USER', 'SYSTEM', 'AI');

-- CreateTable
CREATE TABLE "customers" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "externalId" TEXT,
    "firstName" TEXT NOT NULL,
    "lastName" TEXT,
    "email" TEXT,
    "phone" TEXT,
    "company" TEXT,
    "jobTitle" TEXT,
    "status" "CustomerStatus" NOT NULL DEFAULT 'ACTIVE',
    "source" TEXT,
    "metadata" JSONB,
    "lastActivityAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "archivedAt" TIMESTAMP(3),

    CONSTRAINT "customers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tags" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "normalizedName" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tags_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer_tags" (
    "customerId" UUID NOT NULL,
    "tagId" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "customer_tags_pkey" PRIMARY KEY ("customerId","tagId")
);

-- CreateTable
CREATE TABLE "customer_activities" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "customerId" UUID NOT NULL,
    "type" "ActivityType" NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "metadata" JSONB,
    "actorType" "ActivityActorType" NOT NULL DEFAULT 'USER',
    "actorId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "customer_activities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer_notes" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "customerId" UUID NOT NULL,
    "authorId" UUID,
    "content" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "customer_notes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "customers_organizationId_status_createdAt_idx" ON "customers"("organizationId", "status", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "customers_organizationId_createdAt_idx" ON "customers"("organizationId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "customers_organizationId_updatedAt_idx" ON "customers"("organizationId", "updatedAt" DESC);

-- CreateIndex
CREATE INDEX "customers_organizationId_lastActivityAt_idx" ON "customers"("organizationId", "lastActivityAt" DESC);

-- CreateIndex
CREATE INDEX "customers_organizationId_firstName_lastName_idx" ON "customers"("organizationId", "firstName", "lastName");

-- CreateIndex
CREATE UNIQUE INDEX "customers_organizationId_email_key" ON "customers"("organizationId", "email");

-- CreateIndex
CREATE UNIQUE INDEX "customers_organizationId_externalId_key" ON "customers"("organizationId", "externalId");

-- CreateIndex
CREATE UNIQUE INDEX "customers_id_organizationId_key" ON "customers"("id", "organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "tags_organizationId_normalizedName_key" ON "tags"("organizationId", "normalizedName");

-- CreateIndex
CREATE UNIQUE INDEX "tags_id_organizationId_key" ON "tags"("id", "organizationId");

-- CreateIndex
CREATE INDEX "customer_tags_organizationId_tagId_idx" ON "customer_tags"("organizationId", "tagId");

-- CreateIndex
CREATE INDEX "customer_activities_organizationId_customerId_createdAt_idx" ON "customer_activities"("organizationId", "customerId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "customer_notes_organizationId_customerId_createdAt_idx" ON "customer_notes"("organizationId", "customerId", "createdAt" DESC);

-- AddForeignKey
ALTER TABLE "customers" ADD CONSTRAINT "customers_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tags" ADD CONSTRAINT "tags_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_tags" ADD CONSTRAINT "customer_tags_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_tags" ADD CONSTRAINT "customer_tags_customerId_organizationId_fkey" FOREIGN KEY ("customerId", "organizationId") REFERENCES "customers"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_tags" ADD CONSTRAINT "customer_tags_tagId_organizationId_fkey" FOREIGN KEY ("tagId", "organizationId") REFERENCES "tags"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_activities" ADD CONSTRAINT "customer_activities_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_activities" ADD CONSTRAINT "customer_activities_customerId_organizationId_fkey" FOREIGN KEY ("customerId", "organizationId") REFERENCES "customers"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_notes" ADD CONSTRAINT "customer_notes_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_notes" ADD CONSTRAINT "customer_notes_customerId_organizationId_fkey" FOREIGN KEY ("customerId", "organizationId") REFERENCES "customers"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_notes" ADD CONSTRAINT "customer_notes_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
