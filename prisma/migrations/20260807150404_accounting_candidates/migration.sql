-- CreateTable
CREATE TABLE "AccountingCandidate" (
    "seq" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "candidateId" TEXT NOT NULL,
    "accountSlug" TEXT NOT NULL,
    "messageId" INTEGER NOT NULL,
    "internetMessageId" TEXT,
    "companyCandidate" TEXT,
    "companyBasis" TEXT NOT NULL DEFAULT 'NONE',
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "detectedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "receivedAt" DATETIME,
    "fromName" TEXT,
    "fromEmail" TEXT,
    "subject" TEXT,
    "attachmentsJson" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "AccountingCandidate_candidateId_key" ON "AccountingCandidate"("candidateId");

-- CreateIndex
CREATE INDEX "AccountingCandidate_messageId_idx" ON "AccountingCandidate"("messageId");

-- CreateIndex
CREATE INDEX "AccountingCandidate_status_idx" ON "AccountingCandidate"("status");

-- CreateIndex
CREATE UNIQUE INDEX "AccountingCandidate_accountSlug_messageId_key" ON "AccountingCandidate"("accountSlug", "messageId");
