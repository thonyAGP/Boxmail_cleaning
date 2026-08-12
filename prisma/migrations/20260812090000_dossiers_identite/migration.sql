-- CreateTable
CREATE TABLE "DossierAlias" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "dossierId" INTEGER NOT NULL,
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'ia',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "DossierAlias_dossierId_fkey" FOREIGN KEY ("dossierId") REFERENCES "Dossier" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "DossierIdentifier" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "dossierId" INTEGER NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'other',
    "value" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'ia',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "DossierIdentifier_dossierId_fkey" FOREIGN KEY ("dossierId") REFERENCES "Dossier" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Dossier" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "key" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'bien',
    "label" TEXT NOT NULL,
    "aliases" TEXT,
    "labelSource" TEXT NOT NULL DEFAULT 'auto',
    "status" TEXT NOT NULL DEFAULT 'auto',
    "mergedIntoId" INTEGER,
    "messageCount" INTEGER NOT NULL DEFAULT 0,
    "firstAt" DATETIME,
    "lastAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Dossier_mergedIntoId_fkey" FOREIGN KEY ("mergedIntoId") REFERENCES "Dossier" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_Dossier" ("aliases", "createdAt", "firstAt", "id", "key", "kind", "label", "lastAt", "messageCount", "status", "updatedAt") SELECT "aliases", "createdAt", "firstAt", "id", "key", "kind", "label", "lastAt", "messageCount", "status", "updatedAt" FROM "Dossier";
DROP TABLE "Dossier";
ALTER TABLE "new_Dossier" RENAME TO "Dossier";
CREATE UNIQUE INDEX "Dossier_key_key" ON "Dossier"("key");
CREATE INDEX "Dossier_status_idx" ON "Dossier"("status");
CREATE INDEX "Dossier_mergedIntoId_idx" ON "Dossier"("mergedIntoId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE UNIQUE INDEX "DossierAlias_key_key" ON "DossierAlias"("key");

-- CreateIndex
CREATE INDEX "DossierAlias_dossierId_idx" ON "DossierAlias"("dossierId");

-- CreateIndex
CREATE INDEX "DossierIdentifier_dossierId_idx" ON "DossierIdentifier"("dossierId");

-- CreateIndex
CREATE UNIQUE INDEX "DossierIdentifier_kind_value_key" ON "DossierIdentifier"("kind", "value");

