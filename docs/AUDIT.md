# Audit — troncatures, listes non ouvrables, requêtes sans index

_Régénéré par `npm run audit` le 2026-07-30 09:14:10 (statique seulement)._

**Ne pas éditer ce fichier** : il est reconstruit à chaque passage depuis
`docs/audit-findings.json`. Pour clore un constat, passer son `status` à
`fixed` ou `accepted` dans le JSON — le script ne l'écrase jamais.

| | |
|---|---|
| Constats ouverts | **69** |
| Clos (corrigés ou acceptés) | 0 |
| Nouveaux à ce passage | 0 |
| N’apparaissent plus (peut-être corrigés) | 11 |

## Lecture

Les constats **confirmés** sont mesurés (chronomètre, `EXPLAIN QUERY PLAN`,
octet lu dans le fichier) ou relevés à la main. Ceux marqués **à vérifier**
viennent d'expressions régulières sur le front : ce sont des pistes, pas des
verdicts — certains sont des choix délibérés.

## Gravité : critique (2)

### Liste de mails non ouvrable — La liste relue juste avant la corbeille n’est pas ouvrable

- **Où** : `src/services/cleanup.ts:177` · `listCleanupMessages`
- **Fiabilité** : confirmé
- **Clé** : `B:src/services/cleanup.ts:listCleanupMessages:sans-coordonnees`

`CleanupMessage` porte `uid` et `date` mais ni `account` ni `folder`, et l’enveloppe de réponse ne les ajoute pas — alors que la route les connaît (`admin.ts` lit `req.query.folder ?? "INBOX"`). `openReaderFor` refuse donc d’ouvrir. L’utilisateur ne peut vérifier aucun mail avant de confirmer.

### Liste de mails non ouvrable — L’échantillon affiché avant une suppression de masse est une liste de chaînes

- **Où** : `src/services/cleanup.ts:152` · `previewSenderCleanup`
- **Fiabilité** : confirmé
- **Clé** : `B:src/services/cleanup.ts:previewSenderCleanup:echantillon-chaines-nues`

Le service fait `select: { subject: true }` puis `samples.map(s => s.subject)` : l’aperçu de confirmation est un `string[]`. Ni ouvrable, ni daté, ni traçable — or c’est précisément l’écran où l’utilisateur valide l’envoi de centaines de mails à la corbeille. C’est le cas le plus grave de tout l’audit au vu de l’enjeu.

## Gravité : grave (13)

### Texte tronqué sans moyen de lire l’intégralité — L’infobulle contient les signaux, pas le sujet coupé

- **Où** : `web/js/app.js:2202` · `openCleanupModal`
- **Fiabilité** : confirmé
- **Clé** : `A:web/js/app.js:openCleanupModal:title-occupe-par-les-signaux`

Le `title` vaut `m.signals.join(" · ")`. Le sujet, tronqué par `.mail-subject` (ellipsis), est donc irrécupérable : ni lisible en entier, ni ouvrable. Deux défauts qui se referment l’un sur l’autre.

### Liste de mails non ouvrable — L’aperçu d’une règle de classement n’est pas ouvrable

- **Où** : `src/services/rules.ts:191` · `previewRule`
- **Fiabilité** : confirmé
- **Clé** : `B:src/services/rules.ts:previewRule:sans-coordonnees`

`select: { uid, subject, fromEmail, date }` — ni `account` ni `folder`. Conséquence visible : la modale voisine (aperçu de rétention) est ouvrable, celle-ci non. Même écran, deux traitements, parce que l’API ne fournit pas la même chose. On valide un déplacement de N mails sans en vérifier un seul.

### Liste de mails non ouvrable — Modale listant des mails sans « under-reader »

- **Où** : `web/js/app.js:2138` · `openCleanupModal`
- **Fiabilité** : à vérifier
- **Clé** : `B:web/js/app.js:openCleanupModal:overlay-sans-under-reader`

L’overlay n’a pas la classe under-reader : le panneau de lecture s’ouvrirait DERRIÈRE la modale. Rendre un sujet cliquable ne suffit donc pas — il faut aussi changer la classe de l’overlay.

### Liste de mails non ouvrable — Cliquer le sujet COCHE la case au lieu d’ouvrir le mail

- **Où** : `web/js/app.js:2202` · `openCleanupModal`
- **Fiabilité** : confirmé
- **Clé** : `B:web/js/app.js:openCleanupModal:sujet-non-ouvrable`

Le sujet est un `<span class="mail-subject">` sans `openable` ni écouteur, enveloppé dans un `<label class="mail-row">` : le clic est capté par le label et bascule la case. C’est le même défaut que celui corrigé le 29/07 sur l’aperçu de rétention, mais sur l’écran qui supprime réellement.

### Liste de mails non ouvrable — Modale listant des mails sans « under-reader »

- **Où** : `web/js/app.js:6381` · `openComposeModal`
- **Fiabilité** : à vérifier
- **Clé** : `B:web/js/app.js:openComposeModal:overlay-sans-under-reader`

L’overlay n’a pas la classe under-reader : le panneau de lecture s’ouvrirait DERRIÈRE la modale. Rendre un sujet cliquable ne suffit donc pas — il faut aussi changer la classe de l’overlay.

### Liste de mails non ouvrable — Modale listant des mails sans « under-reader »

- **Où** : `web/js/app.js:3462` · `openRuleModal`
- **Fiabilité** : à vérifier
- **Clé** : `B:web/js/app.js:openRuleModal:overlay-sans-under-reader`

