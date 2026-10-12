-- AlterEnum
ALTER TYPE "ConversationChannel" ADD VALUE 'PORTAL';

-- CreateTable
CREATE TABLE "portal_settings" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "portal_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer_portal_accounts" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "customerId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "customer_portal_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "portal_invites" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "customerId" UUID NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "createdByUserId" UUID,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "portal_invites_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "portal_settings_organizationId_key" ON "portal_settings"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "customer_portal_accounts_organizationId_userId_key" ON "customer_portal_accounts"("organizationId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "customer_portal_accounts_organizationId_customerId_key" ON "customer_portal_accounts"("organizationId", "customerId");

-- CreateIndex
CREATE UNIQUE INDEX "portal_invites_tokenHash_key" ON "portal_invites"("tokenHash");

-- CreateIndex
CREATE INDEX "portal_invites_organizationId_customerId_idx" ON "portal_invites"("organizationId", "customerId");

-- AddForeignKey
ALTER TABLE "portal_settings" ADD CONSTRAINT "portal_settings_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_portal_accounts" ADD CONSTRAINT "customer_portal_accounts_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_portal_accounts" ADD CONSTRAINT "customer_portal_accounts_customerId_organizationId_fkey" FOREIGN KEY ("customerId", "organizationId") REFERENCES "customers"("id", "organizationId") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_portal_accounts" ADD CONSTRAINT "customer_portal_accounts_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "portal_invites" ADD CONSTRAINT "portal_invites_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "portal_invites" ADD CONSTRAINT "portal_invites_customerId_organizationId_fkey" FOREIGN KEY ("customerId", "organizationId") REFERENCES "customers"("id", "organizationId") ON DELETE NO ACTION ON UPDATE CASCADE;


-- An invitation always expires after it was created.
ALTER TABLE "portal_invites"
  ADD CONSTRAINT "portal_invites_expiry_after_creation" CHECK ("expiresAt" > "createdAt");
