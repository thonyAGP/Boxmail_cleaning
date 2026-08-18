# Changement — dossiers-en-cours

- **Date** : 2026-08-18 · **Niveau de risque** : **élevé**
- **Critères déclenchés** :
  - **(a) Taille** : nouveau modèle Prisma + migration, nouveau service moteur,
    routes API, écran et entrée de menu — 6 fichiers au moins, nouveau module.
  - **(b) Architecture** : modélisation BDD nouvelle (l'engagement ouvert n'est
    ni un mail, ni un dossier thématique, ni une échéance) et bascule
    conceptuelle « ce que l'écran représente n'est plus un mail ».
  - **(c) Données** : migration de schéma sur une base SQLite en service —
    le projet interdit de migrer pendant que l'application sert.
  - **(d) Ambiguïté** : « propositions de retour » a au moins trois lectures
    (brouillon rédigé par l'IA / canevas rempli des faits extraits / simple
    fenêtre de réponse pré-adressée).
  - **(f) Blast radius** : alimente la « Vue du jour », l'écran qu'il regarde
    chaque matin, en production.
  - **(g) Observabilité** : un engagement manqué est SILENCIEUX par nature —
    c'est précisément la définition du problème ; rien ne signalera une panne
    du moteur, il faut donc un contrôle explicite.
- **Domaines sensibles** : `donnees-migration`, `deploiement-rollback`

## 1. Intention

- **Besoin** : Anthony a des affaires engagées qui n'aboutissent pas, et **rien
  dans sa boîte mail ne le lui rappellera** :
  1. une société mandatée **il y a un an** pour transférer les parts de son
     frère dans la SARL BRIMMO et remonter ses parts dans la holding — il a
     constaté sur **Infogreffe** que rien n'a été fait ;
  2. un changement de direction de LB2i, **payé à moitié**, procédure jamais
     terminée ;
  3. des courriers URSSAF que Mylène vient de lui renvoyer, auxquels il doit
     répondre d'urgence.
  Les cas 1 et 2 n'ont ni échéance, ni montant qu'il doive, ni mail entrant :
  **le déclencheur est un silence**, pas un message. Aucun moteur fondé sur le
  courrier reçu ne peut les faire remonter. Il demande en plus des
  **propositions de retour** pour les mails qui attendent une réponse et des
  **relances** sur les échéances dépassées, et une entrée de menu dédiée.

- **Critères de succès observables** (dans 3 mois) :
  - Ses trois affaires ci-dessus sont visibles dans l'écran sans qu'il ait eu à
    les rechercher, et celles qui dorment portent « à relancer ».
  - Il déclenche une relance en un clic depuis l'écran, sans réécrire le
    contexte (le brouillon rappelle l'objet, la date d'engagement, le montant
    déjà payé, la référence).
  - Un engagement clos ne réapparaît jamais (ni au prochain mail du fil, ni
    après une réanalyse).
  - Il peut créer une affaire **de tête** en moins d'une minute — sans mail
    source, car pour BRIMMO et LB2i l'information vient d'Infogreffe, pas de
    sa boîte.