L’overlay n’a pas la classe under-reader : le panneau de lecture s’ouvrirait DERRIÈRE la modale. Rendre un sujet cliquable ne suffit donc pas — il faut aussi changer la classe de l’overlay.

### Liste de mails non ouvrable — Modale listant des mails sans « under-reader »

- **Où** : `web/js/app.js:3414` · `openRulePreview`
- **Fiabilité** : à vérifier
- **Clé** : `B:web/js/app.js:openRulePreview:overlay-sans-under-reader`

L’overlay n’a pas la classe under-reader : le panneau de lecture s’ouvrirait DERRIÈRE la modale. Rendre un sujet cliquable ne suffit donc pas — il faut aussi changer la classe de l’overlay.

### Requête sans index / motif coûteux — `ANALYZE` n’est joué qu’une fois, à la migration du 29/07

- **Où** : `prisma/migrations` · `ANALYZE`
- **Fiabilité** : confirmé
- **Clé** : `D:prisma/migrations:ANALYZE:jamais-rejoue`

SQLite ne collecte JAMAIS de statistiques de lui-même. Sans elles, son planificateur ignore quels index valent la peine et retombe sur des balayages. Le commentaire de la migration dit lui-même que c’est « la moitié du gain » des 40 s → 178 ms. Après quelques dizaines de milliers de mails de plus, les statistiques seront périmées — et rien ne le signalera. `PRAGMA optimize` dans `applySqlitePragmas` réglerait cela à coût nul.

### Requête sans index / motif coûteux — Aucun index sur `Deadline.messageId` seul — régression quadratique programmée

- **Où** : `prisma/schema.prisma` · `Deadline`
- **Fiabilité** : confirmé
- **Clé** : `D:prisma/schema.prisma:Deadline:index-messageId-absent`

La protection centrale exécute `NOT EXISTS (SELECT 1 FROM Deadline d WHERE d.messageId = m.id …)` POUR CHAQUE LIGNE candidate. Les deux index existants commencent par `accountSlug`, absent de la sonde : dans SQLite un index (a, b) ne sert pas une recherche sur b seul. La table ne contient que 6 lignes aujourd’hui, donc l’impact est nul — mais `detectDeadlines` tourne après CHAQUE sync sans plafond. Une ligne de schéma neutralise une régression certaine : c’est le meilleur rapport coût/bénéfice de tout l’audit.

### Requête sans index / motif coûteux — Octet nul dans un fichier source

- **Où** : `src/services/categorize.ts` · `(fichier entier)`
- **Fiabilité** : confirmé · offset 29791
- **Clé** : `D:src/services/categorize.ts::octet-nul`

Octet nul à l’offset 29791. Ripgrep classe le fichier comme binaire et le saute SANS RIEN DIRE : toute recherche, tout outil de la chaîne appuyé sur grep ignore ce fichier en silence.

### Requête sans index / motif coûteux — Octet nul dans un fichier source

- **Où** : `src/services/retention.ts` · `(fichier entier)`
- **Fiabilité** : confirmé · offset 23797
- **Clé** : `D:src/services/retention.ts::octet-nul`

Octet nul à l’offset 23797. Ripgrep classe le fichier comme binaire et le saute SANS RIEN DIRE : toute recherche, tout outil de la chaîne appuyé sur grep ignore ce fichier en silence.

### Requête sans index / motif coûteux — Modale de 560 px pour date + sujet + extrait + 2 badges

- **Où** : `web/js/app.js:2139` · `openCleanupModal`
- **Fiabilité** : confirmé
- **Clé** : `D:web/js/app.js:openCleanupModal:modale-trop-etroite`

Conteneur `class="modal"` (560 px) au lieu de `modal-wide` (1100 px) : l’ellipse est garantie sur toutes les lignes. `modal-wide` existe déjà.

### Requête sans index / motif coûteux — Colonne de date en bout de ligne

- **Où** : `web/js/app.js:882` · `openNoiseModal`
- **Fiabilité** : à vérifier
- **Clé** : `D:web/js/app.js:openNoiseModal:date-en-derniere-colonne`

La date est la dernière colonne : c’est la position d’où elle sortait du cadre le 29/07 dès qu’une cellule voisine s’élargissait. La remonter et fixer les largeurs des <th>.

## Gravité : moyen (35)

### Texte tronqué sans moyen de lire l’intégralité — Texte coupé sans infobulle

- **Où** : `web/js/app.js:4151` · `loadBigClean`
- **Fiabilité** : à vérifier
- **Clé** : `A:web/js/app.js:loadBigClean:ellipsis-sans-title`

Cellule tronquée (ellipsis/nowrap) sans attribut title à proximité : le texte complet est irrécupérable pour l’utilisateur.

### Texte tronqué sans moyen de lire l’intégralité — Texte coupé sans infobulle

- **Où** : `web/js/app.js:3606` · `loadUnsubscribe`
- **Fiabilité** : à vérifier
- **Clé** : `A:web/js/app.js:loadUnsubscribe:ellipsis-sans-title`

Cellule tronquée (ellipsis/nowrap) sans attribut title à proximité : le texte complet est irrécupérable pour l’utilisateur.

### Texte tronqué sans moyen de lire l’intégralité — Texte coupé sans infobulle

- **Où** : `web/js/app.js:889` · `openNoiseModal`
- **Fiabilité** : à vérifier
- **Clé** : `A:web/js/app.js:openNoiseModal:ellipsis-sans-title`

