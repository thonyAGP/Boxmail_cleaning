# Plan global — de « logiciel de tri » à « assistant qui prend les devants »

> Établi le 10/08/2026. Construit en trois tours contradictoires avec ChatGPT,
> **fondés sur les données réelles des 7 boîtes** (24 945 mails, 10 ans), et
> validés par un backtest qui a **invalidé la première approche proposée**.
> Transcriptions intégrales : `docs/archives-chatgpt/plan-tour{1,2,3}-{question,reponse}`.
> Prompt d'audit réutilisable : `docs/PROMPT-AUDIT.md`.
>
> **Objectif d'Anthony, mot pour mot** : « me réduire ma charge neuronale et me
> permettre de gagner du temps pour le passer en famille ». Tout ce qui suit
> se juge à cette aune, pas au nombre de fonctionnalités.

---

## 1. Ce que disent les données (faits mesurés, 10/08/2026)

### La noyade est datée, et récente
Part des mails **jamais ouverts**, par année de réception :

| 2013-2020 | 2021 | 2022 | 2023 | 2024 | 2025 | 2026 |
|---|---|---|---|---|---|---|
| 0 à 2 % | 11 % | 23 % | 9 % | 25 % | **45 %** | **63 %** |

Le volume annuel n'a que doublé en 12 ans (673 → 2 870). **Ce n'est donc pas
le volume qui l'a noyé** : c'est le coût de décision par mail. Il a tenu une
boîte à zéro pendant huit ans, puis a décroché.

### Il n'a jamais classé — et c'est un argument POUR l'automatisation
Sur les 7 boîtes : **aucun dossier créé en 10 ans**. Uniquement INBOX / Sent /
Deleted / Drafts. 11 336 mails dorment dans la boîte de réception perso.
Lecture : le coût d'entretien d'un rangement manuel a toujours dépassé sa
valeur perçue. **Ne jamais lui demander de ranger.**

### Le bruit n'est PAS le problème
Aucun expéditeur n'est à 100 % non lu. Les expéditeurs à ≥ 40 mails dont moins
de 10 % sont ouverts se comptent sur une main : Brico Privé (615 mails),
Leroy Merlin (364), HomeExchange (112), kidsnclouds (49) — **4,5 % du volume**.
Les 63 % de non-lus de 2026 sont des mails *légitimes* qu'il n'arrive plus à
traiter, pas des pubs. Le nettoyage ne réglera donc pas la charge mentale.

### La place n'est pas où l'on croit
12,3 Go au total, dont **plus de 6,3 Go sont ses propres envois** (ses 7
adresses en expéditeur). Le pire pollueur entrant, Brico Privé, pèse 340 Mo.
→ « Libérer de l'espace » sort des objectifs principaux ; ça devient une
fonction séparée « santé du stockage » (surveillance de quota).

### Le système propose, personne n'adopte
**114 règles de classement suggérées, 0 active. 0 priorité d'expéditeur posée**
(la fonction existe depuis des mois). 51 corbeille, 47 vu, 12 actions : c'est
tout le signal explicite en base. Une suggestion jamais acceptée est un échec
de conception, pas un manque de discipline.

### Mais le signal implicite est énorme
8 185 échanges où il a répondu (délai moyen **6 jours**), 24 295 verdicts IA
déjà payés, 17 188 extraits de texte, 10 191 mails à pièce jointe.
Ses vrais correspondants ressortent seuls : sa femme (566 mails), 3 conseillers
du Crédit Agricole du Morbihan, 2 notaires, 2 comptables (Comptastar), un
architecte, un service juridique d'assurance, des agences immobilières.

### Le classement actuel ne discrimine pas
info 34 % + aucune intention 24 % = **58 % des mails dans un fourre-tout**.
Les catégories sont celles d'un logiciel (l'intention du message), pas celles
d'un humain surchargé (« ça va me coûter une action » / « ça peut mourir »).

---

## 2. Le backtest qui a tout changé

ChatGPT proposait un **score de relation** (qui écrit, à qui je réponds, en
combien de temps) comme cœur du moteur, avec l'objectif : « ≥ 85 % des mails
réellement répondus dans le top 30 % du score ».

**Je l'ai codé et mesuré** (apprentissage ≤ 2024, validation 2025-2026,
4 152 mails, 240 réponses réelles) :

