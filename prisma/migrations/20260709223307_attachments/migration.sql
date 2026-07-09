-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Message" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "accountSlug" TEXT NOT NULL,
    "folderId" INTEGER NOT NULL,
    "uid" INTEGER NOT NULL,
    "internetMessageId" TEXT,
    "inReplyTo" TEXT,
    "threadId" INTEGER,
    "subject" TEXT,
    "normalizedSubject" TEXT,
    "fromName" TEXT,
    "fromEmail" TEXT,
    "toEmails" TEXT,
    "date" DATETIME,
    "isSeen" BOOLEAN NOT NULL DEFAULT false,
    "isAnswered" BOOLEAN NOT NULL DEFAULT false,
    "isFlagged" BOOLEAN NOT NULL DEFAULT false,
    "isOutbound" BOOLEAN NOT NULL DEFAULT false,
    "sizeBytes" INTEGER NOT NULL DEFAULT 0,
    "hasListUnsubscribe" BOOLEAN NOT NULL DEFAULT false,
    "hasAttachments" BOOLEAN NOT NULL DEFAULT false,
    "attachmentCount" INTEGER NOT NULL DEFAULT 0,
    "isDeleted" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Message_accountSlug_fkey" FOREIGN KEY ("accountSlug") REFERENCES "Account" ("slug") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Message_folderId_fkey" FOREIGN KEY ("folderId") REFERENCES "Folder" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Message_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "Thread" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_Message" ("accountSlug", "createdAt", "date", "folderId", "fromEmail", "fromName", "hasListUnsubscribe", "id", "inReplyTo", "internetMessageId", "isAnswered", "isDeleted", "isFlagged", "isOutbound", "isSeen", "normalizedSubject", "sizeBytes", "subject", "threadId", "toEmails", "uid", "updatedAt") SELECT "accountSlug", "createdAt", "date", "folderId", "fromEmail", "fromName", "hasListUnsubscribe", "id", "inReplyTo", "internetMessageId", "isAnswered", "isDeleted", "isFlagged", "isOutbound", "isSeen", "normalizedSubject", "sizeBytes", "subject", "threadId", "toEmails", "uid", "updatedAt" FROM "Message";
DROP TABLE "Message";
ALTER TABLE "new_Message" RENAME TO "Message";
CREATE INDEX "Message_accountSlug_fromEmail_idx" ON "Message"("accountSlug", "fromEmail");
CREATE INDEX "Message_accountSlug_internetMessageId_idx" ON "Message"("accountSlug", "internetMessageId");
CREATE INDEX "Message_accountSlug_normalizedSubject_idx" ON "Message"("accountSlug", "normalizedSubject");
CREATE INDEX "Message_threadId_idx" ON "Message"("threadId");
CREATE INDEX "Message_accountSlug_isDeleted_date_idx" ON "Message"("accountSlug", "isDeleted", "date");
CREATE UNIQUE INDEX "Message_folderId_uid_key" ON "Message"("folderId", "uid");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
