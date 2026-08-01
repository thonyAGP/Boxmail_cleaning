-- Extraits vides : la plupart venaient d'un bug (mail MONO-PARTIE déclaré
-- « sans partie texte » parce que la racine n'a pas de numéro de partie —
-- corrigé dans findTextNode le 02/08). On remet ces mails à NULL pour que la
-- capture RETENTE avec le correctif ; les rares vraiment sans texte
-- reviendront à '' et y resteront. S'exécute au démarrage, base libre.
UPDATE "Message" SET "snippet" = NULL, "snippetAt" = NULL WHERE "snippet" = '';