| Tranche de score | Réponses capturées |
|---|---|
| top 10 % | 29 % |
| top 20 % | 42 % |
| top 30 % | **45 %** (objectif : 85 %) |
| top 50 % | 45 % — plateau |

**Cause mesurée** : 1 787 des 4 152 mails (**43 %**) viennent d'expéditeurs
jamais vus avant 2025. Score de relation = 0. Le modèle est aveugle sur près
de la moitié du flux.

**Et surtout : le critère lui-même était faux.** Seuls 5,8 % des mails
reçoivent une réponse. Or une facture, un avis d'échéance, une convocation,
une assurance qui expire — rien de tout cela ne se répond par mail, et ce sont
précisément les mails dont l'oubli coûte cher. *Prédire la réponse, c'est
mesurer « Anthony communique », pas « Anthony subit une conséquence ».*

**Conclusions actées** : le score de relation passe de 40 points (cœur) à
**±10 points** (simple départage). Et « inconnu » ne doit pas baisser
l'importance : il doit **augmenter l'incertitude**.

**Actif confirmé** : les verdicts IA déjà en base sont discriminants —
P(réponse réelle) vaut 49 % pour `reply` contre 8 % pour `archive`, soit 6×.
Il serait absurde de refaire analyser ces 24 295 mails.

---

## 3. Le modèle cible

### Le renversement fondamental
Aujourd'hui l'écran demande **« que veux-tu faire de ce mail ? »**.
Demain il dit **« voilà ce que j'ai fait — interviens seulement si c'est faux »**.
L'absence de réaction vaut accord. Il n'y a pas de bouton « Valider ».

