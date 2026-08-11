-- CreateTable
CREATE TABLE "Dossier" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "key" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'bien',
    "label" TEXT NOT NULL,
    "aliases" TEXT,
    "status" TEXT NOT NULL DEFAULT 'auto',
    "messageCount" INTEGER NOT NULL DEFAULT 0,
    "firstAt" DATETIME,
    "lastAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "DossierMessage" (
    "dossierId" INTEGER NOT NULL,
    "messageId" INTEGER NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'subject',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

    PRIMARY KEY ("dossierId", "messageId"),
    CONSTRAINT "DossierMessage_dossierId_fkey" FOREIGN KEY ("dossierId") REFERENCES "Dossier" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "DossierMessage_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "Message" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "Dossier_key_key" ON "Dossier"("key");

-- CreateIndex
CREATE INDEX "Dossier_status_idx" ON "Dossier"("status");

-- CreateIndex
CREATE INDEX "DossierMessage_messageId_idx" ON "DossierMessage"("messageId");
