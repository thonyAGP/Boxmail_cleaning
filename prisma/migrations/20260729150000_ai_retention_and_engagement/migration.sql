-- Stratégie de rétention fondée sur le verdict de l'analyse IA.
ALTER TABLE "RetentionPolicy" ADD COLUMN "matchAiAction" TEXT;

-- Engagement pré-calculé par expéditeur (perf : voir schema.prisma).
ALTER TABLE "Sender" ADD COLUMN "engagedAt" DATETIME;

-- Les sous-requêtes de protection cherchent une tâche par messageId ; sans cet
-- index, chaque ligne balayait toute la table Task.
CREATE INDEX IF NOT EXISTS "Task_messageId_idx" ON "Task"("messageId");

-- Les stratégies filtrent sur le verdict IA et sur l'intention : ces deux
-- index évitent un balayage complet de Message à chaque simulation.
CREATE INDEX IF NOT EXISTS "Message_aiAction_idx" ON "Message"("aiAction");
CREATE INDEX IF NOT EXISTS "Message_accountSlug_intent_idx" ON "Message"("accountSlug", "intent");