Cellule tronquée (ellipsis/nowrap) sans attribut title à proximité : le texte complet est irrécupérable pour l’utilisateur.

### Texte tronqué sans moyen de lire l’intégralité — L’infobulle du sujet dit « Lire le mail » au lieu de donner le sujet

- **Où** : `web/js/app.js:886` · `openNoiseModal`
- **Fiabilité** : confirmé
- **Clé** : `A:web/js/app.js:openNoiseModal:title-libelle-daction`

La cellule est tronquée (`max-width:520px`, ellipsis) et le `title` porte un libellé d’action. Le sujet complet reste inaccessible.

### Texte tronqué sans moyen de lire l’intégralité — Texte coupé sans infobulle

- **Où** : `web/js/app.js:4276` · `openRetentionPreview`
- **Fiabilité** : à vérifier
- **Clé** : `A:web/js/app.js:openRetentionPreview:ellipsis-sans-title`

Cellule tronquée (ellipsis/nowrap) sans attribut title à proximité : le texte complet est irrécupérable pour l’utilisateur.

### Texte tronqué sans moyen de lire l’intégralité — Texte coupé sans infobulle

- **Où** : `web/js/app.js:641` · `quotaCell`
- **Fiabilité** : à vérifier
- **Clé** : `A:web/js/app.js:quotaCell:ellipsis-sans-title`

Cellule tronquée (ellipsis/nowrap) sans attribut title à proximité : le texte complet est irrécupérable pour l’utilisateur.

### Texte tronqué sans moyen de lire l’intégralité — Texte coupé sans infobulle

- **Où** : `web/js/app.js:5705` · `renderInboxBody`
- **Fiabilité** : à vérifier
- **Clé** : `A:web/js/app.js:renderInboxBody:ellipsis-sans-title`

Cellule tronquée (ellipsis/nowrap) sans attribut title à proximité : le texte complet est irrécupérable pour l’utilisateur.

### Texte tronqué sans moyen de lire l’intégralité — Texte coupé sans infobulle

- **Où** : `web/js/app.js:4621` · `renderSettingsBody`
- **Fiabilité** : à vérifier
- **Clé** : `A:web/js/app.js:renderSettingsBody:ellipsis-sans-title`

Cellule tronquée (ellipsis/nowrap) sans attribut title à proximité : le texte complet est irrécupérable pour l’utilisateur.

### Texte tronqué sans moyen de lire l’intégralité — Texte coupé sans infobulle

- **Où** : `web/js/app.js:1920` · `renderStatsTable`
- **Fiabilité** : à vérifier
- **Clé** : `A:web/js/app.js:renderStatsTable:ellipsis-sans-title`

Cellule tronquée (ellipsis/nowrap) sans attribut title à proximité : le texte complet est irrécupérable pour l’utilisateur.

### Liste de mails non ouvrable — Une tâche est ouvrable depuis #/tasks mais pas depuis #/calendar

- **Où** : `web/js/app.js:5222` · `renderCalendarSide`
- **Fiabilité** : confirmé
- **Clé** : `B:web/js/app.js:renderCalendarSide:tache-non-ouvrable`

`taskRowSide` ne rend jamais le titre ouvrable, alors que `taskRow` le fait dès que `canOpen`. Même donnée, deux comportements selon l’écran.

### Liste de mails non ouvrable — Sur l’écran d’accueil, seul un bouton ouvre le mail — pas le sujet

- **Où** : `web/js/app.js:740` · `renderToday`
- **Fiabilité** : confirmé
- **Clé** : `B:web/js/app.js:renderToday:sujet-jamais-cliquable`

Le mail n’est ouvrable que via le bouton « 📖 Lire ». Le sujet lui-même n’est jamais cliquable, contrairement à TOUS les autres écrans. Incohérence d’affordance sur la page vue le plus souvent.

### Liste de mails sans date de réception — Les suggestions ne montrent aucun mail à l’appui

- **Où** : `src/services/learning.ts:37` · `listSuggestions`
- **Fiabilité** : confirmé
- **Clé** : `C:src/services/learning.ts:listSuggestions:cul-de-sac`

« Tu ranges toujours X dans Y » sans un seul exemple ouvrable. La preuve est ce qui rend une suggestion acceptable ou refusable en connaissance de cause.

### Liste de mails sans date de réception — Le rapport « Pourquoi ma boîte est pleine » n’expose aucun mail

- **Où** : `src/services/report.ts:35` · `generateMailboxReport`
- **Fiabilité** : confirmé
- **Clé** : `C:src/services/report.ts:generateMailboxReport:cul-de-sac`

100 % d’agrégats (`TopSender`, `CategorySlice`). L’utilisateur lit « 1 240 newsletters » et ne peut cliquer sur rien pour vérifier. `lastMessageAt`/`oldestMessageAt` sont des bornes MIN/MAX, pas des mails identifiables. Le modèle inverse existe dans le même domaine : `PolicyWithCount` est un agrégat mais dispose de son aperçu détaillé.

### Liste de mails sans date de réception — `TaskItem` est ouvrable mais ne porte pas la date du mail

- **Où** : `src/services/tasks.ts:13` · `listTasks`
- **Fiabilité** : confirmé
- **Clé** : `C:src/services/tasks.ts:listTasks:sans-msgDate`