- **Non-objectifs** (refusés explicitement) :
  - **Aucun envoi automatique.** Jamais un mail parti sans qu'il ait lu et
    cliqué. Les brouillons sont des propositions, pas des envois différés.
  - Pas de rédaction par une clé API côté serveur (décision du 10/07 : pas de
    clé, l'IA tourne sur SON forfait via MCP).
  - Pas de remplacement de « 📁 Mes dossiers » (regroupement thématique de
    2 527 dossiers) : c'est un écran différent, on s'y **rattache**.
  - Pas de détection automatique fine des engagements au premier incrément :
    la saisie manuelle d'abord, la proposition automatique ensuite.

## 2. Carte d'impact

- **Zones touchées directement** :
  - `prisma/schema.prisma` — nouveau modèle `Engagement` (+ migration).
  - `src/services/engagements.ts` — **nouveau** : cycle de vie, `reviewAt`,
    détection de clôture, candidats proposés.
  - `src/services/brouillons.ts` — **nouveau** : canevas de relance/réponse.
  - `src/server/admin.ts` — routes CRUD + brouillon.
  - `web/index.html`, `web/js/app.js`, `web/styles.css` — écran + menu.
  - `src/services/today.ts` — un engagement dû devient candidat de la Vue du jour.
- **Zones touchées indirectement** :
  - `web/js/app.js::rangCandidat()` — nouvelle famille à classer (livrée ce
    matin, § 43) ; le rang doit rester non additionnable.
  - `src/services/followups.ts` — 105 relances déjà détectées ; un engagement
    ne doit pas faire doublon avec la relance du même fil.
  - `src/services/dossiers.ts` — rattachement optionnel à un dossier existant.
  - Le banc d'essai (`npm run banc`) : nouvelle surface possible pour un mail
    « à traiter » ⇒ le taux de fuite ne doit pas monter.
- **Invariants** :
  - Aucun mail n'est envoyé sans un clic explicite de l'utilisateur.
  - Un engagement `clos` ne redevient jamais `ouvert` automatiquement.
  - Un libellé ou une date saisis à la main ne sont JAMAIS réécrits par une
    analyse (même règle que `labelSource=manual` sur les dossiers).
  - Un engagement sans `reviewAt` n'apparaît jamais comme « à relancer ».
  - La suppression d'un engagement ne touche aucun mail.
  - Le taux de fuite du banc ne remonte pas (référence du 18/08 : 45 %).

## 2bis. Surfaces utilisateur

**Parcours clés** (à valider AVANT le code) :

1. *« Qu'est-ce qui traîne ? »* → clic sur **🧭 Dossiers en cours** :
   liste triée, les endormis en tête avec un badge « à relancer ».
2. *« Je note une affaire de tête »* → bouton **+ Nouvelle affaire** :
   intitulé, qui doit agir, depuis quand, quand vérifier, montant déjà payé.
3. *« Je relance »* → bouton **✉️ Préparer la relance** : brouillon pré-rempli
   (destinataire = dernier interlocuteur du dossier, objet, rappel des faits),
   qu'il modifie puis envoie lui-même.
4. *« C'est fait »* → bouton **✅ Clore** : sort de l'écran et de la Vue du jour,
   reste consultable.

```
🧭 Dossiers en cours                              [+ Nouvelle affaire]

┌──────────────────────────────────────────────────────────────┐
│ ⚠️ À RELANCER   Parts de mon frère → holding (SARL BRIMMO)   │
│ Engagé le 12/09/2025 · aucune preuve d'aboutissement         │
│ Attendu de : cabinet mandaté · vérifié le 18/08 (Infogreffe) │
│           [✉️ Préparer la relance]  [✅ Clore]  [⏰ Reporter] │
├──────────────────────────────────────────────────────────────┤
│ ⚠️ À RELANCER   Changement de direction LB2i                 │
│ Payé 50 % · procédure non terminée                           │
├──────────────────────────────────────────────────────────────┤
│ 🕐 EN COURS     Mise en demeure URSSAF — 418 €               │
│ À régler avant le 29/08 · 2 mails · Mylène LE BERRE          │
└──────────────────────────────────────────────────────────────┘
```

- **Validés avec l'utilisateur le** : 18/08, avant le code. Il a tranché le nom
  (**🧭 Affaires en cours**, pour ne pas le confondre avec « 📁 Mes dossiers »)
  et a apporté une correction déterminante sur les brouillons : « j'ai déjà dû
  envoyer des mails en ce sens, donc tu dois avoir l'email et les détails ».
  → le brouillon part du fil réel (destinataire, objet, dates, montants), il
  n'est pas rédigé dans le vide.
- **Rodage prévu** : lui, dès le déploiement ; **2 à 3 boucles de retours
  budgétées**. Le commit ouvre le rodage, il ne clôt pas le chantier
  (leçon ViewGround du 15/08 : 6 retours sur 6 portaient sur des parcours
  jamais conçus).

## 3. Inconnues & hypothèses

- **Inconnues** :
  - Ce que « proposition de retour » recouvre exactement pour lui → **question
    posée avant de coder** (cf. §4, option retenue à confirmer).
  - Combien d'engagements la détection automatique proposerait sans noyer
    l'écran — **6 246 mails envoyés portent 0 extrait et 0 verdict**, donc la
    matière première de la détection n'existe pas encore.
- **Hypothèses** :
  - Ses affaires ouvertes se comptent en dizaines, pas en centaines ⇒ une liste
    simple suffit, pas de pagination ni de recherche au premier incrément.
  - Le dernier interlocuteur du dossier rattaché est le bon destinataire d'une
    relance (à vérifier au rodage — sinon, choix manuel).

## 4. Décision

- **Options** :
  - **A — Tout automatique** : déduire les engagements des verdicts (mail
    sortant portant une action pour un tiers, paiement pour une prestation).
    *Rejeté pour le premier incrément* : les mails envoyés n'ont ni extrait ni
    verdict (0/6 246) ; et ses trois exemples viennent d'Infogreffe et de sa
    mémoire, pas de sa boîte. Une version 100 % automatique ne montrerait
    précisément AUCUN des trois cas qu'il cite.
  - **B — Saisie manuelle seule** : simple, mais l'outil n'apporte rien de plus
    qu'un carnet ; il ne pensera pas à y saisir ce qu'il oublie déjà.
  - **C — Manuel d'abord, proposition ensuite** *(retenue)* : il saisit ses
    affaires en une minute (ses trois cas existent le jour même) ; le moteur
    **propose** des candidats à confirmer au fur et à mesure que les mails
    envoyés reçoivent extraits et verdicts. `reviewAt` fait remonter le
    silence. Les brouillons partent des faits déjà extraits.
- **Décision** : **C**. L'ouverture d'un engagement exige toujours une preuve
  positive (un geste de l'utilisateur, ou un fait analysé) ; **ensuite
  seulement** le silence devient un signal. C'est ce qui évite de transformer
  « je n'ai rien reçu » en « il y a un problème ».
- **Contre-revue** : protocole **aveugle 2 tours** déjà mené le 18/08 —
  `.consult/2026-08-17-score-attention/synthese.md`. C'est elle qui a produit
  l'objet `OpenCommitment` et la distinction **`reviewAt` ≠ `dueAt`**
  (« à cette date, si je n'ai toujours aucune preuve de réalisation, je dois
  regarder »), et qui a établi que l'ouverture doit reposer sur une preuve
  positive. Pas de second tour : la question de conception centrale y a été
  traitée en aveugle.
- **ADR** : **oui** — `docs/adr/0001-engagement-ouvert.md` : pourquoi un
  engagement n'est ni un mail, ni une échéance, ni un dossier ; conditions de
  réouverture (si la détection automatique devient fiable, l'arbitrage
  manuel/auto se rejoue).

## 5. Plan de preuve

- **Conformité** :
  - Créer à la main les **trois affaires réelles** (BRIMMO, LB2i, URSSAF) et
    vérifier qu'elles apparaissent, que les deux endormies portent
    « à relancer » et que l'URSSAF porte son échéance.
  - `reviewAt` dépassé ⇒ badge « à relancer » ; `reviewAt` futur ⇒ pas de badge.
  - Brouillon de relance : contient l'intitulé, la date d'engagement et le
    montant, et **n'envoie rien** (vérifié en lisant la route : aucun appel à
    `smtp.ts` sur ce chemin).
  - Clore ⇒ disparaît de l'écran et de la Vue du jour ; rouvrir une réanalyse
    ne le ressuscite pas.
- **Non-régression** :
  - `npm run banc` **sur le serveur** : taux de fuite ≤ 45 % (référence du
    18/08). *Rappel : en local le banc ne voit que 31 mails et affiche 100 %.*
  - Simulation de la Vue du jour avant/après : un engagement dû ne doit pas
    évincer une obligation datée (classe 0) ni faire doublon avec une relance
    `followups` du même fil.
  - `npx tsc --noEmit`, `node --check web/js/*.js`, scan des octets de contrôle.
- **Invariants** :
  - *Aucun envoi automatique* : `grep` sur le nouveau service et la route de
    brouillon ⇒ zéro import de `smtp.ts` / `sendMail`.
  - *Clos reste clos* : rejouer la détection après clôture ⇒ compte inchangé.
  - *Saisie manuelle non écrasée* : champ `source=manual`, réanalyse ⇒ libellé
    et dates identiques (comparaison avant/après en base).
  - *Migration hors service* : appliquée au **boot**, jamais par `update.ts`
    (règle « database is locked »).
  - *Suppression sans effet de bord* : compte de `Message` inchangé.

## 6. Preuves exécutées

**Conformité — banc fonctionnel du moteur (14 assertions, toutes vertes)**
```
1. Création d'une affaire ENDORMIE (vérification déjà passée)
   ✓ 2 affaires listées · ✓ l'endormie est en tête · ✓ marquée « à relancer »
   ✓ celle à vérifier plus tard ne l'est pas · ✓ compteur à relancer = 1
   pourquoi : « engagée il y a 420 jours · 1131,26 € déjà réglés ·
                aucune preuve d'aboutissement à la date de vérification »
3. ✓ la Vue du jour ne prend QUE les endormies (1 due sur 2)
4. ✓ destinataire repris · ✓ montant rappelé · ✓ date d'engagement rappelée
   ✓ aucun champ d'envoi dans le brouillon
5. ✓ après report : plus aucune affaire due
6. ✓ close → sort de la liste ET de la vue du jour
   ✓ statut reste « clos » après une tentative de modification
7. ✓ suppression : messages inchangés (31 → 31) · ✓ table nettoyée
```

**Conformité — aller-retour HTTP réel (serveur local, session authentifiée)**
```
GET    /api/engagements            → 200  {"items":[],"compteurs":{…}}
POST   /api/engagements            → 201  {"id":5}
GET    /api/engagements            → 1 affaire, aRelancer=1
GET    /api/engagements/5/brouillon → to=romain@legalfree.fr, objet=Relance — …
DELETE /api/engagements/5          → ok
GET    /api/today                  → 200, todo.engagements présent, total cohérent
```

**Conformité — écran (captures + écoute des erreurs JS)**
2 cartes rendues, 1 badge « à relancer », brouillon ouvert (410 car.),
**aucune erreur JS**. Trois défauts VUS À LA CAPTURE et corrigés :
- les onglets du hub s'affichaient **en double** (le routeur les injecte déjà
  après le renderer — l'appel `hubTabs()` en tête de `renderAffaires` était
  en trop) ;
