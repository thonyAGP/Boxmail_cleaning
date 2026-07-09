-- CreateTable
CREATE TABLE "Account" (
    "slug" TEXT NOT NULL PRIMARY KEY,
    "emailAddress" TEXT NOT NULL,
    "displayName" TEXT,
    "lastSyncAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "Folder" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "accountSlug" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "delimiter" TEXT,
    "role" TEXT NOT NULL DEFAULT 'custom',
    "uidValidity" BIGINT,
    "lastUidSeen" INTEGER NOT NULL DEFAULT 0,
    "messageCount" INTEGER NOT NULL DEFAULT 0,
    "unseenCount" INTEGER NOT NULL DEFAULT 0,
    "lastSyncedAt" DATETIME,
    CONSTRAINT "Folder_accountSlug_fkey" FOREIGN KEY ("accountSlug") REFERENCES "Account" ("slug") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Message" (
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
    "isDeleted" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Message_accountSlug_fkey" FOREIGN KEY ("accountSlug") REFERENCES "Account" ("slug") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Message_folderId_fkey" FOREIGN KEY ("folderId") REFERENCES "Folder" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Message_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "Thread" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Thread" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "accountSlug" TEXT NOT NULL,
    "normalizedSubject" TEXT,
    "firstMessageAt" DATETIME,
    "lastMessageAt" DATETIME,
    "lastDirection" TEXT,
    "messageCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Thread_accountSlug_fkey" FOREIGN KEY ("accountSlug") REFERENCES "Account" ("slug") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Sender" (
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
    "notes" TEXT,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Sender_accountSlug_fkey" FOREIGN KEY ("accountSlug") REFERENCES "Account" ("slug") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "Folder_accountSlug_path_key" ON "Folder"("accountSlug", "path");

-- CreateIndex
CREATE INDEX "Message_accountSlug_fromEmail_idx" ON "Message"("accountSlug", "fromEmail");

-- CreateIndex
CREATE INDEX "Message_accountSlug_internetMessageId_idx" ON "Message"("accountSlug", "internetMessageId");

-- CreateIndex
CREATE INDEX "Message_accountSlug_normalizedSubject_idx" ON "Message"("accountSlug", "normalizedSubject");

-- CreateIndex
CREATE INDEX "Message_threadId_idx" ON "Message"("threadId");

-- CreateIndex
CREATE INDEX "Message_accountSlug_isDeleted_date_idx" ON "Message"("accountSlug", "isDeleted", "date");

-- CreateIndex
CREATE UNIQUE INDEX "Message_folderId_uid_key" ON "Message"("folderId", "uid");

-- CreateIndex
CREATE INDEX "Thread_accountSlug_normalizedSubject_idx" ON "Thread"("accountSlug", "normalizedSubject");

-- CreateIndex
CREATE INDEX "Thread_accountSlug_lastMessageAt_idx" ON "Thread"("accountSlug", "lastMessageAt");

-- CreateIndex
CREATE INDEX "Sender_accountSlug_messageCount_idx" ON "Sender"("accountSlug", "messageCount");

-- CreateIndex
CREATE UNIQUE INDEX "Sender_accountSlug_email_key" ON "Sender"("accountSlug", "email");
