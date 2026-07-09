-- CreateTable
CREATE TABLE "AttentionState" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "accountSlug" TEXT NOT NULL,
    "threadId" INTEGER NOT NULL,
    "messageId" INTEGER NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'reply',
    "state" TEXT NOT NULL,
    "snoozedUntil" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "AttentionState_accountSlug_fkey" FOREIGN KEY ("accountSlug") REFERENCES "Account" ("slug") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "AttentionState_accountSlug_threadId_kind_key" ON "AttentionState"("accountSlug", "threadId", "kind");
