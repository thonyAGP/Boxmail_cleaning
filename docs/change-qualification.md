# La boucle de suivi : détecteur → qualification → attentes

*26/08/2026 — niveau moyen (nouveau module, nouvelle table, 3 tools MCP).*

## Le problème

Les 14 attentes affichées sur `#/suivi` ont été établies **à la main** le 26/08 :
un modèle a relu 50 histoires hors du serveur, sur des dossiers compacts
préparés pour l'occasion. C'était juste — et complètement figé. Rien ne les
régénère, aucune nouvelle affaire n'apparaîtra jamais.

Le détecteur mécanique (`anomalies.ts`) signale 305 fils en SQL, sans IA et
sans rien coûter. Mais il ne sait pas lire. Mesuré à l'instant sur deux cas :

- fil 4136, score **213** : « échéance dépassée depuis 982 jours ». En réalité
  il a répondu le 2 janvier 2024, réglé 2 000 € et conditionné le solde à
  l'achèvement du lot. Vrai sujet — mais pas celui que le score annonçait.
- fil 16550, score **209** : « 5 messages reçus, aucune réponse ». Ce sont des
  factures de recharge électrique de 2 à 14 €, **prélevées automatiquement sur
  PayPal**. Rien à faire. Le détecteur seul aurait affiché une alerte.

Un score sur deux se trompe de conclusion. Seule la lecture tranche.

## Ce qui est ajouté

Le patron éprouvé du rattrapage d'analyse, transposé aux **histoires** au lieu
des mails isolés : un vivier servi par lots, un agent qui lit sur le forfait de
l'utilisateur, des verdicts renvoyés. Aucune clé API côté serveur.

| Élément | Rôle |
|---|---|
| `services/qualification.ts` | compose le dossier compact, enregistre les verdicts |
| `mcp/tools/qualification.ts` | `next_dossiers_batch`, `submit_dossiers_batch`, `qualification_progress` |
| `cli/dossiers.ts` (`npm run dossiers`) | voir ce qui serait servi, sans rien consommer |
| table `Qualification` | trace de lecture — additive, aucune donnée touchée |

**Le dossier compact** porte le début et la fin de l'histoire (3 + 4 messages),
les extraits, les obligations déjà extraites, et la raison mécanique du
signalement. Mesuré : **3,2 Ko par dossier**, soit ~26 Ko pour un lot de 8 —
le même ordre que le lot d'analyse (30 Ko).

**La table `Qualification`** mémorise jusqu'à quel message on a lu. Un fil
qualifié ne revient que si un message y arrive ensuite : c'est ce qui vide le
vivier, et ce qui permettra de dire « c'est le 3e rappel » au lieu de rejuger
l'histoire à zéro.

## Ce qui est protégé

- **Une attente déjà traitée n'est jamais écrasée** : son geste prime sur une
  relecture automatique.
- **Idempotent par `threadId`** : rejouer un lot ne duplique rien.
- Aucune suppression, aucun envoi. On note ce qu'il y a à suivre, il décide.
- Les attentes produites portent `source: 'mecanique'`, distinctes des 14 de
  l'audit — on saura toujours d'où vient chaque carte.

## Preuves exécutées sur la production

1. `npx tsc --noEmit` — types ok.
2. Migration relue avant application : `CREATE TABLE` + 2 index, rien d'autre.
   Appliquée app arrêtée (« database is locked » rencontré : le rattrapage
   jojo56 tenait la base, coupé puis relancé — il reprend où il en est).
3. `npm run dossiers` sur les données réelles : 305 fils signalés, lot de 3 à
   **9,6 Ko**, histoires lisibles.
4. Aller-retour complet avec deux verdicts réels : **2 lus, 1 attente créée,
   0 rejet**. Attente #15 en base, `source: 'mecanique'`.
5. Vivier vidé : 303 restants, les deux fils qualifiés ne reviennent plus.

## Ce qui reste

Brancher la boucle sur une exécution régulière (le cowork fait déjà ce geste
pour l'analyse). Tant que ce n'est pas fait, la boucle existe mais il faut la
lancer — c'est le dernier pas avant que les cartes se créent seules.
