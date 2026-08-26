-- CreateTable
CREATE TABLE "Qualification" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "threadId" INTEGER NOT NULL,
    "jusquAu" DATETIME NOT NULL,
    "verdict" TEXT NOT NULL,
    "motif" TEXT,
    "score" INTEGER,
    "qualifieAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE UNIQUE INDEX "Qualification_threadId_key" ON "Qualification"("threadId");

-- CreateIndex
CREATE INDEX "Qualification_verdict_idx" ON "Qualification"("verdict");
