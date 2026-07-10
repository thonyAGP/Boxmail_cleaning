-- CreateTable
CREATE TABLE "RetentionPolicy" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "matchIntent" TEXT,
    "matchCategory" TEXT,
    "unseenOnly" BOOLEAN NOT NULL DEFAULT false,
    "ageDays" INTEGER NOT NULL,
    "action" TEXT NOT NULL DEFAULT 'trash',
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "autoApply" BOOLEAN NOT NULL DEFAULT false,
    "appliedCount" INTEGER NOT NULL DEFAULT 0,
    "lastAppliedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "RetentionPolicy_key_key" ON "RetentionPolicy"("key");
