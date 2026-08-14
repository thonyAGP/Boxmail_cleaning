# Changement — comptes-imap-mot-de-passe

- **Date** : 2026-08-14 · **Niveau de risque** : élevé
- **Critères déclenchés** :
  - (c) Sécurité/secrets : on stocke un mot de passe de boîte mail au repos et on ajoute une branche au chemin d'authentification IMAP/SMTP.
  - (a) Taille : ≥ 5 fichiers attendus (accounts.ts, imap.ts, smtp.ts, admin.ts, config.ts, web/js/app.js).
  - (f) Blast radius : le pool IMAP modifié sert les 7 boîtes Outlook de production ; une régression y casserait la sync de tout le parc.
- **Domaines sensibles** : securite

## 1. Intention
- **Besoin** : Anthony veut enrôler sa boîte professionnelle **lb2i** hébergée chez OVH. L'app ne sait enrôler que des comptes Outlook.com via OAuth (MSAL/XOAUTH2) ; OVH n'offre pas d'OAuth — il faut l'authentification IMAP classique par mot de passe. POP3 est écarté d'emblée : pas de dossiers, sémantique de téléchargement-suppression incompatible avec tout le modèle de l'app (sync de dossiers, corbeille, soft delete).
- **Critères de succès observables** :
  1. Depuis l'écran « Ajouter une boîte mail », un formulaire « Compte IMAP (OVH…) » permet d'enrôler lb2i sans ligne de commande ; la connexion est TESTÉE avant enregistrement (échec = message clair, rien n'est stocké).
  2. La boîte lb2i se synchronise, apparaît dans le tableau de bord et tous les écrans comme les boîtes Outlook (brief, importants, nettoyage…).
  3. Les 7 boîtes Outlook existantes continuent de se synchroniser à l'identique (aucun changement de comportement).
  4. L'envoi SMTP depuis lb2i fonctionne avec confirmation, comme aujourd'hui.
- **Non-objectifs** :
  - POP3 (refusé, voir Besoin).
  - CLI d'enrôlement IMAP (Anthony n'utilise que l'interface ; la CLI reste OAuth-only pour l'instant).
  - Détection automatique des serveurs (autoconfig/SRV) : un préréglage OVH suffit, champs éditables pour les autres fournisseurs.
  - Migration du format accounts.json : les champs nouveaux sont optionnels, les enregistrements OAuth existants restent valides tels quels.

## 2. Carte d'impact
- **Zones touchées directement** :
  - `src/services/accounts.ts` — `AccountRecord` +`authType?`, `passwordBlob?`, `imapHost/imapPort/smtpHost/smtpPort?` ; `upsertImapAccount()` ; `tokenStatus()` branché par type.
  - `src/services/imap.ts` — `getClient()` : branche auth LOGIN (user/pass déchiffré) + host/port par compte ; expiration de pool fixe (50 min) pour ces comptes.
  - `src/services/smtp.ts` — `sendEmail()` : branche auth pass + host/port par compte, `secure` selon port (465 = TLS implicite, 587 = STARTTLS).
  - `src/server/admin.ts` — endpoint `POST /api/enroll/imap` (validation, test de connexion imapflow AVANT stockage, upsert, jamais de mot de passe dans les logs ni la réponse).
  - `web/js/app.js` (+ `web/js/api.js`) — la modale « Ajouter une boîte mail » gagne l'option IMAP avec préréglage OVH (`ssl0.ovh.net` 993/465).
- **Zones touchées indirectement** :
  - Tous les consommateurs d'`AccountRecord` (sync, cleanup, MCP tools, health, brief…) — ils traitent le record comme opaque, aucun ne lit `cacheBlob` directement (vérifié : `accessTokenFor` n'a que 3 appelants : imap.ts, smtp.ts, tokenStatus).
  - `src/services/oauth.ts` — non modifié, mais `accessTokenFor` ne doit JAMAIS être appelé sur un compte password (garde explicite).
  - accounts.json en production (7 comptes OAuth) — relu par le nouveau code sans migration.
