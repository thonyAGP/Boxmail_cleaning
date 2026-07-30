# Audit — troncatures, listes non ouvrables, requêtes sans index

_Régénéré par `npm run audit` le 2026-07-30 09:38:33 (statique seulement)._

**Ne pas éditer ce fichier** : il est reconstruit à chaque passage depuis
`docs/audit-findings.json`. Pour clore un constat, passer son `status` à
`fixed` ou `accepted` dans le JSON — le script ne l'écrase jamais.

| | |
|---|---|
| Constats ouverts | **48** |
| Clos (corrigés ou acceptés) | 22 |
| Nouveaux à ce passage | 0 |
| N’apparaissent plus (peut-être corrigés) | 7 |

## Lecture

Les constats **confirmés** sont mesurés (chronomètre, `EXPLAIN QUERY PLAN`,
octet lu dans le fichier) ou relevés à la main. Ceux marqués **à vérifier**
viennent d'expressions régulières sur le front : ce sont des pistes, pas des
verdicts — certains sont des choix délibérés.

## Gravité : moyen (31)

### Texte tronqué sans moyen de lire l’intégralité — Texte coupé sans infobulle

- **Où** : `web/js/app.js:4211` · `loadBigClean`
- **Fiabilité** : à vérifier
- **Clé** : `A:web/js/app.js:loadBigClean:ellipsis-sans-title`

Cellule tronquée (ellipsis/nowrap) sans attribut title à proximité : le texte complet est irrécupérable pour l’utilisateur.

### Texte tronqué sans moyen de lire l’intégralité — Texte coupé sans infobulle

- **Où** : `web/js/app.js:3666` · `loadUnsubscribe`
- **Fiabilité** : à vérifier
- **Clé** : `A:web/js/app.js:loadUnsubscribe:ellipsis-sans-title`

Cellule tronquée (ellipsis/nowrap) sans attribut title à proximité : le texte complet est irrécupérable pour l’utilisateur.

### Texte tronqué sans moyen de lire l’intégralité — Texte coupé sans infobulle

- **Où** : `web/js/app.js:911` · `openNoiseModal`
- **Fiabilité** : à vérifier
- **Clé** : `A:web/js/app.js:openNoiseModal:ellipsis-sans-title`

Cellule tronquée (ellipsis/nowrap) sans attribut title à proximité : le texte complet est irrécupérable pour l’utilisateur.

### Texte tronqué sans moyen de lire l’intégralité — Texte coupé sans infobulle

- **Où** : `web/js/app.js:4336` · `openRetentionPreview`
- **Fiabilité** : à vérifier
- **Clé** : `A:web/js/app.js:openRetentionPreview:ellipsis-sans-title`

Cellule tronquée (ellipsis/nowrap) sans attribut title à proximité : le texte complet est irrécupérable pour l’utilisateur.

### Texte tronqué sans moyen de lire l’intégralité — Texte coupé sans infobulle

- **Où** : `web/js/app.js:641` · `quotaCell`
- **Fiabilité** : à vérifier
- **Clé** : `A:web/js/app.js:quotaCell:ellipsis-sans-title`

Cellule tronquée (ellipsis/nowrap) sans attribut title à proximité : le texte complet est irrécupérable pour l’utilisateur.

### Texte tronqué sans moyen de lire l’intégralité — Texte coupé sans infobulle

- **Où** : `web/js/app.js:5765` · `renderInboxBody`
- **Fiabilité** : à vérifier
- **Clé** : `A:web/js/app.js:renderInboxBody:ellipsis-sans-title`

Cellule tronquée (ellipsis/nowrap) sans attribut title à proximité : le texte complet est irrécupérable pour l’utilisateur.

### Texte tronqué sans moyen de lire l’intégralité — Texte coupé sans infobulle

- **Où** : `web/js/app.js:4681` · `renderSettingsBody`
- **Fiabilité** : à vérifier
- **Clé** : `A:web/js/app.js:renderSettingsBody:ellipsis-sans-title`

