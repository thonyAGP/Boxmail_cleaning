-- CreateTable
CREATE TABLE "Deadline" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "accountSlug" TEXT NOT NULL,
    "messageId" INTEGER NOT NULL,
    "threadId" INTEGER,
    "title" TEXT NOT NULL,
    "date" DATETIME NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'other',
    "status" TEXT NOT NULL DEFAULT 'proposed',
    "confidence" REAL NOT NULL DEFAULT 0.6,
    "reason" TEXT NOT NULL,
    "sourceText" TEXT NOT NULL,
    "fromEmail" TEXT,
    "fromName" TEXT,
    "subject" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Deadline_accountSlug_fkey" FOREIGN KEY ("accountSlug") REFERENCES "Account" ("slug") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "Deadline_accountSlug_status_date_idx" ON "Deadline"("accountSlug", "status", "date");

-- CreateIndex
CREATE UNIQUE INDEX "Deadline_accountSlug_messageId_date_key" ON "Deadline"("accountSlug", "messageId", "date");
