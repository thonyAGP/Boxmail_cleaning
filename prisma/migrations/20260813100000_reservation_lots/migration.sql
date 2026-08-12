-- Réservation des lots d'analyse : un agent pose sa marque sur les mails
-- qu'il emporte, un autre agent ne les reçoit plus. La marque périme au bout
-- de 30 minutes (constante CLAIM_TTL_MS, services/analysis.ts) pour qu'une
-- session interrompue ne retire pas ses mails du vivier définitivement.
ALTER TABLE "Message" ADD COLUMN "claimedAt" DATETIME;
ALTER TABLE "Message" ADD COLUMN "claimedBy" TEXT;
CREATE INDEX "Message_claimedAt_idx" ON "Message"("claimedAt");
