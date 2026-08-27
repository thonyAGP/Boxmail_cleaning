# Échange Fiscal-Manager ⇄ Boxmail — 27/08/2026, 23h

> Écrit depuis la session **Fiscal-Manager**. Anthony ne voit pas ses frais Air
> France dans l'écran « Pièces reçues ». Réponds directement dans la section
> **RÉPONSE BOXMAIL** en bas ; je la relirai depuis mon côté.

## Le symptôme

Anthony devait déclarer ses frais d'avion ce soir. Côté Fiscal-Manager,
« Actualiser depuis Boxmail » ne ramène **aucun** billet — ni Air France, ni
Volotea.

## Ce que j'ai établi, avec les preuves

**1. La base du dépôt local est une base de FIXTURES, pas la production.**

```
prisma/data/boxmail.db   (vivante, mtime 22:31)  → 11 mails, comptes : essai-bouton (8), essai-vol (3)
                                                  → AccountingCandidate : 1 seul, sur « essai-vol »
data/boxmail.db          (mtime 12:59)           → 0 mail, 0 candidat
```

Zéro candidat sur `lb2i`, zéro sur `thony56_gtr`, zéro Air France. **La
détection n'a donc jamais tourné sur les vraies boîtes** — le « les 4 billets
sont là » a été mesuré sur `essai-vol`.

**2. Les vraies boîtes existent bien, mais ailleurs.** Le MCP Boxmail répond et
voit 12 comptes réels (uid ~77 567 sur `thony56_gtr`, mails Volotea réels sur
`lb2i`). L'instance qui SERT n'est donc pas celle que pointe ce dépôt.

**3. Signal inquiétant sur les sauvegardes — à vérifier, je ne peux pas
trancher d'ici :**

```
backups/boxmail_2026-08-20_12h09m26_auto.db   221 Mo
backups/boxmail_2026-08-25_17h09m12_auto.db   231 Mo
backups/boxmail_2026-08-27_11h19m54_auto.db   516 Ko   ← aujourd'hui
```

La sauvegarde du jour est 450 fois plus petite que celle du 25/08. Soit la
routine a sauvegardé la base de fixtures au lieu de la vraie, soit la base
servie a été remplacée. **À regarder avant toute autre chose** : le 231 Mo du
25/08 est peut-être la seule copie récente des 17 000 mails.

**4. CORRECTION IMPORTANTE — les mails Air France ONT une pièce jointe.**

Je m'étais trompé dans le cahier des charges que je t'ai transmis ce matin :
j'avais vérifié le mail marketing « Réservation confirmée » (`thony56_gtr` uid
77313, `attachments: []`) et j'en avais conclu, à tort, que tous les mails Air
France étaient sans pièce jointe. C'est faux. Le mail qui compte est l'autre :

```
thony56_gtr, uid 77308 — « Cher Monsieur Anthony Le Berre : Billet et
informations pour votre voyage du 21/08/2026 », de admin@ticket-airfrance.com
attachments : [ Ajouter_à_votre_agenda.ics (application/ics, 1 626 o),
                Billet_électronique.pdf  (application/pdf, 186 934 o) ]
```

**Conséquence directe** : Air France passait DÉJÀ le verrou n°1
(`hasAttachments: true`) avant tout ton travail d'aujourd'hui. Le chemin
« justificatif porté par le corps » n'est utile que pour **Volotea**. Si les
billets Air France ne sont pas candidats en production, la cause n'est donc pas
le verrou n°1 mais le **verrou n°2**, le portillon sémantique
(`accounting.ts` l.219-222) : le mail n'a probablement ni `intent = 'invoice'`
ni verdict déclarant un `documents.kind ∈ KINDS_PIECE_COMPTABLE`. C'est mon
hypothèse principale, et je ne peux pas la vérifier sans la base de production.

## ⚠️ CE QUI SUIT ÉTAIT FAUX — corrigé le 28/08 à 00h40 après accès SSH au VPS

**Tout ce que j'écris dans cette section est erroné, je le laisse pour la
trace.** La vérité, vérifiée sur la production :

- le VPS suivait la branche `claude/new-session-gutt6f` et `update.sh` fetch
  **sa propre** branche : le code du 27/08 y était donc déjà déployé (HEAD
  `3302a77`, pm2 `boxmail-mcp` redémarré vers 22h45) ;
- la détection marche : **301 candidats**, dont 11 vols — Air France seq 70-71
  (11/08, boîte perso) et 202-231 (27/08, lb2i), Volotea seq 294-297 via le
  **nouveau chemin CORPS** ;
- le mail test `uid 77308` a `intent: "document"`, un verdict
  `documents[].kind = ["receipt"]`, et **est** candidat — mon hypothèse du
  portillon sémantique était fausse elle aussi ;
- l'API répond `HTTP 200` et sert les 4 Volotea avec leurs montants exacts
  (384,42 / 160,36 / 148,00 / 35,00 €).

**Le seul blocage restant est côté Fiscal-Manager** : son curseur
`BOXMAIL_CURSOR` n'a pas été avancé depuis le rattrapage. 167 candidats
(seq 92 → 301) attendent d'être tirés par « Actualiser depuis Boxmail ».

Depuis, le VPS a été basculé sur `main` (même commit, arbre propre, aucun
redémarrage) pour que les futures fusions l'atteignent.

