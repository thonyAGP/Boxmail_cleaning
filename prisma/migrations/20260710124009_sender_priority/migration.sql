-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Sender" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "accountSlug" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "displayName" TEXT,
    "domain" TEXT,
    "messageCount" INTEGER NOT NULL DEFAULT 0,
    "unseenCount" INTEGER NOT NULL DEFAULT 0,
    "unsubscribeCount" INTEGER NOT NULL DEFAULT 0,
    "totalSizeBytes" BIGINT NOT NULL DEFAULT 0,
    "firstMessageAt" DATETIME,
    "lastMessageAt" DATETIME,
    "kind" TEXT NOT NULL DEFAULT 'unknown',
    "category" TEXT,
    "categorySource" TEXT NOT NULL DEFAULT 'auto',
    "categoryReason" TEXT,
    "priority" TEXT NOT NULL DEFAULT 'normal',
    "notes" TEXT,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Sender_accountSlug_fkey" FOREIGN KEY ("accountSlug") REFERENCES "Account" ("slug") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_Sender" ("accountSlug", "category", "categoryReason", "categorySource", "displayName", "domain", "email", "firstMessageAt", "id", "kind", "lastMessageAt", "messageCount", "notes", "totalSizeBytes", "unseenCount", "unsubscribeCount", "updatedAt") SELECT "accountSlug", "category", "categoryReason", "categorySource", "displayName", "domain", "email", "firstMessageAt", "id", "kind", "lastMessageAt", "messageCount", "notes", "totalSizeBytes", "unseenCount", "unsubscribeCount", "updatedAt" FROM "Sender";
DROP TABLE "Sender";
ALTER TABLE "new_Sender" RENAME TO "Sender";
CREATE INDEX "Sender_accountSlug_messageCount_idx" ON "Sender"("accountSlug", "messageCount");
CREATE UNIQUE INDEX "Sender_accountSlug_email_key" ON "Sender"("accountSlug", "email");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