- **Invariants** :
  - Un compte OAuth existant se connecte après le changement exactement comme avant (même chemin de code, aucun champ requis en plus).
  - Le mot de passe n'apparaît JAMAIS en clair : ni dans accounts.json (chiffré AES-256-GCM comme cacheBlob), ni dans les logs, ni dans une réponse API, ni dans le repo.
  - Un échec du test de connexion à l'enrôlement ne stocke RIEN.
  - `accessTokenFor` sur un compte password lève une erreur claire (pas de comportement silencieux).
  - Les garde-fous existants (soft delete, dry-run, journalisation) s'appliquent à l'identique au nouveau compte — aucun chemin de code ne les contourne.

## 3. Inconnues & hypothèses
- **Inconnues** :
  - Les paramètres exacts de la boîte lb2i (adresse complète, mot de passe — connus d'Anthony seul ; le préréglage OVH `ssl0.ovh.net:993/465` est le standard mutualisé OVH, à confirmer au premier enrôlement réel).
  - OVH MX Plan impose parfois l'adresse complète comme login — on utilise l'adresse email comme user par défaut (c'est le cas standard).
- **Hypothèses** :
  - imapflow accepte `auth: { user, pass }` (documenté) et le reste de la couche IMAP (plages d'UID, flags…) est agnostique du fournisseur. Les particularités Outlook codées (plages d'UID) sont inoffensives sur OVH (comportement standard).
  - nodemailer gère `secure:true` port 465 pour OVH (standard).
  - HTTPS en prod (boxmail.lb2i.com) protège le transit unique du mot de passe navigateur→serveur à l'enrôlement. C'est une déviation ASSUMÉE de la règle « les tokens ne transitent jamais par le navigateur » : un mot de passe IMAP n'a pas d'autre chemin possible, il transite UNE fois, en HTTPS, et n'est jamais renvoyé au client.

## 4. Décision
- **Options** :
  - **A. IMAP par mot de passe intégré au modèle de comptes existant** (retenue) : champs optionnels sur `AccountRecord`, même fichier accounts.json, même chiffrement, branche `authType` aux 3 points de contact auth. + : surface minimale, zéro migration, l'app entière marche sans changement ; − : accounts.json porte deux natures de secrets.
  - **B. Passerelle OAuth tierce / proxy** (écartée) : aucun fournisseur OAuth pour OVH mutualisé, complexité injustifiée.
  - **C. POP3** (écartée) : incompatible avec le modèle (dossiers, corbeille, soft delete).
  - **Store séparé pour les comptes password** (variante de A, écartée) : deux fichiers de comptes = deux chemins de lecture partout, le contraire de l'objectif « le reste de l'app ne voit rien ».
- **Décision** : option A. Le record reste opaque pour tout le code aval ; seule la résolution des identifiants (3 points) branche sur `authType`.
- **Contre-revue** : FAITE (protocole aveugle 2 tours, `.consult/2026-08-14-comptes-imap/synthese.md`, fil ChatGPT 6a7f37d0). Verdict : architecture confirmée, amendements retenus — (1) test SMTP `verify()` en plus de l'IMAP avant tout stockage ; (2) anti-écrasement : nom déjà en OAuth → refus explicite, nom en password → mise à jour du mot de passe après re-test ; (3) `imapUser`/`smtpUser` optionnels (défaut = adresse) ; (4) `imapSecure`/`smtpSecure` stockés à l'enrôlement (993/465 = TLS implicite, 143/587 = STARTTLS `requireTLS`), jamais `rejectUnauthorized:false` ; (5) santé sans faux « ok token » ; (7) garde SSRF sur l'hôte, ports limités (993/143, 465/587), erreurs sémantiques, pas de logger protocolaire. Sa divergence E (dossiers Outlook en dur) est retirée après vérification : rôles par SPECIAL-USE, `appendToSent` générique, `uidValidity` par dossier.
- **ADR** : non — extension naturelle du modèle existant, pas de décision à mémoire longue.

## 5. Plan de preuve
- **Conformité** :
  - `npx tsc --noEmit` et `node --check web/js/app.js web/js/api.js` propres.
  - Test local (PORT=8799, .env de dev) : `POST /api/enroll/imap` avec un serveur IMAP factice/injoignable → erreur claire, accounts.json inchangé (rien stocké sur échec).
  - Enrôlement réel lb2i par Anthony via l'interface = preuve de bout en bout (inconnues §3).
- **Non-régression** :
  - Relecture d'accounts.json de dev par le nouveau code : les comptes OAuth existants se chargent (listAccountNames/getAccountRecord inchangés).
  - Chemin OAuth de `getClient`/`sendEmail` inchangé à diff près (relecture du diff : la branche password est additive, le flux OAuth ne traverse aucune ligne nouvelle).
  - En prod après déploiement : les 7 boîtes continuent de se synchroniser (autosync + santé).
- **Invariants** :
  - Grep du diff : aucun log du champ mot de passe ; la réponse de l'endpoint ne contient pas le mot de passe.
  - accounts.json après enrôlement de test : `passwordBlob` illisible (base64 GCM), jamais de clair.
  - Test unitaire rapide : `accessTokenFor` sur un record `authType:'password'` → erreur explicite.
- **Gate securite (au commit)** : attester — chiffrement au repos identique aux tokens, aucun secret loggé, transit unique HTTPS, rien stocké sur échec de connexion.

## 6. Preuves exécutées
- **Résultats** (tous EXÉCUTÉS le 14/08) :
  - `npx tsc --noEmit` : exit 0 ; `node --check web/js/app.js web/js/api.js` : OK.
  - Endpoint testé sur serveur local PORT=8799 (session admin réelle) :
    nom déjà en OAuth → **HTTP 409** sans tentative de connexion ; `localhost` → 400 « adresse locale » ; `192.168.1.10` → 400 « IP privée » ; `nexiste-pas.invalid` → 400 « nom introuvable (DNS) » ; port SMTP 25 → 400 ; **vrai ssl0.ovh.net:993 avec mauvais identifiants → 400 « identifiants refusés par le serveur IMAP »** (message sémantique, connexion réelle OVH traversée). Après TOUS ces échecs : `accounts.json` **octet pour octet identique** (sha256 d5915cb1… avant = après).
  - Preuves unitaires (tsx, store jetable) — 8/8 OK : mot de passe absent en clair du JSON ; aller-retour `imapPasswordOf` exact (avec accents) ; `accessTokenFor(password)` lève « s'authentifie par mot de passe » ; fixture OAuth legacy sans `authType` relue intacte ; `upsertImapAccount` sur un nom OAuth refuse et laisse l'enregistrement inchangé ; `imapPasswordOf(oauth)` lève.
  - Grep du diff : la seule ligne de log ajoutée est `compte IMAP enrôlé` (account/username/hosts) — jamais le mot de passe ni sa longueur.
- **Diff réel ↔ carte d'impact** : conforme — 6 fichiers, tous dans la carte (`config.ts` prévu mais finalement non modifié : les valeurs par compte suffisent, les défauts globaux restent Outlook).
- **Divergences vs plan** : les amendements de la contre-revue (SMTP verify, 409 anti-écrasement, users/secure explicites, SSRF, ports limités, erreurs sémantiques) intégrés au périmètre — voir §4. Aucune zone hors carte.

## 7. Mise en service & observation
- **Déploiement / rollback** : livraison par le canal habituel (push → bandeau de mise à jour → git pull + redémarrage). Rollback = revert du commit ; les champs nouveaux d'accounts.json sont ignorés par l'ancien code (optionnels), donc retour arrière sans casse.
- **Signaux à observer** : santé des 7 boîtes Outlook après déploiement (écran santé + autosync) ; premier enrôlement lb2i (test de connexion) ; première sync lb2i complète ; `logs/operations.jsonl` sans trace de secret.
- **Clôture** : après le premier enrôlement réel + une sync complète lb2i + 24 h de sync normale du parc.