Il suit correctement le modèle oplog (`account`/`folder`/`uid` nullables) mais n’a que `dueDate` (échéance de la tâche) et `createdAt` (création de la ligne). Le front est contraint de passer `t.dueDate` à `openReaderFor` : le lecteur affiche donc l’échéance à la place de la date de réception. Se propage au brief. Le modèle à copier est `DeadlineItem`, qui joint le Message source et émet `msgDate` distinct de `date`.

### Liste de mails sans date de réception — Aucun accès aux mails d’un expéditeur avant de s’en désinscrire

- **Où** : `src/services/unsubscribe.ts:28` · `listUnsubscribable`
- **Fiabilité** : confirmé
- **Clé** : `C:src/services/unsubscribe.ts:listUnsubscribable:cul-de-sac`

`UnsubscribableSender` est un agrégat sans `folder`/`uid` ni date de mail : impossible de vérifier ce que l’expéditeur envoie avant de couper.

### Liste de mails sans date de réception — L’écran Échéances affiche la date d’échéance, jamais celle du mail

- **Où** : `web/js/app.js:3215` · `deadlineRow`
- **Fiabilité** : confirmé
- **Clé** : `C:web/js/app.js:deadlineRow:msgDate-non-affiche`

`fmtDate(x.date)` est l’échéance. `x.msgDate` — la date de réception du mail source — est fourni par l’API et jamais rendu.

### Liste de mails sans date de réception — Les quatre listes de l’accueil n’affichent aucune date de réception

- **Où** : `web/js/app.js:740` · `renderToday`
- **Fiabilité** : confirmé
- **Clé** : `C:web/js/app.js:renderToday:aucune-date-de-reception`

Réponses et relances n’ont qu’un délai relatif (`daysAgo`) ; factures et importants n’ont RIEN. La ligne « échéances » affiche `d.date` (la date d’échéance) alors que `d.msgDate` est disponible et utilisé ailleurs. Un mail de 2020 se présente exactement comme un mail de ce mois-ci.

### Requête sans index / motif coûteux — Balayage complet de Message (34 877 lignes)

- **Où** : `src/services` · `generateBrief`
- **Fiabilité** : confirmé · 34 877 lignes · écran à 305 ms
- **Clé** : `D:service:generateBrief:scan-Message`

Le planificateur SQLite annonce « SCAN main.Message » : aucun index ne sert cette requête. Vérifier les colonnes du WHERE et du ORDER BY — attention, un index (a, b) ne sert PAS une requête qui ne filtre que sur b.

```sql
SELECT COUNT(*) AS `_count$_all` FROM (SELECT `main`.`Message`.`id` FROM `main`.`Message` LEFT JOIN `main`.`Folder` AS `j0` ON (`j0`.`id`) = (`main`.`Message`.`folderId`) WHERE (`main`.`Message`.`accountSlug` = ? AND `main`.`Message`.`isDeleted` = ? AND `main`.`Message`.`isOutbound` = ? AND `main`.`Message`.`createdAt` >= ? AND (`j0`.`role` NOT IN (?,?,?) AND (`j0`.`id` IS NOT NULL))) LIMIT ? OFFSET ?) AS `sub`
```

### Requête sans index / motif coûteux — Balayage complet de Message (34 877 lignes)

- **Où** : `src/services` · `generateMailboxReport`
- **Fiabilité** : confirmé · 34 877 lignes · écran à 492 ms
- **Clé** : `D:service:generateMailboxReport:scan-Message`

Le planificateur SQLite annonce « SCAN m » : aucun index ne sert cette requête. Vérifier les colonnes du WHERE et du ORDER BY — attention, un index (a, b) ne sert PAS une requête qui ne filtre que sur b.

```sql
SELECT CASE WHEN m.isOutbound = 1 THEN 'outbound' ELSE COALESCE(s.category, 'unknown') END AS cat,
            COUNT(*) AS cnt, SUM(m.sizeBytes) AS size
     FROM Message m
  JOIN Folder f ON f.id = m.folderId
  LEFT JOIN Sender s ON s.accountSlug = m.accountSlug AND s.email = m.fromEmail
  WHERE m.isDeleted = 0 AND f.role NOT IN ('trash', 'spam') GROUP BY cat ORDER BY cnt DESC
```

### Requête sans index / motif coûteux — Balayage complet de Sender (3 677 lignes)

- **Où** : `src/services` · `generateMailboxReport`
- **Fiabilité** : confirmé · 3 677 lignes · écran à 492 ms
- **Clé** : `D:service:generateMailboxReport:scan-Sender`

Le planificateur SQLite annonce « SCAN main.Sender » : aucun index ne sert cette requête. Vérifier les colonnes du WHERE et du ORDER BY — attention, un index (a, b) ne sert PAS une requête qui ne filtre que sur b.

```sql
SELECT `main`.`Sender`.`id`, `main`.`Sender`.`accountSlug`, `main`.`Sender`.`email`, `main`.`Sender`.`displayName`, `main`.`Sender`.`category`, `main`.`Sender`.`messageCount`, `main`.`Sender`.`totalSizeBytes` FROM `main`.`Sender` WHERE `main`.`Sender`.`messageCount` > ? ORDER BY `main`.`Sender`.`messageCount` DESC LIMIT ? OFFSET ?
```

### Requête sans index / motif coûteux — La leçon du 29/07 n’a pas été propagée ici

