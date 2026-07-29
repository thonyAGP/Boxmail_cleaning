-- Les stratégies « newsletters » et « réseaux sociaux » filtrent sur
-- Sender.category, qui n'était indexé sur aucune colonne utile. Mesuré sur la
-- vraie base (35 000 mails) : l'aperçu de `newsletter90` prenait 7,5 s et la
-- simulation complète de la page 12,9 s. Avec cet index : 65 ms et 178 ms.
CREATE INDEX IF NOT EXISTS "Sender_accountSlug_category_idx" ON "Sender"("accountSlug", "category");

-- Le planificateur de SQLite choisit son plan d'après des statistiques qu'il ne
-- collecte JAMAIS tout seul. Sans ANALYZE il ignorait quels index valaient la
-- peine et repartait sur un balayage complet ; c'est la moitié du gain ci-dessus.
ANALYZE;
