-- CreateTable
CREATE TABLE "RentilaCommand" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "kind" TEXT NOT NULL,
    "params" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "accountSlug" TEXT,
    "messageId" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'proposed',
    "result" TEXT,
    "executedAt" DATETIME
);

-- CreateIndex
CREATE INDEX "RentilaCommand_status_idx" ON "RentilaCommand"("status");