- **Où** : `src/services/learning.ts:132` · `listSuggestions`
- **Fiabilité** : confirmé
- **Clé** : `D:src/services/learning.ts:listSuggestions:auto-jointure-par-ligne`

Ce bloc conserve exactement le motif qui coûtait 40 s ailleurs : une auto-jointure `Message`↔`Message` sur `threadId` réévaluée par ligne, doublée de `LEFT JOIN Task`. `Sender.engagedAt` calcule DÉJÀ conv/engaged/tasked — il suffirait de le lire au lieu de le recalculer.

### Requête sans index / motif coûteux — `ORDER BY RANDOM()` répété dix fois

- **Où** : `src/services/quality.ts:100` · `getReviewSample`
- **Fiabilité** : confirmé
- **Clé** : `D:src/services/quality.ts:getReviewSample:order-by-random`

Forcer un tri aléatoire matérialise et trie TOUT le résultat avant de garder n lignes ; l’index sur la catégorie ne sauve que le filtre. Appelé 2 fois directement et 8 fois via `sampleRetentionTargets`.

### Requête sans index / motif coûteux — Un comptage par règle, et deux boucles imbriquées de comptages

- **Où** : `src/services/rules.ts:69` · `toView`
- **Fiabilité** : confirmé
- **Clé** : `D:src/services/rules.ts:toView:n-plus-1-imbrique`

`toView` fait un `count` par règle (101 règles aujourd’hui), appelé depuis quatre endroits. `suggestRules` imbrique en plus un `count` par expéditeur dans une boucle sur les dossiers. Les règles « sujet » utilisent `LIKE %v%`, jamais indexable.

### Requête sans index / motif coûteux — Chargement de toute la table en mémoire, puis N+1 en écriture

- **Où** : `src/services/sync.ts:626` · `linkThreads`
- **Fiabilité** : confirmé
- **Clé** : `D:src/services/sync.ts:linkThreads:charge-toute-la-table`

Deux `findMany` sans `take` — dont un qui charge les ~35 000 lignes pour construire des Map — puis `db.message.update()` et `db.thread.create()` appelés dans la boucle. Manque aussi un index `(accountSlug, threadId)`.

### Requête sans index / motif coûteux — 3 677 `upsert` unitaires en boucle

- **Où** : `src/services/sync.ts:809` · `rebuildSenders`
- **Fiabilité** : confirmé
- **Clé** : `D:src/services/sync.ts:rebuildSenders:upserts-unitaires`

Une écriture Prisma par expéditeur, sur une connexion `connection_limit=1`, et relancé après CHAQUE nettoyage. Le bon motif existe déjà dans le dépôt : `categorize.ts` groupe ses écritures par `updateMany`.

### Requête sans index / motif coûteux — Une requête par expéditeur, jusqu’à 1 000 fois

- **Où** : `src/services/unsubscribe.ts:115` · `listUnsubscribable`
- **Fiabilité** : confirmé
- **Clé** : `D:src/services/unsubscribe.ts:listUnsubscribable:n-plus-1`

`db.message.findFirst` est appelé DANS la boucle sur les expéditeurs, avec `orderBy date desc` que `Message(accountSlug, fromEmail)` ne couvre pas : chaque tour trie tous les messages de l’expéditeur. Un index `(accountSlug, fromEmail, date)` le rendrait instantané.

### Requête sans index / motif coûteux — Classe CSS « att-dl » utilisée mais jamais définie

- **Où** : `web/js/app.js:6074` · `class="att-dl"`
- **Fiabilité** : à vérifier
- **Clé** : `D:web/js/app.js:att-dl:classe-css-inexistante`

Le style attendu n’est jamais appliqué. Sur un conteneur de table, cela signifie un overflow:auto absent, donc une table qui déborde sans barre de défilement (cas réel : .tablewrap).

### Requête sans index / motif coûteux — Classe CSS « att-view » utilisée mais jamais définie

- **Où** : `web/js/app.js:6073` · `class="att-view"`
- **Fiabilité** : à vérifier
- **Clé** : `D:web/js/app.js:att-view:classe-css-inexistante`

Le style attendu n’est jamais appliqué. Sur un conteneur de table, cela signifie un overflow:auto absent, donc une table qui déborde sans barre de défilement (cas réel : .tablewrap).

### Requête sans index / motif coûteux — Classe CSS « cal-side » utilisée mais jamais définie

- **Où** : `web/js/app.js:5162` · `class="cal-side"`
- **Fiabilité** : à vérifier
- **Clé** : `D:web/js/app.js:cal-side:classe-css-inexistante`

Le style attendu n’est jamais appliqué. Sur un conteneur de table, cela signifie un overflow:auto absent, donc une table qui déborde sans barre de défilement (cas réel : .tablewrap).

### Requête sans index / motif coûteux — Classe CSS « openable-btn » utilisée mais jamais définie

- **Où** : `web/js/app.js:2613` · `class="openable-btn"`
- **Fiabilité** : à vérifier
- **Clé** : `D:web/js/app.js:openable-btn:classe-css-inexistante`

Le style attendu n’est jamais appliqué. Sur un conteneur de table, cela signifie un overflow:auto absent, donc une table qui déborde sans barre de défilement (cas réel : .tablewrap).

### Requête sans index / motif coûteux — Cellule expéditeur en `nowrap` sans `max-width`

- **Où** : `web/js/app.js:888` · `openNoiseModal`
- **Fiabilité** : confirmé
- **Clé** : `D:web/js/app.js:openNoiseModal:expediteur-sans-plafond`

