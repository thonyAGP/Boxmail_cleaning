-- CreateTable
CREATE TABLE "Engagement" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "label" TEXT NOT NULL,
    "expected" TEXT,
    "actor" TEXT NOT NULL DEFAULT 'tiers',
    "status" TEXT NOT NULL DEFAULT 'propose',
    "source" TEXT NOT NULL DEFAULT 'auto',
    "openedAt" DATETIME NOT NULL,
    "reviewAt" DATETIME,
    "dueAt" DATETIME,
    "amountPaid" REAL,
    "contactEmail" TEXT,
    "contactName" TEXT,
    "accountSlug" TEXT,
    "dossierId" INTEGER,
    "reason" TEXT,
    "notes" TEXT,
    "snoozedUntil" DATETIME,
    "closedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Engagement_dossierId_fkey" FOREIGN KEY ("dossierId") REFERENCES "Dossier" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "EngagementMessage" (
    "engagementId" INTEGER NOT NULL,
    "messageId" INTEGER NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'contexte',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

    PRIMARY KEY ("engagementId", "messageId"),
    CONSTRAINT "EngagementMessage_engagementId_fkey" FOREIGN KEY ("engagementId") REFERENCES "Engagement" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "EngagementMessage_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "Message" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "Engagement_status_reviewAt_idx" ON "Engagement"("status", "reviewAt");

-- CreateIndex
CREATE INDEX "Engagement_dossierId_idx" ON "Engagement"("dossierId");

-- CreateIndex
CREATE INDEX "EngagementMessage_messageId_idx" ON "EngagementMessage"("messageId");