### Quatre zones, plus une file unique
| Zone | Contenu | Volume visé |
|---|---|---|
| **À faire** | une action humaine est réellement nécessaire | quelques éléments |
| **À vérifier** | le système a décidé mais les signaux se contredisent | très court |
| **Fait pour vous** | replié par défaut, consultable pour l'audit | l'essentiel |
| **À surveiller** | rien à faire maintenant, le système suit (attente d'un tiers, échéance future) | — |

### Trois scores indépendants, pas un seul
Un score unique mélange des choses différentes. Il en faut trois :

- **CONSEQUENCE_RISK (0-100)** — *que se passe-t-il si Anthony ne le voit pas ?*
  Verdict IA (`pay` +35, `reply` +20, `read` +8, `archive` −20) + échéance
  (≤ 7 j +35, ≤ 30 j +25…) + nature détectée (juridique/mise en demeure +30,
  fiscal/banque +25, assurance/contrat/signature +22, facture +20 — on prend le
  **max**, pas la somme) + contexte (n° de dossier connu +18, affaire active
  +15, adresse de bien +12 ; plafond +20) + relation (**±10 seulement**).
- **ACTION_NEED (0-100)** — *y a-t-il un geste à faire ?* `pay` +45, `reply`
  +40, demande explicite +35, signature/paiement +30, échéance proche +25,
  dernier mail entrant non répondu +20, `archive` −20.
- **UNCERTAINTY (0-100)** — *à quel point je peux me tromper ?* aucun verdict
  IA +20, expéditeur inconnu +15, domaine inconnu +10, classification
  contradictoire +20, pièce utile non extraite +20. Réductions : n° de dossier
  exact −20, adresse connue −15, verdict présent −15.

Une assurance qui expire donne CONSEQUENCE 80 / ACTION_NEED 30 : elle mérite
l'attention **sans qu'aucune réponse ne soit attendue**. C'est exactement ce
que l'ancien modèle ratait.

### L'arbre de décision (déterministe, local, explicable)
```
SI action explicite ET ACTION_NEED >= 50            → À FAIRE
SINON SI on attend un tiers                          → À SURVEILLER
SINON SI CONSEQUENCE >= 70                           → À FAIRE (ou À VÉRIFIER
                                                       si l'action est inconnue)
SINON SI UNCERTAINTY >= 45 ET CONSEQUENCE >= 35      → À VÉRIFIER
SINON SI CONSEQUENCE <= 25 ET ACTION_NEED <= 20
        ET UNCERTAINTY <= 35                         → FAIT POUR VOUS
SINON                                                 → À VÉRIFIER
```

### Deux cerveaux
- **Local, toujours disponible** : historique, scores, entités, échéances,
  documents, décisions réversibles. Le serveur doit fonctionner **sans Claude**.
- **Claude, sous portail strict** : uniquement si (pas de verdict IA existant)
  ET (35 ≤ CONSEQUENCE ≤ 69) ET (UNCERTAINTY ≥ 45), ou pièce importante mal
  classée. Claude renvoie des **faits structurés** (action requise, échéance,
  type de conséquence, entités, confiance) — **jamais la zone** : c'est le
  moteur déterministe qui décide. Objectif : ≤ 15 % du flux.

### Les contextes remplacent les dossiers
Un mail ne « va » nulle part : il reste où il est, et le système sait qu'il
concerne *Brimmo + bien de Brest + sinistre dégât des eaux*. Vue calculée,
jamais un rangement à faire. Amorçage sans taxonomie humaine : boîte dédiée →
société (signal très fort), fil de discussion, adresse de bien, n° de dossier
ou de facture, correspondant métier récurrent, raison sociale lue dans le PDF.

---

## 4. Le banc de mesure (à construire AVANT de coder le moteur)

On ne peut pas reconstruire « l'importance » sans label humain. On construit
donc trois jeux observables sur les 10 ans :

- **MUST_SURFACE** — réponse humaine ultérieure, OU `aiAction` = reply/pay, OU
  échéance détectée, OU document à conséquence (facture, appel de fonds,
  contrat, convocation, mise en demeure, assurance, fiscal, signature).
- **LIKELY_LOW_RISK** — `archive` ET aucune réponse ET aucune échéance ET
  aucune pièce à conséquence ET aucun contexte actif.
- **False Auto-Done Rate** — *le KPI de sécurité* : parmi les mails que le
  moteur veut traiter seul, combien portaient un signal MUST_SURFACE ?

**Objectifs** : < 1 % de fuite dans Auto-Done ; 100 % des `pay` et des
échéances hors Auto-Done ; ≥ 95 % des réponses réelles hors Auto-Done.
*Mieux vaut 30 % de mails auto-traités avec 0,5 % de fuite que 70 % avec 5 %.*

**Deux précautions méthodologiques** :
1. **Ablation** — si `pay` donne +35 et qu'on vérifie ensuite que les `pay`
   remontent, on teste son propre `if`. Il faut retirer chaque signal et
   vérifier que les autres rattrapent le mail.
2. **Toujours découper les résultats** par expéditeur connu/inconnu, avec/sans
   pièce jointe, avec/sans verdict IA, avec/sans échéance, et par année. Sinon
   une bonne performance sur les connus masquera le trou des 43 % d'inconnus.

**KPI directeur du produit** : *nombre de décisions humaines pour 100 mails
reçus*. Cible : 100 mails → 10 à 20 décisions, puis 5 à 10. Et ces décisions
doivent porter sur l'argent, les engagements, les délais, les relations
humaines et les vraies ambiguïtés — rien d'autre.

---

## 5. Les phases

| # | Chantier | Critère de réussite (mesurable rétrospectivement) |
|---|---|---|
| **0** | **Banc de validation** : MUST_SURFACE, LIKELY_LOW_RISK, rapport découpé par sous-population | les 4 152 mails 2025-26 tous évaluables, métriques séparées connus/inconnus |
| **1** | **Moteur 3 scores + arbre**, sans nouvelle analyse IA | ≥ 98 % des MUST_SURFACE hors Auto-Done ; 100 % des `pay` et échéances ; ≥ 95 % des réponses réelles |
| **2** | **Inconnus & contextes** : prior par domaine, entités (société, bien, dossier), texte des pièces | sur les 1 787 inconnus : ≥ 95 % des MUST_SURFACE hors Auto-Done |
| **3** | **Claude sélectif** sur la seule bande ambiguë | ≤ 15 % du flux ; cette tranche concentre ≥ 3× plus de MUST_SURFACE que la moyenne |
| **4** | **Écran inversé** : 4 zones, exécution + contestation en 1 geste | ≥ 40 % du flux en Fait pour vous, ≤ 20 % en À vérifier, fuite < 1 % |
| **5** | **Registre documentaire** : hash SHA-256 comme identité, extraction, renommage de la **copie** exportée | ≥ 95 % des pièces inventoriées ; zéro doublon envoyé au connecteur comptable |
| **6** | **Proactivité** : affaires, brouillons de réponse, relances | < 5 min d'attention email par jour sur une semaine normale |

**Transverses, jamais des phases** : élimination du bruit à haute confiance
(4,5 % du volume) ; surveillance du quota de stockage.

**Règle de passage** : on ne passe pas à la phase suivante parce que « la
fonctionnalité est finie », mais quand **le nombre de décisions demandées à
Anthony a réellement baissé**.

---

## 6. Les pièces jointes : un registre, pas des fichiers attachés

10 191 mails portent une pièce (12,3 Go). Aujourd'hui, une pièce n'existe que
comme « la pièce jointe du mail du 12 mai ».

Elle doit devenir un **document** : identité = **hash SHA-256** (pas le nom),
avec fournisseur, société, type, date, montant, n° de facture, échéance,
texte extrait, provenance, niveau de confiance.

- **Renommage** : uniquement sur la **copie exportée**
  (`BRIMMO_Facture_ENGIE_2026-05-18_148.37EUR.pdf`), **jamais** le fichier
  d'origine dans le mail, et jamais comme identité interne.
- **Le connecteur comptable devient un consommateur** de ce registre, pas un
  système parallèle : Boxmail garde hash + provenance + destination + statut de
  livraison ; l'application comptable reste seule autorité sur la comptabilité.
- **Ne pas viser « 100 % des pièces lues par l'IA »** : viser 100 %
  *inventoriées*, typées localement, et lecture profonde seulement des pièces
  susceptibles d'avoir de la valeur.

---

## 7. Ce qu'on ne fera PAS

- **Pas de questionnaire de priorités.** L'importance dépend du contexte, pas
  de l'adresse : le Crédit Agricole qui annonce un prélèvement rejeté et le
  Crédit Agricole qui envoie sa newsletter placements n'ont rien à voir.
- **Faire disparaître les règles de l'interface.** Une règle doit être une
  *conséquence* de l'apprentissage, pas un objet que l'utilisateur administre.
  (114 suggérées, 0 activée : la preuve est faite.)
- **Supprimer le bouton « Passer ».** S'il faut passer un mail, c'est que le
  système n'aurait pas dû le présenter.
- **Ne jamais faire disparaître silencieusement** ce dont l'oubli coûte cher —
  fiscal, banque, assurance, avocat, copropriété, échéance contractuelle —
  même à 98 % de confiance.
- **Ne pas transformer la proactivité en avalanche d'alertes** : « vous avez 17
  choses importantes » serait pire que la boîte mail.
- **Pas d'affaires tout de suite** (phase tardive) : d'abord les contextes.
  Remplacer 25 000 mails par 8 000 dossiers ne résoudrait rien.

---

## 8. Structures de données (SQLite, phases 0-2)

Six tables à ajouter, pas davantage avant d'avoir mesuré :

- **`entities`** — sociétés, personnes, biens, services.
  `entity_type, canonical_key (unique), label, parent_id, source, confidence`.
  Clés : `company:econom`, `property:46-republique-brest`, `person:notaire-x`.
- **`message_entities`** — `message_id, entity_id, role, confidence, source`
  (rôles : company, property, sender_relation, subject).
- **`relationship_profiles`** — cache **reconstructible** : compteurs pondérés
  (demi-vie 2 ans), `reply_rate`, `median_reply_hours`, `relationship_score`.
- **`implicit_signals`** — le dataset brut : `signal_type` (historical_reply,
  reply_within_24h, restored_from_trash, user_override…), `occurred_at`.
- **`attention_decisions`** — le cœur du nouvel écran : `cost_class`, `zone`,
  `proposed_action`, les 3 scores, `decision_confidence`, `reasons_json`,
  `model_version`, `state` (proposed/executed/overridden/reverted), et
  **`original_folder` / `original_flags_json`** pour pouvoir tout défaire.
- **`decision_events`** — journal complet (computed, executed, user_override,
  reverted, recomputed).

---

## 9. Prochaine action concrète

**Phase 0, le banc de validation.** Ce n'est pas une fonctionnalité visible :
c'est ce qui permettra de dire objectivement si le moteur est sûr avant de le
laisser agir. Sans lui, on coderait à l'aveugle — et le backtest du 10/08 vient
de prouver qu'une intuition raisonnable peut se tromper d'un facteur deux.

Livrable : un rapport reproductible, découpé par sous-population, sur les
4 152 mails de 2025-2026.