Un nom long élargit la table au-delà du conteneur et pousse la dernière colonne — la date — hors du cadre. C’est le mécanisme exact du bug du 29/07.

### Requête sans index / motif coûteux — Classe CSS « tablewrap » utilisée mais jamais définie

- **Où** : `web/js/app.js:3600` · `class="tablewrap"`
- **Fiabilité** : à vérifier
- **Clé** : `D:web/js/app.js:tablewrap:classe-css-inexistante`

Le style attendu n’est jamais appliqué. Sur un conteneur de table, cela signifie un overflow:auto absent, donc une table qui déborde sans barre de défilement (cas réel : .tablewrap).

### Requête sans index / motif coûteux — Classe CSS « today-row » utilisée mais jamais définie

- **Où** : `web/js/app.js:681` · `class="today-row"`
- **Fiabilité** : à vérifier
- **Clé** : `D:web/js/app.js:today-row:classe-css-inexistante`

Le style attendu n’est jamais appliqué. Sur un conteneur de table, cela signifie un overflow:auto absent, donc une table qui déborde sans barre de défilement (cas réel : .tablewrap).

### Requête sans index / motif coûteux — Classe CSS « verify-zone » utilisée mais jamais définie

- **Où** : `web/js/app.js:4009` · `class="verify-zone"`
- **Fiabilité** : à vérifier
- **Clé** : `D:web/js/app.js:verify-zone:classe-css-inexistante`

Le style attendu n’est jamais appliqué. Sur un conteneur de table, cela signifie un overflow:auto absent, donc une table qui déborde sans barre de défilement (cas réel : .tablewrap).

### Compteurs et totaux incohérents — Compteur d’expéditeurs catégorisés hors index

- **Où** : `src/services/today.ts:214` · `generateToday`
- **Fiabilité** : confirmé
- **Clé** : `E:src/services/today.ts:generateToday:count-sans-accountSlug`

`db.sender.count({ category: { not: null } })` sans `accountSlug` : l’index `Sender(accountSlug, category)` est inutilisable, colonne de tête absente. C’est exactement le piège de l’index composite qui a coûté 40 s.

## Gravité : faible (19)

### Texte tronqué sans moyen de lire l’intégralité — Liste coupée à 8 sans indiquer le reste

- **Où** : `web/js/app.js:4176` · `loadBigClean`
- **Fiabilité** : à vérifier
- **Clé** : `A:web/js/app.js:loadBigClean:slice-sans-indicateur`

Un .slice() tronque l’affichage sans « … », sans « et N autre(s) » et sans title : rien ne signale à l’utilisateur qu’il manque des éléments.

### Texte tronqué sans moyen de lire l’intégralité — Nom affiché long tronqué, l’infobulle ne donne que l’adresse

- **Où** : `web/js/app.js:3607` · `loadUnsubscribe`
- **Fiabilité** : confirmé
- **Clé** : `A:web/js/app.js:loadUnsubscribe:nom-affiche-coupe`

`max-width:340px` + ellipsis, `title` = `s.email` seulement. Un nom d’expéditeur long reste illisible.

### Texte tronqué sans moyen de lire l’intégralité — Message de progression coupé net à 44 caractères

- **Où** : `web/js/app.js:349` · `pollJobs`
- **Fiabilité** : confirmé
- **Clé** : `A:web/js/app.js:pollJobs:coupe-en-plein-mot`

`lastProgress.slice(0, 44)` sans « … » ni `title` : la pastille d’activité coupe en plein mot et rien ne permet de lire la suite.

### Texte tronqué sans moyen de lire l’intégralité — Liste coupée à 44 sans indiquer le reste

- **Où** : `web/js/app.js:349` · `pollJobs`
- **Fiabilité** : à vérifier
- **Clé** : `A:web/js/app.js:pollJobs:slice-sans-indicateur`

Un .slice() tronque l’affichage sans « … », sans « et N autre(s) » et sans title : rien ne signale à l’utilisateur qu’il manque des éléments.

### Texte tronqué sans moyen de lire l’intégralité — Quatre sections coupées à 3 sans dire combien il en reste

- **Où** : `web/js/app.js:1430` · `renderBrief`
- **Fiabilité** : confirmé
- **Clé** : `A:web/js/app.js:renderBrief:reste-non-indique`

Les autres panneaux du tableau de bord affichent « …et N autre(s) ». Le brief et la section échéances du tableau de bord ne le font pas.

### Texte tronqué sans moyen de lire l’intégralité — Liste coupée à 3 sans indiquer le reste

- **Où** : `web/js/app.js:1452` · `renderBrief`
- **Fiabilité** : à vérifier
- **Clé** : `A:web/js/app.js:renderBrief:slice-sans-indicateur`

Un .slice() tronque l’affichage sans « … », sans « et N autre(s) » et sans title : rien ne signale à l’utilisateur qu’il manque des éléments.

### Texte tronqué sans moyen de lire l’intégralité — Liste coupée à 3 sans indiquer le reste

- **Où** : `web/js/app.js:5129` · `renderCalendarBody`
- **Fiabilité** : à vérifier
- **Clé** : `A:web/js/app.js:renderCalendarBody:slice-sans-indicateur`

Un .slice() tronque l’affichage sans « … », sans « et N autre(s) » et sans title : rien ne signale à l’utilisateur qu’il manque des éléments.

### Texte tronqué sans moyen de lire l’intégralité — Liste coupée à 3 sans indiquer le reste

