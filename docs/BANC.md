# Banc de mesure

> Mesuré le 2026-08-11 à 14:22 · étiquettes gelées le 2026-08-11
>
> Ce fichier est produit par `npm run banc`. Il ne se modifie pas à la main.

## Le chiffre

**Taux de fuite : 56 %** (-4.2) — ❌ hors limite (< 1 %).

107 mails sur 191 dont l'oubli a une conséquence, et qui restent à traiter, n'apparaissent sur aucune surface du produit.

Périmètre : 17779 mails entrants de boîte de réception. 5479 MUST_SURFACE (30.8 %), dont **191 non résolus dans les 12 derniers mois** — c'est la population jugée. 3140 mails à faible risque (17.7 %).

Sur tout le stock non résolu, sans limite d'âge : 1375 / 1459 (94.2 %). Ce chiffre situe l'arriéré ; il n'est pas le critère — reprocher au produit de ne pas afficher un mail de 2019 n'aurait pas de sens.

## Où les mails apparaissent

| Surface | Mails |
|---|---|
| réponses attendues | 189 |
| importants | 115 |
| aujourd'hui | 21 |
| factures à traiter | 9 |
| échéances | 3 |

## Découpages

Une moyenne flatteuse masque toujours un trou. Le backtest du 10/08 l'a montré : 43 % du flux vient d'expéditeurs jamais vus.

### Par boîte

| Tranche | MUST_SURFACE | Fuite | Taux |
|---|---|---|---|
| Altoen | 4 | 2 | 50 % ⚠️ |
| Au-marais | 21 | 12 | 57.1 % ⚠️ |
| Brimmo | 63 | 42 | 66.7 % ⚠️ |
| Colocar | 22 | 10 | 45.5 % ⚠️ |
| Econom | 6 | 3 | 50 % ⚠️ |
| Location_Brest | 21 | 17 | 81 % ⚠️ |
| thony56_gtr | 54 | 21 | 38.9 % ⚠️ |

### Par année

| Tranche | MUST_SURFACE | Fuite | Taux |
|---|---|---|---|
| 2025 | 66 | 39 | 59.1 % ⚠️ |
| 2026 | 125 | 68 | 54.4 % ⚠️ |

### Expéditeur

| Tranche | MUST_SURFACE | Fuite | Taux |
|---|---|---|---|
| connu | 161 | 90 | 55.9 % ⚠️ |
| inconnu | 30 | 17 | 56.7 % ⚠️ |

### Pièce jointe

| Tranche | MUST_SURFACE | Fuite | Taux |
|---|---|---|---|
| avec | 118 | 69 | 58.5 % ⚠️ |
| sans | 73 | 38 | 52.1 % ⚠️ |

### Verdict IA

| Tranche | MUST_SURFACE | Fuite | Taux |
|---|---|---|---|
| analysé | 176 | 93 | 52.8 % ⚠️ |
| jamais analysé | 15 | 14 | 93.3 % ⚠️ |

### Motif

| Tranche | MUST_SURFACE | Fuite | Taux |
|---|---|---|---|
| document à conséquence | 66 | 52 | 78.8 % ⚠️ |
| verdict pay | 47 | 33 | 70.2 % ⚠️ |
| verdict reply | 78 | 22 | 28.2 % ⚠️ |

## Cas témoins

Les échecs connus, gardés en dur. Un lot qui les casse à nouveau se voit ici.

| Cas | Attendu | Constaté | Verdict |
|---|---|---|---|
| Air France — rappel d'enregistrement périmé | absent | nulle part | ✅ |
| PayFiP — maintenance du 12 mai | absent | nulle part | ✅ |
| Facture Sosh transmise par sa mère | visible | réponses attendues | ✅ |
| Elisa Serrano — deux sujets dans un fil | visible | — | · introuvable |

## Méthode

**MUST_SURFACE** — réponse humaine ultérieure dans le fil, OU verdict IA `reply`/`pay`, OU échéance retenue, OU pièce jointe dont le nom ou le sujet porte un mot à conséquence.

**Résolu** — il a répondu, il a pris une décision de dépouillement, ou l'échéance est faite ou écartée. Un mail résolu ne peut pas fuir : il garde sa valeur d'étiquette (il prouve que ce type de mail compte) mais ne constitue pas un reproche. « Lu » ne vaut PAS résolu — ouvrir un mail n'est pas le traiter, et c'est exactement son problème.

**Étiquettes gelées.** MUST_SURFACE se définit en partie sur `aiAction`, un champ que la refonte supprime. Les recalculer après chaque lot rendrait la mesure circulaire — le moteur serait jugé sur une règle qu'il vient de changer. Elles sont donc figées une fois pour toutes dans `docs/banc-etiquettes.json`.

**Ce n'est pas une vérité terrain.** Personne n'a annoté 25 000 mails. Un « document à conséquence » est reconnu par une liste de mots. Cette liste a le droit d'être imparfaite : elle est le mètre étalon, pas le moteur. Ce qui compte est qu'elle ne bouge plus.
