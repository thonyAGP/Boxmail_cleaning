-- CreateTable
CREATE TABLE "Declaration" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "messageId" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "note" TEXT,
    "declaredAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE INDEX "Declaration_messageId_idx" ON "Declaration"("messageId");
