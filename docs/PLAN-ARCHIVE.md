# Archive froide — libérer de la place sans modifier un seul mail

> Idée d'Anthony (11/08) : « une autre possibilité serait, si la taille devient
> préoccupante, de créer une boîte d'archive qui permette d'y stocker les
> pièces les plus volumineuses en rangeant les mails par boîte. Au minimum cela
> rendrait 5 Go supplémentaires. »

Mesures sur la base de production + revue extérieure (ChatGPT, transcription
dans `docs/archives-chatgpt/pieces-jointes-2026-08-11.md`).
**Rien n'est engagé : ce document sert à décider.**

---

## 1. Pourquoi cette voie l'emporte sur les deux autres

| Approche | Mails touchés | Espace | Risque |
|---|---:|---:|---|
| Nettoyage du bruit | 966 | 137 Mo | faible |
| Doublons de pièces | ~1 658 copies | ~1,4 Go **repérés** | — |
| **Archive froide** | **506** | **5,42 Go** | modéré, maîtrisable |

Remarque décisive sur les doublons : **repérer 1,4 Go ne libère pas 1,4 Go.**
Pour les libérer il faudrait supprimer des mails ou retirer leurs pièces — donc
retomber sur la chirurgie MIME qu'on écarte. L'archivage, lui, est une action
physique simple.

### L'angle mort qu'on vient de découvrir

Toutes les analyses précédentes portaient sur la boîte de RÉCEPTION. Or :

| Boîte / dossier | Mails | Poids |
|---|---:|---:|
| thony56_gtr / réception | 11 336 | 4,99 Go |
| **thony56_gtr / envoyés** | **4 635** | **4,11 Go** |
| Brimmo / envoyés | 550 | 0,88 Go |

**186 des 297 mails de plus de 10 Mo sont des mails qu'il a ENVOYÉS** : des
photos. « Photos Audi A4 » (13 ans), « Ski Verbier » (12 ans), « Photo de notre
nouvel appartement » (14 ans), « Amoco Cadiz » (8 ans). À garder pour
toujours, à ne jamais consulter — la définition même d'une archive.

---

## 2. Deux contraintes Microsoft qui bornent l'idée

> **Mise a jour 11/08** : Anthony n'est pas attache a Outlook.com pour
> l'archive — « je ne suis pas ferme a un autre fournisseur d'adresse mail
> pour archivage ». La limite des 5 Go ci-dessous est PROPRE A MICROSOFT et
> cesse donc d'etre une fatalite. Le choix du fournisseur fait l'objet d'un
> tour de verification en cours (offres gratuites avec vrai IMAP, politiques
> d'inactivite, limites de taille par message).
>
> Consequence technique a connaitre : l'application ne sait aujourd'hui se
> connecter qu'a des comptes **Microsoft en OAuth**. `AccountRecord` ne porte
> que `homeAccountId` + `cacheBlob` (cache MSAL), et `imapService.getClient`
> construit toujours `auth: { user, accessToken }` sur
> `config.imap.host`. Ajouter un mode « IMAP generique » (serveur, port,
> identifiant, mot de passe d'application chiffre avec la mecanique
> AES-256-GCM deja en place) represente une trentaine de lignes et une page
> d'enrolement — c'est plus SIMPLE que l'OAuth, pas plus complique.

**a) Le compte gratuit Outlook.com n'est pas un coffre de 15 Go.** Outlook.com gratuit
offre 15 Go de boîte mail **mais seulement 5 Go de stockage Microsoft**, et les
pièces jointes comptent dans les DEUX. Dépasser les 5 Go peut bloquer l'envoi
et la réception alors même que les 15 Go ne sont pas atteints.
→ **Le facteur limitant est 5 Go, pas 15.** Marge de sécurité produit : ne pas
dépasser ~3,5 Go de pièces indexées dans le compte d'archive.

**b) Une boîte Outlook.com doit être ouverte au moins une fois par an**, sinon
elle peut être fermée et ses mails supprimés. Pour un compte d'archive, que
personne n'ouvre par définition, c'est un risque sérieux.
→ Invariant produit : `dernière_connexion_interactive < 10 mois`, avec rappel.
Ne pas supposer qu'une connexion IMAP automatique suffit.

**c) Et une tension à assumer franchement avec l'utilisateur** : notre règle est
« corbeille, jamais de suppression définitive ». Or Outlook compte les éléments
supprimés dans le quota jusqu'à leur purge (automatique à 30 jours). Donc :

```
J0        copie vérifiée, original → Éléments supprimés
J0 → J30  0 Go réellement libéré, mais retour arrière trivial
~J30      Outlook purge tout seul → l'espace est enfin rendu
```

**L'espace n'est réellement récupéré qu'au bout d'un mois**, et parce
qu'Outlook purge lui-même. L'assistant, lui, ne supprime jamais définitivement.
Si cette conséquence n'est pas acceptable, l'archivage ne peut pas libérer
durablement de capacité — il faut le dire avant, pas après.

---

## 3. Le contrat technique

**Ne jamais reconstruire le message.** On descend les octets bruts
(`BODY.PEEK[]`) et on donne EXACTEMENT ces octets à l'`APPEND` de la
destination. Ni en-têtes, ni frontières MIME, ni pièces ne sont touchés.

À préserver explicitement : la **date interne** (sans elle, le mail archivé
prend la date du jour) et les drapeaux — lu, répondu, suivi, brouillon — mais
jamais `\Deleted` ni `\Recent`.

