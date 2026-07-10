-- CreateTable
CREATE TABLE "AnalysisFeedback" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "engine" TEXT NOT NULL,
    "accountSlug" TEXT NOT NULL,
    "messageId" INTEGER NOT NULL,
    "verdict" TEXT NOT NULL,
    "reason" TEXT,
    "subject" TEXT,
    "fromEmail" TEXT,
    "fromName" TEXT,
    "claim" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE INDEX "AnalysisFeedback_engine_verdict_idx" ON "AnalysisFeedback"("engine", "verdict");

-- CreateIndex
CREATE UNIQUE INDEX "AnalysisFeedback_engine_messageId_key" ON "AnalysisFeedback"("engine", "messageId");