- le montant réglé apparaissait **deux fois** sur la même ligne (déjà présent
  dans `pourquoi`, construit côté serveur) ;
- dans la modale, les `<label>` restaient en ligne et la zone de texte se
  réduisait à une colonne illisible → classe `.form-vert`.

**Invariants**
- *Aucun envoi automatique* : `grep -n "smtp|sendMail|nodemailer|transport"`
  sur `engagements.ts` et `brouillons.ts` → **une seule occurrence, dans un
  commentaire**. Idem sur le bloc de routes : aucun résultat.
- *Clos reste clos* : assertion 6 (statut inchangé après `modifierEngagement`).
- *Saisie manuelle non écrasée* : `source` bascule en `manual` à toute
  modification ; la création manuelle naît `ouvert`, la proposition `propose`.
- *Migration hors service* : `src/index.ts` applique les migrations **avant**
  d'ouvrir le service (`ensureMigrationsApplied`, « seul moment où personne ne
  tient le fichier SQLite »). `update.ts` ne migre pas.
- *Suppression sans effet de bord* : assertion 7 (31 → 31 messages).
- *Migration additive* : 5 `CREATE TABLE/INDEX`, **zéro `ALTER`, zéro `DROP`**
  ⇒ rollback sans perte de données.

**Outils** : `npx tsc --noEmit` OK · `node --check web/js/*.js` OK ·
accolades CSS équilibrées (443/443) · scan d'octets de contrôle : néant.

