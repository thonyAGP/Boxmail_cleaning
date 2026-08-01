-- Ordre d'affichage des comptes + diagnostic quota (retour utilisateur 01/08).
ALTER TABLE "Account" ADD COLUMN "sortOrder" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Account" ADD COLUMN "quotaCheckedAt" DATETIME;
ALTER TABLE "Account" ADD COLUMN "quotaNote" TEXT;
