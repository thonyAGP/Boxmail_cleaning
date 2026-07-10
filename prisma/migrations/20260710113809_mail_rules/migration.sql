-- CreateTable
CREATE TABLE "MailRule" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "accountSlug" TEXT NOT NULL,
    "matchType" TEXT NOT NULL,
    "matchValue" TEXT NOT NULL,
    "targetFolder" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'suggested',
    "autoApply" BOOLEAN NOT NULL DEFAULT false,
    "reason" TEXT NOT NULL,
    "appliedCount" INTEGER NOT NULL DEFAULT 0,
    "lastAppliedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "MailRule_accountSlug_fkey" FOREIGN KEY ("accountSlug") REFERENCES "Account" ("slug") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "MailRule_accountSlug_status_idx" ON "MailRule"("accountSlug", "status");

-- CreateIndex
CREATE UNIQUE INDEX "MailRule_accountSlug_matchType_matchValue_key" ON "MailRule"("accountSlug", "matchType", "matchValue");
