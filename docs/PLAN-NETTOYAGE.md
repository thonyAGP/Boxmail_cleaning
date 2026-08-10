# Nettoyage — refonte « fin d'utilité »

> Point de départ, mot pour mot : « le système de nettoyage n'est aussi pas
> performant, tu mélanges des boîtes, des dates, des réponses qui sont vieilles,
> tu devrais en faire des groupes […] il ne fait que lister des actions
> possibles, il n'explique pas pourquoi selon la typologie des mails, les boîtes
> etc… si par exemple newsletter avec code promo, mais dépassé depuis 3 mois,
> pas la même chose que le même mail reçu il y a 2 jours (date de validité de
> l'offre etc…) »

Travail mené le 10/08 : mesures sur la base de production + trois tours avec
ChatGPT (transcription dans `docs/archives-chatgpt/nettoyage-2026-08-10.md`).

---

## 1. Ce que disent les données réelles (et non ce qu'on croyait)

Toutes les mesures ci-dessous portent sur la base de production, dossier
**boîte de réception uniquement** (18 035 mails, 7 471 Mo) sauf mention.

### 1.1 Trois erreurs de mesure à corriger d'abord

| On disait | En réalité |
|---|---|
| « Altoen : 1 070 mails de plus d'un an, 421 Mo à récupérer » | C'était la **corbeille** d'Altoen (423 Mo). Sa boîte de réception fait 1 049 mails. |
| « Brico Privé : 615 mails, 340 Mo » | **620 de ses 626 mails sont déjà à la corbeille.** Il en reste 3 en réception. |
| « 8 762 mails récupérables / 1,3 Go » | Les 9 stratégies visent 6 928 mails, mais **4 274 portent une pièce jointe, sont une facture/document, ou viennent d'une personne**. |

**Leçon** : toute statistique de nettoyage doit filtrer `Folder.role = 'inbox'`.
Compter la corbeille, c'est promettre de vider une poubelle déjà vide.

### 1.2 Le gisement honnête

Simulation des portes successives sur les 18 035 mails de réception :

| État | Mails | Taille |
|---|---:|---:|
| PROTÉGÉ · pièce jointe | 4 645 | 3 959 Mo |
| PROTÉGÉ · facture/document | 4 048 | 2 390 Mo |
| PROTÉGÉ · une personne | 3 472 | 202 Mo |
| JE NE SAIS PAS | 3 417 | 417 Mo |
| PROTÉGÉ · tu le lis | 1 096 | 115 Mo |
| **UTILITÉ TERMINÉE** | **635** | **89 Mo** |
| **SUPPLANTÉ** | **331** | **48 Mo** |
| PROTÉGÉ · suivi (étoilé) | 305 | 234 Mo |
| ENCORE UTILE | 86 | 16 Mo |

**966 mails réellement nettoyables, 137 Mo — moins de 2 % du volume.**

> **Conséquence produit majeure** : le poids de ses boîtes est dans les
> pièces jointes et les documents, c'est-à-dire dans ce qu'il faut GARDER.
> Le nettoyage ne peut PAS être vendu comme un gain de place. Il retire des
> objets morts, il ne libère pas d'espace. Toute promesse en gigaoctets est
> mensongère et doit disparaître de l'interface.

### 1.3 Ce qui se périme vraiment (son intuition, vérifiée)

Part des mails de plus de 30 jours, par intention (toutes boîtes) :

| Intention | Total | > 30 j | Part |
|---|---:|---:|---:|
| rendez-vous | 528 | 528 | **100 %** |
| livraison | 123 | 123 | **100 %** |
| rappel | 892 | 869 | 97 % |
| confirmation | 1 441 | 1 411 | 98 % |
| code OTP | 278 | 272 | 98 % |
| promotion | 905 | 840 | 93 % |

Presque tout ce qui se périme **est** périmé. Le système ne le savait pas.

### 1.4 Lire la date de validité : ça ne marche pas

Recherche des formulations (`valable jusqu'au`, `expire le`, `dernier jour`,
`se termine le`, compte à rebours…) sur les promotions réelles :
**607 examinées, 18 portent un signal, soit 3 %.**
Cause : on ne stocke que ~500 caractères du corps, la mention est plus bas.
Re-télécharger 25 000 corps complets n'est pas envisageable sur le VPS.

→ La date explicite reste une source **opportuniste**, jamais le pilier.

### 1.5 La supplantation : la trouvaille qui remplace la date

Combien de mails plus récents du **même expéditeur** sont arrivés depuis :

- 905 mails d'offre au total
- **453 supplantés par ≥ 10 mails plus récents**, 348 par ≥ 25, 270 par ≥ 50
- Cadences mesurées : Brico Privé 1 offre / 2,3 j ; Leroy Merlin 1 / 14,8 j

Ce n'est pas une inférence sur une durée de vie, c'est un **fait comptable**,
et il s'explique en une phrase : « Leroy Merlin t'a envoyé 40 offres depuis. »

### 1.6 Les pièges qu'on a évités en simulant

- **« Sujet répété = jetable » : FAUX.** 6 088 mails ont un sujet strictement
  répété (dont 2 097 avec pièce jointe). Ce sont ses 13 déclarations de
  revenus DGFiP, ses 12 télépaiements de taxe d'habitation, ses 24 ajouts de
  bénéficiaire Crédit Agricole, ses 21 avis de remboursement mutuelle. La
  répétition signe un **processus récurrent**, trivial ou fiscal.
- **La catégorie `info` (43 % de la réception) n'est pas du bruit** : ses plus
  gros expéditeurs sont Mylène LE BERRE (411), Alizé (270), son agent
  immobilier (222), soraya (120), Sandrine (102). C'est sa vie.
- **Des êtres humains sont classés « promotion/newsletter »** :
  nathalie@agencedesenfantsrouges.com (166 mails, 136 lus), ashley_keira@,
  fanch56@, arnaudg35@. Le classifieur ne se trompe pas de nuance, il se
  trompe de nature.
- **Le drapeau `hasAttachments` est trompeur sur les pubs** : 52 % des promos
  et 217 des 792 Leroy Merlin « ont une pièce jointe » — ce sont des images
  intégrées.

### 1.7 État de vie des boîtes : ne jamais compter ce qui est REÇU

Recevoir est passif : une boîte morte reçoit quand même de la publicité.
Seuls les **gestes humains** comptent (lire, envoyer).

Règle retenue : `ACTIVE` si `lus_30j ≥ 10` ou `envoyés_90j ≥ 3` ;
`DORMANT` si `lus_90j < 10` **et** `envoyés_90j = 0` ; sinon `QUIET`.

| Boîte | lus 30 j | envoyés 90 j | vieux jamais lus | État |
|---|---:|---:|---:|---|
| thony56_gtr | 19 | 20 | 380 | ACTIVE |
| Au-marais | 33 | 5 | 505 | ACTIVE |
| Location_Brest | 11 | 3 | 178 | ACTIVE |
| Brimmo | 10 | 8 | 139 | ACTIVE |
| Colocar | 5 | 0 | 41 | QUIET |
| **Altoen** | **2** | **0** | **1 311** | **DORMANT** |
| **Econom** | **5** | **0** | **88** | **DORMANT** |

Avec le seuil « reçus ≥ 20 » proposé initialement, Altoen ressortait ACTIVE.

---

## 2. Le modèle retenu

### 2.1 Quatre axes orthogonaux, jamais un score

Un score unique (`cleanup_score > 72 → supprimer`) est opaque et indéfendable.
On garde quatre axes indépendants et des **portes successives** :

1. **CYCLE DE VIE** — que représente ce mail ?
2. **ÉTAT TEMPOREL** — encore utile / terminé / inconnu
3. **ÉTAT DE REMPLACEMENT** — la suite du flux l'a-t-elle supplanté ?
4. **ÉTAT DE PROTECTION** — correspondant, document, usage, action attendue

Autorisation, et rien d'autre :

```
nettoyable =
    NON protégé
    ET ( expiration_prouvée
         OU (cycle.supplantable ET supplantation_forte)
         OU règle_explicitement_approuvée_par_Anthony )
```

**`EXPIRED_INFERRED` seul n'autorise JAMAIS un lot de masse.**

### 2.2 Deux horloges, pas une durée de vie

Une confirmation de commande a une utilité terminée mais une valeur de preuve.
D'où deux dates distinctes, et `NULL` veut dire « je ne sais pas », jamais
« infini » (le permanent s'écrit `retention_policy = PERMANENT`) :

| Cycle de vie | fin d'utilité | fin de conservation |
|---|---|---|
| OTP (sans PJ, IA ≠ reply/pay) | réception + 24 h | idem |
| Promotion, date explicite trouvée | la date | idem |
| Promotion, supplantation forte | date du n-ième successeur | idem |
| Promotion, ni l'un ni l'autre | NULL | NULL |
| Rendez-vous / rappel, date lisible | événement + 7 j | PJ ? NULL : événement + 30 j |
| Rendez-vous / rappel, sans date | NULL | NULL |
| Livraison « livré » | réception + 7 j | réception + 90 j (litige) |
| Livraison « expédié / en cours » | NULL | NULL |
| Confirmation compte/abonnement | réception + 7 j | réception + 30 j |
| Confirmation de paiement | réception | NULL — `DOCUMENTARY` |
| Confirmation de commande | NULL | NULL |
| Facture, contrat, document | jamais | `PERMANENT` |

Règle transversale : `ai_action ∈ (reply, pay)` et confiance haute ⇒ les deux
horloges sont `NULL` et le nettoyage est interdit — rien ne prouve que
l'action a été faite.

### 2.3 Le seuil de supplantation

Ni fixe, ni proportionnel à la seule cadence :

```
successeurs_requis = borne(3, plafond(30 / intervalle_médian_expéditeur), 12)
supplanté = âge ≥ 30 j ET successeurs_même_cycle ≥ successeurs_requis
```

Brico Privé (2,3 j) → 12 ; Leroy Merlin (14,8 j) → 3. Autrement dit : il faut
avoir reçu **un mois de flux de remplacement**.

**La supplantation est une propriété du CYCLE DE VIE, pas de l'expéditeur.**
`supplantable = vrai` : promotion, OTP, alertes commerciales, newsletters
d'actualité. `supplantable = faux` : facture, relevé, paiement, commande,
contrat, correspondance, réservation — un relevé bancaire mensuel est
« supplanté » par le suivant et pourtant chacun compte. Prudence explicite sur
rappel / livraison / confirmation : dix rappels peuvent viser dix événements.

### 2.4 La relation à l'expéditeur prime sur la classification

Le classifieur s'est trompé de **nature** (des humains en « newsletter »).
On ne répare donc pas sa première erreur avec sa deuxième conclusion.

```
si Anthony a déjà écrit à cet expéditeur → CORRESPONDANT
CORRESPONDANT ⇒ aucune suppression de masse fondée sur l'expéditeur
                ou sur l'intention, quelle que soit la classification
```

Un domaine grand public (gmail, hotmail, live, orange, free…) n'établit pas
qu'il s'agit d'un humain, mais **interdit** de conclure « automatisé » : la
relation reste `INCONNUE`. Taux de lecture ≥ 80 % (sur ≥ 10 mails) ⇒
`PROTÉGÉ_PAR_L_USAGE`.

Nuance essentielle : le taux de lecture interdit de conclure « cet expéditeur
est du bruit ». Il n'interdit pas de jeter un objet intrinsèquement périssable
— un OTP FranceConnect de 2024 reste jetable même s'il lit tous ses
FranceConnect. **Sauf pour un CORRESPONDANT humain**, où le veto est dur.

### 2.5 Le verdict IA est une barrière négative, jamais une permission

- `reply` / `pay` + confiance haute → **veto**
- `archive` / `none` → lève le veto, **ne crée aucune permission**

Conséquence immédiate : le preset `ai_archive90` (« ce que l'IA a jugé bon à
archiver », **3 936 mails, 1 169 Mo — la plus grosse stratégie**) repose sur
une permission que ce modèle interdit. À réécrire ou à retirer.

### 2.6 Sous-typer les confirmations plutôt que les abandonner

1 441 confirmations, dont 1 411 de plus de 30 jours. Les laisser en
« je ne sais pas » à vie, ce n'est pas de la prudence, c'est un abandon.
Sous-typage mesuré sur les données réelles :

| Sous-type | n | avec PJ | Traitement |
|---|---:|---:|---|
| (non identifié) | 543 | 200 | reste inconnu |
| commande / achat | 322 | 202 | horloges NULL |
| paiement / prélèvement | 161 | 87 | `DOCUMENTARY` |
| inscription / compte | 105 | 27 | **7 j / 30 j** |
| réservation / séjour | 89 | 9 | selon date de séjour |
| administratif | 83 | 51 | `PERMANENT` |
| contrat / assurance | 65 | 27 | `PERMANENT` |
| livraison | 28 | 23 | selon « livré » |
| abonnement | 25 | 14 | 7 j / 30 j |
| rendez-vous | 20 | 14 | événement + 7 j |

Même en ne sous-typant proprement que 60 %, on transforme ~850 inconnus en
objets exploitables. La pièce jointe **augmente la prudence**, elle n'a jamais
l'effet inverse (`sans PJ` ≠ `jetable`). Un montant élevé protège ; un petit
montant n'autorise rien.

---

## 3. Ce que voit Anthony

### 3.1 Ce qu'on supprime

L'écran actuel est un tableau *Expéditeur / Mails / Non lus / Taille / Risque /
Pourquoi / bouton « Examiner »*, toutes boîtes et tous âges confondus. Sa
colonne « Pourquoi » dit « 85 % portent un lien de désinscription » — un fait
technique sur des en-têtes, pas une raison. C'est le « truc de 1990 » qu'il
décrit, et c'est cette page qui disparaît.

« Examiner » ne dit pas ce qui va se passer. Le bouton porte désormais
l'action : **« Mettre les 83 rendez-vous passés à la corbeille »**.

### 3.2 Groupement

Clé : **boîte × entité expéditrice × cycle de vie × état**.
La période n'est PAS une clé — elle explique, elle ne regroupe pas ; sinon on
recrée une liste comptable (janvier, février, mars…).
L'entité expéditrice est normalisée : les deux adresses Leroy Merlin
(84 + 69 mails) sont un seul interlocuteur pour un humain.

- **≥ 10 mails** → carte autonome
- **5 à 9** → seulement si ≥ 10 Mo, ou certitude ≥ 0,95, ou ≥ 80 % jamais lus
- **1 à 4** → jamais de carte individuelle
- **≥ 100** → une seule proposition avec ventilation, détail à la demande

Le résidu se regroupe par **niveau de certitude**, jamais « parce qu'il reste
des mails » : « 23 petites choses devenues inutiles — 9 codes temporaires,
7 rendez-vous passés, 4 offres terminées, 3 livraisons clôturées, venant de
8 expéditeurs dont aucun n'est un correspondant. » Si le résidu mélange des
niveaux de certitude, aucune action unique n'est proposée.

Simulation actuelle : **16 cartes** (444 mails, 64 Mo) + un résidu de
298 groupes (522 mails). Les cartes réelles seraient :
Leroy Merlin rendez-vous 83 · Airbnb rappels 69 · LeBonBail 39 ·
Calendrier Outlook 38 · Airbnb OTP 34 · Assurance Maladie OTP 32 ·
HomeExchange 23 · Smoobu OTP 19 · Air France 19 · Leroy Merlin rappels 18…

### 3.3 Le ton

Honnêteté du vocabulaire, c'est non négociable :

- expiration prouvée → « ces offres **ont expiré** »
- supplantation forte → « ces offres **ont été suivies de 12 autres** »
- inférence → « ces offres ont plus de trois mois et sont **probablement**
  dépassées » — jamais « ont expiré »

Et surtout, dire ce qu'on **ne touche pas**, ce qui compte autant que le reste :

> Je laisse tranquilles les expéditeurs que tu utilises vraiment.
> Famileo : tu lis 58 mails sur 65. FranceConnect : 48 sur 48.
> Je ne les considère donc pas comme du bruit.

### 3.4 Le nettoyage cesse d'être une destination

Devoir penser « il faut que j'aille nettoyer mes mails », c'est exactement la
charge mentale qu'on veut supprimer. Le nettoyage devient un **comportement**
qui s'exprime dans le briefing, et « Nettoyage » n'est plus qu'une page
d'historique pour qui veut comprendre.

Seuil d'apparition dans le briefing (sinon l'assistant devient lui-même du
bruit) : au moins 20 objets certains, ou 25 Mo, ou un groupe de 50 ; et
**deux propositions maximum** par briefing.

### 3.5 Délégation en trois niveaux

Un clic sur « Mettre les 83 à la corbeille » vaut **APPROUVE_CE_LOT**, jamais
**APPROUVE_LA_POLITIQUE**. Les deux sont enregistrés séparément.

L'automatisation ne se propose qu'après **trois conditions cumulées** :
deux lots approuvés sur le **même quadruplet** (boîte, expéditeur, cycle,
base de nettoyage), **aucune annulation**, et sur **deux jours distincts** —
pour éviter le clic-clic-clic dans le même écran. Anthony est non technique et
cliquera vite : c'est précisément pour ça que la barrière est temporelle.

La proposition doit être concrète, jamais abstraite :

> Tu as déjà validé deux fois ce même nettoyage sur Altoen.
> Leroy Merlin envoie une nouvelle offre environ tous les 15 jours.
> Je peux désormais mettre automatiquement à la corbeille uniquement leurs
> promotions de plus de 30 jours déjà suivies par au moins 3 promotions plus
> récentes. Les mails récents, les commandes et les factures ne seront pas
> concernés.
> [ Continuer à me demander ] [ Faire automatiquement à l'avenir ]

Le choix conservateur est visuellement normal, jamais caché dans « Annuler ».
La règle mémorisée reste lisible par un humain — jamais `cleanup_policy_37
confidence >= .84` :

```
ALTOEN · Leroy Merlin · promotions uniquement
> 30 jours · ≥ 3 promotions plus récentes → corbeille
```

Une fois active, le briefing rend compte : « J'ai mis 14 anciennes promotions
Leroy Merlin à la corbeille selon ta règle Altoen. » avec **Annuler** et
**Modifier cette règle**.

---

## 3bis. Le verdict qui change la priorité

Au troisième tour, une fois les mesures posées, la conclusion partagée a été :

> « Si tu continues maintenant à perfectionner le nettoyage, tu perfectionnes
> la mauvaise fonctionnalité. »

Le raisonnement tient en trois constats déjà démontrés plus haut :

1. Le gisement de suppression est **faible** (966 objets, 137 Mo). Les deux
   premiers tours n'ont pas été inutiles : ils ont produit un moteur assez
   prudent pour **prouver** que le gisement est faible. C'était la mesure
   qu'il fallait obtenir — et elle dit d'arrêter.
2. Un OTP de 2023 enterré à la 8 000ᵉ ligne ne consomme **aucune** attention
   aujourd'hui. Le supprimer ne réduit donc pas la charge mentale. Ce qui la
   réduit, c'est qu'il **cesse de faire partie du monde actif** : plus de
   briefing, plus de rappel, plus de résultat de recherche, plus d'analyse.
   La mise à la corbeille n'est que la conséquence physique de cette décision.
3. Ses boîtes ne sont pas sales : ce sont **des archives personnelles et
   professionnelles non structurées**. 4 645 pièces jointes, 4 048 documents,
   3 472 mails de personnes. Supprimer davantage serait la mauvaise réponse.

### Trois mondes plutôt que « important / nettoyable »

| Monde | Contenu | Traitement |
|---|---|---|
| **ACTIF** | facture à payer, mail à répondre, réservation à venir | participe au briefing |
| **MÉMOIRE** | facture payée, déclaration fiscale, relevé, remboursement mutuelle, échanges avec Nathalie | n'encombre jamais, doit être **retrouvable instantanément** |
| **MORT** | OTP ancien, rappel passé, promo supplantée, événement clos | **disparaît en silence** |

### Le vrai chantier suivant : retrouver sans classer

Anthony ne classe rien, et lui demander de le faire serait le même reproche
sous un autre nom. La formule est donc « **je range mentalement pour toi, sans
que tu aies à ranger physiquement** » : aucun mail n'est déplacé, SQLite porte
une organisation virtuelle (`attention_state`, `reference_kind`, entité
expéditrice, noms des pièces jointes) et un index de recherche plein texte
sur sujet + expéditeur + résumé IA + extrait + **nom des pièces jointes**.

Objectif : répondre à « la dernière facture du Crédit Agricole pour Altoen »,
« les remboursements mutuelle de l'an dernier », « les échanges avec Nathalie
sur l'appartement », « la déclaration de revenus 2025 » — et sortir 2 à 5
éléments, pas 222.

Retournement utile : le **sujet répété**, inutilisable pour supprimer, devient
excellent pour retrouver. Il identifie une **famille de processus** (DGFiP /
déclaration, Crédit Agricole / bénéficiaire, mutuelle / remboursement,
Airbnb / réservation). On ne jette pas le signal, on change son rôle.

De même, `has_attachment` doit rester un veto de suppression **sans** être une
dispense de traitement : une pièce jointe déclenche classement documentaire,
indexation et récupérabilité. « Facture Leroy Merlin — Altoen », « Avis DGFiP
— personnel », « Bail — Location Brest ». Bien plus utile que 137 Mo.

### Conséquence sur la navigation

`Aujourd'hui` (3 choses + « j'ai écarté 27 informations devenues inutiles ») ·
`Recherche` transformée en « Que cherches-tu ? » avec des exemples concrets ·
éventuellement `Documents` (Factures · Banque · Fiscal · Immobilier ·
Contrats · Réservations) **sans qu'aucun dossier n'ait été créé**.
Et « Nettoyage » **sort du menu**.

Phrase à tenir, à la place de « Libérez 137 Mo » :

> J'ai identifié 966 anciens mails qui n'ont plus d'utilité. Ils occupent peu
> de place, mais je peux les écarter pour qu'ils ne polluent plus tes
> recherches ni mes analyses. Je ne touche ni aux documents, ni aux pièces
> jointes, ni à tes échanges personnels.

Réserve : un écran ponctuel de « remise à plat » reste légitime pour le
premier passage sur une vieille boîte. Une fois ce stock initial traité, il
n'a plus de raison de figurer dans la navigation permanente.

---

## 4. Découpage

**Phase 1 — les faits.** Sous-typage des confirmations ; relation à
l'expéditeur (CORRESPONDANT dès qu'il a écrit) ; cadence et supplantation par
(boîte, expéditeur, cycle) ; état de vie des boîtes sur les gestes humains.
Aucune interface. Simulation à blanc obligatoire.

**Phase 2 — les deux horloges** et les portes successives, avec `NULL` assumé.
Retrait ou réécriture de `ai_archive90`. Passage à blanc comparé à la phase 1.

**Phase 3 — la parole.** Cartes boîte × expéditeur × cycle × état, phrases
honnêtes, bouton qui porte l'action, et la carte « ce que je ne touche pas ».

**Phase 4 — le briefing.** Seuils d'apparition, deux propositions maximum, et
l'écran Nettoyage rétrogradé en historique.

**Phase 5 — la délégation.** Décision de lot ≠ décision de politique ; les
trois préconditions ; règles lisibles, annulables, modifiables.

---

## 5. Garde-fous inchangés

Corbeille uniquement (jamais d'EXPUNGE), aperçu exact avant exécution, lots de
200, journalisation complète avec la liste des mails, annulation réelle,
« 0 mail personnel » — et désormais : **aucune statistique de nettoyage ne
compte autre chose que la boîte de réception**, et **aucune promesse en
gigaoctets**.
