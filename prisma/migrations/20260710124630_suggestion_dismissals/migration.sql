-- CreateTable
CREATE TABLE "SuggestionDismissal" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "kind" TEXT NOT NULL,
    "refKey" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE UNIQUE INDEX "SuggestionDismissal_kind_refKey_key" ON "SuggestionDismissal"("kind", "refKey");
