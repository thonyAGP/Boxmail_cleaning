-- CreateTable
CREATE TABLE "Attente" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "cote" TEXT NOT NULL,
    "quoi" TEXT NOT NULL,
    "qui" TEXT NOT NULL,
    "quiEmail" TEXT,
    "accountSlug" TEXT NOT NULL,
    "threadId" INTEGER,
    "messageId" INTEGER,
    "importance" TEXT NOT NULL DEFAULT 'moyenne',
    "urgence" TEXT NOT NULL DEFAULT 'moyenne',
    "etat" TEXT NOT NULL DEFAULT 'ouverte',
    "pourquoi" TEXT NOT NULL,
    "risque" TEXT,
    "dueAt" DATETIME,
    "montant" REAL,
    "devise" TEXT,
    "source" TEXT NOT NULL DEFAULT 'audit',
    "assertionAt" DATETIME,
    "vueAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE INDEX "Attente_etat_urgence_idx" ON "Attente"("etat", "urgence");

-- CreateIndex
CREATE INDEX "Attente_cote_etat_idx" ON "Attente"("cote", "etat");

-- CreateIndex
CREATE INDEX "Attente_threadId_idx" ON "Attente"("threadId");
