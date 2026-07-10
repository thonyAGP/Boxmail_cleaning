-- AlterTable
ALTER TABLE "Account" ADD COLUMN "quotaLimitBytes" BIGINT;
ALTER TABLE "Account" ADD COLUMN "quotaUsedBytes" BIGINT;