Cellule tronquée (ellipsis/nowrap) sans attribut title à proximité : le texte complet est irrécupérable pour l’utilisateur.

### Texte tronqué sans moyen de lire l’intégralité — Texte coupé sans infobulle

- **Où** : `web/js/app.js:1947` · `renderStatsTable`
- **Fiabilité** : à vérifier
- **Clé** : `A:web/js/app.js:renderStatsTable:ellipsis-sans-title`

Cellule tronquée (ellipsis/nowrap) sans attribut title à proximité : le texte complet est irrécupérable pour l’utilisateur.

### Texte tronqué sans moyen de lire l’intégralité — Texte coupé sans infobulle

- **Où** : `web/js/app.js:689` · `todayRow`
- **Fiabilité** : à vérifier
- **Clé** : `A:web/js/app.js:todayRow:ellipsis-sans-title`

Cellule tronquée (ellipsis/nowrap) sans attribut title à proximité : le texte complet est irrécupérable pour l’utilisateur.

### Liste de mails non ouvrable — Une tâche est ouvrable depuis #/tasks mais pas depuis #/calendar

- **Où** : `web/js/app.js:5222` · `renderCalendarSide`
- **Fiabilité** : confirmé
- **Clé** : `B:web/js/app.js:renderCalendarSide:tache-non-ouvrable`

`taskRowSide` ne rend jamais le titre ouvrable, alors que `taskRow` le fait dès que `canOpen`. Même donnée, deux comportements selon l’écran.

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

- **Où** : `web/js/app.js:6134` · `class="att-dl"`
- **Fiabilité** : à vérifier
- **Clé** : `D:web/js/app.js:att-dl:classe-css-inexistante`

Le style attendu n’est jamais appliqué. Sur un conteneur de table, cela signifie un overflow:auto absent, donc une table qui déborde sans barre de défilement (cas réel : .tablewrap).

### Requête sans index / motif coûteux — Classe CSS « att-view » utilisée mais jamais définie

- **Où** : `web/js/app.js:6133` · `class="att-view"`
- **Fiabilité** : à vérifier
- **Clé** : `D:web/js/app.js:att-view:classe-css-inexistante`

Le style attendu n’est jamais appliqué. Sur un conteneur de table, cela signifie un overflow:auto absent, donc une table qui déborde sans barre de défilement (cas réel : .tablewrap).

### Requête sans index / motif coûteux — Classe CSS « cal-side » utilisée mais jamais définie

- **Où** : `web/js/app.js:5222` · `class="cal-side"`
- **Fiabilité** : à vérifier
- **Clé** : `D:web/js/app.js:cal-side:classe-css-inexistante`

Le style attendu n’est jamais appliqué. Sur un conteneur de table, cela signifie un overflow:auto absent, donc une table qui déborde sans barre de défilement (cas réel : .tablewrap).

### Requête sans index / motif coûteux — Classe CSS « openable-btn » utilisée mais jamais définie

- **Où** : `web/js/app.js:2660` · `class="openable-btn"`
- **Fiabilité** : à vérifier
- **Clé** : `D:web/js/app.js:openable-btn:classe-css-inexistante`

Le style attendu n’est jamais appliqué. Sur un conteneur de table, cela signifie un overflow:auto absent, donc une table qui déborde sans barre de défilement (cas réel : .tablewrap).

### Requête sans index / motif coûteux — Classe CSS « today-row » utilisée mais jamais définie

- **Où** : `web/js/app.js:697` · `class="today-row"`
- **Fiabilité** : à vérifier
- **Clé** : `D:web/js/app.js:today-row:classe-css-inexistante`

Le style attendu n’est jamais appliqué. Sur un conteneur de table, cela signifie un overflow:auto absent, donc une table qui déborde sans barre de défilement (cas réel : .tablewrap).

