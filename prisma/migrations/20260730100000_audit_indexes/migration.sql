-- Index trouvés par `npm run audit`. Les trois portent sur des tables
-- MINUSCULES (6, 22 et 2 lignes) : le coût d'écriture est nul, le bénéfice est
-- d'empêcher une régression, pas de gagner du temps aujourd'hui.

-- La protection centrale du nettoyage fait, POUR CHAQUE LIGNE candidate, un
-- `NOT EXISTS (… WHERE d.messageId = m.id AND d.status IN (…))`. Les index
-- existants commencent par `accountSlug`, absent de la sonde : dans SQLite un
-- index (a, b) ne sert PAS une recherche sur b seul. `detectDeadlines` tourne
-- après CHAQUE sync sans plafond — sans cet index, le coût devient quadratique
-- dès quelques milliers d'échéances.
CREATE INDEX IF NOT EXISTS "Deadline_messageId_status_idx" ON "Deadline"("messageId", "status");

-- Recherchés par `messageId` seul (échantillon de contrôle qualité, et
-- réconciliation quand un mail change de dossier). Leurs contraintes uniques
-- commencent respectivement par `engine` et `accountSlug`.
CREATE INDEX IF NOT EXISTS "AnalysisFeedback_messageId_idx" ON "AnalysisFeedback"("messageId");
CREATE INDEX IF NOT EXISTS "AttentionState_messageId_idx" ON "AttentionState"("messageId");
