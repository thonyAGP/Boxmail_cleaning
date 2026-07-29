-- AlterTable
ALTER TABLE "Message" ADD COLUMN "aiSummary" TEXT;
ALTER TABLE "Message" ADD COLUMN "aiAction" TEXT;
ALTER TABLE "Message" ADD COLUMN "aiVerdictAt" DATETIME;
ALTER TABLE "Message" ADD COLUMN "aiModel" TEXT;
ALTER TABLE "Message" ADD COLUMN "intentSource" TEXT NOT NULL DEFAULT 'auto';
