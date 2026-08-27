-- Justificatif porté par le CORPS du mail (billets d'avion sans pièce jointe).
-- Additif et nullable : les candidats existants restent inchangés.
ALTER TABLE "AccountingCandidate" ADD COLUMN "bodyDocJson" TEXT;