- **Où** : `web/js/app.js:1297` · `renderDashboard`
- **Fiabilité** : à vérifier
- **Clé** : `A:web/js/app.js:renderDashboard:slice-sans-indicateur`

Un .slice() tronque l’affichage sans « … », sans « et N autre(s) » et sans title : rien ne signale à l’utilisateur qu’il manque des éléments.

### Texte tronqué sans moyen de lire l’intégralité — Liste coupée à 10 sans indiquer le reste

- **Où** : `web/js/app.js:4782` · `renderSettingsBody`
- **Fiabilité** : à vérifier
- **Clé** : `A:web/js/app.js:renderSettingsBody:slice-sans-indicateur`

Un .slice() tronque l’affichage sans « … », sans « et N autre(s) » et sans title : rien ne signale à l’utilisateur qu’il manque des éléments.

### Texte tronqué sans moyen de lire l’intégralité — Liste coupée à 2 sans indiquer le reste

- **Où** : `web/js/app.js:783` · `renderToday`
- **Fiabilité** : à vérifier
- **Clé** : `A:web/js/app.js:renderToday:slice-sans-indicateur`

Un .slice() tronque l’affichage sans « … », sans « et N autre(s) » et sans title : rien ne signale à l’utilisateur qu’il manque des éléments.

### Requête sans index / motif coûteux — Recherches par `messageId` non indexées

- **Où** : `prisma/schema.prisma` · `AnalysisFeedback`
- **Fiabilité** : confirmé
- **Clé** : `D:prisma/schema.prisma:AnalysisFeedback:index-messageId-absent`

`AnalysisFeedback(engine, messageId)` est inutilisable quand on ne filtre que sur `messageId` — ce que font `quality.ts` et la réconciliation des déplacements. Même remarque pour `AttentionState`. Tables minuscules aujourd’hui, index quasi gratuit.

### Requête sans index / motif coûteux — Balayage complet de Message (34 877 lignes)

- **Où** : `src/services` · `analysisCoverage`
- **Fiabilité** : confirmé · 34 877 lignes · écran à 145 ms
- **Clé** : `D:service:analysisCoverage:scan-Message`

Le planificateur SQLite annonce « SCAN main.Message » : aucun index ne sert cette requête. Vérifier les colonnes du WHERE et du ORDER BY — attention, un index (a, b) ne sert PAS une requête qui ne filtre que sur b.

```sql
SELECT COUNT(*) AS `_count$_all` FROM (SELECT `main`.`Message`.`id` FROM `main`.`Message` LEFT JOIN `main`.`Folder` AS `j0` ON (`j0`.`id`) = (`main`.`Message`.`folderId`) WHERE (`main`.`Message`.`isDeleted` = ? AND `main`.`Message`.`isOutbound` = ? AND (`j0`.`role` NOT IN (?,?) AND (`j0`.`id` IS NOT NULL)) AND `main`.`Message`.`accountSlug` = ?) LIMIT ? OFFSET ?) AS `sub`
```

### Requête sans index / motif coûteux — Balayage complet de Message (34 877 lignes)

- **Où** : `src/services` · `analysisProgress`
- **Fiabilité** : confirmé · 34 877 lignes · écran à 102 ms
- **Clé** : `D:service:analysisProgress:scan-Message`

Le planificateur SQLite annonce « SCAN main.Message » : aucun index ne sert cette requête. Vérifier les colonnes du WHERE et du ORDER BY — attention, un index (a, b) ne sert PAS une requête qui ne filtre que sur b.

```sql
SELECT COUNT(*) AS `_count$_all` FROM (SELECT `main`.`Message`.`id` FROM `main`.`Message` LEFT JOIN `main`.`Folder` AS `j0` ON (`j0`.`id`) = (`main`.`Message`.`folderId`) WHERE (`main`.`Message`.`isDeleted` = ? AND `main`.`Message`.`isOutbound` = ? AND (`j0`.`role` NOT IN (?,?) AND (`j0`.`id` IS NOT NULL)) AND `main`.`Message`.`snippet` IS NOT NULL AND (NOT `main`.`Message`.`snippet` = ?)) LIMIT ? OFFSET ?) AS `sub`
```

### Requête sans index / motif coûteux — Parcours d’index complet sur Message (34 877 lignes)

- **Où** : `src/services` · `generateMailboxReport`
- **Fiabilité** : confirmé · 34 877 lignes · écran à 492 ms
- **Clé** : `D:service:generateMailboxReport:scan-Message-idx`

Le planificateur SQLite annonce « SCAN m USING INDEX Message_accountSlug_isDeleted_date_idx » : il parcourt tout un index au lieu de cibler des lignes. Bien moins coûteux qu’un balayage de table, mais reste linéaire.

```sql
SELECT m.accountSlug AS account, COUNT(*) AS cnt, SUM(m.sizeBytes) AS size
     FROM Message m
  JOIN Folder f ON f.id = m.folderId
  LEFT JOIN Sender s ON s.accountSlug = m.accountSlug AND s.email = m.fromEmail
  WHERE m.isDeleted = 0 AND f.role NOT IN ('trash', 'spam') GROUP BY m.accountSlug ORDER BY cnt DESC
```

### Requête sans index / motif coûteux — Parcours d’index complet sur Sender (3 677 lignes)