### Requête sans index / motif coûteux — Classe CSS « verify-zone » utilisée mais jamais définie

- **Où** : `web/js/app.js:4069` · `class="verify-zone"`
- **Fiabilité** : à vérifier
- **Clé** : `D:web/js/app.js:verify-zone:classe-css-inexistante`

Le style attendu n’est jamais appliqué. Sur un conteneur de table, cela signifie un overflow:auto absent, donc une table qui déborde sans barre de défilement (cas réel : .tablewrap).

### Compteurs et totaux incohérents — Compteur d’expéditeurs catégorisés hors index

- **Où** : `src/services/today.ts:214` · `generateToday`
- **Fiabilité** : confirmé
- **Clé** : `E:src/services/today.ts:generateToday:count-sans-accountSlug`

`db.sender.count({ category: { not: null } })` sans `accountSlug` : l’index `Sender(accountSlug, category)` est inutilisable, colonne de tête absente. C’est exactement le piège de l’index composite qui a coûté 40 s.

## Gravité : faible (17)

### Texte tronqué sans moyen de lire l’intégralité — Liste coupée à 8 sans indiquer le reste

- **Où** : `web/js/app.js:4236` · `loadBigClean`
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

- **Où** : `web/js/app.js:1479` · `renderBrief`
- **Fiabilité** : à vérifier
- **Clé** : `A:web/js/app.js:renderBrief:slice-sans-indicateur`

Un .slice() tronque l’affichage sans « … », sans « et N autre(s) » et sans title : rien ne signale à l’utilisateur qu’il manque des éléments.

### Texte tronqué sans moyen de lire l’intégralité — Liste coupée à 3 sans indiquer le reste

- **Où** : `web/js/app.js:5189` · `renderCalendarBody`
- **Fiabilité** : à vérifier
- **Clé** : `A:web/js/app.js:renderCalendarBody:slice-sans-indicateur`

Un .slice() tronque l’affichage sans « … », sans « et N autre(s) » et sans title : rien ne signale à l’utilisateur qu’il manque des éléments.

### Texte tronqué sans moyen de lire l’intégralité — Liste coupée à 3 sans indiquer le reste

- **Où** : `web/js/app.js:1324` · `renderDashboard`
- **Fiabilité** : à vérifier
- **Clé** : `A:web/js/app.js:renderDashboard:slice-sans-indicateur`

Un .slice() tronque l’affichage sans « … », sans « et N autre(s) » et sans title : rien ne signale à l’utilisateur qu’il manque des éléments.

### Texte tronqué sans moyen de lire l’intégralité — Liste coupée à 10 sans indiquer le reste

- **Où** : `web/js/app.js:4842` · `renderSettingsBody`
- **Fiabilité** : à vérifier
- **Clé** : `A:web/js/app.js:renderSettingsBody:slice-sans-indicateur`

Un .slice() tronque l’affichage sans « … », sans « et N autre(s) » et sans title : rien ne signale à l’utilisateur qu’il manque des éléments.

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

## Clos