**Ne jamais croire l'`APPEND` sur parole.** Après dépôt, on relit le message
depuis l'archive et on exige :

```
sha256(octets source) == sha256(octets destination)
```

C'est plus fort que « la commande a réussi » : ça prouve que les en-têtes, le
MIME, les pièces et la signature embarquée sont les mêmes octets. Si l'empreinte
diffère : **archivage en échec, original parfaitement intact**.

### Machine à états — aucun état où il n'existe zéro copie

```
SÉLECTIONNÉ → SOURCE_LUE → SOURCE_EMPREINTE → DÉPÔT_EN_COURS
→ DÉPOSÉ → RELU_DEPUIS_ARCHIVE → VÉRIFIÉ → SOURCE_EN_CORBEILLE
→ QUARANTAINE (30 j) → TERMINÉ
```

Panne avant le dépôt : l'original seul. Pendant : l'original existe toujours.
Après : au pire deux exemplaires. Jamais aucun.

**Le cas vicieux à traiter** : dépôt réussi mais réponse perdue (connexion
coupée). Au redémarrage on ne sait pas si le message est arrivé. **Ne surtout
pas redéposer aveuglément** : chercher d'abord dans l'archive par `Message-ID`
+ taille + date interne proche, télécharger le candidat, comparer l'empreinte.
Si elle existe déjà, reprendre à l'état « vérifié ». C'est ce détail qui rend
l'opération réellement rejouable.

**Gros messages** : si le serveur annonce `APPENDLIMIT`, vérifier avant ;
sinon tenter et traiter proprement un refus. Les 29 mails de plus de 20 Mo sont
précisément ceux à tester en premier.

---

## 4. Ce qu'on ne fait pas

- **Pas de déplacement du fil entier.** Un fil peut contenir un PDF de 18 Mo de
  2018 et un échange actif de 2026 ; déplacer tout pour accompagner le PDF
  serait absurde. On archive au niveau du MESSAGE, et c'est l'assistant qui
  rétablit la continuité : « Conversation avec le notaire — 7 messages ici,
  2 archivés », les neuf réapparaissant dans l'ordre à l'ouverture.
- **Pas de mail-repère** injecté dans la boîte d'origine pour dire où est
  parti le vrai. Ce serait transformer « je n'altère pas tes boîtes » en
  « j'injecte de faux mails », et créer du bruit permanent. La provenance vit
  en base (compte, dossier, UIDVALIDITY, UID d'origine ET d'arrivée, empreinte,
  date d'archivage).
- **Pas de seconde entrée d'index** pour la copie archivée : on la rattache au
  même message logique, sinon l'archivage fabrique lui-même des doublons de
  recherche pendant les 30 jours où les deux copies coexistent.
- **Pas de ferme de comptes gratuits** pour multiplier les quotas. Un compte
  d'archive, oui ; quatre, non.
- **Pas de score « taille × ancienneté »** : des portes d'éligibilité, puis un
  tri par taille décroissante.

Et une mise en garde à retenir : **l'archive est une relocalisation, pas une
sauvegarde**. Une fois l'original purgé, perdre l'archive c'est perdre le mail.
D'où la conservation des empreintes et un contrôle d'intégrité périodique.

---

## 5. Périmètre mesuré

Portes retenues : taille, ancienneté, **non suivi** (jamais un mail étoilé),
**fil éteint depuis 12 mois**, aucune action en cours. Le caractère lu/non lu
n'est PAS un critère : sur dix ans, c'est un mauvais indicateur de valeur.
Les factures, contrats et actes ne sont pas exclus — ce sont au contraire de
bons candidats : on veut les conserver, pas les supprimer.

| Critère | Mails | Volume |
|---|---:|---:|
| > 20 Mo et > 2 ans | 29 | 0,65 Go |
| **> 10 Mo et > 2 ans** | **252** | **3,78 Go** |
| > 10 Mo et > 3 ans | 232 | 3,48 Go |
| > 5 Mo et > 3 ans | 491 | 5,25 Go |

**Premier passage recommandé, plafonné à 3 Go : 181 mails, 2,99 Go**
(thony56_gtr 143, Location_Brest 18, Brimmo 13, Au-marais 5, Altoen 2).
Puis contrôle humain du stockage réel du compte d'archive avant d'aller plus loin.

---

## 6. Ordre des opérations

1. **Empreintes et détection des doublons** — sans risque, utile à tout le reste.
2. **Aucun nettoyage physique des pièces jointes.**
3. **Pilote d'archivage** sur le périmètre ci-dessus, plafonné à 3 Go.
4. **Contrôle du stockage réel** du compte d'archive (les 5 Go Microsoft).
5. Extension éventuelle jusqu'aux 252 mails.
6. **Déduplication visuelle** dans la recherche (« 1 document · 4 occurrences »).

---

## 7. Décisions qui appartiennent à Anthony

1. **Créer le compte d'archive** (et le nommer) — c'est son compte, pas le nôtre.
2. **Accepter que l'original parte à la corbeille et soit purgé par Outlook au
   bout de 30 jours** : c'est ce qui libère réellement la place.
3. **S'engager à ouvrir la boîte d'archive une fois par an**, sinon Microsoft
   peut la fermer et supprimer son contenu.

Tant que ces trois points ne sont pas tranchés, rien ne se déplace.