**Non-régression (banc d'essai)** : exécuté SUR LE SERVEUR après déploiement —
référence du 18/08 matin : fuite 45 % (86/191). Résultat : voir § 7.

**Diff réel ↔ carte d'impact** : **conforme**. Toutes les zones touchées
étaient prévues. Une zone indirecte annoncée s'est effectivement révélée :
`dedoublonnerCandidats` — sans un cas dédié, **toutes les affaires tombaient
sur la même clé** (`i|undefined|undefined|…`) et se seraient réduites à une
seule carte. Défaut trouvé à la relecture, avant exécution.

**Divergences vs plan** : une seule, assumée — les affaires alimentent les
3 cartes de l'accueil mais **PAS** la file de dépouillement
(`startTodoAssistant`), qui affiche un mail dans le panneau de droite : une
affaire n'a pas de mail unique à y montrer.

## 7. Mise en service & observation

- **Déploiement / rollback** : commit + push ; sur le serveur `git pull`,
  `npm run build`, migration appliquée au **boot** (pas par `update.ts`),
  `pm2 restart`. Rollback : `git revert` + rebuild ; la table nouvelle reste
  en place sans conséquence (aucune donnée existante n'est modifiée) —
  **la migration est purement additive**, aucune colonne existante touchée.
- **Signaux à observer** : nombre d'engagements ouverts (doit rester dans les
  dizaines) ; taux de fuite du banc au prochain passage ; `logs/operations.jsonl`
  pour les créations/clôtures. Un engagement manqué étant silencieux par
  nature, le contrôle est le **rodage avec lui**, pas une métrique.
- **Clôture** : <à remplir>