| Constat | Statut | Note |
|---|---|---|
| La liste relue juste avant la corbeille n’est pas ouvrable (`listCleanupMessages`) | fixed | account + folder émis ; la liste est ouvrable. Test navigateur : 14 vérifications. |
| L’échantillon affiché avant une suppression de masse est une liste de chaînes (`previewSenderCleanup`) | fixed | CORRECTION DE MON ANALYSE : ce champ n’était affiché nulle part (la liste de confirmation vient de listCleanupMessages). C’était du code mort — supprimé plutôt que « corrigé ». Le classement « critique » était une erreur de ma part. |
| L’infobulle contient les signaux, pas le sujet coupé (`openCleanupModal`) | fixed | title = le sujet ; les signaux restent sur le badge. Vérifié : un sujet de 157 caractères est récupérable par l’infobulle. |
| L’aperçu d’une règle de classement n’est pas ouvrable (`previewRule`) | fixed | account + folder.path joints ; l’aperçu de règle est ouvrable. |
| Modale listant des mails sans « under-reader » (`openCleanupModal`) | fixed | under-reader posé — sans quoi rendre le sujet cliquable n’aurait rien changé. |
| Cliquer le sujet COCHE la case au lieu d’ouvrir le mail (`openCleanupModal`) | fixed | La ligne est un <div>, seule la case reste dans un <label> (.mail-pick). Contre-cas vérifié au navigateur : cliquer le sujet n’a pas bougé la case. |
| Modale listant des mails sans « under-reader » (`openComposeModal`) | accepted | FAUX POSITIF assumé. C'est le formulaire de rédaction, pas une liste de mails — la règle s'est déclenchée sur le champ « Objet ». Et la fenêtre de rédaction DOIT passer au-dessus du lecteur : on écrit une réponse depuis le mail ouvert. |
| Modale listant des mails sans « under-reader » (`openRuleModal`) | accepted | FAUX POSITIF assumé. Formulaire de création de règle, aucune liste de mails à ouvrir. |
| Modale listant des mails sans « under-reader » (`openRulePreview`) | fixed | under-reader + modal-wide, sujets ouvrables, expéditeur affiché. |
| `ANALYZE` n’est joué qu’une fois, à la migration du 29/07 (`ANALYZE`) | fixed | PRAGMA optimize au démarrage : SQLite décide lui-même si une table a assez changé, donc c’est quasi gratuit et les statistiques ne périment plus. |
| Aucun index sur `Deadline.messageId` seul — régression quadratique programmée (`Deadline`) | fixed | Index (messageId, status) ajouté. Table de 6 lignes : le bénéfice est d’empêcher la régression quadratique, pas de gagner du temps aujourd’hui. |
| Octet nul dans un fichier source (`(fichier entier)`) | fixed | Idem retention.ts. |
| Octet nul dans un fichier source (`(fichier entier)`) | fixed | Séparateur de clé remplacé par l’échappement \u0000 : chaîne IDENTIQUE à l’exécution, source redevenue lisible par grep. |
| Modale de 560 px pour date + sujet + extrait + 2 badges (`openCleanupModal`) | fixed | modal-wide + under-reader. Vérifié : lecteur z=96 au-dessus de l’overlay z=94. |
| Colonne de date en bout de ligne (`openNoiseModal`) | fixed | Date remontée en 2e position, largeurs fixes sur les <th>. |
| L’infobulle du sujet dit « Lire le mail » au lieu de donner le sujet (`openNoiseModal`) | fixed | title = le sujet, au lieu du libellé « Lire le mail ». |
| Sur l’écran d’accueil, seul un bouton ouvre le mail — pas le sujet (`renderToday`) | fixed | Le corps de la ligne est ouvrable ; le bouton 📖 reste pour la découvrabilité. |
| Les quatre listes de l’accueil n’affichent aucune date de réception (`renderToday`) | fixed | Date de réception ajoutée dans todayRow, donc sur les 4 listes d’un coup. Pour une échéance c’est bien msgDate (le mail), pas la date d’échéance. |
| Cellule expéditeur en `nowrap` sans `max-width` (`openNoiseModal`) | fixed | max-width + ellipsis + title sur la cellule expéditeur : elle ne peut plus élargir la table et pousser la date hors du cadre. |
| Classe CSS « tablewrap » utilisée mais jamais définie (`class="tablewrap"`) | fixed | Règle .tablewrap ajoutée (overflow-x auto). |
| Liste coupée à 2 sans indiquer le reste (`renderToday`) | fixed | title avec toutes les raisons + « … » quand il y en a plus de 2 — comme le faisait déjà renderReaderAnalysis. |
| Recherches par `messageId` non indexées (`AnalysisFeedback`) | fixed | Index sur messageId ajouté, idem AttentionState. |

