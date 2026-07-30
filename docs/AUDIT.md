# Audit — troncatures, listes non ouvrables, requêtes sans index

_Régénéré par `npm run audit` le 2026-07-30 08:56:23 (statique seulement)._

**Ne pas éditer ce fichier** : il est reconstruit à chaque passage depuis
`docs/audit-findings.json`. Pour clore un constat, passer son `status` à
`fixed` ou `accepted` dans le JSON — le script ne l'écrase jamais.

| | |
|---|---|
| Constats ouverts | **29** |
| Clos (corrigés ou acceptés) | 0 |
| Nouveaux à ce passage | 29 |
| N’apparaissent plus (peut-être corrigés) | 0 |

## Lecture

Les constats **confirmés** sont mesurés (chronomètre, `EXPLAIN QUERY PLAN`,
octet lu dans le fichier) ou relevés à la main. Ceux marqués **à vérifier**
viennent d'expressions régulières sur le front : ce sont des pistes, pas des
verdicts — certains sont des choix délibérés.

## Gravité : grave (7)

### Liste de mails non ouvrable — Modale listant des mails sans « under-reader »

- **Où** : `web/js/app.js:2138` · `openCleanupModal`
- **Fiabilité** : à vérifier
- **Clé** : `B:web/js/app.js:openCleanupModal:overlay-sans-under-reader`

L’overlay n’a pas la classe under-reader : le panneau de lecture s’ouvrirait DERRIÈRE la modale. Rendre un sujet cliquable ne suffit donc pas — il faut aussi changer la classe de l’overlay.

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

### Requête sans index / motif coûteux — Colonne de date en bout de ligne

- **Où** : `web/js/app.js:882` · `openNoiseModal`
- **Fiabilité** : à vérifier
- **Clé** : `D:web/js/app.js:openNoiseModal:date-en-derniere-colonne`

La date est la dernière colonne : c’est la position d’où elle sortait du cadre le 29/07 dès qu’une cellule voisine s’élargissait. La remonter et fixer les largeurs des <th>.

## Gravité : moyen (15)

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

## Gravité : faible (7)

### Texte tronqué sans moyen de lire l’intégralité — Liste coupée à 8 sans indiquer le reste

- **Où** : `web/js/app.js:4176` · `loadBigClean`
- **Fiabilité** : à vérifier
- **Clé** : `A:web/js/app.js:loadBigClean:slice-sans-indicateur`

Un .slice() tronque l’affichage sans « … », sans « et N autre(s) » et sans title : rien ne signale à l’utilisateur qu’il manque des éléments.

### Texte tronqué sans moyen de lire l’intégralité — Liste coupée à 44 sans indiquer le reste

- **Où** : `web/js/app.js:349` · `pollJobs`
- **Fiabilité** : à vérifier
- **Clé** : `A:web/js/app.js:pollJobs:slice-sans-indicateur`

Un .slice() tronque l’affichage sans « … », sans « et N autre(s) » et sans title : rien ne signale à l’utilisateur qu’il manque des éléments.

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

### Texte tronqué sans moyen de lire l’intégralité — Liste coupée à 8 sans indiquer le reste

- **Où** : `web/js/app.js:1297` · `renderDashboard`
- **Fiabilité** : à vérifier
- **Clé** : `A:web/js/app.js:renderDashboard:slice-sans-indicateur`

Un .slice() tronque l’affichage sans « … », sans « et N autre(s) » et sans title : rien ne signale à l’utilisateur qu’il manque des éléments.

### Texte tronqué sans moyen de lire l’intégralité — Liste coupée à 2 sans indiquer le reste

- **Où** : `web/js/app.js:4782` · `renderSettingsBody`
- **Fiabilité** : à vérifier
- **Clé** : `A:web/js/app.js:renderSettingsBody:slice-sans-indicateur`

Un .slice() tronque l’affichage sans « … », sans « et N autre(s) » et sans title : rien ne signale à l’utilisateur qu’il manque des éléments.

### Texte tronqué sans moyen de lire l’intégralité — Liste coupée à 2 sans indiquer le reste

- **Où** : `web/js/app.js:783` · `renderToday`
- **Fiabilité** : à vérifier
- **Clé** : `A:web/js/app.js:renderToday:slice-sans-indicateur`

Un .slice() tronque l’affichage sans « … », sans « et N autre(s) » et sans title : rien ne signale à l’utilisateur qu’il manque des éléments.