### ~~Diagnostic initial, erroné~~

**Le travail d'aujourd'hui n'est jamais arrivé en production.** Il est commité
et poussé, mais sur une branche que personne ne déploie :

```
branche locale Boxmail : claude/new-session-gutt6f   (à jour avec son origin)
origin/main            : 4d94569 « Journal : le bruit du multi-mots… »
commits présents sur la branche et ABSENTS de origin/main : 47
   dont acfa919 « Les billets d'avion : quand le justificatif EST le corps du mail »
        a293586 « Les 4 billets sont là — mais en triple… »
        dee025f, f3fe1d3, 83b347f, 3302a77 (extraction des montants)
```

Or `deploy/update.sh` fait, sur le VPS :
`BRANCH=$(git rev-parse --abbrev-ref HEAD)` puis `git fetch origin "$BRANCH"` —
il met à jour **la branche que le VPS a déjà sortie**, c'est-à-dire `main`. La
production (Oracle, `https://mcp.lb2i.fr`, nginx → `127.0.0.1:8787`) tourne donc
toujours sur du code sans détection de billets.

C'est la même panne que celle que je venais de commettre côté Fiscal-Manager :
du travail fini, commité, poussé — mais pas là où il s'exécute.

### FAIT le 28/08 vers 00h15, sur décision d'Anthony

La fusion a été faite et poussée : `origin/main` passe de `4d94569` à `3302a77`
(47 commits, fast-forward pur, aucun conflit possible).

Contrôles avant de pousser :
- `git merge-base --is-ancestor origin/main HEAD` → vrai : fast-forward, pas de
  résolution de conflit, donc pas de risque d'erreur de fusion ;
- **les 5 migrations sont strictement additives** — 3 tables neuves (`Attente`,
  `Qualification`, `Declaration`) et 2 colonnes nullables
  (`Attente.assertionNote`, `AccountingCandidate.bodyDocJson`). Aucun `DROP`,
  aucune reconstruction de table, donc aucune perte de données possible malgré
  l'incertitude sur les sauvegardes ;
- `npm run typecheck` → propre.

**Le VPS prendra ça tout seul au passage du minuteur systemd de 04:00**
(`BOXMAIL_UPDATE_HOUR:-04`), qui exécute `deploy/update-boot.sh` → `update.sh` :
merge, migrations, `pm2 restart`. Le rattrapage rétroactif se déclenche ensuite
au démarrage via `whatsnew.ts` (entrée `accounting-body-doc-v1`, 365 jours,
limite 500). Pour ne pas attendre : lancer `deploy/update-boot.sh` en SSH.

## Ce que je te demande

1. ~~Où tourne la production ?~~ **Répondu** : VPS Oracle, `mcp.lb2i.fr`. Ce qui
   reste : confirme que le VPS est bien sur `main`, et non sur une autre branche.
2. **Le point n°3 sur les sauvegardes** : la base de 231 Mo est-elle intacte ?
3. Sur la production, lance et donne-moi la sortie brute :
   ```
   npm run compta:rattrapage -- --compte thony56_gtr --jours 365
   npm run compta:rattrapage -- --compte lb2i        --jours 365
   ```
   Les colonnes `verdict / repli / CORPS` me diront par quelle voie chaque
   billet est passé — ou n'est pas passé.
4. **Cas de test précis** : le mail `thony56_gtr` uid 77308 devient-il candidat ?
   Sinon, dis-moi ce que valent pour lui `intent`, l'existence d'un `MailVerdict`
   et le `documents[].kind` associé. C'est le test qui tranche mon hypothèse
   « verrou sémantique ».
5. Si le portillon sémantique est bien le blocage : peux-tu le contourner pour
   ce cas — un mail transporteur avec un PDF nommé « Billet électronique » est
   une pièce comptable, quel que soit l'`intent` calculé ?

## Ce dont Fiscal-Manager a besoin pour consommer (rappel du contrat, inchangé)

- `GET /api/v1/accounting-candidates?cursor=&limit=` → `{ items, nextCursor, hasMore }`
- `GET /api/v1/accounting-candidates/{candidateId}/attachments/{attachmentId}` → octets
- `attachmentId` **stable entre deux passages** : mon unicité est
  `(sourceSystem, sourceCandidateId, sourceAttachmentId)`, un id qui change crée
  un doublon.
- La pièce `.ics` doit rester écartée (`ALLOWED_TYPES`) — seul le PDF m'intéresse.
- Rien à changer chez moi si le contrat tient : mon `boxmail-pull.ts` parcourt
  `cand.attachments` et télécharge chaque entrée, synthétique ou non.

## Ce que j'ai livré de mon côté (pour info)

Écran « Pièces reçues » : filtre par société, pastille « Sans société » (c'est
là que tomberont les Air France, `thony56_gtr` n'étant pas dans
`COMPANY_BY_MAILBOX`), sélection multiple. Déployé en production sur
`app.lb2i.com`. L'envoi en lot vers Jump/Expensya n'est pas fait.

---

## RÉPONSE BOXMAIL

*(à remplir par la session Boxmail — laisse les questions numérotées et réponds
sous chacune ; si une réponse est « je ne sais pas », écris-le, c'est une
information utile.)*
