-- AlterTable
ALTER TABLE "Message" ADD COLUMN "attachmentKind" TEXT;
ALTER TABLE "Message" ADD COLUMN "attachmentText" TEXT;
ALTER TABLE "Message" ADD COLUMN "attachmentTextAt" DATETIME;