- **Où** : `src/services` · `generateToday`
- **Fiabilité** : confirmé · 3 677 lignes · écran à 294 ms
- **Clé** : `D:service:generateToday:scan-Sender-idx`

Le planificateur SQLite annonce « SCAN main.Sender USING COVERING INDEX Sender_accountSlug_category_idx » : il parcourt tout un index au lieu de cibler des lignes. Bien moins coûteux qu’un balayage de table, mais reste linéaire.

```sql
SELECT COUNT(*) AS `_count$_all` FROM (SELECT `main`.`Sender`.`id` FROM `main`.`Sender` WHERE `main`.`Sender`.`category` IS NOT NULL LIMIT ? OFFSET ?) AS `sub`
```

### Requête sans index / motif coûteux — Balayage complet de Message (34 877 lignes)

- **Où** : `src/services` · `listUnifiedInbox`
- **Fiabilité** : confirmé · 34 877 lignes · écran à 60 ms
- **Clé** : `D:service:listUnifiedInbox:scan-Message`

Le planificateur SQLite annonce « SCAN main.Message » : aucun index ne sert cette requête. Vérifier les colonnes du WHERE et du ORDER BY — attention, un index (a, b) ne sert PAS une requête qui ne filtre que sur b.

```sql
SELECT COUNT(*) AS `_count$_all` FROM (SELECT `main`.`Message`.`id` FROM `main`.`Message` LEFT JOIN `main`.`Folder` AS `j0` ON (`j0`.`id`) = (`main`.`Message`.`folderId`) WHERE (`main`.`Message`.`isDeleted` = ? AND (`j0`.`role` = ? AND (`j0`.`id` IS NOT NULL))) LIMIT ? OFFSET ?) AS `sub`
```

### Requête sans index / motif coûteux — Parcours d’index complet sur Message (34 877 lignes)

- **Où** : `src/services` · `listUnifiedInbox`
- **Fiabilité** : confirmé · 34 877 lignes · écran à 60 ms
- **Clé** : `D:service:listUnifiedInbox:scan-Message-idx`

Le planificateur SQLite annonce « SCAN main.Message USING INDEX Message_accountSlug_isDeleted_date_idx » : il parcourt tout un index au lieu de cibler des lignes. Bien moins coûteux qu’un balayage de table, mais reste linéaire.

```sql
SELECT `main`.`Message`.`id`, `main`.`Message`.`accountSlug`, `main`.`Message`.`uid`, `main`.`Message`.`threadId`, `main`.`Message`.`subject`, `main`.`Message`.`fromName`, `main`.`Message`.`fromEmail`, `main`.`Message`.`date`, `main`.`Message`.`isSeen`, `main`.`Message`.`isFlagged`, `main`.`Message`.`isOutbound`, `main`.`Message`.`intent`, `main`.`Message`.`hasListUnsubscribe`, `main`.`Message`.`hasAttachments`, `main`.`Message`.`attachmentCount`, `main`.`Message`.`sizeBytes`, `main`.`Message`.`snippet`, `main`.`Message`.`folderId` FROM `main`.`Message` LEFT JOIN `main`.`Folder` AS `j0` ON (`j
```

### Requête sans index / motif coûteux — Balayage complet de Sender (3 677 lignes)

- **Où** : `src/services` · `listUnsubscribable`
- **Fiabilité** : confirmé · 3 677 lignes · écran à 5 ms
- **Clé** : `D:service:listUnsubscribable:scan-Sender`

Le planificateur SQLite annonce « SCAN main.Sender » : aucun index ne sert cette requête. Vérifier les colonnes du WHERE et du ORDER BY — attention, un index (a, b) ne sert PAS une requête qui ne filtre que sur b.

```sql
SELECT `main`.`Sender`.`id`, `main`.`Sender`.`accountSlug`, `main`.`Sender`.`email`, `main`.`Sender`.`displayName`, `main`.`Sender`.`domain`, `main`.`Sender`.`messageCount`, `main`.`Sender`.`unseenCount`, `main`.`Sender`.`unsubscribeCount`, `main`.`Sender`.`totalSizeBytes`, `main`.`Sender`.`firstMessageAt`, `main`.`Sender`.`lastMessageAt`, `main`.`Sender`.`kind`, `main`.`Sender`.`category`, `main`.`Sender`.`categorySource`, `main`.`Sender`.`categoryReason`, `main`.`Sender`.`engagedAt`, `main`.`Sender`.`priority`, `main`.`Sender`.`unsubscribeHttp`, `main`.`Sender`.`unsubscribeMailto`, `main`.`S
```

### Requête sans index / motif coûteux — Balayage complet de Message (34 877 lignes)

- **Où** : `src/services` · `searchIndex`
- **Fiabilité** : confirmé · 34 877 lignes · écran à 59 ms
- **Clé** : `D:service:searchIndex:scan-Message`

Le planificateur SQLite annonce « SCAN main.Message » : aucun index ne sert cette requête. Vérifier les colonnes du WHERE et du ORDER BY — attention, un index (a, b) ne sert PAS une requête qui ne filtre que sur b.

```sql
SELECT COUNT(*) AS `_count$_all` FROM (SELECT `main`.`Message`.`id` FROM `main`.`Message` WHERE (`main`.`Message`.`isDeleted` = ? AND (`main`.`Message`.`subject` LIKE ? OR `main`.`Message`.`fromEmail` LIKE ? OR `main`.`Message`.`fromName` LIKE ?)) LIMIT ? OFFSET ?) AS `sub`
```

