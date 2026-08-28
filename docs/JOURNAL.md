# Journal des sessions — Boxmail / Mail Assistant

> Historique détaillé des livraisons et décisions, déplacé depuis CLAUDE.md le
> 01/08/2026 (le fichier faisait 84 Ko et était injecté dans chaque requête
> Claude, ce qui faisait planter les sessions — voir CLAUDE.md § Conventions).
> Ordre : du plus récent au plus ancien. Ajouter les nouveaux comptes rendus EN TÊTE.

## 28/08 (59) — Un accent invisible, et trois pages prises pour trois factures

Sa question : « on en est où dans le traitement de mes factures pour Expensya
et Jump ? » La réponse honnête était : **bloqué depuis le 27/08, et pas pour la
raison qu'on croyait.**

**1. La panne était dans les journaux d'accès, pas dans le code de détection.**
Trois pulls Fiscal-Manager d'affilée : `?cursor=0&limit=100` → 200, puis 500 sur
**toujours la même pièce**, puis plus rien. Le curseur ne « prenait pas de
retard », il était RÉINITIALISÉ par un plantage. La pièce : `Facture mars 2026
république.pdf`, dont le « é » est un `e` suivi de l'accent COMBINANT U+0301 —
Node tolère le Latin-1 dans un en-tête, pas au-dessus, et `setHeader` levait.
Un accent invisible à l'œil gelait trois semaines de justificatifs.

Le champ de mines complet a valu autant que le correctif : sur les 286 noms de
pièces, **8 cassaient l'en-tête, 0 après** — sinon on retombait dessus au
candidat n° 120. `entete-fichier.ts` sert les deux formes de la RFC 6266.
Deux hypothèses avaient été formulées avant (branche non déployée, portillon
sémantique) : les deux fausses. **Lire les journaux d'accès AVANT de relire le
code.**

**2. « Mylène me scanne les documents page par page. »** Trois lignes « facture
sosh », Orange/Sosh, 23,61 € chacune — soit 70,83 € pour une facture de 23,61 €,
la rechute exacte du billet compté trois fois de la veille. Un mail, trois JPEG :
Boxmail en faisait correctement un candidat, Fiscal-Manager un frais par pièce.
Mais c'est Boxmail qui LIT les documents : c'est à lui de dire lesquels n'en
font qu'un.

La valeur est dans l'ÉTROITESSE de la règle, et elle vient de la simulation sur
les 213 candidats réels : 40 portent plusieurs pièces, elle n'en touche que 2 —
seq 67 (3 pages → 1 document) et seq 237 (8 pièces → DEUX liasses de 4 pages
dans le même mail, à ne fusionner ni en une ni en huit). 8 frais en double
évités. Elle s'abstient sur les 18 factures Amazon d'un seul mail, les 7 relevés
`01-25`…`07-25`, les paires Invoice+Receipt. D'où : images seulement, même
racine, numérotation contiguë. Le contrat API est additif (`pageGroups`,
`documentCount`) et rien n'est fusionné — l'écran affiche la raison en français
et les pages numérotées, pour qu'il puisse contredire avant que ça devienne un
frais. Un défaut trouvé en regardant la capture et pas le code : les pages
sortaient dans l'ordre du mail, « page 3 sur 3 » en tête.

**3. L'échange avec Fiscal-Manager, dans `ECHANGE-FISCAL-MANAGER.md`.** Il a
corrigé le vrai défaut, plus grave que le bug : chez lui une pièce en échec
arrêtait le pull ET figeait le curseur, sous un bandeau qui annonçait « la
reprise reprendra où elle s'est arrêtée ». Sa frayeur sur les sauvegardes était
infondée — le fichier de 516 Ko était la base de fixtures de son dépôt de dev,
la prod fait 593 Mo. Sa question sur le plafond de 10 Mo : personne ne s'en
approche (plus grosse pièce 3,94 Mo annoncés). Au passage, **mon `sizeBytes`
ment de ~37 %** : c'est la taille ENCODÉE du BODYSTRUCTURE (1 392 026 annoncés
pour 1 017 248 servis, rapport 0,7307). Non corrigé faute de connaître
l'encodage de chaque partie ; dit plutôt que caché.

## 27/08 (58) — « Où je trouve le résumé ? » — et la leçon des cartes

Trois retours d'affilée, tous justes, tous sur la même faille : **ce que je
livre doit être VU par lui, pas seulement écrit quelque part.**

**1. « Tu as fait plein de trucs que tu ne m'as pas documentés. »** Le défaut
était plus grave qu'un manque de doc : le connecteur Fiscal-Manager tournait
depuis le 07/08 sans qu'AUCUN écran de Boxmail ne montre ce qu'il envoyait.
C'est précisément ce qui a laissé passer un billet compté trois fois et une
lettre d'information prise pour 250 € de dépense — je regardais un compteur,
pas une liste. Livré : l'écran `#/pieces-compta` et une section d'aide qui
répond à ses cinq questions (ce que j'envoie, comment ça part, comment il
vérifie, sur quoi je me base, ce qui peut m'échapper).

**2. « C'est incompréhensible tes cartes, où as-tu vu faire ça. »** J'avais
livré 213 justificatifs en grille de fiches : boutons repliés sur deux lignes,
noms de fichiers coupés, montants noyés. Les cartes servent à TRANCHER trois ou
quatre choses ; un registre de lignes homogènes est un TABLEAU. Refait en
tableau, lignes de 32 px vérifiées au banc, justification dépliable à la
demande — l'afficher 213 fois est du bruit, ne jamais l'afficher est un acte de
foi.

**3. « Ce qui est envoyé à Jump ou Expensya est uniquement les frais de
LB2I. »** J'avais écrit dans l'aide que les pièces partaient « ensuite vers Jump
ou Expensya » : faux pour une facture BRIMMO ou Au-marais. La chaîne exacte est
« Boxmail met à disposition → Fiscal-Manager vient chercher → c'est là qu'il
qualifie par société ». D'où le filtre par BOÎTE, qui n'est pas un confort :
combiné au filtre de nature, il répond à « quels billets partent en note de
frais ? ».

**Sa question la plus précise de la journée** : « Fiscal-Manager perd le lien de
téléchargement ou tu le lui transmets ? » Vérifié dans SON dépôt plutôt
qu'affirmé (`lib/accounting/boxmail-pull.ts`) : au pull il télécharge le PDF et
le stocke chez lui (`fileBytes`), avec un SHA-256 pour repérer un même document
arrivé par un autre mail. Une fois importée, la pièce ne dépend plus de Boxmail.
La seule fenêtre fragile est entre le repérage et le premier téléchargement —
d'où l'importance de la clause de protection.

**Deux règles montées dans CLAUDE.md** : un texte tronqué ne permet jamais de
conclure « non » ; et regarder un compteur ne remplace pas lire la liste.

## 27/08 (57) — Les billets d'avion, et trois troncatures en enfilade

Sa demande, avec le piège déjà identifié par lui : « la protection
anti-suppression de Boxmail repose sur l'hypothèse qu'un candidat comptable a
toujours une pièce jointe. Faire entrer des mails sans PJ casse cette hypothèse
en silence. » Les billets d'avion ne portent AUCUNE pièce jointe — le corps EST
le justificatif — et ils étaient oubliés systématiquement dans Jump et Expensya.

**La protection d'abord.** Le commentaire en tête d'`accounting.ts` affirmait
qu'« un candidat est par définition un mail à pièce jointe », donc que la clause
`m.hasAttachments = 0` de `retention.ts` suffisait. Vrai tant que la détection
exigeait une pièce. Une confirmation de vol coche `hasAttachments = 0` ET
`intent NOT IN ('invoice','document')` : les deux conditions de suppression à la
fois, et comme aucun PDF n'est stocké, le justificatif serait perdu pour de bon.
Clause explicite ajoutée : tout mail portant un `AccountingCandidate` **ACTIF**
est protégé. `SKIPPED` en est exclu — le protéger aurait gelé en silence le
nettoyage de tous les mails « facture » sans pièce. Le banc vérifie les deux
sens, y compris la contre-épreuve qu'un mail ordinaire reste supprimable.

**La pièce synthétique.** `attachmentId` = `"body"`, constante donc stable :
c'est ce qui empêche le doublon côté Fiscal-Manager (contrainte unique
`sourceSystem, sourceCandidateId, sourceAttachmentId`). Le corps est rendu en
PDF **à la demande**, par un générateur maison sans dépendance
(`services/pdf.ts`), déterministe à l'octet, rien n'est persisté. Vérifié dans
Chrome : un défaut vu au RENDU — « Malaga (AGP) ? Brest (BES) », la flèche
n'existant pas en WinAnsi — corrigé par translittération, parce que sur un
billet la flèche EST l'itinéraire.

**PUIS TROIS TRONCATURES, l'une après l'autre**, et c'est le vrai enseignement
de la journée. Le rattrapage sur `lb2i` a rendu **0 billet sur 94 candidats**,
trois fois de suite, pour trois raisons différentes :

1. `analysisInput` est un extrait SÉLECTIONNÉ (~2 200 car., passages sautés
   marqués « […] ») : les 2 280 caractères indexés de la confirmation Volotea ne
   contenaient AUCUNE ligne de paiement.
2. Le repli « lire le corps complet » ne l'était pas : `readEmail().text`
   s'arrête à 5 000 caractères — c'est un texte d'AFFICHAGE — alors que le HTML
   du mail fait **220 395** caractères. Dans les 5 000 lus, les seules lignes
   portant un montant étaient « à partir de 2 € » : de la publicité.
3. Une fois le HTML converti, le montant était là… mais **deux lignes sous son
   libellé** (`175 | Montant payé avec MASTERCARD:` / `177 | 160,36€`), mise en
   page HTML ordinaire. Ma fenêtre ne regardait que la ligne précédente.

À chaque étape j'ai conclu « pas de montant » sans avoir lu le texte qui le
portait. C'est le § 53 sous trois formes. La règle est montée dans CLAUDE.md :
**un texte tronqué ne permet jamais de conclure « non »** — avant tout verdict
négatif, se demander d'où vient le texte et s'il est complet.

Ce qui a permis d'en sortir : ne rien supposer et aller LIRE le mail réel sur
la production, à chaque fois. Le banc synthétique était vert du premier coup et
le serait resté — il testait des corps que j'avais écrits moi-même. Il rejoue
désormais la mise en page réelle, avec ses pièges (« à partir de 2 € »,
« économisé 39.42€ » dans le même corps).

## 27/08 (56) — SIDER : ce qui donnait « l'impression d'un truc solide »

Trois défauts signalés depuis l'écran, sur un remboursement de 1 000 € au
dossier « Comptabilité Client SIDER ». Son verdict : « tu donnes l'impression
d'avoir créé un truc solide mais en fait c'est du vent. Rien n'est
exploitable. »

**1. Le brouillon proposait n'importe qui.** `motsDuNom()` retenait tout mot de
≥ 4 lettres hors civilités : « comptabilite », « client » et « sider ». Les deux
premiers désignent une FONCTION de boîte aux lettres, pas quelqu'un — d'où IKEA
Service client, TotalEnergies service.client, Vis Express service.client
proposés comme destinataires. Pire, le pré-rempli était devenu
`compta.client@qerys.com` au lieu de `litiges@sider.biz`, pourtant dans le fil.
Correctif : une liste de vocabulaire de service (compta, client, litiges,
service, agence, formes juridiques, civilités) écartée AVANT le choix. Il ne
reste que « sider ». Et s'il ne reste rien, on ne cherche pas par nom : les
correspondants du fil suffisent.

**2. « Voir l'histoire » renvoyait 153 mails.** Le bouton cherchait le mot le
plus LONG du libellé — « Comptabilite », 12 lettres — chez 42 interlocuteurs
sans rapport. Or la fonction qu'il demandait existait depuis le 18/08 : les
trois focales de `contexteDuMail`, servies par le panneau « 📚 Contexte » du
lecteur. Elle était ENFERMÉE : `chargerContexte` vivait dans
`renderReaderAnalysis`, donc n'existait que si un mail était ouvert. Hissée hors
du lecteur avec un paramètre `ctx` (le lecteur empile le mail courant, une
modale se referme avant d'ouvrir). « Voir l'histoire » ouvre désormais sur
`sujet` — le fil — et affiche les élargissements avec leur compteur.

**3. Le constat était tronqué au milieu d'une phrase** — un `slice(0, 140)` dans
`brouillons.ts`, retiré.

**Le bouton « Proposer ».** Signalé dans la foulée : « je ne sais pas à quoi il
correspond, et une fois cliqué il n'est pas annulable ». Trois défauts d'un
coup — un libellé qui décrivait mon geste et pas son effet ; une création en
statut `proposed` qui l'envoyait re-valider sur un AUTRE écran une date qu'il
venait d'approuver ; aucun retour en arrière. Devient « ⏰ Me le rappeler »,
crée `confirmed`, et pose un bandeau « Annuler ».

**Le banc a trouvé un quatrième défaut, dans l'annulation elle-même** :
`dismissDeadline` laisse la ligne en base, et la route d'analyse masque toute
date déjà enregistrée QUEL QUE SOIT son statut (`knownKeys`). Annuler aurait
donc enterré la date pour toujours. D'où `deleteDeadline`, réservé à
l'annulation immédiate — « écarter » reste ce qu'il est, une décision de refus.

**CLAUDE.md redescendu de 15,2 à 12,1 Ko** après son rappel — « claude.md n'a
pas vocation à stocker toute cette merde d'historique ». Sorti : le détail du
dossier LEGALFREE (il est ici et surtout dans l'app), les dates et anecdotes
derrière chaque règle, le réglage du pilote ChatGPT (qui n'est pas une règle
Boxmail). Gardé : les règles à l'impératif. Contrôle automatique du diff pour
vérifier qu'aucun repère technique n'avait disparu — deux avaient sauté
(`npm run genkey`, `analysis.ts`), remis. C'est la deuxième dérive du fichier
après les 84 Ko du 01/08 : le seuil d'alarme (~12 Ko) est écrit en tête.

## 27/08 (55) — Le renversement promis le 10/08, enfin livré

Sa demande, mot pour mot : « je suis sûr que tu devrais déjà être capable de
prévoir ou de m'orienter afin que je valide ou non **une décision que tu auras
déjà prise**. Je ne veux pas avoir des listes empilées de ce qui est à faire ou
que tu imagines, mais **de ce que tu penses que je devrais faire**. »

Et sur les 114 règles jamais activées, une précision qui change le diagnostic :
« je n'ai même pas été y jeter un œil, car c'est une suite de 114 lignes à dire
oui ou non ». Ce n'était pas un refus du classement — un refus qu'on le lui
fasse faire.

### Ce que l'audit du dépôt a trouvé

`docs/PLAN-ASSISTANT.md:105-108`, écrit le 10/08, disait déjà : « Aujourd'hui
l'écran demande "que veux-tu faire de ce mail ?". Demain il dit "voilà ce que
j'ai fait — interviens seulement si c'est faux". L'absence de réaction vaut
accord. Il n'y a pas de bouton Valider. »

**Jamais livré. Douze sessions depuis.** Et le code *annonçait* le bon
comportement sans l'appliquer : `web/js/app.js:1692` promettait en commentaire
« un bandeau *Fait · Annuler* apparaît », la ligne suivante passait `null` comme
`onUndo` — **le bouton n'a jamais existé**. Les routes d'annulation
(`replyRestore`, `followupRestore`, `deadlineAction('restore')`) existaient et
n'étaient appelées de nulle part sur cet écran.

**16 surfaces d'arbitrage** recensées, dont 4 à usage MESURÉ NUL : 114 règles
suggérées / 0 activée · 0 fusion, 0 renommage, 0 masquage en un mois · aucune
trace de notation des moteurs. Trois affirmations fausses à l'écran : la phrase
« N choses méritent ton attention » (celle de la colère du 18/08), le bouton
« C'est réglé » qui n'enregistrait aucun paiement, le nettoyage annoncé en
gigaoctets alors que moins de 2 % du volume est supprimable.

### La consultation ChatGPT (protocole aveugle, 2 tours)

`.consult/2026-08-26-aujourdhui/synthese.md`. Trois apports décisifs :

**Deux modèles séparés, jamais recombinés en un score.** Le *risque objectif*
(« si rien ne se passe, y a-t-il un problème ? ») et la *politique de
présentation* (« est-il utile de le montrer aujourd'hui ? »). Le second n'a
jamais le droit d'annuler le premier — sinon le système apprend la
procrastination : « l'utilisateur ignore toujours les impôts pénibles, le
système apprend qu'il ne souhaite pas les voir ».

**« L'absence de réaction vaut accord » ne se généralise pas.** C'est la
correction qui a modifié le plan. Le silence peut valider un état de
FONCTIONNEMENT de l'assistant (je surveille, je ne montre plus, je regroupe) ;
il ne doit JAMAIS fabriquer un état du MONDE (facture payée, document reçu).
« Ton produit donne l'exemple parfait avec "C'est réglé" qui signifie en réalité
"mail lu" : c'est une confusion entre interaction UI et état du monde. »

**Le piège de sa demande.** Trois niveaux : prédire son comportement (utile pour
l'attention, mais reproduit ses mauvaises habitudes) · recommander une action
(**ce qu'il demande réellement**) · décider ce qui est bon pour lui (danger : le
produit fabrique une fonction d'utilité qu'il ne connaît pas). « Il ne dispose
pas de vingt ans d'historique des OBJECTIFS de l'utilisateur, mais de vingt ans
de traces de COMPORTEMENT. » D'où la hiérarchie retenue : paternaliste sur
l'attention, affirmatif sur la recommandation, humble sur les décisions
conséquentes.

### Livré

**1. La table `Declaration`** — un fait déclaré, horodaté, jamais inféré. Elle
se branche sur une porte qui existait déjà dans `semantique.ts:701` (« MANUEL —
l'utilisateur a tranché ou agi. Sa vérité prime ») et ferme l'action sur son
`kind` EXACT. Réversible : un mail qui contredit reprend le dessus. Éprouvé :
une déclaration fait disparaître la facture de `generateToday()`, son annulation
la fait revenir.

**2. Le renversement des cartes.** Les quatre questions deviennent des annonces,
chacune portant son `undo`. Le bandeau a enfin son bouton.

**3. Le silence auditable** — `80 488 mails suivis · 82 dossiers ouverts ·
79 peuvent attendre · 3 aujourd'hui`. La contrepartie d'un écran qui décide
seul : « un système bavard et mauvais énerve, un système silencieux et mauvais
cache des problèmes ». L'accroche devient « Voici ce dont je m'occuperais
aujourd'hui ».

**4. Quatre écrans retirés du menu**, badge compris. Les CAPACITÉS restent
(routes accessibles par URL) : seule la console permanente disparaît.

**5. La télémétrie.** `npm run charge` — mesuré : 12 reçus, 1 demandée, **8,3
pour 100 mails**, 8 autonomes, 1 annulation. Le KPI était écrit depuis le 10/08
et n'avait jamais été mesuré. Il ne se lit JAMAIS seul : « le meilleur produit
du monde selon cette métrique serait celui qui ne montre rien ».

`OperationEntry.decision` est un CHAMP explicite, pas le préfixe `ui_` : une
métrique fondée sur un nom se dégrade en silence au prochain outil ajouté. Piège
vérifié — un champ `decision` existait déjà dans le journal avec les valeurs
`seen`/`trash` (le `reviewDecision` du dépouillement, imbriqué dans `params`).

### Deux incidents, deux leçons

**Le nom d'un dossier de migration est son identité.** J'ai appliqué
`assertionNote` sous un nom provisoire puis commité sous son nom horodaté : au
redémarrage, `duplicate column name`, **health 502**. Réparé par
`prisma migrate resolve --applied`. La règle est dans `CLAUDE.md`.

**Ce qui n'est pas commité ne survit pas à la nuit.** Le timer
`boxmail-update.timer` a tourné à 04:04 UTC et restauré tous les fichiers
déployés par `scp` — les boutons étaient revenus à l'ancien libellé sans que
rien ne le signale. Une demi-heure perdue à en chercher la cause. Livrer par
git, toujours.

### Reste du chantier

Volontairement hors de cette livraison, et à faire **après** avoir mesuré que la
charge baisse : le modèle comportemental · les états dormante / surveillée /
candidate avec réveil sur ÉVÉNEMENT · la fusion de `#/suivi` et « Aujourd'hui »
(contrats incompatibles : l'un reçoit `actions[]` du serveur, l'autre les calcule
côté client) · le **contre-audit des NON-MONTRÉS**, qui est la seule mesure des
faux négatifs — « auditer les cartes montrées mesure la précision, jamais ce que
l'assistant a enterré ».

## 26/08 (54) — Le suivi des affaires se met à jour tout seul

Suite directe du § 53. Les 14 attentes affichées sur `#/suivi` avaient été
établies À LA MAIN : un modèle avait relu 50 histoires hors du serveur, sur des
dossiers compacts préparés pour l'occasion. C'était juste — et complètement
figé. Cette session a corrigé les erreurs de raisonnement que cette relecture
avait révélées, puis a automatisé le geste lui-même.

### Les quatre défauts, tirés de la relecture des 50 histoires

1. **Le sens de l'argent.** Un montant valait 20 points sans qu'on regarde QUI
   facture — ses propres factures émises remontaient donc comme des dettes
   (Club Med, 222 950 €). `mesEntites()` reconnaît désormais ses sociétés ; un
   montant qu'il a émis vaut 5 points au lieu de 20.
2. **Le silence ne prouve rien hors d'une demande d'argent.** « Le créancier
   qui se tait a été payé » est vrai d'une facture, faux d'une signature : le
   demandeur classe et attend. La convention d'honoraires de son avocate
   dormait depuis 19 mois et la règle la déclarait réglée — alors que son
   action contre le maître d'œuvre n'avait jamais démarré. Règle restreinte
   aux demandes de paiement, dans `anomalies.ts` ET `obligations.ts`.
3. **Quatre correspondants ne font pas une histoire.** Le fil se replie sur le
   sujet normalisé quand l'en-tête RFC manque, agrégeant des inconnus sous un
   même « Re: ». Au-delà de 3 correspondants distincts : −35 points.
4. **Une relance a une direction.** « INFO RELANCE TIERS » de son assurance
   protection juridique dit qu'ELLE a relancé la partie adverse. Veto placé
   avant tout autre test d'escalade.

Mesuré : **183 → 305 fils**. La hausse est le point 2, qui cesse d'enterrer ce
qu'il enterrait à tort. Aucun Airbnb ni Trustpilot dans le haut du classement.

**Piège évité de justesse** : le slug de compte était découpé, et « Au-marais »
devenait « au », « Location_Brest » devenait « location ». Tout émetteur
contenant ces syllabes — Renault, une location saisonnière — passait pour l'une
de ses sociétés, **inversant le sens de ses dettes**. Le slug reste entier.

**Relevé** : seuls 650 messages portent un montant, la direction ne joue donc
que sur ceux-là. `EntityMention.role='issued_by'` en couvrirait 20 % de plus
(5 847 contre 4 846) — à brancher si le besoin s'en fait sentir.

### La boucle : détecteur → lecture → attentes

Le détecteur signale 305 fils en SQL, sans IA et sans rien coûter. Mais il ne
sait pas lire, et sur les deux premiers dossiers relus il se trompait **une
fois sur deux** :

- fil 4136, score **213** — « échéance dépassée depuis 982 jours ». En réalité
  il a répondu le 2 janvier 2024, réglé 2 000 € et conditionné le solde à
  l'achèvement du lot (cloisons non démolies, portes non terminées). Vrai
  sujet, mais pas celui que le score annonçait.
- fil 16550, score **209** — « 5 messages reçus, aucune réponse ». Factures de
  recharge électrique de 2 à 14 €, **prélevées automatiquement sur PayPal**.
  Rien à faire.

D'où deux étages, sur le patron éprouvé du rattrapage d'analyse : un vivier
servi par lots, un agent qui LIT sur le forfait de l'utilisateur, des verdicts
renvoyés. Aucune clé API côté serveur.

| Élément | Rôle |
|---|---|
| `services/qualification.ts` | compose le dossier compact, enregistre les verdicts |
| `mcp/tools/qualification.ts` | `next_dossiers_batch` · `submit_dossiers_batch` · `qualification_progress` |
| `cli/dossiers.ts` (`npm run dossiers`) | voir ce qui serait servi, sans rien consommer |
| table `Qualification` | trace de lecture (additive) |

**Le dossier compact** porte le début et la fin de l'histoire (3 + 4 messages),
les extraits, les obligations déjà extraites et la raison mécanique du
signalement. Mesuré : **3,2 Ko par dossier**, ~26 Ko pour un lot de 8 — le même
ordre que le lot d'analyse. Un fil de 40 messages n'est jamais envoyé en entier.

**La table mémorise jusqu'à quel message on a lu.** Un fil qualifié ne revient
que si un message y arrive ensuite : c'est ce qui vide le vivier, et ce qui
permettra de dire « c'est le 3e rappel » plutôt que de rejuger à zéro.

**Garde-fous** : une attente déjà traitée n'est jamais écrasée (son geste prime
sur une relecture automatique) ; idempotent par `threadId` ; aucune suppression,
aucun envoi ; les attentes produites portent `source='mecanique'`, distinctes
des 14 de l'audit.

Éprouvé sur la production : 2 dossiers qualifiés, 1 attente créée, 0 rejet,
vivier passé de 305 à 303, les fils lus ne reviennent plus.

### La tâche planifiée

`trig_01SnQhTSebN3VnzLBx7dw9NS` — **tous les jours à 06:43 UTC**, jumelle du
cowork d'analyse (`trig_01SLhekXbwP85yQTnP32Aaof`, :17 chaque heure) : même
architecture à sous-agents (un dossier pèse 3 Ko, une conversation meurt vers
30), liste blanche stricte de 4 tools, coupure à 40 minutes.

Son prompt porte les quatre règles ci-dessus comme consignes de lecture, et
s'ouvre sur l'avertissement qui compte : *le score du détecteur n'est pas un
verdict, il se trompe une fois sur deux — lis avant de conclure.*

Pas de conflit avec le cowork malgré leur chevauchement : les deux passent par
le même processus serveur, donc la même connexion SQLite. Le « database is
locked » rencontré pendant la migration venait d'un CLI **séparé** (le
rattrapage des extraits de jojo56), coupé puis relancé — il reprend où il en
était.

### Ce que la première vague a révélé

**Sept doublons sur 26 attentes.** L'idempotence portait sur `threadId`, or les
14 attentes de l'audit n'en ont pas : la boucle les a recréées. Le rapprochement
exige désormais trois signaux concordants — même compte, même côté, un mot
distinctif commun sur le correspondant ET deux sur l'objet, *ou* la même
échéance. Ce dernier critère a été ajouté sur le doublon qu'il ne fallait pas
manquer : les **deux seules urgences critiques de l'écran étaient la même dette
URSSAF**, et elles ne partagent que le mot « urssaf ». Garde-fou vérifié sur
données réelles : les deux attentes Comptastar (le bilan 2025, le juriste pour
l'AG) partagent « comptastar » et « econom » et restent bien séparées.
`npm run attentes:dedoublonner` rejoue la règle sur l'existant.

En rapprochant, l'urgence, l'importance et le risque prennent **le maximum des
deux** : mesuré dans les deux sens — l'audit voyait Zanitti « haute » quand la
relecture disait « faible », et l'inverse sur Comptastar.

**La rubrique « urgences » débordait.** Sa règle était `urgence === 'critique'
|| !!risque` — tenable tant que `risque` restait rare et écrit à la main.
Produit en série, il a fait remonter **11 urgences sur 19**, dont une
« faible/faible » (un contrat de travail de 2022). Or c'est la seule rubrique
qui échappe au budget d'attention : la noyer supprime la notion même d'urgence.
Un risque n'élève désormais que ce qui était déjà jugé « haute ». Résultat
mesuré : 6 urgences, toutes légitimes ; l'écran affiche 12 cartes, 4 en réserve.

**La tâche s'arrêtait trop tôt.** Première exécution : arrêt après deux
sous-agents — 48 dossiers, exactement 2 × 24, le plafond d'un sous-agent —
alors qu'il restait 257 dossiers et 35 minutes. Six jours de rattrapage au lieu
d'un et demi. Il manquait la phrase que le cowork d'analyse martèle :
« N'ARRÊTE JAMAIS LA BOUCLE AVANT LA LIMITE DE TEMPS tant que les sous-agents
rapportent etat=ok ».

### Reste à faire

- **Vérifier l'écran au navigateur** : les corrections de classement ont été
  mesurées par le service qui l'alimente, pas par un clic.
- **Mesurer la boucle sur la suite du stock** (258 dossiers restants) :
  proportion d'attentes réelles, et surtout la qualité des `pourquoi` affichés.
- L'écran `#/suivi` n'a pas été retouché : il affiche les attentes quelle que
  soit leur source. À revoir quand le volume aura augmenté (le budget
  d'attention est à 7 ordinaires par jour).
- Étape 5 du MVP — la mémoire condensée de l'affaire — reste à faire.

## 26/08 (53) — La moitié muette : 8 248 mails envoyés sans un mot de contenu

Parti d'une demande de synthèse (le dossier Legalfree, 14 mois, 2 478,68 € versés),
la session a mis au jour un trou structurel et l'a comblé.

**Le déclencheur.** Reconstituer le dossier a exigé d'ouvrir les mails un par un
en IMAP. Motif : `backfillSnippets` portait `isOutbound: false` EN DUR — les
8 248 mails envoyés n'avaient donc aucun extrait, soit 100 %. Or la moitié d'une
conversation est ce que l'utilisateur a lui-même demandé, promis ou contesté :
ses trois questions du 5 novembre (capital à 100 000 €, comptes courants,
groupement des formalités) étaient introuvables, comme sa relance du 18 novembre
(« C'est fou quand même de ne jamais avoir de retour à mes nombreux mails »).

**Le second trou, plus grave.** `SNIPPET_WINDOW_DAYS = 90` : le rattrapage qui
suit chaque sync ne lit que les 90 derniers jours, 150 mails à la fois. Une boîte
fraîchement enrôlée restait donc muette sur tout son passé, SANS QUE RIEN NE LE
SIGNALE. Mesuré sur les 4 boîtes ajoutées le 25/08 : jojo56 exposait 1 167 de ses
46 543 mails (2,5 %), techni-soft 26 sur 4 750. Conséquence concrète : un reçu de
**1 347,42 €** invisible dans un dossier en cours — le total « payé » qu'on
croyait exact (1 131,26 €) était faux de plus de moitié.

**Et le moteur d'analyse tournait à vide en le croyant fini** : 20 468 mails jugés
sur 20 469 « analysables »… mais 71 298 reçus au total. `candidateWhere` exige
`snippet != null` : un mail sans texte n'est pas en attente, il est INVISIBLE.
Le cowork ne dure que 4 minutes parce qu'il n'a rien à juger, pas parce qu'il
échoue. Ses 6 tools ne peuvent pas fabriquer d'extraits — le maillon manquait
côté serveur, pas côté prompt.

**Livré** : option `outbound` sur `backfillSnippets` ('exclude' par défaut, donc
rien ne change ailleurs ; le vivier d'analyse reste sur les entrants) · CLI
reprenable `npm run snippets -- --sent|--tout [-a Boîte]` · le post-sync capture
désormais les envoyés (sinon le trou se recreuse à chaque mail écrit) ·
`demarrerRattrapageHistorique` déclenché à la PREMIÈRE arrivée d'un compte
(un ré-enrôlement ne relance rien ; le refresh de token ne passe pas par là).

**Résultat mesuré** : 18 471 extraits capturés en trois passes (1 425 mails en
14,6 min, 6 789 en 80,4 min, 10 886 en 55,3 min — ~200 mails/min). **11 boîtes
sur 12 à 100 %**, dont thony56_gtr (15 866) et techni-soft (0,5 % → 100 %).
jojo56 et ses 49 044 mails tournent encore.

**Cowork** : plafond de 4 sous-agents remplacé par une boucle bornée au TEMPS —
relevé `date +%s`, enchaînement sans limite de nombre tant que « etat=ok »,
coupure impérative à 3 000 s pour ne pas chevaucher le passage de H+17.

**Écran « 💶 Où est passé mon argent »** — et deux erreurs de conception rattrapées
par la mesure, comme le veut la règle maison :

1. *« Les montants ne sont pas une donnée »* : FAUX. `VerdictDocument` en
   contenait déjà 4 923, dont 2 593 chiffrés. Le manque était l'affichage.
2. *Un tableau de bord financier global* : impossible. Vérifié pièce par pièce,
   le haut du classement contient des annonces immobilières (château à
   2 680 000 €), des budgets de copropriété (756 605,61 € Foncia), des pesos
   chiliens (928 054 CLP — la devise EST renseignée, c'était l'agrégat qui
   fautait) et une erreur de lecture (1 654 320 extrait « 654 320 »). D'où le
   parti pris : PAR TIERS, pièce par pièce, groupé par devise, jamais de total
   de portefeuille.
3. *La complétude* : première version muette là où il fallait parler — elle ne
   regardait que les boîtes ayant rendu une pièce, donc pas jojo56 lue à 6 %,
   précisément parce qu'une boîte aveugle ne rend rien. C'était le piège
   Legalfree reproduit. Corrigée : elle porte sur toutes les boîtes et affiche
   « lecture INCOMPLÈTE : 44 176 mails ne sont pas encore lus ».

**Deux pièges de test à retenir.** (a) Ma sonde de session cherchait
`input[type="password"]` : or `#login-view` reste dans le DOM une fois connecté,
seulement masqué — le test a donc affirmé « pas connecté » pendant 18 minutes
alors qu'Anthony l'était. Tester la VISIBILITÉ de `#app-view`, pas la présence
d'un nœud. (b) L'erreur console `blocked://files.stripe.com` n'est pas un défaut :
c'est le bloqueur de mouchards qui fonctionne. Isolée par un test dédié —
0 erreur au chargement, 0 après recherche, 1 seule après ouverture du lecteur.

**Son retour** : « c'est une bonne ébauche ». Limites identifiées (à confirmer
avec lui) : l'écran ne montre que les pièces CHIFFRÉES — 5 lignes sur les 61
mails du dossier Legalfree, donc sans les mails qui font le récit ; la
chronologie ne signale pas les silences (6 mois entre février et août) ; et un
tiers n'est pas un dossier — l'opération ECONOM/BRIMMO/ALTOEN traverse trois
sociétés et trois boîtes.

## 25/08 (52) — Précédent/Suivant, la date dans les cartes, un en-tête qui se tait

Trois demandes, dans la continuité du § 49 — les deux dernières venaient de la
contre-revue, qu'il a lue et validée.

### Précédent / Suivant

Deux règles font tout le travail :

1. **« Suivant » n'est jamais le mail chronologiquement suivant de la base.**
   C'est le voisin dans la SÉRIE d'où l'on a ouvert le lecteur — les cartes de
   la Vue du jour, les résultats de la Recherche, dans l'ordre où ils sont à
   l'écran. Vérifié depuis les deux : « 1 / 3 » sur la Vue du jour, « 1 / 23 »
   sur une recherche.
2. **La série est FIGÉE à l'ouverture.** Marquer un mail réglé ne le fait pas
   disparaître sous les doigts ni renuméroter le « 2 / 3 » — mesuré identique
   avant et après une action. Rien ne bouge sous ses yeux.

Elle se **suspend** dans une branche de contexte (mail ouvert depuis
« Contexte ») : il y a déjà un « ← retour » là-bas, et deux notions
concurrentes de « précédent » seraient illisibles.

### La date dans les cartes

« Au moins sans cliquer dessus je pourrais savoir s'il est récent ou pas. »
Chaque carte porte sa date et son heure. Pour les mails frais, la fraîcheur
passe devant (« il y a 2 h », « hier », « il y a 3 jours »), parce qu'« il y a
3 jours » ne dit pas si c'était un vendredi soir ou un lundi matin — les deux
sont donnés, la date exacte restant en infobulle.

### L'en-tête se tait

Il tient sur **une ligne** : qui écrit, quand, quelle boîte. L'adresse
complète, les destinataires et le dossier partent derrière **« Détails »** —
le dossier d'un mail n'a aucune raison de prendre de la hauteur à chaque
lecture. Mesuré : **42 px au lieu de 59**.

Et les deux menus de correction quittent le flux pour **« Pourquoi ? »**, dans
une section « Me corriger ». L'argument de la contre-revue était juste : ce sont
des outils de **réglage**, pas du contenu de mail — il ne les touche qu'en cas
d'erreur, et ils mangeaient deux lignes à chaque lecture. Vérifié : **0** menu
visible dans le flux, **3** atteignables en un clic.

### Un rebase qui a failli passer inaperçu

Le `git push` a été **rejeté** : dix commits d'autres sessions étaient arrivés
entre-temps (accents, recherche multi-mots, pondération des pièces jointes,
OpenSpec). Le rebase est passé sans conflit — mais **tout a été re-testé**, car
un test passé avant le rebase ne prouve rien sur le code d'après. La recherche
réécrite fonctionne toujours (« facture » → 2 382 mails chez 405
interlocuteurs), et la série y marche.

**À signaler, hors de cette passe** : « facture » met désormais **3,6 s** depuis
la réécriture multi-mots. C'était ~300 ms au § 46. Le chantier appartient à une
autre session ; le chiffre est ici pour qu'il ne se perde pas.

## 24/08 (51) — Le bruit du multi-mots, et la facture qui retrouve son logement

### 1. « Complètement hors sujet »

`facture électricité miron` rendait 54 mails : des PV d'AG, des DPGF, des
décomptes de charges. Régression **introduite par la passe 1** : le contenu
d'une pièce jointe pesait `3` au classement, autant qu'un sujet — or un PV de
copropriété de cinquante pages contient forcément les trois mots quelque part.
Pire, la CONCENTRATION ajoutée la veille pour éviter les mots éparpillés se
retournait contre elle-même : trois mots croisés dans un OCR, c'est le hasard.

Corrigé : `MATCH_CONTENU_PIECE` 3 → 1, et concentration calculée sur les seuls
champs COURTS. Le filtre ne change pas — ces mails restent trouvables par le
contenu de leurs documents, ils cessent de passer devant.

**Et surtout** : le tri par défaut restait « les plus récents », donc le
classement ne jouait pas. Un mot = « montre-moi tout » ; plusieurs mots =
« trouve-moi ça », donc pertinence. Le sélecteur AFFICHE l'ordre appliqué —
basculer en douce aurait été un mensonge.

### 2. Le trou : la facture ne dit pas de quel bien elle parle

Sa remarque : « tu ne pouvais pas le voir car la pièce jointe est à télécharger
à part ». Vérifié sur le mail bellenergie : `attachments: []`, « miron » absent
des 127 000 caractères, et à la place un **PDL 07140955100609**.

Mesure sur trois fournisseurs de SES boîtes :

| | adresse du bien | PDF direct | identifiant |
|---|---|---|---|
| EDF | **oui, dans le mail** | non | n° client 6029414501 |
| la bellenergie | non | **oui**, signé jusqu'en 2031 | PDL 07140955100609 |
| Free Mobile | non | non (espace abonné) | identifiant 56129155 |

Le point commun n'est pas le PDF : c'est l'**identifiant**. Et chez EDF
l'adresse est à 712 caractères du début, donc **déjà dans `analysisInput`**.
Son idée de télécharger une fois par identifiant inconnu reste juste, mais elle
n'est pas la première marche — beaucoup de fournisseurs disent déjà tout.

### 3. ÉTAPE 1 livrée — `liaisons.ts`

Deux temps, zéro requête sortante : un mail qui donne adresse **et** identifiant
apprend le lien ; tout mail suivant portant cet identifiant rejoint le logement
sans nommer d'adresse. `resoudre()` faisait déjà ce travail, on ne fait que le
nourrir — sur tous les mails, analysés ou non.

**Exiger un libellé** (« Adresse du logement : ») n'est pas une précaution
excessive : le pied de page de Free porte « Siège social : 16, rue de la Ville
l'Evêque ». Sans cette règle, chaque expéditeur deviendrait un « bien ». Idem
pour les identifiants : jamais un nombre isolé, et un identifiant seul ne crée
jamais de dossier — il ne fait qu'en rejoindre un.

**Automatique pour les mails entrants**, sa demande expresse : branché dans le
job des extraits, par où passe tout mail dont le texte devient disponible. Une
capacité « Quoi de neuf » rattrape l'existant au premier démarrage.

**Dernier chaînon** : la recherche ne regardait pas les dossiers rattachés,
seulement les contextes de l'IA — le rattachement existait en base et ne servait
à rien. `Dossier` et `DossierAlias` rejoignent la CTE « dossier cité ».

Mesuré sur 41 000 mails : la recherche est **plus rapide** qu'avant (pire cas
955 → 422 ms). Bancs : 13 cas recherche, 5 cas liaisons sur les vrais textes
(dont les deux pièges), 1 épreuve de bout en bout.

### 4. Ce qui reste

- **Étape 2** : rattachement par expéditeur quand aucun identifiant n'accroche.
- **Étape 3** : télécharger le PDF (cas bellenergie) — lien signé direct
  vérifié, garde-fous définis (`.pdf` uniquement, pas de cookie, type vérifié,
  journalisé), à ne faire que si les étapes 1-2 laissent un trou réel.
- **Mesure de couverture** : trois fournisseurs ne font pas une statistique. Un
  recensement sur les 858 factures dirait la proportion réelle.


## 23/08 (50) — « Pourquoi une recherche aussi simple ne me retourne rien ? »

Capture à l'appui : `facture électricité miron` → « Je n'ai rien trouvé ».

### 1. La cause : la phrase était cherchée d'un bloc

`search.ts:182` transformait tout ce qu'il tapait en **un seul motif** :
`LIKE '%facture électricité miron%'`. Pas trois mots — une chaîne de 25
caractères, espaces compris, cherchée telle quelle. Aucun mail réel ne
s'intitule ainsi. Le défaut valait pour **toute** recherche de plus d'un mot,
depuis toujours.

Prouvé sur une base SQLite jetable rejouant la requête du serveur. Trois
défauts distincts sont sortis du même test :

| Test | Résultat |
|---|---|
| `%facture électricité miron%` | seul un mail intitulé littéralement ainsi |
| `%électricité%` vs `%electricite%` | ensembles **disjoints** |
| `%électricité%` sur « **É**lectricité » | **rien** — `LIKE` ne replie que l'ASCII |

Le troisième n'était pas connu : la casse des lettres accentuées.

### 2. Conception challengée avec Codex (OpenAI), à sa demande

Le pilote ChatGPT de l'autre poste n'existe pas sur ce PC (comme la clé
`ssh boxmail` : ce n'est pas la machine du CLAUDE.md). Passé par le MCP Codex.

Convergence sur l'essentiel, et trois apports que je n'avais pas :
- **le repli** quand rien ne sort, sinon on remplace « 0 résultat à tort » par
  « 0 résultat parce qu'un mot périphérique manquait » ;
- **les mots courts qui comptent** : une règle « ignorer ≤ 2 lettres » tuerait
  `RH`, `TV`, `RIB`, `T2`, `M2` — liste blanche obligatoire ;
- **le score peut mentir** : trois mots dans trois champs sans rapport ont l'air
  d'un excellent résultat. Défaut *créé* par le multi-mots, à corriger avec lui.

Il a aussi écarté ma piste du dépliage d'accents à la volée. La mesure lui a
donné raison (§ 4). FTS5 écarté des deux côtés : changerait la sémantique
(« RIB » ne trouverait plus « Ribéroux ») et exigerait un index reconstruit.

### 3. PASSE 1 — la recherche cherche des mots

Cinq changements indissociables : découpage en mots (`termes.ts`) ; mots creux
écartés mais mots courts protégés ; **`analysisInput` ouvert à la recherche**
(2 200 caractères de corps au lieu des 500 de `snippet`, déjà en base, absent
sur les 6 246 envoyés — le plus gros gain du lot pour zéro rattrapage) ; repli
qui NOMME le mot introuvable ; concentration (mots réunis dans un même champ)
dans le score.

L'écran dit ce qu'il a compris — « Je cherche : facture · électricité · miron »
— et ce qu'il a relâché. Découper en silence serait pire que ne pas découper.

SQL engendré pour N mots, sans sous-requête corrélée, 11 paramètres au plus.

### 4. PASSE 2 — les accents, décidés SUR MESURE

Trois conceptions mesurées sur 41 000 mails synthétiques aux dimensions réelles
(corps de 2 200 caractères, OCR sur 20 %, base de 248 Mo) :

| Conception | Base | Recherche |
|---|---|---|
| déplier à chaque requête | — | 543 ms → **13 511 ms** (25×) |
| recopier le corps déplié | +71 % | **doublée** |
| **champs courts + entités** | **+6 %** | **+15 %** |

La deuxième était mon intention de départ. La borne à 3 000 caractères que
j'avais ajoutée pour la sauver n'a presque rien rendu : dans un corpus réel la
plupart des mails tiennent déjà sous cette taille — **le coût venait de la
duplication du corps**, pas des documents scannés.

Retenu : sujet, expéditeur, noms de pièces, résumé, **entités et dossiers lus
par l'analyse**. C'est là que vivent les noms accentués qui servent à retrouver
(« République », « Nîmes »). Le corps reste cherché en entier, mais à l'accent
près — limite assumée, écrite dans `accents.ts`, et **mesurée par le banc**.

Colonnes tenues par des **déclencheurs SQLite**, pas par du TypeScript : plus
de dix fichiers écrivent ces textes, un oubli ferait mentir la colonne en
silence. Vérifié à l'insertion et à la mise à jour. Le SQL des déclencheurs est
**engendré** depuis la liste d'accents (`scripts/gen-migration-accents.mjs`) :
écrit à la main il aurait divergé de celle qui déplie la requête, et une
divergence là ne casse rien bruyamment — elle fait manquer des mails.

Remplissage de l'existant : **5,2 s** au premier démarrage.

### 5. `npm run banc:search`

Rejoue des recherches et rapproche les paires accentuées : deux orthographes du
même mot doivent rendre le même nombre de mails. Il signale déjà l'écart
résiduel du corps (« electricite » 3 / « électricité » 4). À lancer **sur le
serveur** — en local, six mails de test et tout paraît parfait.

### 6. Ce qui reste ouvert

- **La boîte `location-miron` n'est pas enrôlée** (8 boîtes vérifiées via le
  MCP ; « miron » absent des INBOX `Location_Brest` et `Brimmo`). Aucun
  correctif de recherche ne fera apparaître des mails absents de la base.
- **L'écart accentué dans le corps** : à trancher avec lui une fois le banc
  passé sur le serveur, avec le coût chiffré ci-dessus.
- **Passe 3 non faite** (il a demandé les passes 1 et 2) : la couche
  « phrase » — dates, présence de pièce jointe, types de documents devenant des
  filtres visibles et retirables.


## 20/08 (49) — « L'affichage complet des emails est à reprendre »

Son message, en trois griefs : le mail s'ouvre **par-dessus** la liste (« je ne
peux pas passer d'un mail à l'autre sans fermer puis rouvrir ») ; le bouton
« C'est réglé » **disparaît** quand on ouvre le mail ; la barre devrait
**refléter ce qu'on attend de lui**, pas offrir neuf boutons identiques.

### 1. Le mail s'ouvre à CÔTÉ de la liste

Le remède existait déjà dans le produit : la lecture **ancrée en colonne**, en
service sur la Boîte de réception, « À traiter » et la Revue. Elle n'était
simplement pas branchée sur les deux écrans d'où il travaille le plus — la Vue
du jour et la Recherche. Une fonction manquante ? Non : un branchement manquant.

Vérifié en rejouant SON geste : ouvrir un mail, puis cliquer directement le
suivant sans fermer. Vue du jour « URSSAF » → « igloohome » ; Recherche, ligne
0 → 1. Les cartes et leurs boutons restent cliquables à gauche pendant la
lecture.

**Bug de fond trouvé en testant, antérieur au changement** : deux rendus
concurrents de la Vue du jour (retour arrière, double clic, rendu initial suivi
d'un `hashchange`) posaient chacun leurs écouteurs sur le même écran. Un clic
« Voir le mail » ouvrait alors **deux** lecteurs et l'écran retombait fermé une
fois sur deux — mesuré : 2 lectures déclenchées par clic. Un jeton de rendu fait
abandonner les rendus périmés. Au passage, `closeReader` ne refermait que la
PREMIÈRE colonne de la page ; il y en a maintenant plusieurs.

### 2. La barre dit ce qu'on attend de lui

C'est le grief le plus juste, et ChatGPT l'a formulé mieux que moi :
**« Boxmail oublie sa propre conclusion au moment précis où Anthony ouvre la
preuve. »** La Vue du jour annonce « ce mail attend un paiement » ; on ouvre le
mail, et il n'y a plus que Répondre / Transférer / Tâche / Comptabilité…

Rien à inventer : le verdict couvre **19 133 des 20 005 mails de la boîte de
réception (96 %)** et sait, pour chacun, ce qui est attendu **et de qui**. Sur
ses non lus : review 349 · reply 225 · other 178 · provide_document 121 ·
confirm 95 · **pay 79** · book 35 · sign 18. Tout cela dormait en base.

Livré : un bandeau en français au-dessus des boutons (« Payer 418 € · avant le
29 août »), un « pourquoi ? » qui montre la citation qui le justifie, et **deux
boutons contextuels au maximum**. Les neuf commandes d'origine passent sous
**« Toutes les actions »** — un endroit qui, lui, ne bouge jamais : la barre est
contextuelle, le menu est la mémoire musculaire.

Garde-fous : le filtre `actor = 'user'` (sans lui, « maman transmet une facture
Sosh » deviendrait « payer maman ») ; « À vérifier » au lieu de « À faire »
quand la confiance est faible — on n'enlève pas le bouton, on annonce la
couleur ; les 4 % sans verdict gardent la barre habituelle, **pas de « C'est
réglé » inventé**. Et un bouton « ✓ Paiement fait » ne prétend pas payer : il
note que c'est fait, comme le « C'est réglé » des cartes. Seul « Répondre »
exécute vraiment.

Vérifié sur un VRAI mail (avis Urssaf) : bandeau, bouton « ✓ Vérifié », menu
replié contenant les 7 autres commandes, et après clic le mail **reste à
l'écran** avec son corps NON reconstruit (témoin posé sur l'iframe, retrouvé
après l'action).

**Défaut vu à la capture, pas par les tests** : en colonne ancrée sur la
Recherche, la barre d'actions tombait **222 px sous le bord de l'écran** — le
lecteur fait une pleine hauteur mais démarrait à 247 px. La colonne se cale
maintenant en haut à l'ouverture (elle était déjà `sticky`) : barre à 937 px
sur 950.

### Le pilote ChatGPT réparé — trois consultations perdues avant

Trois lancements d'affilée ont rapporté **9 caractères** : le driver prenait le
bloc **« Réflexion »** des modèles qui raisonnent pour la réponse finale (texte
stable → il concluait au bout de 6 s), puis déclarait la génération **avortée à
180 s** alors qu'elle travaillait encore. Deux correctifs dans
`~/.claude/tools/chatgpt/driver.mjs` : ignorer ce libellé pour la détection de
fin, et allonger la patience à 300/480 s. La réponse suivante faisait 19 231
caractères.

**Incident à noter** : entre-temps, le driver a lu une conversation personnelle
d'Anthony (« Vérifier un montage immobilier ») au lieu de notre fil. Vérifié en
cherchant une phrase propre à notre message : **elle n'y est pas — rien n'a été
écrit chez lui**. Cause probable, de son propre aveu : Chrome proposait de
rouvrir les sessions précédentes. Une fenêtre restée ouverte par les tests a été
fermée après avoir vérifié qu'elle n'affichait qu'`about:blank`.

**Reste de la contre-revue, non livré** : Précédent/Suivant dans le lecteur
(série figée à l'ouverture, jamais recalculée après une action), et la
restructuration du chrome (métadonnées repliées derrière « Détails », menus de
correction déplacés dans « Pourquoi Boxmail me montre ça ? »). ChatGPT
recommandait cet ordre, et la barre d'actions passait en premier.

## 19-20/08 (48) — Rendre la hauteur au mail, réunir les Volotea, et le seuil qui ne protégeait de rien

Trois retours d'affilée, tous réglés en mesurant avant de coder.

### « En agrandissant on ne voit rien de plus si le mail est dans la hauteur »

Il avait raison, et c'était embarrassant : le bouton livré le matin élargissait
sans rien rendre. Son idée était la bonne — « profiter de cet espace en largeur
pour réduire les bandeaux haut et bas ». Ce qui était EMPILÉ passe donc côte à
côte : les métadonnées tiennent sur une ligne au lieu de trois, « Classé » et
« Expéditeur » se placent l'un à côté de l'autre. **Rien n'est masqué.**

Mesuré sur une copie de sa base (fenêtre 1500×950) : bandeaux **349 → 199 px**,
hauteur de mail **601 → 751 px, soit +25 %**.

**Détail qui a coûté une capture** : les bandeaux étaient d'abord bridés à une
colonne de 1 100 px — par souci d'alignement, hérité de la passe précédente.
Ils retombaient donc sur trois lignes et le gain n'était que de 19 %. En leur
rendant toute la largeur (ce qu'il demandait, mot pour mot), on passe à 25 %.
La cohérence de colonne ne valait pas la hauteur qu'elle mangeait.

### « Très bizarre d'avoir 2 expéditeurs alors que les 2 viennent du domaine volotea »

Une société parle par plusieurs portes : Volotea écrit depuis `volotea.com` ET
depuis `voloteahelp.zendesk.com` (son guichet de support). Le domaine racine ne
suffisait pas.

**Trois simulations sur les 1 819 interlocuteurs réels avant d'écrire une
ligne** — et les deux premières étaient à jeter :

1. **Fusionner sur le nom affiché** : 107 collisions, dont « Équipe des comptes
   Microsoft » qui aurait réuni `microsoft.com` avec `daum.net` (usurpation),
   « Comptastar » trois sociétés différentes, « Mail Delivery System » trois
   serveurs, « fr » un fournisseur de propreté avec Bosch. **Écarté.**
2. **Nom entier + garde « le nom se lit dans le domaine »** : 48 réunions,
   toutes correctes — mais « Air France pour ANTHONY LE BERRE » et « Airbnb
   Photo Team » restaient à part, alors que leurs domaines
   (`service-airfrance.com`, `photography.airbnb.com`) disent qui écrit.
3. **Plus long DÉBUT du nom confirmé par le domaine** : 73 réunions… dont
   **4 fausses sur des personnes** — « Philippe Cottet » réuni à « philippe
   jacquot », « Mélanie Baltazar » à « Melanie Duran », parce que l'adresse
   inverse prénom et nom et que seul le prénom survivait.

**Règle finale** = 3 + une seconde garde : pour une personne physique, le nom
**entier** est exigé. Résultat : **64 réunions, 90 clés absorbées, relues une
par une, zéro faux positif.** Volotea passe de 2 cartes à 1, Air France de 4 à
1 (111 mails), IKEA de 3 à 1, Leroy Merlin 615. Bonus : Daniel HELAOUET
retrouve ses trois adresses (free, orange, yahoo) dans une seule carte.

Ce qui reste séparé l'est **à raison** : « Airbnb » depuis `express.medallia`
(le prestataire de questionnaires, qui écrit aussi pour d'autres marques),
« Air France Info Vol » depuis `connect-passengers`. Ces cartes portent
désormais **« via &lt;domaine&gt; »** — on n'invente pas un rapprochement faux, on
dit pourquoi il y en a deux.

### « Charger les images aussi si moins de 300 k, c'est rapide »

**Le seuil ne peut pas fonctionner**, et ce n'est pas une opinion : on ne
connaît le poids d'une image qu'APRÈS l'avoir téléchargée, et ce
téléchargement est exactement ce qui signale la lecture. Pire, le pixel espion
pèse moins d'un kilo-octet : « charger sous 300 Ko » chargerait **tous** les
traceurs et n'écarterait que les grandes photos — l'inverse de son intention.

Lu 18 de ses vrais mails HTML pour en avoir le cœur net : **17 portent des
images distantes** (jusqu'à 56 dans un seul), **0 porte une image embarquée
(cid)**. Il n'y avait donc même pas de catégorie « sans risque » à débloquer
d'office, comme je l'espérais d'abord.

Le besoin derrière la demande, c'est « arrête de me faire cliquer » — et c'est
un choix qui lui appartient. La barre de blocage reçoit un second bouton
**« Toujours les afficher »**, réversible depuis Réglages › Compréhension des
mails. Un clic, une fois, comme dans Outlook.

Vérifié en **interceptant la réponse de lecture** (le corps ne se charge pas en
dev, faute de compte IMAP local), avec surveillance des requêtes sortantes : au
premier contact, 2 images neutralisées et **aucune requête ne sort** ; au clic
« Afficher les images », **2 requêtes partent dont le pixel espion**. La
démonstration du risque est faite, pas supposée.

### « On peut bloquer le pixel espion, non ? juste celui-là ? »

Sa relance, et elle vaut bien mieux que le seuil. **Oui** : un mouchard se
DÉCLARE — il est en 1×1, ou masqué (`display:none`), ou son adresse dit ce
qu'elle fait (`/open`, `blank.gif`, `/s/eo/` chez les routeurs, « eo » pour
*email open*). On le repère donc **sans le télécharger**, ce qui est tout
l'enjeu : le poids, lui, n'était connaissable qu'après.

Désormais, **même quand il choisit de voir les images, les mouchards restent
dehors**. Mesuré sur 286 images distantes de 25 de ses mails : **37 retirées
(13 %), 249 gardées**, liste des 37 relue une par une — aucune vraie image
dedans.

**Un critère jeté en cours de route, et c'est le plus instructif** :
« hébergé chez un routeur d'emailing » (sendgrid, iterable, mailchimp…)
attrapait **120 images** — dont les icônes Facebook, Instagram et TikTok
servies par `library.iterable.com`. Un CDN d'emailing héberge aussi les vraies
images : **l'hébergeur ne dit rien de l'intention**. Les motifs retenus sont
donc étroits — on ne devine pas, on ne retient que l'aveu.

Éprouvé sur un mail portant 4 vraies images et 4 mouchards (un par mode de
détection), requêtes sortantes surveillées : **4/4 vraies images demandées,
0/4 mouchard**, icône du routeur bien conservée.

**Ce que ça ne fait PAS**, et c'est écrit dans les Réglages : **47 images
normales sur 286 portent un identifiant unique** dans leur adresse. Charger le
logo suffit alors à signaler la lecture. Retirer le mouchard enlève le
mouchard, pas tout le pistage — mieux vaut le dire que le laisser croire.

Défaut vu à la capture, pas par le test : un mouchard déclarant 30×30 laissait
une image cassée au milieu du mail. Il est maintenant sorti du flux, pas
seulement privé de son adresse.

## 19/08 (47) — Lire un mail en grand, sans en faire un troisième lecteur

**Sa demande**, capture d'une confirmation Volotea à l'appui (mail HTML très
graphique, comprimé dans le panneau de 880 px) : « il serait bon d'avoir un
bouton permettant d'avoir la lecture du mail en plein écran. Regarde avec
ChatGPT ce qui serait le mieux à faire. »

**Ce n'est PAS `requestFullscreen()`**, et c'est délibéré : le plein écran du
navigateur confisque la touche Échap, sort du cadre de l'application et
empêcherait les modales du lecteur (Répondre, Transférer, Tâche, Rentila) de
s'ouvrir par-dessus. Une simple classe CSS suffit. D'où le mot **« Agrandir »**
plutôt que « plein écran » : ce n'est pas la même promesse.

**Deux régimes de largeur, une seule commande.** Le texte brut est borné à
82 caractères et centré (mesuré : 824 → 692 px) — étiré sur 1 500 px, l'œil se
perd en revenant à la ligne. Le HTML garde 100 % (mesuré : 1 500 px) : un mail
conçu pour 600 px conserve sa composition, un relevé bancaire gagne enfin ses
colonnes. Anthony n'a pas à savoir ce qui distingue les deux.

**Rien ne disparaît.** Les 7 actions, l'analyse et les pièces jointes restent
en place ; seule l'en-tête devient collante. « C'est mon lecteur habituel, mais
en grand » — pas un troisième mode de lecture. Faire s'évanouir des boutons
qu'il chercherait ensuite serait une faute chez un utilisateur non technique.

**Échap retire un niveau à la fois** : il réduit d'abord, il ferme ensuite. En
grand, il n'y a plus de voile où cliquer à côté ; perdre le mail d'un seul
appui serait brutal. En le câblant, découverte d'un doublon : un gestionnaire
de touches vivait dans `openReader` alors qu'un gestionnaire **global** posé au
démarrage faisait déjà le travail — et comme le premier n'était retiré que s'il
gérait lui-même l'appui, **il s'en accumulait un par mail ouvert**. Le global
gagnait de toute façon (enregistré avant), ce qui a d'abord fait croire que
« réduire d'abord » ne marchait pas. Supprimé.

**L'agrandissement suit la SÉANCE**, pas le disque : il survit au mail suivant,
à la pile de lecture, au retour arrière, et retombe à la fermeture. La largeur
réglée à la poignée est une préférence durable ; la façon de lire ce mail-ci ne
l'est pas. La poignée reste d'ailleurs — son défaut n'était pas d'exister mais
d'être **invisible** (6 px sans aucun repère au repos), d'où le petit trait
central.

**Contre-revue ChatGPT** (`.consult/2026-08-19-lecture-plein-ecran/`, 1 tour —
la réponse suffisait). Son apport décisif, le piège que je n'avais pas vu :
**ne RIEN reconstruire au basculement**. Pas d'`innerHTML`, pas d'iframe
recréée — sinon on lit le milieu d'une réservation, on clique « Agrandir » et
on se retrouve projeté en haut du mail. Vérifié en marquant le nœud de contenu :
il survit, et le défilement reste à 500 px. Corollaire respecté : le lecteur
ancré n'est pas déplacé dans un autre conteneur, il reçoit la classe sur place.

**Vérifications de géométrie** (copie de la base de production, fenêtre 1500) :
lecteur 880 → 1500 px ; colonne ancrée 646×926 → 1500×950 à (0,0) — et aucun
ancêtre de `.inbox-dock` ne porte de `transform`/`filter`/`will-change`/
`contain`, ce qui aurait neutralisé `position: fixed` en silence.

**Deux défauts d'affichage attrapés à la CAPTURE, pas par les tests** — la
règle du 18/08 continue de payer :
1. la barre d'actions restait collée au bord gauche pendant que l'analyse juste
   au-dessus était rentrée de 200 px ;
2. **⛶ (U+26F6)**, le symbole habituel du plein écran, sort en **carré vide** à
   la taille d'un petit bouton sous Windows. Vingt candidats ont été rendus côte
   à côte pour trancher : retenu la paire couleur **↗️ / ↙️**, lisible à toute
   taille et visuellement opposée.

**Limite du banc en local** : le corps des mails ne se charge pas (aucun compte
IMAP en dev — « Compte lb2i inconnu »). Les deux régimes de contenu ont donc
été **injectés** dans le vrai lecteur pour éprouver la géométrie et l'invariant.
Dit ici pour que personne ne relise ces mesures comme un test de bout en bout.

## 19/08 (46) — La recherche : 132 s → 300 ms, et un ordre qu'on choisit

**Son retour**, capture de `/admin/#/search` à l'appui sur le mot « avocat » :
« la recherche est bonne mais **elle est très lente**, et **le tri est fait
n'importe comment** ; ce serait judicieux de les avoir par défaut par ordre de
dernier échange, mais de pouvoir trier par ordre inverse, destinataire, etc. »
Et : « voir avec ChatGPT ce qu'il imagine, construisez ensemble ».

**La lenteur, chronométrée morceau par morceau avant de toucher à quoi que ce
soit** (base de production, 41 607 mails) :

| Morceau | Temps |
|---|---|
| LIKE sujet / snippet / résumé | 35-46 ms |
| LIKE attachmentText (OCR) | 144 ms |
| LIKE verdict.contexts | 17 ms |
| **LIKE verdict.mentions** | **132 763 ms** |
| OR complet (count) | 136 457 ms |

Un seul coupable, et il valait 99,9 % du temps. `EXPLAIN QUERY PLAN` l'a dit :
Prisma traduit `verdict.mentions.some.nameRaw.contains` en sous-requête
**corrélée** — pour CHACUN des 41 607 mails, un `SCAN` des 29 039
`EntityMention` (l'index `(kind, nameRaw)` ne sert à rien pour un `LIKE '%x%'`),
soit ~1,2 milliard de comparaisons. Le même LIKE sur la table **seule** : 6 ms.

**Contre-revue ChatGPT** (`.consult/2026-08-19-recherche/`, 2 tours). Deux
apports qui ont changé la livraison :

1. **Ne pas garder la pré-requête d'ids + `id IN [...]`** que j'envisageais :
   le gros ensemble doit rester DANS SQLite. Vérifié ensuite empiriquement, et
   il avait raison au-delà de son argument : un `IN` de **1 000** valeurs ne
   renvoie pas une erreur, il fait **PANIQUER** le moteur Prisma
   (`PrismaClientRustPanicError`, limite SQLite de 999 paramètres). 999 passe,
   1 000 casse. Le remède naïf aurait introduit un nouveau bug.
2. **Le vrai problème n'était pas le tri mais le `take 400`.** On ne classait
   pas « les interlocuteurs les plus pertinents » mais « les plus pertinents
   **parmi les 400 mails les plus récents** » : un résultat fort de 2019 était
   écarté avant même d'être scoré. Le 400 ne bornait pas l'affichage, il
   bornait l'UNIVERS.

**Ce qui est livré.** Phase A : une requête SQL écrite à la main (CTE non
corrélées) qui rend TOUT le vivier en lignes maigres, avec un `matchMask`
calculé en SQL — obligatoire, puisque la ligne compacte ne porte plus l'OCR et
que « trouvé dans le contenu de la pièce » ne serait plus reconstituable.
Groupement, scoring et tri **globaux**. Phase B : hydratation des seuls mails
montrés. Le `count()` séparé disparaît (il se disputait l'unique connexion) et
le total affiché devient exact.

Mesuré **sur la production** après déploiement : avocat 280 ms, quittance
234 ms, facture 316 ms, république 334 ms, et le pire cas absolu — « de »,
21 602 mails, 1 897 interlocuteurs — **731 ms**.

**Le tri.** Un seul réglage, qui décide de l'ordre des interlocuteurs ET des
mails dans leur carte : les plus récents (défaut), les plus anciens, A→Z, Z→A,
les plus pertinents. On dit **« interlocuteur »** et pas « destinataire » :
dans une recherche l'autre partie est tantôt l'un tantôt l'autre. Deux détails
qui comptent : le classement se fait sur la date du mail **qui correspond**
(sinon une newsletter d'hier ferait remonter un interlocuteur dont le seul
rapport avec « avocat » date de 2021), et le tri est refait **côté serveur** —
retrier les lignes déjà chargées lui montrerait « les plus anciennes » de la
page en les faisant passer pour les plus anciennes tout court.

**Les mails envoyés** (repérés par ChatGPT, vérifiés ensuite) : le corpus en
compte **5 976**. Groupés sur l'expéditeur, ils tombaient tous dans une carte
« moi-même ». L'interlocuteur d'un mail envoyé est son **destinataire**
(`toEmails` est rempli sur 5 975/5 976) : les deux sens d'un échange se
rejoignent maintenant dans une seule carte, avec ↗ / ↘ par ligne. Un envoi à
plusieurs compte chez chacun d'eux.

**Piège du test, payé une fois.** Le premier passage Playwright a conclu « le
tri ne change rien — ANOMALIE ». C'était faux : j'attendais la disparition du
spinner, or au moment du clic la page porte encore les résultats précédents,
donc la condition est vraie **immédiatement** et on relit l'ancien écran. Il
faut attendre la **réponse réseau** `/api/find`. L'API, elle, était juste
depuis le début. Un test mal synchronisé accuse le code innocent.

**Reste ouvert, mesuré mais NON traité — les ACCENTS.** `LIKE '%republique%'`
→ 64 mails, `LIKE '%République%'` → 294. La casse est insensible (ASCII),
l'accent non : « echeance », « reglement », « electricite » ratent la majorité
des résultats, **en silence**. ChatGPT a changé d'avis en cours de route et
préconise FTS5 (`unicode61 remove_diacritics 2`) pour ça. Non retenu
aujourd'hui : il a signalé deux problèmes, c'est un troisième, il touche le
schéma, exige un backfill des 41 607 mails et de l'OCR, et changerait la
sémantique de matching sur une fonction qu'il juge « bonne » (le distinguo
« RIB » ≠ « Ribéroux » vient précisément du LIKE + scoring mot entier).
**À trancher avec lui.**

## 18/08 (45) — « Nos échanges » : un contexte qui parlait d'autre chose

**Ses trois reproches**, capture à l'appui, sur une mise en demeure URSSAF
transférée par Mylène : trop d'étapes (« cliquer sur un message pour avoir un
bandeau, puis ensuite voir le détail à nouveau »), **impasse** (« plus de
possibilité de revenir en arrière sur le mail principal »), et hors sujet
(« nos échanges ne se cantonne pas qu'au sujet traité » — il y voyait
« COUCOU » et « 100 ans de la PLM »).

**Les deux causes, trouvées dans le code avant toute proposition.**
1. `correspondance.ts` triait les conversations par date décroissante puis
   `slice(0, 12)`. **Aucun critère de pertinence.** Il ne voyait pas « 12
   sujets » mais **les 12 plus récents sur 264**.
2. Cliquer un message appelait `openReader()`, qui commence par
   `closeReader()` : le mail en cours était **détruit**, sans pile de
   navigation. Ce n'était pas un bouton « retour » manquant — le modèle était
   « remplacer » au lieu de « consulter ».

**Contre-revue aveugle 2 tours** (`.consult/2026-08-18-nos-echanges/`). Accord
immédiat sur le principe : l'historique est du CONTENU inline, pas une
navigation ; donc **aucun bouton retour dans le parcours normal**, il n'y a
rien dont il faille revenir.

**Trois mesures ont fait RÉVISER sa proposition initiale** (défaut fondé sur
le dossier IA) : seulement **31 %** des mails portent un dossier, **28 %** en
portent plusieurs, et leur **médiane est de 1 mail**. Le cas qui tranche : sur
le mail URSSAF, le dossier le plus PRÉCIS (« URSSAF Bretagne », 2 mails) est
le moins utile ; c'est le plus LARGE (« SAS LB2I », 10 mails avec Mylène) qui
porte le contexte. **Les dossiers sont d'excellents signaux de liaison, pas
un conteneur navigable** — d'où l'union plutôt qu'un choix.

**La règle retenue** : `LIÉ À CE MAIL = même correspondant ET (même fil OU
même sujet normalisé OU ≥ 1 dossier en commun)`. Trois focales — `Ce sujet` ·
**`Lié à ce mail`** (défaut) · `Tout avec X` — triées par FORCE DU LIEN, la
date ne départageant qu'à force égale. Libellé choisi contre « Cette affaire »
(singulier faux dans 28 % des cas) et « Dossiers liés » (expose
l'implémentation).

**Mesuré sur 250 mails réels** : médiane 41 → **1**. 92 % des cas tiennent en
≤ 20 liés (plafond retenu) ; **41 % n'ont aucun lié**, d'où le soin porté au
cas vide — on ne s'élargit JAMAIS en douce, sinon le même bouton voudrait dire
tantôt « voici les liens », tantôt « je n'ai rien trouvé, voilà autre chose ».

**Livré** : `contexteDuMail()` + route `/messages/:id/contexte` ; panneau
refondu (accordéon sur place, repère « vous êtes ici », un seul corps ouvert à
la fois, « Ouvrir ce mail ↗ » en geste secondaire) ; **pile de lecture** dont
le bouton de retour NOMME sa destination (`← URSSAF`, pas `← Retour`).

**Preuve de l'invariant central** : titre du lecteur avant/après dépliement
d'un message du contexte → **identique**. L'impasse est fermée.

## 18/08 (44) — « Affaires en cours » : ce que le courrier ne rappellera jamais

**Sa demande, répétée** : des propositions de retour pour les mails qui
attendent une réponse, des relances sur les échéances dépassées, et une entrée
de menu. Trois exemples : l'URSSAF via Mylène ; une société mandatée il y a un
an pour transférer les parts de son frère dans la SARL et remonter ses parts
dans la holding — rien fait, constaté **sur Infogreffe** ; un changement de
direction LB2i **payé à moitié**, procédure jamais terminée.

**Le point dur.** Pour les deux derniers, il n'y a ni échéance, ni montant
qu'il doive, ni mail entrant. **Personne ne lui écrira.** Le déclencheur est un
SILENCE. Aucun moteur fondé sur le courrier reçu ne peut les faire remonter —
d'où un objet nouveau, qui n'est ni un mail, ni un dossier, ni une échéance.

**Sa correction, décisive** : « j'ai déjà dû envoyer des mails en ce sens, donc
tu dois avoir l'email et les détails ». Vérifié, et il avait raison :

- **LEGALFREE** (`romain@legalfree.fr`, boîte Brimmo) : devis « augmentation de
  capital par apport de titres » le 24/06/2025, **1 131,26 € réglés le 05/08**
  (840 € de commissariat aux apports + 2 × 145,63 €), rapport du commissaire
  livré en novembre, puis deux demandes d'informations manquantes le 21/11, une
  relance restée sans réponse le 25/11 (« Sauf erreur ce mail reste sans
  réponse »), et le **19/01/2026 : « Nous vous confirmons que nous avons bien
  annulé votre dossier ECONOM-LEG8007 »**. Voilà pourquoi Infogreffe ne montre
  rien : le dossier n'a pas traîné, il a été ANNULÉ faute de réponse.
- **CAPTAIN CONTRAT** (boîte lb2i) : commande « Modification de société —
  Pack Standard » le 13/11/2025, bloquée le 26/11 — « votre dossier est encore
  en cours de signature, **Ludovic n'ayant pas signé** ses documents » — puis
  **échec du prélèvement de 294,67 € le 13/12/2025** (« sans régularisation de
  ce paiement, vous ne pourrez plus accéder… »). « Payé à moitié » : exactement.

**Cadrage niveau ÉLEVÉ** (nouveau modèle + migration sur base en service +
écran en production + ambiguïté réelle sur « propositions de retour ») :
`.chantier/2026-08-18-dossiers-en-cours/change.md`. Contre-revue aveugle déjà
menée le matin même (§ 43) — c'est elle qui a produit l'objet `OpenCommitment`
et la distinction **`reviewAt` ≠ `dueAt`** : « à cette date, si je n'ai
toujours aucune preuve de réalisation, je dois regarder ».

**Livré**
- `Engagement` + `EngagementMessage` (migration **purement additive** :
  5 CREATE, zéro ALTER, zéro DROP ⇒ retour arrière sans perte).
- `services/engagements.ts` — cycle de vie, `reviewAt`, report, clôture.
  **L'ouverture exige toujours une preuve positive** ; ensuite seulement le
  silence devient un signal. Sans cette règle on retombait exactement dans la
  qualification par preuve négative corrigée le matin même.
- `services/brouillons.ts` — relance et réponse construites depuis le fil RÉEL
  (destinataire, objet, date d'engagement, montant réglé). **Aucun import de
  `smtp.ts`** : rien ne part sans qu'il clique. Invariant vérifié au grep.
- Écran **🧭 Affaires en cours** — nom qu'il a choisi lui-même pour ne pas le
  confondre avec « 📁 Mes dossiers » (2 527 regroupements de mails par sujet).
  Entrée de menu + onglet dans le hub « À traiter ».
- Les affaires en souffrance entrent dans les **3 cartes de l'accueil**, en
  classe 2 : établies, mais pas obligation datée — elles ne peuvent donc pas
  évincer une échéance dépassée.

**Preuves** : 14 assertions fonctionnelles vertes ; aller-retour HTTP complet
(création → liste → brouillon → suppression) ; `/api/today` cohérent ; captures
d'écran sans aucune erreur JS.

**Quatre défauts attrapés avant livraison, dont trois PAR LA CAPTURE** : les
onglets du hub s'affichaient en double (le routeur les injecte déjà) ; le
montant réglé apparaissait deux fois sur la même ligne ; les champs de la
modale restaient en ligne, réduisant la zone de texte à une colonne illisible.
Le quatrième vient d'une relecture : sans cas dédié, `dedoublonnerCandidats`
faisait tomber **toutes** les affaires sur la même clé
(`i|undefined|undefined|…`) et les réduisait à une seule carte. Sans capture
d'écran, les trois premiers partaient en production.

**Assumé** : les affaires n'entrent pas dans la file de dépouillement, qui
affiche un mail dans le panneau de droite — une affaire n'en a pas un seul.
Et la détection automatique reste à faire : les **6 246 mails ENVOYÉS n'ont ni
extrait ni verdict**, la matière première n'existe donc pas encore.

## 18/08 (43) — « Vue du jour » : trois publicités devant une mise en demeure

**Le déclencheur.** Capture d'Anthony : « 3 choses méritent ton attention
aujourd'hui » = une offre d'anniversaire Europcar de 56 jours, une promo
Galaxy S26, une notification Airbnb. Sa mise en demeure **URSSAF de 418 €**,
correctement analysée et à régler avant le 29/08, **absente de l'écran**.
« Qu'est-ce que c'est que ton analyse de merde ? » — justifié.

Ma première explication (le score) était incomplète. Sa correction a désigné
le vrai défaut : « ces emails n'attendaient même pas de réponse (juste
notification de gratification de 50 points), c'est donc super mal pensé ».

**Deux défauts distincts, mesurés sur la production.**

1. **Qualification par preuve négative.** 9 des 10 « réponses attendues »
   n'étaient qualifiées que par la forme du fil — dernier message entrant,
   rien envoyé depuis. Aucune preuve positive exigée.
2. **Score saturé.** 50 (réponse attendue) + 50 (seuil dépassé) + ≤ 10
   (ancienneté) ⇒ **8 candidats sur 8 exactement à 110**. Le tri ne
   discriminait plus rien : l'ordre affiché était l'ordre d'insertion. Et les
   paiements, figés à 60, perdaient TOUJOURS — y compris l'URSSAF.

**La cause racine, trouvée en creusant.** Les 8 fautifs portaient tous
`intent = 'info'` de l'ancienne analyse — un intent **absent de
`NO_REPLY_INTENTS`**, qui contenait pourtant `promo`, `invoice`,
`confirmation`… Le signal existait et personne ne l'écoutait ; la carte
tombait sur le `return attendue: true` final. Les 7 écartés sont tous des
expéditeurs `company` ; les 2 candidats légitimes du même lot (sa comptable,
l'URSSAF via Mylène) sont classés `person` et survivent par l'exception
« personne », qui a donc fait exactement son travail.

**Deux fausses pistes traversées, notées pour ne pas les refaire.**
Ma première mesure cherchait le mot « repli » dans une justification qui ne le
contient pas (elle dit « Dernier message du fil, reçu il y a N jours ») :
elle affichait « 0 qualifié par repli » alors qu'il y en avait 9. Puis le banc
d'essai lancé **en local** a affiché 100 % de fuite — il lit des étiquettes
gelées calculées sur le serveur mais interroge les moteurs sur la base locale,
qui ne contient que 31 mails. **Le banc n'a de sens que sur le serveur.**

**Contre-revue ChatGPT en protocole aveugle (2 tours)** —
`.consult/2026-08-17-score-attention/synthese.md`. Il a révisé sur les trois
points où je lui ai opposé des mesures, notamment son veto par en-têtes de
diffusion (déjà réfuté ici le 12/08 : 21 des 191 mails « à traiter » écartés,
dont cinq AXA et « [ACTION REQUISE] Mise en conformité »). Il a en revanche
**réfuté à juste titre mon garde-fou « deux signaux indépendants »** : une
vraie mise en demeure d'un cabinet non catégorisé, au montant mal extrait,
serait tombée hors classe haute. La corroboration **promeut**, elle ne filtre
pas — position retenue : la sienne.

**Livré.**
- `intent = 'info'` ajouté à `NO_REPLY_INTENTS`.
- `preuve: 'verdict' | 'structure'` exposé sur chaque réponse attendue.
- Paiements : `dueAt`, `montant`, `enRetard` remontés en clés **structurées** —
  l'interface classait jusqu'ici en relisant une phrase française.
- Score additif remplacé par `rangCandidat()` : rang lexicographique
  [classe, échéance, corroboration, tranche d'âge], **classes non
  additionnables** (une classe basse ne rattrape jamais en vieillissant).
  Il en existait **deux copies** dans `app.js`, libres de diverger — une seule
  définition désormais, partagée par l'accueil et la file de missions.
- Dédoublonnage étendu aux paiements (expéditeur + sujet) : cinq
  « igloohome API Payment Grace Period » et deux « TRAKmy » occupaient sept
  places de file, invisibles tant que les publicités les enterraient.

**Preuves — banc d'essai sur le SERVEUR, avant → après :**
fuite **45 % → 45 %** (86/191 : aucun mail à conséquence perdu) ;
surface « réponses attendues » **165 → 79** (86 fausses affirmations
retirées) ; importants (749), factures (10), échéances (3) inchangées.
Simulation de l'écran : les 7 publicités disparaissent, l'URSSAF 418 € entre
en carte n° 2, la file passe de 30 à 19 sans radotage.

**Ce qui reste ouvert, assumé.** L'écran ne sait toujours pas représenter
l'**engagement silencieux** : le mandat d'il y a un an pour les parts de son
frère (rien fait, constaté sur Infogreffe) et le changement de direction LB2i
payé à moitié n'ont ni date, ni montant qu'il doive, ni mail entrant — rien
ne les fera jamais remonter. C'est l'objet du chantier « Dossiers en cours »
(`OpenCommitment` avec un `reviewAt` distinct du `dueAt`). Manque aussi un
champ de **conséquence** dans le verdict : sans lui, une obligation `pay` sans
date d'igloohome se classe au-dessus d'un « capitaux propres inférieurs à la
moitié du capital ».

## 17/08 (42) — lb2i validé, et le bug qui rendait ses 5 254 mails invisibles

**1. Le chantier IMAP par mot de passe est VALIDÉ EN RÉEL.** Anthony a enrôlé
lb2i lui-même depuis l'interface : `authType=password`, `ssl0.ovh.net:993`,
**5 254 mails** synchronisés (juin 2022 → août 2026), 6 dossiers. Aucune
intervention nécessaire. Chantier clos.

**2. MAIS les 5 254 mails étaient invisibles à l'analyse** : 0 extrait sur
5 254, donc 0 éligible au rattrapage (`candidateWhere` exige `snippet` non
null). Cause lue dans les logs : `extraits post-sync en échec — Invalid
prisma.message.update(): unexpected end of hex escape at line 1 column 40825`.

Diagnostic : le nettoyage des demi-caractères de substitution enchaînait deux
`replace`, et le second (`(^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]`) CONSOMME le
caractère précédent — donc sur des demi-caractères CONSÉCUTIFS il n'en
traitait qu'un sur deux. **Prouvé avant de corriger** : « deux low
consécutifs », « trois low consécutifs » et « low en tout début » survivaient
tous les trois. Un seul survivant suffisait à faire échouer la transaction de
100 mails, l'exception remontait, la passe s'arrêtait — d'où zéro extrait pour
la boîte entière. Le même bug avait déjà frappé le 30/07 sur `codePoint()` :
c'est la troisième fois que ce motif coûte cher.

Correctif en deux temps (les deux nécessaires) :
- `assainirTexte()` s'appuie sur **`toWellFormed()`** (ES2024, présent sur le
  Node 20 du serveur, avec repli boucle) — il n'y a plus de recouvrement
  possible. Vérifié : 6 cas sur 6 écrivables, emoji et accents intacts.
- **Repli mail par mail** si un paquet est refusé : le mail fautif est isolé
  (extrait vide + version posée, donc pas de boucle) au lieu de faire tomber
  les 99 autres. Aucune liste de caractères ne sera jamais exhaustive — le
  filet compte autant que la cause traitée.

Piège rencontré au passage : éditer littéralement `\u0000` dans le source
insère de VRAIS octets de contrôle (6 introduits, dont un octet nul — la
leçon déjà consignée). Corrigé par script ; vérification « 0 octet de contrôle
littéral » ajoutée aux preuves.

**3. Zentra identifié et réparé** (autre repo) : `thonyAGP/zentra`, monorepo
Nx sur Vercel, gère déjà contrats, garanties, historique de prix, comparaison,
et les catégories `LOAN` / `INSURANCE_LOAN`. Sa production ne se déployait
plus depuis le 05/08 : `useSearchParams()` sans frontière `<Suspense>` sur
`/reset-password` — et `/verify-email` avait le même défaut, qui aurait cassé
le build juste après. Les deux corrigés, `next build` vérifié en local,
branche `fix/build-suspense-searchparams` poussée.

**4. Rattrapage** : 13 081 verdicts au matin, 4 140 restants (~4 300/jour).
Passé en **claude-sonnet-5** à sa demande (forfait en limite) — à repasser en
Opus/Fable le 18/08.

## 14/08 (41) — Rattrapage ×4 par sous-agents + comptes IMAP par mot de passe (OVH)

**1. Rattrapage accéléré ×4** (demande : « 17 jours c'est super long »). Le
prompt du déclencheur claude.ai a été réécrit en ORCHESTRATEUR : il ne juge
plus aucun mail lui-même, il lance jusqu'à 4 sous-agents en séquence (tool
Task, dispo dans la session Cowork), chacun avec un contexte neuf qui juge
~40 mails et rend UNE ligne (« jugés=n restants=m etat=ok|vide|note »).
Repli automatique vers l'ancien mode direct (40 max) si les sous-agents sont
indisponibles. Testé par run manuel : **+263 verdicts en 49 min** (run manuel
+ passage planifié de 15 h 17) contre ~40 avant — mécanique PROUVÉE. Débit
~160/h ⇒ fin du rattrapage ~4 jours. Rappel utile : le serveur sert les mails
PAR PRIORITÉ (argent, échéances, réponses attendues d'abord) — les oublis
importants remontent dans les premiers jours, pas à la fin.

**2. Comptes IMAP par mot de passe** (boîte lb2i chez OVH — POP3 écarté :
incompatible dossiers/corbeille/soft delete). Chantier niveau ÉLEVÉ
(`.chantier/2026-08-14-comptes-imap-mot-de-passe/change.md`), contre-revue
ChatGPT en protocole aveugle (`.consult/2026-08-14-comptes-imap/synthese.md`,
verdict : architecture confirmée + amendements intégrés : test SMTP `verify()`
avant stockage, 409 anti-écrasement OAuth→password, users/secure explicites,
garde SSRF, ports 993/143/465/587 seulement, erreurs sémantiques).
Livré : `authType`/`passwordBlob` (AES-256-GCM, même module que les tokens)
+ host/port/secure PAR COMPTE dans accounts.json (zéro migration, absent =
OAuth) ; branches password aux 3 points de contact (pool IMAP, SMTP avec
requireTLS sur 587, tokenStatus honnête) ; garde explicite `accessTokenFor` ;
`POST /api/enroll/imap` qui teste IMAP (connect+LIST+INBOX) ET SMTP (verify)
avant tout stockage ; formulaire dans la modale d'ajout, préréglage
`ssl0.ovh.net` 993/465. Preuves : tsc OK, 409/SSRF/DNS/port testés en local,
vrais identifiants refusés par le vrai OVH → 400 propre et accounts.json
octet pour octet intact, 8/8 preuves unitaires (aller-retour chiffrement,
legacy intact). Reste : l'enrôlement réel lb2i par Anthony (validation de
bout en bout), puis 24 h d'observation de la sync du parc.

## 14/08 (40) — Nuit vérifiée : backfill OCR terminé, rattrapage à plein régime

Point du matin (11 h 15 UTC), rien modifié sur le serveur :

- **Backfill OCR TERMINÉ** hier à 18 h 37 UTC (~3 h 45 comme prévu) :
  976 scans traités, **811 lisibles (83 %)**, 164 restés charabia — un peu
  sous le pilote (93 %) : la fin de la file portait plus de photos/TIF
  dégradés. 41 requeues au total. Sondé les 3 derniers textes : lisibles
  (bon de retour La Redoute, recommandé Solly Azar). Chantier OCR CLOS.
- **Rattrapage à plein régime toute la nuit** : 1 119 verdicts (+752 depuis
  hier 15 h 38 UTC ≈ 40/h, exactement le débit attendu), dernier posé à
  10 h 30 UTC. Reste **16 101 à relire** ⇒ ~17 jours à ce rythme.
- **Piège de mesure évité** : un `COUNT(*)` naïf des messages sans verdict
  donne 35 135 — le vrai vivier suit `candidateWhere` d'analysis.ts
  (hors corbeille/spam/sortants/supprimés, snippet non null) : 16 101,
  cohérent avec les 16 905 d'avant-hier. Ne jamais publier le count naïf.

## 13/08 (39) — Point de contrôle : OCR et rattrapage vérifiés de bout en bout

Session de vérification pure (rien modifié sur le serveur). État à 15 h 55 UTC :

- **Rattrapage horaire vivant** : 367 verdicts (repère précédent 311 à
  13 h 33 UTC), dernier posé à 15 h 38 UTC — soit ~28/passage sur les deux
  derniers passages, dans l'ordre de grandeur attendu (~40).
- **Backfill OCR en cours, pas fini** : 216 scans tentés sur ~929, dont
  194 lisibles (90 %, cohérent avec le pilote à 93 %) et 22 restés charabia.
  713 restants ⇒ ~3 h de backfill à ~15 s/doc. Dernière OCR à 15 h 56 UTC,
  le worker mouline.
- **Qualité sondée sur 8 textes au hasard** : fournisseurs, montants, numéros
  de facture, adresses tous exploitables (Belleguic, Dispano, Mingant, CAF,
  STGS…). Bruit OCR classique (« Frangois ») mais les champs clés passent.
- **Boucle requeue → ré-analyse VÉRIFIÉE de bout en bout** : 33 verdicts
  retirés (`ocr_requeue_analysis` dans operations.jsonl) car la pièce est
  devenue lisible ; sur les 8 premiers requeues (14 h 56), 3 avaient déjà un
  NOUVEAU verdict posé par le passage de 15 h 17 (15 h 36-15 h 38). Le reste
  attend le prochain passage. Rien à corriger.

Astuce d'accès prod réapprise : pas de sqlite3 sur la VM ; requêter via un
script .cjs copié par scp dans /home/ubuntu/boxmail (résolution de
@prisma/client) avec `DATABASE_URL="file:...boxmail.db?connection_limit=1"`.
Attention aux quotes imbriquées ssh/heredoc : écrire le script en local puis scp.

## 13/08 (38) — OCR des scans : le goulot n° 1 est levé

Reprise sur « goulot n° 1 : lire les scans ». Mesure d'entrée sur la prod :
921 mails `attachmentKind='scan'` (PDF sans couche texte + photos), et le PDF
scanné était un cul-de-sac TOTAL — ni extractible, ni montrable à Claude
(`attachmentForVision` n'acceptait que jpeg/png/webp/gif). Même « faire lire
par l'IA » exigeait donc un rendu PDF→image côté serveur.

**Architecture** (plan + contre-revue ChatGPT, `.consult/2026-08-13-ocr-scans/`,
verdict « d'accord avec réserves », 6 corrections intégrées) : OCR local
gratuit — tesseract 5.3.4 fra+eng + pdftoppm via apt (sudo vérifié, 1 vCPU
ARM) — la doctrine « pas de clé API serveur » tient. Corrections retenues de
la contre-revue : provenance `attachmentTextSource='ocr'` (un montant OCRisé
n'a pas la fiabilité d'une couche texte), score de lisibilité par la sortie
TSV de tesseract (médiane des confiances en signal principal, l'heuristique
linguistique en secondaire, assouplie si un montant/n° de facture est lu),
`ocrVersion` pour l'idempotence durable (incrémenter = tout redevient
éligible), worker périodique au lieu d'une capability-fleuve (« la base est
la queue » : tick 2 min, UN document, s'abstient si un job tourne), raster
borné en PIXELS (-scale-to 2400, pas de DPI), JPEG pour la vision (seul
format dont on contrôle la taille).

**Livré en 5 commits poussés** : socle (migration attachmentTextSource/
ocrAt/ocrVersion + services/ocr.ts pur + banc `npm run ocr:banc`) ; passe
`ocrScansForAccount` (télécharge ENFIN les images ≥30 Ko, retente
l'extraction maison d'abord, chunks au format existant avec troncature PAR
PAGE, rejeu detectIntent, remise en vivier IA CIBLÉE — seuls les verdicts
ayant déclaré « pièce illisible » sont supprimés, oplog
`ocr_requeue_analysis`) + routes `/ocr/status` et `/ocr/backfill` + ligne
Paramètres ; vision des PDF scannés (`pdfPageEnJpeg`, paramètre `page` sur
read_attachment) + doctrine mise à jour ; worker `autoocr.ts` + capability
d'ANNONCE `ocr-scans-v1` (throw tant que les binaires manquent → retentée à
chaque boot) ; correctif trouvé PAR le pilote.

**Le correctif du pilote, à retenir** : pdftoppm SORT EN ERREUR (« Wrong page
range given ») quand on demande une page au-delà de la dernière — la boucle
jetait la pièce ENTIÈRE, pages déjà lues comprises. Les 2 premiers documents
du pilote sont tombés dessus (2/2 illisibles) ; après correctif et
réinitialisation des 16 mails marqués à tort : **90 lisibles sur 97 (93 %)**.
Échantillon qualité (6 tirés au hasard) : carte d'identité, échéancier Crédit
Mutuel, devis Leroy Merlin 849,00 €, ticket SNCF, factures — fournisseurs,
montants et numéros ressortent, aucun faux « lisible » dans l'échantillon.
~15 s par document.

**En sortie de session** : le backfill serveur continue tout seul sur les
~820 restants (job `ocr`, suivi via la pastille d'activité ou
`GET /api/ocr/status`) ; ensuite le worker 2 min prend le relais pour le flux
courant. Les mails renvoyés à l'analyse (`requeued`) seront repris par le
rattrapage horaire. Pièges VPS notés : `npm install --omit=dev` casse le
build (retire @types/node) — installer complet ; les scripts Node ad hoc
doivent vivre DANS /home/ubuntu/boxmail (résolution @prisma/client) avec
`DATABASE_URL=file:../data/boxmail.db`.

## 13/08 (37) — Le rattrapage tourne enfin seul : quatre pannes invisibles

Journée d'incidents, tous du même genre : des choses qui AVAIENT L'AIR de
marcher. À garder, parce que chacune s'est payée deux fois.

**1. Un plafond au-dessus du plafond réel ne sert à rien.** « Analyse les 300
mails prioritaires » a échoué sur « The request body is not valid JSON »
(821 Ko). Correctif posé : budget de 180 Ko par lot. Récidive le même jour à
934 Ko — le budget n'avait JAMAIS servi, un lot de 40 pesant 120 Ko. La mesure
existait (83 Ko notés la veille) et n'avait été comparée à RIEN. Plafond réel
mesuré ensuite : au-delà d'environ 25 000 jetons (~85 Ko) un résultat d'outil
part dans un fichier que l'agent relit — le poids revient par la fenêtre.
Budget ramené à 30 Ko, lots de 15 au plus, défaut 10.

**2. La vraie limite est ailleurs, et aucun réglage de lot ne la déplace.** La
conversation CUMULE les lots : une session tient une soixantaine de mails,
point. Pire, le SOCLE d'une session pèse déjà ~600 Ko de définitions de
connecteurs — cinq sous-agents sont morts au même chiffre (625 à 630 Ko)
AVANT de traiter un seul mail. Mesuré : Boxmail = 63 Ko pour 58 outils, donc
PAS la cause ; Rentila (~110 outils) et Vercel (~40) le sont. Conclusion
durable : pour du volume, il faut un contexte NEUF par lot, et ne charger que
le connecteur nécessaire.

**3. Réservation des lots** — colonnes `claimedAt` / `claimedBy`, migration
`20260813100000`. `next_analysis_batch` n'en avait aucune : deux agents sur la
même boîte recevaient les MÊMES mails. La version évidente — SELECT des ids
puis UPDATE pour les marquer — ne réserve RIEN : contrôle négatif écrit et
exécuté, elle sert 5 mails sur 5 en double, parce qu'un autre appel passe
entre les deux `await`. Retenu : une seule instruction
`UPDATE … WHERE id IN (SELECT … LIMIT n) RETURNING id`, que SQLite exécute
d'un bloc. La réservation PÉRIME en 30 minutes, et c'est la propriété qui
compte le plus : une session qui meurt en plein lot ne doit pas retirer ses
mails du vivier pour toujours — remplacer « double travail » (visible) par
« mails disparus » (invisible) serait bien pire.

**4. Un redémarrage du serveur cassait SILENCIEUSEMENT les analyses.** Les
sessions MCP vivent en mémoire ; on répondait 400 à une session inconnue, ce
qu'un client lit comme une erreur définitive. Chaque déploiement arrêtait donc
le rattrapage sans que rien ne le signale. Le protocole prévoit 404 = « relance
une initialisation » : corrigé, et vérifié en réel (ma propre connexion s'est
rétablie seule au premier appel suivant).

**5. La tâche planifiée « cowork » travaillait à vide depuis des jours.**
Déclencheur claude.ai `trig_01SLhekXbwP85yQTnP32Aaof`, toutes les heures.
Trois défauts cumulés : elle visait la portée `uncertain` (2 mails restants)
au lieu de `relecture` (17 000) ; elle déposait avec `submit_analysis_batch`,
qui n'écrit PAS de verdict sémantique — les mails ne quittaient donc jamais le
vivier et elle aurait tourné en rond indéfiniment ; et l'autorisation
automatique ne couvrait que cet ancien tool, si bien qu'avec le bon elle serait
restée bloquée sur une demande de permission que personne ne clique à 3 h du
matin. Corrigée, allégée à Boxmail et 6 outils, bornée à 40 mails par passage.
**Vérifiée de bout en bout : 40 verdicts déposés, arrêt propre, 0 mail resté
réservé.** Horaire passé de :15 à :17 (réarmement inutile, voir ci-dessous).

**Piège de méthode, constaté trois fois dans la journée** : conclure trop tôt.
« C'est corrigé » sur un garde-fou qui ne s'était jamais déclenché ; « relance
ton rattrapage » sur une cible hors d'atteinte ; « j'ai cassé la planification »
sur une mesure prise 4 minutes avant que le job ne démarre — il part avec ~9
minutes de retard, ce qu'un seul relevé antérieur (11:15 parti à 11:19) suffisait
à prévoir. À chaque fois le chiffre était là, sans référence à laquelle le
comparer.

**Ce que l'analyse a rapporté** (~280 mails relus) : convention d'honoraires
d'avocat à parapher, justificatifs 2024 réclamés par Comptastar bloquant deux
bilans, analyses légionelles imposées par l'ARS sur le 33 rue François Miron,
comptes 2022/2023 non validés (risque de mandataire judiciaire), plusieurs
factures échues depuis 2023-2024, et un règlement de 25 000 € portant DEUX IBAN
et deux bénéficiaires différents entre le mail et le PDF. Huit faux montants
écartés au passage — capitaux sociaux lus en pied de page, TVA prise pour un
TTC — que l'ancien système aurait transformés en échéances.

**Goulot désormais** : les scans et les PDF à police brouillée restent
illisibles, donc leurs montants inconnus. Trois analyses indépendantes ont buté
dessus le même jour. C'est ce qui bloque la vue documentaire et le fiscal.

## 11/08 (36) — Lire le contenu des documents : trois pannes trouvees en reel

Suite immediate de « retrouver sans classer », sur son « Go ». Objectif :
retrouver une facture par son montant ou par le fournisseur ecrit DEDANS.

**Le fonds mesure** : 7 019 mails a piece jointe (hors corbeille et envoyes),
6 062 Mo, dont 3 365 PDF, 1 312 JPG, 222 fichiers Office. Le texte n'avait ete
extrait que sur 27. La cause n'etait pas une panne : le job post-sync ne
regardait que 40 mails sur 60 jours, donc le FONDS n'etait jamais attaque.

**Trois defauts reels, invisibles en test unitaire, trouves en production :**

1. **Les factures modernes ne rendaient RIEN** (32 caracteres = leur nom de
   fichier). L'extracteur ne lisait que les chaines litterales `(…)` et
   sautait volontairement les chaines hexadecimales `<…>`, illisibles sans la
   table de la police. Corrige : les tables `/ToUnicode` du PDF
   (`beginbfchar` / `beginbfrange`) sont lues en premiere passe, le texte
   decode en seconde.
2. **Les factures IKEA resistaient meme apres ca.** Diagnostic sur le fichier
   reel : leur texte n'est pas en hexadecimal mais en codes sur DEUX octets
   glisses dans des chaines litterales — `(\u00001\u0000B\u0000H\u0000F)` vaut
   « Page ». Ces chaines passent desormais par la meme table, et le decodage
   n'est retenu que s'il explique au moins 60 % de la chaine (un PDF simple
   garde son texte intact). Verifie sur la vraie facture : « Facture »,
   « SCI ALTOEN », « Numero de Facture: FRINV25000003159229 », le numero de
   TVA et les dates ressortent, et `documentHints` reconnait le fournisseur.
3. **Un PDF rendait « fr-FR fr-FR fr-FR »** : les operateurs Tj/TJ etaient
   cherches comme de simples sous-chaines, si bien qu'un flux de metadonnees
   pouvait etre analyse comme du texte. Cherches comme des MOTS desormais.

**Ajoute aussi** : lecture des documents Office (.docx/.xlsx/.pptx) — ce sont
des archives ZIP contenant du XML, et zlib etait deja la pour les PDF. Lecteur
fonde sur l'annuaire central (tailles fiables), separation des cellules pour ne
pas fabriquer de faux mots. Verifie en reel sur `409IND.xlsx` (2 547 car.) et
`FICHE EXPLIQUATIVE COMPTES ALTOEN 2023.docx` (1 243 car.). Plus un repli par
extension : plusieurs serveurs annoncent `application/octet-stream` pour un
PDF, et ces pieces n'etaient donc jamais telechargees.

**Cadence** : le job post-sync n'a plus de borne de date et travaille sous
plafond de volume (40 Mo) ; un rattrapage complet est lancable a la main
(`/attachment-text/backfill`, plafond 150 Mo par lot, reprise automatique).

**Prochaine etape** : la vue documentaire. Mesure faite le meme jour avec le
sujet, le nom des pieces et le resume seuls : 2 669 des 7 019 mails a piece
jointe se rattachent deja a une famille (Immobilier 713, Banque 683, Factures
564, Contrats 390, Fiscal 203, Reservations 116). La couverture montera
nettement quand le texte des pieces sera en base — c'est pour ca qu'elle passe
apres, et pas avant.

## 11/08 (35) — « Retrouver sans classer » : premier jalon livré

Décision d'Anthony après le compte rendu du 10/08 : « on part sur retrouver
sans classer ». Le nettoyage n'est plus le chantier ; le produit doit répondre
à « où est ce document ? ».

**Le manque de départ, mesuré** : aucun nom de pièce jointe n'était stocké, et
le TEXTE des pièces n'avait été lu que sur **27 mails sur 10 191**. La
promesse « je retrouve ton document » reposait donc sur du vide. Or la sync
lisait déjà le nom du fichier dans le `bodyStructure` — et le jetait.

**Livré** :
- `Message.attachmentNames` ; collecte au fil de la sync (coût nul, la
  structure est déjà lue) + job de rattrapage `attachment-names` qui ne
  descend QUE les structures IMAP (aucune pièce téléchargée) et répare au
  passage `hasAttachments` sur les mails indexés avant son calcul ;
- la recherche couvre désormais le nom des pièces ET le résumé de l'analyse
  (17 056 mails en ont un), en plus du sujet, de l'expéditeur, du texte et du
  contenu des pièces déjà lues ;
- chaque résultat dit **pourquoi** il ressort (« trouvé dans le nom de la
  pièce jointe ») — son reproche constant : le produit n'explique rien ;
- `services/find.ts` : regroupement par **entité expéditrice**. Les deux
  adresses Leroy Merlin (mail. et news.) fusionnent ; deux adresses hotmail
  restent deux personnes (sinon tous ses contacts fusionneraient en un groupe
  « hotmail ») ;
- l'écran « Recherche » devient **« Que cherches-tu ? »** : une entrée, des
  exemples cliquables tirés de SES boîtes (quittance, avis d'imposition,
  bail…), puis quelques interlocuteurs avec leurs fichiers en évidence — plus
  de liste à plat de 200 lignes triées par date.

**Vérifié au navigateur** sur un jeu d'essai : « quittance » remonte les mails
Foncia dont le sujet ne dit que « Votre document est disponible » ; « leroy
merlin » ne fait qu'UN groupe ; « imposition » ressort par le seul résumé ;
zéro erreur JS.

**Deux pièges rencontrés en production, corrigés** :
- le client Prisma du serveur était généré avant la migration (`Unknown
  argument attachmentNames`) — `prisma generate` ne fait pas partie du
  `npm run build`. Et la migration exige d'ARRÊTER l'app (« database is
  locked »), comme le disait déjà la leçon durable ;
- la première passe réelle rapportait `appstore_lm.gif`, `quote_lm.gif`,
  `loc_lm.gif`… : les images de décoration des newsletters noyaient le vrai
  `723767.pdf`. Filtre posé (image non déclarée en pièce jointe, ou < 30 Ko),
  1 996 mails remis à examiner.

**Suite** : le contenu des pièces (27/10 191 lues) reste le gros manque ;
puis la vue documentaire (Factures · Banque · Fiscal · Immobilier · Contrats),
sans qu'aucun dossier n'ait été créé.

## 10/08 (34) — Nettoyage : les mesures disent d'arrêter le nettoyage

Reproche de départ : « tu mélanges des boîtes, des dates, des réponses qui
sont vieilles […] il ne fait que lister des actions possibles, il n'explique
pas pourquoi […] newsletter avec code promo dépassé depuis 3 mois, pas la
même chose que le même mail reçu il y a 2 jours ».

Trois tours avec ChatGPT (conversation dédiée, archivée dans
`docs/archives-chatgpt/nettoyage-2026-08-10.md`), mais surtout **sept mesures
sur la base de production**. Synthèse complète : `docs/PLAN-NETTOYAGE.md`.

**Son intuition est vérifiée** : 100 % des rendez-vous et des livraisons, 98 %
des confirmations et des OTP, 97 % des rappels, 93 % des promos ont plus de
30 jours. Presque tout ce qui se périme EST périmé, et le système l'ignorait.

**Mais trois de mes chiffres étaient faux, et c'est le plus important.**
Les « 1 070 mails / 421 Mo » d'Altoen et les « 615 mails Brico Privé »
mesuraient la CORBEILLE. `rebuildSenders` agrégeait tous les dossiers :
l'écran affichait « Brico Privé — 615 mails » alors qu'il en restait **3** en
réception, les 623 autres étant déjà jetés. **Corrigé** (corbeille et spam
exclus de `Sender`, même périmètre pour le « gardés » de `cleanup.ts`).

**Le gisement réel, simulé à blanc sur les 18 035 mails de réception :
966 mails nettoyables, 137 Mo sur 7 471 — moins de 2 % du volume.** Le poids
est dans 4 645 pièces jointes et 4 048 documents, c'est-à-dire dans ce qu'il
faut GARDER. Le nettoyage ne peut donc plus être vendu comme un gain de place.

Pièges évités en simulant, comme toujours :
- « lire la date de validité de l'offre » : **3 %** des promos portent un
  signal exploitable dans l'extrait de 500 caractères. Idée abandonnée comme
  pilier, gardée comme source opportuniste.
- « sujet répété = jetable » : **FAUX**. 6 088 mails ont un sujet répété — ce
  sont ses 13 déclarations DGFiP, ses 12 télépaiements de taxe d'habitation,
  ses 24 ajouts de bénéficiaire bancaire, ses 21 avis de remboursement
  mutuelle. La répétition signe un processus récurrent, pas de l'inutilité.
- `info` (43 % de la réception) n'est pas du bruit : Mylène 411 mails,
  Alizé 270, son agent immobilier 222… c'est sa vie.
- des humains sont classés « newsletter/promotion » (nathalie@, ashley_keira@,
  fanch56@) : le classifieur se trompe de NATURE, pas de nuance.
- l'état d'activité d'une boîte ne doit **jamais** compter ce qui est REÇU
  (recevoir est passif). Sur les seuls gestes humains : Altoen et Econom
  passent DORMANT, les cinq autres restent protégées.

**Trouvaille qui remplace la date de validité : la SUPPLANTATION.** 453 des
905 offres ont été suivies d'au moins 10 mails plus récents du même
expéditeur. C'est un fait comptable, pas une inférence, et ça se dit en une
phrase : « Leroy Merlin t'a envoyé 40 offres depuis celle-ci. » Seuil retenu :
`borne(3, 30 / cadence_médiane, 12)`, et la supplantation est une propriété du
CYCLE DE VIE (jamais un relevé bancaire, jamais une facture).

**Verdict partagé au 3ᵉ tour : continuer à perfectionner le nettoyage, c'est
perfectionner la mauvaise fonctionnalité.** Ses boîtes ne sont pas sales, ce
sont des archives non structurées. Le prochain chantier est « retrouver sans
classer » — aucun mail déplacé, une organisation virtuelle en base, une
recherche qui répond à « la dernière facture du Crédit Agricole pour Altoen ».
Et « Nettoyage » sort du menu. **À valider avec lui avant de s'y engager.**

## 10/08 (33) — Fausses échéances : les heuristiques écrasaient l'IA

Retour cinglant : « tu m'interprètes des échéances alors qu'il s'agit d'un
message informant d'un arrêt du service le 12 mai […] Voilà pourquoi je ne
crois absolument pas à ton système d'analyse sans IA ». Plus un lien absurde :
« voir les factures à transmettre à la comptabilité » menait au calendrier.

**Vérification qui change le diagnostic** : l'IA avait DÉJÀ bien jugé ce mail
(intent info, action « à lire », confiance haute, résumé exact). C'est le
détecteur de dates qui tournait en parallèle et l'ignorait. Mesuré sur la
base : **11 échéances sur 15** portaient sur un mail que l'IA jugeait sans
action, plus 3 doublons exacts.

Livré et déployé : veto du verdict IA (confiance haute + « rien à faire » ⇒
pas d'échéance), rattrapage du stock (**10 des 15 dates écartées**, statut
réversible), et chaque carte « Quoi de neuf » porte enfin sa propre
destination (le bouton pointait en dur vers #/deadlines).

Débat dédié avec ChatGPT (conversation séparée — voir la leçon ci-dessous) :
le défaut n'est pas l'absence d'IA mais la **confusion entre extraction et
interprétation**. Décisions actées dans `docs/PLAN-ASSISTANT.md` § 6 bis :
un **arbitre unique** crée les objets métier (les détecteurs ne produisent que
des preuves) ; trois états **ASSERT / HOLD / IGNORE** ; une date n'est une
échéance que si **ACTEUR → ACTION → CONTRAINTE** tient ; quatre types de dates
(deadline, événement, transaction, information) ; hiérarchie d'autorité **par
type de conclusion** ; et le mode sans IA doit perdre en rappel, jamais en
précision.

**Leçons Playwright (2 colères de plus)** : ne jamais viser « la conversation
la plus récente » (c'était la sienne, en cours de génération — interrompue) ;
vérifier l'URL avant d'écrire ; et surtout **un sujet = une conversation**,
jamais deux sujets transverses dans le même fil. Règles dans
`~/.claude/CLAUDE.md`.

## 10/08 (32) — Suppression en 1 clic, et lecture des pièces jointes

**Suppression (colère utilisateur)** : « j'en ai marre de devoir trier et
cliquer 2 fois pour supprimer. On avait dit que la suppression se faisait mais
on gardait un bandeau de rattrapage de 10 s ». Le garde-fou n'est plus une
question AVANT, c'est un bandeau APRÈS qui ramène VRAIMENT les mails :
moveEmails/moveToTrash renvoient les UIDs pris dans la corbeille (COPYUID,
RFC 4315), deux routes de restauration (`/messages/restore`,
`/review/restore`) refont le trajet inverse et réveillent l'index avec le
nouvel UID. Plus de confirm() dans : lecteur, dépouillement (mail seul ET
lot), « Ce que j'ai remarqué », sélection de la boîte de réception. Annuler au
dépouillement remet aussi le mail à SA place dans le parcours. Si le serveur
ne rend pas les UIDs, le bandeau s'affiche SANS bouton plutôt que de promettre
un retour impossible. Restent confirmées (aperçu explicite, pas un clic de
trop) : modale bruit, Libérer de l'espace, passage d'une stratégie en auto,
et les déplacements.

**Pièces jointes (bug de classement)** : « tu m'as mis payer ma mère alors que
ma mère m'a juste envoyé en scan la facture de Sosh ». L'analyse ne voyait que
l'expéditeur — or l'expéditeur ne dit PAS de quoi parle le document.
- `attachment-text.ts` : extraction de texte PDF SANS dépendance (zlib natif —
  ni pdfjs ni OCR sur le VPS), + indices du document : fournisseur RÉEL,
  montant TTC, n° de facture, nature.
- Un scan n'est pas bricolé : c'est DIT (kind=scan) et c'est Claude qui le
  regarde — nouveau tool MCP `read_attachment` (texte, ou l'image elle-même).
- Message.attachmentText/Kind, lecture à la sync (40/passe, 60 j) + rattrapage
  « Quoi de neuf » 90 j plafonné à 250/boîte (10 192 mails à PJ en base).
- detectIntent lit la pièce en dernier recours et nomme le vrai fournisseur ;
  jamais d'écrasement d'un intent IA/manuel. next_analysis_batch porte le
  contenu des pièces et signale les scans — c'est ce qui manquait au lot fautif.
- Les candidats comptables exposent fournisseur/montant/n° → Fiscal-Manager
  pré-remplit le frais (« Lu dans le document : Sosh · 15,99 € »).
- Bouton « 🧾 Comptabilité » dans le lecteur : envoyer une facture à
  Fiscal-Manager sans attendre la détection (idempotent), demande du 10/08.

Testé : extraction PDF compressé/non compressé, détection des scans, scénario
« maman envoie une facture Sosh » → intent invoice « facture de Sosh —
15.99 € », et circuit suppression → corbeille → annulation → retour.

**3 retours en fin de session (10/08, corrigés et déployés)** :
1. « À traiter aujourd'hui » était une MODALE au milieu de l'écran → c'est
   maintenant une PAGE à deux colonnes comme le dépouillement, mail affiché
   d'office à droite, lecteur = geste du parcours (capture vérifiée).
2. Incohérence « ~53 min » (modale) vs « ≈ 78 min » (accueil) : deux barèmes,
   et l'accueil comptait 52 actions quand le parcours n'en recevait que 35
   (listes plafonnées à TOP=10 par famille). Un seul barème `todoMinutes`,
   estimation sur ce qui sera RÉELLEMENT parcouru + mention du reste ;
   `todo.queued` ajouté côté serveur.
3. « c'est l'intégralité des pièces jointes qui doit être lue […] recherche
   rapide même sur des pièces non nommées » : toutes les pièces d'un mail
   (plus de limite à 3), toutes les pages du PDF, 4 000 → 200 000 caractères,
   nom du fichier indexé avec le texte, et la RECHERCHE cherche dans
   `attachmentText` (recherche générale + filtre rapide des dossiers).
   ⚠️ Reste à faire : le rattrapage ne couvre que 90 jours / 250 mails par
   boîte (134 mails lus au premier passage, 27 documents + 14 scans). Les
   10 191 mails à pièce jointe déjà indexés ne sont pas tous lus — il faudra
   un bouton de rattrapage complet (pattern des extraits) si Anthony veut la
   recherche sur tout le fonds.

## 07/08 (31) — Connecteur Fiscal-Manager V1 : « zéro facture perdue »

Demande : Anthony paye des frais pro en carte perso puis se fait rembourser ;
risque qu'une facture reçue par mail ne soit jamais transmise à la
comptabilité. Design débattu avec ChatGPT (2 tours contradictoires + une
correction d'Anthony en direct : Fiscal-Manager est sur VERCEL, pas local —
son CLAUDE.md est périmé). Design : docs/CONNECTEUR-FISCAL-MANAGER.md,
transcriptions dans docs/archives-chatgpt/. Principe : « Boxmail détecte,
Fiscal-Manager qualifie », pont PULL unidirectionnel.

Côté Boxmail (déployé, validé en prod) :
- Table AccountingCandidate (métadonnées SEULEMENT — l'IMAP reste le stockage
  durable, jamais de PDF sur le VPS) ; société proposée par boîte
  (Brimmo/Econom/Colocar/Altoen, Location_Brest→BRIMMO, perso+Au-marais→null).
- Détection post-sync (intent invoice + PJ pdf/jpg/png/webp, images en ligne
  et <30 Ko écartées) + rattrapage « Quoi de neuf » 12 mois : 68 mails
  examinés, 57 pièces prêtes.
- API /api/v1/accounting-candidates : jeton dédié lecture seule
  (ACCOUNTING_READ_TOKEN, jamais le bearer MCP), curseur seq monotone,
  pièce streamée depuis l'IMAP à la demande, 410 Gone + SOURCE_MISSING si le
  mail a disparu (jamais de disparition silencieuse). Testé : 401/403, liste,
  curseur, 410, téléchargement réel 142 Ko, journal.
- Protection anti-suppression : déjà couverte par la protection centrale
  (hasAttachments + intent invoice) — aucune clause ajoutée. Relink des
  candidats quand un mail change de dossier.

Côté Fiscal-Manager (même session, repo LB2I-Fiscal-Manager) : modèle
AccountingDocument (PDF stocké EN BASE — filesystem Vercel éphémère), pull
idempotent par curseur (unique source+candidat+pièce, SHA-256, reprise sur
erreur), écran « Pièces reçues » (/pieces : créer un frais pré-rempli,
associer à un frais en attente, payé société, ignorer, société modifiable —
« proposée » = déduite de la boîte), groupe Boxmail dans /config, repli Jump
sur invoicePdf en base. Reste : validation réelle par Anthony.

Leçon Playwright (2 colères utilisateur) : profil Chrome persistant partagé
~/.claude/browser-profile + attendre un login STABLE (3 polls), bannière dans
la page, jamais de close() pendant une connexion → règles dans ~/.claude/CLAUDE.md.

## 06/08 (30) — Dépouillement : aperçu manquant après Corbeille/Déplacer

Retour : « certaines fois je me retrouve sans l'aperçu du mail à
traiter ». Cause : dans le lecteur, Corbeille et Déplacer faisaient
onRemoved(...) PUIS closeReader() — or, dans le dépouillement,
onRemoved avance au mail suivant et ouvre SON aperçu (ancrage
synchrone) ; le closeReader() tardif refermait donc le panneau du
NOUVEAU mail. Fix : refermer d'abord, avancer ensuite (les deux
gestes). Les autres enchaînements (réponse envoyée, reclassement,
lots, fin de session) étaient déjà dans le bon ordre. Au passage :
pièces jointes + image en ligne VALIDÉES en réel par l'utilisateur
(envoi HomeExchange reçu avec l'image).

## 06/08 (29) — Erreur 413 en prod : nginx limitait les corps à 1 Mo

Premier essai réel des pièces jointes → « Erreur 413 » : nginx (défaut
client_max_body_size 1m) rejetait avant l'app. Corrigé SUR LA VM
(client_max_body_size 32m dans les deux blocs server de
/etc/nginx/sites-enabled/boxmail, nginx -t + reload, vérifié : 6 Mo sur
/send → 401 et plus 413). Répercuté dans deploy/nginx.conf.example, et
message d'erreur 413 rendu parlant dans le composeur.

## 06/08 (28) — Pièces jointes et images en ligne dans le composeur

Retour : « dans la réponse, je ne peux pas ajouter de pièce jointe, ni
d'image dans les lignes du texte ». Fait :
- smtp.ts : OutgoingMail gagne html? et attachments? (OutgoingAttachment
  {filename, content, contentType?, cid?}) — MailComposer produit le bon
  MIME (mixed > related > alternative, testé hors ligne : cid, inline,
  texte de secours).
- admin.ts /send : validation des pièces (10 max, 10 Mo/pièce, 15 Mo
  total, noms nettoyés, cid contrôlé), html refusé au-delà de 500 Ko ;
  journal ui_send_mail enrichi (noms des pièces).
- index.ts : limite JSON dédiée 30 Mo sur la SEULE route /send (regex),
  le reste inchangé à 4 Mo — vérifié en réel (6 Mo → 401 sur /send,
  413 ailleurs).
- Composeur (app.js) : textarea → div contenteditable pre-wrap ;
  boutons 📎 Joindre des fichiers (vignettes retirables) et 🖼️ Insérer
  une image (au curseur) ; collage Ctrl+V d'une capture → image en
  ligne ; glisser-déposer (image → texte, autre → pièce jointe). À
  l'envoi : images data: converties en pièces cid + HTML (pre-wrap,
  largeur plafonnée 640 px), texte innerText en secours ; confirmation
  mentionne le nombre de pièces. Limites contrôlées aussi côté client.
À VALIDER en réel par l'utilisateur (l'envoi SMTP ne se teste pas en dev).

## 05/08 (27) — Corbeille sur toutes les cartes du dépouillement

Retour : « rajoute-moi systématiquement un bouton pour supprimer depuis
la liste des emails au dépouillement ». Avant, 🗑️ Corbeille… n'existait
que sur les lots et les mails « rangeables » (class range) ; les cartes
« À décider » (important) et « À lire » (read) obligeaient à ouvrir le
lecteur pour supprimer. Fait : bouton 🗑️ Corbeille… ajouté sur toutes
les cartes individuelles (factorisé en toTrash, placé en dernier avant
⏭️ Passer) — toujours confirm(), soft delete ~30 j, journalisé via
decide('trash'). Aussi ce jour (hors code) : ancienne install locale
C:\Users\leberan\boxmail-mcp supprimée du poste (autostart Démarrage
Windows retiré) — seule la prod Oracle tourne désormais.

## 03/08 (26) — Rentila PAR DÉFAUT sur les assurances (bbeed06)

Retour : « pourquoi une étape de plus ? fais l'inverse : Rentila par
défaut, événement/tâche en alternative ». Fait : ReviewProposal gagne
objectType 'rentila_message' (title=sujet, body, property,
deadlineId/Title/date = échéance liée) ; buildProposal le place EN TÊTE
pour insurance_expired/expiring avec bien. La carte de l'étape = sujet
+ corps éditables + case « confirmer aussi l'échéance liée » (cochée).
validateProposal('rentila_message') : transaction {création commande
send_tenant_message approved + échéance liée proposed→confirmed si
cochée + mail dépouillé}, une ligne de journal (« message locataire
préparé … + échéance confirmée … + mail traité »). « Déjà fait » masqué
sur ce type. Boutons secondaires et modale 🏠 Rentila… inchangés.
Testé bout en bout : proposition par défaut, case présente, validation
→ étape suivante, commande en file, échéance liée confirmée.
NOTE test-env : les reseeds laissent des échéances orphelines (les
seeds suppriment Message, pas Deadline) — faux positifs à ignorer.

## 03/08 (25) — Commande « Message au locataire » (9859403)

Retour : « pour les assurances périmées, il faudrait envoyer un message
via la plateforme au bon locataire pour qu'il téléverse son attestation
dans son espace ». Câblé : 3e kind send_tenant_message dans la file de
commandes — modale 🏠 Rentila…, onglet « ✉️ Message au locataire »
(bien OU locataire, sujet, corps textarea). Sur un mail « Assurance
locataire expirée/expire dans N jours : {bien} », l'onglet est
PRÉ-SÉLECTIONNÉ, bien extrait du sujet, message tout rédigé
(attestation à téléverser, rubrique Documents). Recette MCP : bail
ACTIF du bien (query_leases active=1) → tous ses locataires →
create_message avec EXACTEMENT le texte validé ; ambiguïté = rien
n'est envoyé. Testé Playwright : onglet actif, bien « 101 1er droite
T3 », commande en file avec les bons params. Capture : la carte
« Confirmer l'échéance » (rattrapage) visible derrière la modale —
la chaîne complète mail→échéance→message tient.

## 03/08 (24) — « Quoi de neuf » : rattrapage automatique (10c73a8)

Retour : « je ne vois rien de nouveau malgré la MAJ » — sa capture
montrait pourtant le neuf (bouton 🏠 Rentila…, alerte seule, un
ascenseur) MAIS l'assurance expirée restait en régime B : la détection
ne traite que les nouveaux arrivants, ses mails Rentila historiques
n'avaient pas d'échéance → pas de proposition. Le trou de guidage
exact spécifié au tour 5 ChatGPT.
Livré : services/whatsnew.ts — registre de capacités versionné
(rentila-parser-v1 ; v2 = nouvelle entrée immuable), rattrapage AUTO au
boot si interne/réversible/journalisé (détection sujets 120 j toutes
boîtes → échéances proposées), bilan data/whatsnew.json + journal
(capability_backfill), échec = pas de marqueur (retenté). Routes GET
/whatsnew + POST /whatsnew/:id/seen ; Vue du jour : carte « 🆕
Nouveau : … [Voir] [OK] » qui disparaît une fois vue.
LEÇON re-payée : un remplacement par node -e avait posé l'IMPORT mais
PAS l'appel au boot (dist grep = 0) — TOUJOURS grep le dist/le fichier
après un patch programmatique ; l'Edit direct est plus sûr.
Testé : boot → carte « 22 mails relus, 4 échéances proposées », le
mail assurance passe [A] confirm « Renouveler l'assurance… », OK → 0.

## 03/08 (23) — Rentila phase 2 : la file de commandes (8bbf148)

Abonnement Rentila RÉACTIVÉ par l'utilisateur → le connecteur MCP
répond (402 avant). Lectures de démonstration : 11 biens loués (46 rue
de la République ×9 SARL BRIMMO, 28b Duperré SCI ALTOEN, Massillon +
Yves Collet en nom propre), 15 loyers en retard (−10 207,82 € au
total ; Myrtille Herasse −562,50 € ↔ son mail « virement de 600 € »),
4 assurances expirées + 2 manquantes, 6 révisions, 7 baux qui expirent.
CONSTAT d'architecture : PAS d'API publique Rentila documentée (FAQ
muette) — le connecteur MCP est le seul canal. Donc même décision que
l'analyse IA : AUCUN identifiant Rentila côté serveur. Architecture
« file de commandes » :
1. Boxmail PRÉPARE (bouton 🏠 Rentila… du lecteur → modale : Pointer un
   loyer payé [locataire pré-rempli, montant extrait du texte, date du
   jour, option quittance] ou Tâche Rentila) — le formulaire est
   l'aperçu-confirmation, la commande naît « approved ».
2. File : modèle RentilaCommand (kind/params JSON/label/status
   proposed|approved|done|failed|cancelled), services/rentila-commands
   .ts, routes /rentila/commands (+/approve /cancel), compteur sur la
   carte Gestion locative (« N validée(s) — à faire exécuter par
   Claude », échecs en rouge).
3. Claude exécute via ses DEUX connecteurs : tool MCP
   rentila_pending_commands (recettes par kind dans la description —
   mark_rent_paid : retrouver locataire → loyers impayés → pointer
   change_payment_status + quittance ; AMBIGUÏTÉ = échec rapporté,
   jamais de pointage hasardeux) puis rentila_command_result
   (obligatoire, succès comme échec). 4 outils journalisés (famille
   suivi). Phrase-clé utilisateur : « exécute mes commandes Rentila ».
Testé bout en bout : API → file → client MCP réel (SDK du projet,
listTools + callTool) → report → done. Migration 20260803100041.

## 03/08 (22) — « Déjà fait » + lot Rentila réduit au technique

(691495c) « ✔ Déjà fait » sur la carte de proposition : bascule en
consignation (datetime-local pré-rempli maintenant, modifiable),
validateProposal(markDone/doneAt) → tâche née done (doneAt) ou échéance
née/passée 'done', journal « action consignée comme faite … + mail
traité ». PIÈGE réparé : le patch de la route admin par node -e n'avait
PAS matché (markDone silencieusement absent) — toujours vérifier par
grep après un remplacement programmatique. Bug corrigé au passage :
après correction manuelle vers une intention actionnable, la carte
proposait l'ancienne lecture → onReclassified re-demande reviewQueue et
re-rend l'étape sur place.
(48dc74a) Lot Rentila redécoupé (retour : « choses différentes, un par
un ; les copies de mes envois, on s'en fout ») : noise=false pour
insurance_expired/expiring, rent_late, rent_revision,
intervention_done, lease_signed → décisions individuelles ; quand la
détection a déjà créé l'échéance → proposition « Confirmer l'échéance »
(même enregistrement) ou « déjà confirmée → Continuer » (buildProposal,
branche rentila+existing en tête). Le lot ne garde que outbound_copy /
download_copy / login / tenant_connected — libellé « Rentila — copies &
technique ». Testé : 6 singles aux bonnes propositions + lot 4x.

## 03/08 (21) — Reclasser = décider, « Action à faire », un ascenseur (d6cd1e4)

Trois retours en direct pendant son premier vrai dépouillement :
1. « Si je passe le mail à Information, que dois-je faire en plus ? » →
   RIEN : reclasser vers info/promo/confirmation/livraison/otp pendant
   le dépouillement vaut décision (mail traité, étape suivante) + bandeau
   « ↩️ Annuler » 10 s (showUndoToast) — l'annulation efface la décision
   (POST /review/undo, ui_review_undo) + restaure l'ancienne intention +
   remet l'étape. Hook openReader opts.onReclassified (propagé via
   renderReaderAnalysis(a, item, opts)).
2. Le mail eToro « Vote now! » n'entrait dans aucune case → nouvelle
   intention `action_required` (« ⚡ Action à faire ») : enum + libellés
   des deux côtés, règle regex AVANT reminder (« action requise » migré),
   STRONG_INTENTS. SIMULÉE sur les sujets réels de prod : 163 puis 151
   après resserrage de « activez votre » (compte/espace/carte/accès —
   sinon marketing Getaround/Total). Converge sur les 7 boîtes. En
   review : classe important, proposition tâche (sujet en intitulé),
   régime A d'office (règle déterministe) ; correction manuelle
   d'intention = régime A d'office aussi.
3. Double ascenseur → #rv-wrap .reader.docked à calc(100vh - 172px) :
   la page ne défile plus, seul le mail défile.
Réponse à sa question « je viens de voter, je classe en quoi ? » :
⚡ Action à faire puis Vu — et les prochains seront proposés en tâche.
Testé Playwright : page sans scroll, carte eToro pré-remplie,
reclassement → « Courrier 6 sur 10 » + bandeau, Annuler → mail revenu.

## 03/08 (20) — Démarrage direct + dock + chantier 2 tranche 1 (f51c032)

Retour utilisateur : « pourquoi recliquer Dépouiller sur la page ? la
vue est à moitié vide, charge le mail par défaut et précharge la
suite ». Livré (6afbdd0) : la page #/depouillement lance le parcours
d'elle-même (reviewStart, plus d'écran d'accueil), le mail s'ouvre
D'OFFICE en colonne ancrée (openReaderFor + dock #rv-dock dans une
.inbox-layout — closeReader() sur les lots), les 2 mails suivants sont
préchargés (readMessageCached). Lien « Rouvrir le mail » conservé.
CHANTIER 2 TRANCHE 1 (f51c032) — la review à deux régimes est branchée :
- review.ts : buildProposal (facture→échéance « Payer X — avant le
  date » ou tâche sans date ; réponse→« Répondre à {prénom} » ;
  rendez-vous ; message locataire Rentila→« Traiter avec le
  locataire — {sujet} ») ; convergence() booléenne (≥2 signaux, 0
  contradiction ; grammaire Rentila = régime A d'office) ;
  enrichissement de reviewQueue (regime/proposal sur les singles non
  range, échéances existantes par messageId, historique par groupBy).
- validateProposal : transaction SQLite (objet + reviewedAt/décision),
  échéance née CONFIRMED (validation humaine), confirmation du même
  enregistrement si proposée, idempotence par état complet, IMAP hors
  transaction, UNE ligne ui_review_validate (famille Mails).
- UI : carte .prop-card (titre/date éditables + pourquoi), Valider
  primaire (les autres gestes déclassés), .prop-uncertain en régime B,
  clavier Entrée/P/V (Entrée dans un champ = sortir du champ).
Testé seeds+Playwright : [A]×3 avec bons titres, [B]×3 honnêtes,
validation done/already, échéance confirmée + tâches créées, Entrée
avance. RESTE chantier 2 : familles restantes (Rentila docs_missing,
abonnement), champs date sur tâches ?, puis chantier 3 (enchaînement
des segments) et 4 (Vue du jour passive + Quoi de neuf).

## 03/08 (19) — Confrontation Claude ↔ ChatGPT + chantier 1 (8977f9a)

Colère utilisateur : « pas guidé, les 3 boutons de temps sont stupides,
je veux une review : je note, je valide, ça passe au suivant — de
l'assistance, pas 30 % du boulot ». Demande explicite : discuter EN
DIRECT avec ChatGPT via une fenêtre Playwright (2 tours de
confrontation + 1 sujet). Fait : Chrome piloté par CDP (:9666, profil
dédié, mode ChatGPT sans connexion), 3 échanges — transcript complet
dans ux-review/confrontation-chatgpt-tri-guide.md (non versionné).
DÉCISIONS ACTÉES (co-signées ChatGPT après confrontation) :
1. Le temps est une INFORMATION, jamais une décision — choix 5/15 min
   supprimés partout (livré, 8977f9a). Pas de sélecteur de priorité non
   plus : la file EST l'autorité.
2. Review à DEUX RÉGIMES : A (signaux convergents) = écran centré sur
   la PROPOSITION pré-remplie éditable, Entrée valide, mail derrière
   « Voir le mail », une phrase « pourquoi » ; B (incertain) = aucune
   pré-sélection, honnêteté (« je ne suis pas assez sûr, lis-le »).
   Bascule = règle booléenne : ≥ 2 signaux positifs (expéditeur
   catégorisé ou vu ≥ 5×, intention fiable, date extraite, ≥ 3 gestes
   cohérents, accord IA↔heuristiques) ET 0 contradiction.
3. LISTE NOIRE jamais pré-validée : envoi de mail, corbeille, masse,
   règles, désinscription — Entrée ne peut jamais envoyer.
4. Nouveautés : auto-exécution SI (rien d'envoyé au distant + rien de
   perdu + rien de visible non validé + journalisé), puis carte
   COMPTE-RENDU « Quoi de neuf » (une par capacité, disparaît une fois
   vue) ; sinon carte-action avec aperçu exact.
5. Gabarits de proposition par famille (titres commençant par un VERBE :
   « Payer EDF — 89 € avant le 14/09 », « Répondre à Myrtille »,
   « Contacter le locataire — fuite évier ») ; Rentila en review =
   « l'échéance existe déjà → [Voir l'échéance] [Continuer] ».
6. Flux de session : Quoi de neuf → dépouillement → réponses → relances
   → échéances → factures → nettoyage → « À demain », enchaîné sans
   retour à l'accueil ; Vue du jour = « Commencer ma session » + Quoi de
   neuf + états passifs.
ORDRE DE CHANTIER : 1 temps supprimé (FAIT) → 2 review deux régimes +
gabarits → 3 enchaînement des segments → 4 Vue du jour passive.
TOURS 4-5 (Anthony s'est connecté à ChatGPT — modèle réflexion élevée ;
la conversation sans compte a été PERDUE à la connexion, reprise avec
récapitulatif) :
7. Valider une proposition = DEUX effets indissociables (objet créé/
   confirmé + mail vu), dans une transaction SQLite locale avec UNE
   ligne de journal ; l'effet IMAP reste hors transaction (tolérance
   actuelle). Unicité en base sourceMessageId+objectType (UPSERT).
   Idempotence sur l'ÉTAT COMPLET (objet présent + mail non dépouillé →
   appliquer seulement « vu »). ENTERRÉ comme gold-plating :
   proposalVersion, obsolescence, persistance des propositions (elles se
   régénèrent à l'affichage), operationId, file de sync différée.
8. Échéances en review : proposée existante → « Confirmer » (même
   enregistrement, PROPOSED→CONFIRMED) ; aucune → « Créer » (naît
   CONFIRMED, source=review) ; confirmée existante → « existe déjà,
   [Voir] [Continuer] ». Jamais de doublon.
9. Clavier = accélérateur (souris d'abord) : Entrée valide ; DANS un
   champ, Entrée sort du champ (2e Entrée valide) ; P passer, V voir le
   mail, Échap ferme ; multiligne = Ctrl+Entrée.
10. Lots : jamais de régime B (un incertain n'entre pas dans un lot ;
   une contradiction extrait LE mail, pas tout le lot) ; les interdits
   de pré-validation s'appliquent aussi aux lots.
11. Quoi de neuf : registre EN DUR versionné (rentila-parser-v1, v2 =
   nouvelle entrée immuable, capabilityFamily pour l'affichage),
   marqueurs data/ (pas localStorage), carte disparaît une fois vue
   (bilan conservé dans data/+journal), capacité à 0 mail = carte
   courte quand même.
LEÇON Playwright/ChatGPT : le sélecteur contenteditable générique
attrape le CANVAS d'une réponse (saisie partie dedans → document
corrompu, réparé par Ctrl+Z ×40) — cibler #prompt-textarea STRICT.
Transcript des 5 tours : ux-review/confrontation-chatgpt-tri-guide.md.

## 03/08 (18) — Connecteur Rentila, phase 1 (6fb5388)

Décision : écosystème de connecteurs (tour GitHub fait : Rentila_Assist,
LB2I-Fiscal-Manager, CasaSync, frais Jump…) ; on commence par Rentila.
Périmètre validé : détection par EXPÉDITEUR *@rentila.com (toutes boîtes
d'office — « pourquoi se limiter » acté ; en pratique Location_Brest).
MÉTHODE (leçon appliquée) : grammaire construite sur les SUJETS RÉELS de
prod (scan ssh boxmail → /tmp/rentila-scan.cjs, DATABASE_URL=file:…
requis, module en chemin absolu). Constats clés : extraits VIDES (HTML
seul) → tout repose sur le sujet ; fromName « SARL BRIMMO via Rentila »
= copies de SES propres envois (bruit pur) ; sujet libre = message
relayé de la messagerie (locataire — jamais du bruit).
Livré : services/rentila.ts (parseRentilaMail → kind/label/property/
due/noise, 16 kinds ; rentilaOverview) ; deadlines.ts passe Rentila
(titres réécrits en obligations, deep saute les gabarits) ; review.ts
classifyRow partagé + lot unique « 🏠 Alertes Rentila » par compte +
rentilaLabel sur les singles ; GET /rentila/overview ; carte Vue du
jour « 🏠 Gestion locative » (invisible sans activité Rentila).
Testé (seeds sujets réels + Playwright) : 3 échéances proposées aux bons
titres/dates (expirée→aujourd'hui, +30 j, révision +30 j), overview
complet, « Fuite évier cuisine » classé à décider, lot 8 notifications.
L'échéance assurance remonte d'elle-même dans « À traiter aujourd'hui »
(priorité Haute) — la boucle est bouclée sans code dédié.
PHASE 2 (à faire, prérequis : accès API/MCP Rentila côté serveur — « on
regardera ensemble ») : lecture bail/solde dans le lecteur, puis actions
validées (tâche Rentila, téléversement de document, pointage loyer).
NOTE prod : les mails Rentila DÉJÀ reçus ne créeront leurs échéances
qu'à la prochaine détection (bouton de l'écran 📅 Dates ou sync auto
pour les nouveaux arrivants).

## 02/08 (17) — Le lecteur devient un geste du dépouillement

Retour utilisateur immédiat après livraison des Lots 2-3 : « j'ouvre le
1er mail, je le supprime, je reviens à la page de dépouillement. C'est
nul. » Deux causes réelles :
1. `openReaderFor` a un défaut `onRemoved: () => route()` → supprimer
   depuis le lecteur re-rendait TOUTE la page → retour à l'accueil du
   dépouillement, session perdue.
2. Après une réponse envoyée, `#c-done` faisait `route()` → même effet.
Correctifs : le parcours passe des callbacks au lecteur — corbeille /
déplacement (`onRemoved(item, 'delete'|'move')`) et réponse envoyée
(`opts.onReplied`, transmis à openComposeModal via `onSent`) comptent
comme la décision de l'étape et font avancer la file (compteurs
`replied`/`moved` ajoutés au bilan ; la réponse enregistre aussi
reviewDecide('seen') pour sortir le mail de la file). `onSent` absent =
comportement historique (`route()`).
PIÈGE corrigé au passage : le pied d'étape utilisait la classe
`.modal-foot` — or la modale de composition écrit son bouton « Fermer »
dans LE PREMIER `.modal-foot` du document. Classe dédiée `.rv-foot`.
LEÇON : jamais de classes de modale (`modal-body`/`modal-foot`) hors
d'une modale — plusieurs écrans les ciblent par sélecteur global.
Testé (Playwright, IMAP/SMTP simulés par page.route) : répondre →
« Courrier 2 sur 6 », corbeille lecteur → « Courrier 3 sur 6 », bilan
« 1 répondu(s) · 1 mis à la corbeille », zéro retour accueil.

## 02/08 (16) — Dépouillement Lots 2-3 + correction d'intention efficace

(`633f3ce`) Fin du plan ChatGPT validé :
- **Lot 2** : le parcours vit sur `#/depouillement` (page plein écran,
  renderReviewPage → reviewIntro → reviewRun → reviewFinish ; moteur
  d'étapes extrait dans runReviewEngine, écrit dans #rv-title/#rv-body/
  #rv-foot). Reprise de session = serveur (reviewedToday + total, pas de
  localStorage). Choix du temps 5/15 min/tout : coût estimé par étape
  (lot 0,4 min, important 1,5, lecture 0,7, rangeable 0,3),
  reviewSliceByMinutes coupe la file dans l'ordre de priorité. Fin de
  session : bilan + « Il reste N — Continuer ». startReviewFlow() est
  devenu une simple navigation (Vue du jour + Boîte y mènent).
- **Lot 3** : reviewLearning() (service review.ts) agrège les décisions
  seen/trash/keep par compte|expéditeur|intention ; motif COHÉRENT
  seulement (une seule décision observée — toute contradiction éteint le
  motif) ; 2 gestes → remarque, ≥3 gestes AVEC mails en attente →
  proposition (liste exacte, « Appliquer » via reviewDecide journalisé,
  corbeille toujours confirmée, « Ne plus proposer » définitif dans
  data/review-learning.json + oplog ui_review_learning_dismiss).
  Routes GET /review/learning, POST /review/learning/dismiss.
- **Bug corrigé** (retour utilisateur en cours de session : « je passe le
  mail en information et il reste dans la Vue du jour ») : le PATCH
  /messages/intent, quand la correction porte sur le DERNIER mail entrant
  de son fil, appelle dismissReply (intent ≠ reply_expected) ou
  restoreReply (intent = reply_expected). Réponse enrichie de
  replyDismissed ; le lecteur l'affiche et recharge la Vue du jour
  derrière. Vérifié : counts.active 0, todo.replies vide, restauration OK.
Testé bout en bout (seeds + Playwright) : navigation carte→page, reprise,
proposition appliquée (4 mails corbeille confirmés), parcours 5 min,
Arrêter → bilan, Continuer → intro. Journal : dismiss_reply,
ui_review_learning_dismiss, ui_review_decide ×3. LEÇON seed : Thread
n'a pas de champ subjectKey (normalizedSubject).
Reste du plan (§5 Lot 3, non demandé explicitement) : intégrer les motifs
appris à l'écran « Règles proposées »/learning.ts et mesurer les
corrections dans la durée.

## 02/08 (15) — Dépouillement livré (Lot 1 du plan ChatGPT validé)

(`6b0c0bc`) Le cycle « décision prise » est en place :
- **services/review.ts** : ligne de base data/review-baseline.json
  (48 h au premier appel, n'avance JAMAIS — la file se vide par
  reviewedAt) ; classify() important/read/range (person + bank/admin/
  insurance + invoice/reply_expected/appointment/reminder + aiAction
  reply/pay → important ; confidence low → read, jamais range) ; lots
  homogènes clé compte|expéditeur|intention, échantillon 10 ; decide()
  seen (IMAP \Seen + index) / trash (moveToTrash lots 200 + isDeleted) /
  action (createTask source mail + messageRef) / later / keep, puis
  reviewedAt+reviewDecision, oplog ui_review_decide (famille Mails).
- Routes GET /review/summary, /review/queue, POST /review/decide
  (globales, pas par compte).
- Vue du jour : #today-review (carte Dépouiller) rempli en asynchrone.
- startReviewFlow() : modale une-étape-par-groupe ; « Décider un par
  un » éclate un lot (≤ échantillon) ; corbeille toujours confirm() ;
  fin avec décompte par décision.
- Boîte unifiée : bascule ✨ Décisions recommandées (défaut,
  localStorage inbox-view) / 🕐 Plus récents ; loadInboxReco() =
  3 sections + actions par ligne + Tout dépouiller ; uniquement sur
  @inbox unifiée (pas les dossiers ni une boîte seule).
Testé bout en bout sur seeds : action→tâche, vu, corbeille, résumé 0,
journal FR. RESTE (Lots 2-3) : reprise de session affichée, temps
choisi sur le dépouillement, apprentissage des règles après gestes
répétés, « déjà dépouillés » listés dans la vue reco.

## 02/08 (14) — Bug répondeurs automatiques + fondations « dépouillement »

(`5340900`) Bug réel : l'utilisateur répond depuis l'app, le répondeur
d'en face répond 1 min après → le fil retombait dans « À répondre » ET
disparaissait de « À relancer ». Corrigé à la racine : colonne
Message.isAutoReply (détection sujet au sync + rattrapage SQL du stock),
exclue des candidats ET des agrégats de fin de fil dans attention.ts,
et du « réponse reçue » de followups.ts. Testé sur le scénario exact.
Au passage : dérive d'index réparée (Deadline_messageId_status reporté
au schéma — Prisma allait le DROPper), et la même migration pose les
colonnes du chantier dépouillement (reviewedAt, reviewDecision, index)
issues du plan ChatGPT validé par l'utilisateur (cycle « décision
prise » : pending/decided/later, Vue du jour = orchestrateur,
Dépouiller = parcours, À traiter = obligations, Boîte = vue libre).
Lot 1 à implémenter ensuite (compteur + carte Vue du jour + parcours +
tri « décisions recommandées » de la Boîte).
Leçon test : les candidats « À relancer » exigent le rôle de dossier
'sent' — un seed dans INBOX ne les exerce pas.

## 02/08 (13) — Images cid: à la demande + lecture accélérée

(`018ec87`) La limite « images intégrées non résolues » de l'entrée 12
est levée : les pièces jointes exposent leur Content-ID (BodyNode.id /
mailparser cid), le premier rendu bloque AUSSI les cid: (plus de lien
cassé), et « Afficher les images » les résout vers
/attachments/:index?inline=1 — récupérées à la demande, jamais
téléchargées sur disque. Perfs : cache mémoire serveur des corps lus
(LRU 20, un mail est immuable), cache client (LRU 20, réouverture
instantanée — utile en mode « une par une »), Cache-Control privé 24 h
sur l'inline, loading=lazy + decoding=async injectés sur les <img>.
Testé en API mockée : cid: demandée en inline et affichée, distante
affichée, aucun lien cassé avant le clic.

## 02/08 (12) — Lecture des mails : rendu HTML fidèle + images + largeur

Retour utilisateur (capture prod) : newsletters illisibles en texte
extrait (trous partout), pas d'images, lecture étroite. Livré
(`f25e8b0`) :
- imap.ts : readEmail renvoie aussi `html` (findHtmlNode — même cas
  mono-partie que findTextNode —, decodeText, plafond 800 Ko) ; le
  texte extrait reste renvoyé (citation de réponse + analyse).
- app.js : renderReaderHtml → iframe sandbox="allow-same-origin
  allow-popups" srcdoc (PAS d'allow-scripts ; <script>/on*/javascript:
  retirés en plus par sanitizeMailHtml). Images distantes bloquées par
  défaut (src→data-x-src comptés, url(https:) neutralisé) + bandeau
  « N image(s) bloquée(s) » et bouton Afficher. <base target=_blank>.
  Mails texte : rendu brut conservé, \n{3,} compactés.
- Largeurs : reader superposé 620→min(880px,94vw) ; colonne ancrée
  inbox 44 %→54 % (min 480 px).
Limite connue : les images embarquées cid: (pièces jointes inline) ne
sont pas résolues — seules les images distantes s'affichent.
Testé via page.route (API mockée) : rendu fidèle, blocage/affichage
des images, script inerte.

## 02/08 (11) — MARCHE ARRIÈRE emojis (validée) + 3 colonnes + Risque

⚠️ LEÇON : la dé-émojisation complète (entrée 10) SUR-INTERPRÉTAIT la
demande — l'utilisateur voulait réduire les CUMULS visuels, pas
dépersonnaliser. Il a exigé (et obtenu) une liste exacte AVANT
modification. Restauration validée puis livrée (`fc26587`) :
- app.js restauré de c4c0bdd (tous les emojis reviennent) + seul
  correctif ré-appliqué : chevrons ▸/▾ de l'expand ;
- sidebar : emojis d'origine à la place des SVG, libellés connus
  (Aujourd'hui, Boîte de réception, Nettoyage rapide, Classement
  automatique, Journal d'activité, État des boîtes), logo 📬 ;
  groupes + pied de statut + badges-zéro conservés ;
- la Vue du jour reste sobre (choix validé) ; wording P1-P3 conservé.
RÈGLE DURABLE : ne plus retirer d'emojis existants ; réduire seulement
les accumulations (emoji + pastille + badges sur une même ligne).

Chantiers livrés sur la base restaurée (même commit) :
- Boîte de réception : lecture ANCRÉE en colonne droite (openReader
  option `dock`, .inbox-layout.with-reader, sticky pleine hauteur ;
  overlay conservé ailleurs et < 1100 px, closeReader referme le dock) ;
- stratégies de nettoyage : niveau de risque (retention.ts
  RISK_BY_KEY very_low/low/medium — dérivé de la clé, pas de
  migration) affiché en badge dans Nettoyage rapide et Libérer de
  l'espace ;
- pleine largeur (.main sans max-width — le 1440 px laissait un vide à
  droite sur grand écran, retour prod) + colonne Raison de la Vue du
  jour bornée à 2 lignes (.clamp2, détail en infobulle).

## 02/08 (10) — Refonte visuelle, Étape 4 : expand revu + dé-émojisation

Retour utilisateur : « la gestion de l'expand n'est pas très bien
gérée » (capture jointe illisible — corrigé sur constat propre).
Livré (`f5c3369`) :

- Expand des comptes : chevrons ▸/▾ sans cadre (comme DOSSIERS MAIL),
  sous-arbre indenté sur ligne de rappel, dossiers en texte (plus
  d'emoji de rôle), « + dossiers » retiré du titre COMPTES.
- Dé-émojisation complète de app.js : 603 emojis retirés par script
  (strip \p{Extended_Pictographic} + ↩️ + FE0F après conversion des cas
  fonctionnels : étoile ★/☆, PJ n, « liste », ↓). PIÈGE réparé : le
  titre de la boîte unifiée faisait `.replace(/^\S+ /,'')` pour manger
  l'emoji de tête des labels — devenu destructeur (« Boîte » sautait).
  Badges-emoji du bloc d'analyse supprimés (texte seul), const
  replyBadge/FOLDER_ROLE_EMOJI mortes supprimées.
- Tableau de bord renommé « État des comptes » (= sidebar) ; message
  MSAL (oauth.ts) sans emojis.

La refonte visuelle est donc complète (Étapes 1-4). Non fait,
volontairement : Boîtes mail en 3 colonnes (§9) et colonne « Risque »
du nettoyage (§10) — structurels/données, à décider séparément.

## 02/08 (9) — Refonte visuelle, Étapes 1-2 (brief « direction retenue »)

Nouveau brief utilisateur : direction « outil de pilotage professionnel »
(sidebar bleu nuit #172634, surfaces ivoire chaudes, accent #185A8C,
rayons modestes, zéro emoji/pilule/glow, icônes filaires). Livré
(`9712fe1`), EN ATTENTE DE VALIDATION avant généralisation (Étape 4) :

- styles.css réécrit en tokens (anciens noms gardés en ALIAS — aucun
  sélecteur supprimé, tout l'existant se rethème sans toucher app.js).
- Sidebar 232 px : groupes VUE D'ENSEMBLE / COMPTES / DOSSIERS MAIL /
  NETTOYAGE / AUTOMATISATION / OUTILS / SYSTÈME, icônes SVG inline
  (spritesheet <defs> dans index.html, zéro dépendance), pied avec
  point d'état + n/n synchronisés (updateSideStatus, refreshOverview).
- Vue du jour refondue : bandeau 5 indicateurs (une surface, séparateurs),
  70/30, tableau À traiter (Priorité point coloré/Action/Compte/Raison/
  Attente, lignes → lecteur) + Commencer/5-15 min conservés, Échéances à
  venir, panneaux État du système / Nettoyage proposé (Nettoyage guidé
  conservé) / Activité récente (emojis du journal neutralisés à
  l'affichage). « Bonjour Anthony » → « Vue du jour » + date.
- Désinscriptions = entrée de navigation propre (NAV_BY_ROUTE).

RESTE (Étape 4, après validation utilisateur) : dé-emojiser et aligner
les autres écrans (Boîtes mail, hubs À traiter, Nettoyage/Libérer,
Désinscriptions en tableau §11, Règles, État des comptes §8, lecteur,
modales, assistant), opLine sans emojis, largeurs de lecture.

## 02/08 (8) — Phase 3 de la revue UX : l'assistant assiste vraiment

(`cbcced7`) Trois briques, toutes côté web/ :

- **File de missions unifiée + temps choisi** : startTodoAssistant trie
  désormais TOUTES les catégories par urgence (fonction `urgency` —
  retards +50/+30, échéances 80−2×joursRestants borné [−10..30],
  ancienneté plafonnée à 10 j en départage ; poids grossiers à dessein,
  commentés). Boutons [5 min] [15 min] sur la carte « Commencer »
  (affichés si > 3 actions) : file bornée à floor(min/1,5) actions les
  plus urgentes ; l'écran de fin dit combien d'actions moins urgentes
  restent.
- **Corriger l'assistant guidé par défaut** : renderVerify éclaté en
  renderVerifyGuided (une carte « Vérification 3 sur 12 » : claim, Lire,
  Oui/Non-corriger (raisons + applyVerifyCorrection)/Je ne sais
  pas/Passer, résumé de fin) et renderVerifyList (ancienne vue) ;
  verifyRecord factorisé ; mode dans localStorage `verify-mode`,
  bascule dans l'en-tête.
- **Calendrier « À venir » par défaut** : renderCalendarUpcoming (30 j
  en liste groupée par jour, Aujourd'hui/Demain, retards en rouge,
  badge « à confirmer » cliquable vers #/deadlines, mail d'origine
  ouvrable) ; onglets À venir/Mois (localStorage `cal-view`), la grille
  et son panneau jour inchangés derrière « Mois ».

Parcours Playwright complets validés (Oui→avance, raisons, Passer,
bascule liste, assistant, bascule vues calendrier). La revue UX est
maintenant couverte sur ses trois phases ; améliorations possibles
plus tard : missions « suggestion de nettoyage » dans la file,
priorisation plus fine, largeurs de lecture (§ densité).

## 02/08 (7) — Mojibake branché + Phase 2 de la revue UX (navigation)

**Mojibake branché** (`45c6d85`) : cleanSnippet répare à la capture ;
repairSnippets réécrit sur le module séquence-par-séquence (l'ancien code
« chaîne entière », jamais branché, est supprimé) — répare le stock,
REJOUE l'intention sur le texte lisible (intentSource=auto uniquement),
recalcule la confiance des boîtes touchées, journalise (famille
Analyses). Au boot : passe unique différée 30 s, marqueur
`data/mojibake-repair.done` (le supprimer relance). Testé bout en bout
sur seeds : « Ã©chÃ©ance/â‚¬/â€™ » réparés, intention info→invoice,
confiance high reposée. Les ~3 617 extraits réels seront réparés au
premier démarrage après mise à jour.

**Phase 2 navigation** (`633f53f`, `aa1de83`) : sidebar à 7 entrées
(Aujourd'hui, Boîte de réception, À traiter, Nettoyer, Organiser,
Calendrier, Recherche) + groupes repliables « Dossiers mail » et
« Plus » (états en localStorage, ouverture auto si la page active y
vit). Les hubs gardent les routes existantes : `hubTabs()` injecte une
barre d'onglets commune en tête d'écran, centralement dans `route()`
(possible car tous les renderers posent leur page-head avant leur
premier await — vérifié : aucun renderer de hub n'est appelé hors
routeur). `highlightNav` = table NAV_BY_ROUTE. Badges sidebar réduits à
3 (Aujourd'hui, À traiter — posés par renderToday —, Mails suivis) ;
les 7 rafraîchisseurs par moteur ne sont plus appelés au boot (les
fonctions restent, no-op). Bandeau de mise à jour factorisé
(checkForUpdates) et posé AUSSI sur Aujourd'hui — indispensable
puisque État des boîtes est passé dans « Plus ». État des boîtes :
bannières santé/jamais-synchronisée en tête avec bouton Tout
synchroniser, Actions rapides supprimées.

Restent (Phase 3) : file de missions unifiée intercatégories (today.ts
agrège déjà), choix du temps disponible, mode « une vérification à la
fois » pour Corriger l'assistant, vue Calendrier « À venir » par défaut.

## 02/08 (6) — Revue UX : Phase 1 « clarté » livrée en 6 passes + mojibake commité

L'utilisateur a fourni une revue UX/UI complète (18 captures, pack local
`ux-review/` non versionné). Diagnostic central validé : l'interface
ressemblait à un panneau d'administration de moteurs, pas à un assistant.
Plan retenu : Phase 1 (clarté sans restructurer) → Phase 2 (hubs de
navigation) → Phase 3 (file de missions). La Phase 1 est livrée, en 6
commits poussés séparément :

- **P1.1 wording orienté action** (`f32b684`) : tableau de la revue
  appliqué partout — À répondre, À ne pas manquer, À relancer, Dates à
  confirmer, Mes tâches, Nettoyage rapide, Libérer de l'espace,
  Classement automatique, Règles proposées, Corriger l'assistant, État
  des boîtes ; « enrôlé »→connecté, « index (local)/indexé »→mails
  synchronisés/copie locale, importance faible/moyenne/haute→peut
  attendre/à regarder/prioritaire, plus d'« Appliquer » ambigu. Fait par
  script de remplacement ordonné avec comptage par règle (scratchpad),
  audité via git diff. Côté serveur : label moteur « important »
  (quality.ts) et fin de nettoyage (report.ts).
- **P1.2 badges & états vides** (`4b5f05f`) : compteurs seulement si
  > 0 (onglets, pastilles comptes, panneaux Aujourd'hui) ; `.empty`
  compacté (12px).
- **P1.3 un bouton principal/écran** (`db3cc0b`) : Sync rapide principal
  sur la vue compte, Tout synchroniser sur État des boîtes, ＋ Créer une
  règle sur Classement automatique ; emojis retirés des boutons.
- **P1.4 lecteur** (`87edf91`) : analyse déplacée SOUS le contenu ;
  résumé une ligne (verdict en mots + confiance + raison sans le poids
  numérique), détail dépliable ; corrections toujours visibles.
- **P1.5 journal + messages techniques** (`5e6d4d9`) : tous les
  événements traduits (défaut = phrase `result` du serveur), lots IA
  regroupés (« 240 mails analysés (5 lots) »), filtres
  Tout/Mails/Analyses/Suivi/Réglages ; erreur MSAL reformulée pour
  l'interface (le geste passe par Paramètres, plus par npm),
  SYNC_INTERVAL/ENABLE_SMTP_SEND relégués en infobulle.
- **P1.6 progression** (`79a3f1e`) : carte « N actions — environ M min
  [Commencer] » dominante sur Aujourd'hui ; « Action 2 sur 7 · ~3 min
  restantes » ; fin « C'est bon pour aujourd'hui » avec décompte.

Avant tout ça, le chantier en attente a été commité tel quel
(`1ad98cd`) : `mojibake.ts` (module écrit et mesuré, PAS ENCORE BRANCHÉ
— intégration sync + rattrapage des 3 617 extraits à faire) + garde
snippets.ts contre les demi-caractères de substitution.

Testé à chaque passe : tsc, node --check, serveur 8799 + seeds,
captures Playwright (une douzaine d'écrans). Restent pour la suite :
Phase 2 (hubs À traiter/Nettoyer/Organiser, sidebar à 7 entrées — ⚠️ y
déplacer le bandeau de mise à jour sur Aujourd'hui si le Tableau de bord
sort de la navigation), Phase 3 (file de missions unifiée — today.ts
agrège déjà, mode « une vérification à la fois » pour Corriger
l'assistant), et le branchement mojibake.

## 02/08 (5) — Les sessions survivent aux mises à jour

« À chaque maj il faut que je me réidentifie » : les sessions vivaient en
mémoire, chaque redémarrage déconnectait. Corrigé : persistance dans
data/sessions.json (jetons + expiration, mode 600, débounce 1,5 s avec
unref pour ne pas retenir l'arrêt), rechargées au boot ; TTL par défaut
porté à 30 jours glissants (ADMIN_SESSION_TTL_MINUTES pour changer).
Testé en réel : login → kill serveur → relance → toujours authentifié.
La mise à jour qui LIVRE ce correctif déconnecte une dernière fois.

## 02/08 (4) — Décision actée : l'IA lit TOUT, les règles se déduisent de ses verdicts

L'utilisateur a tranché (« fais ce que je te dis ») :
- next_analysis_batch : quand le scope douteux est ÉPUISÉ, bascule
  automatique sur les mails sans verdict (scope de la réponse fait foi) —
  la boucle Cowork horaire, sans changement de prompt, mène au traitement
  intégral. Description du tool MCP mise à jour.
- learning.ts : suggestions 🔕 DÉDUITES DES VERDICTS IA (expéditeur dont
  ≥ 8 mails lus par l'IA sont ≥ 90 % « à archiver »/« rien à faire », hors
  catégorie person, preuve chiffrée) — validation via le mécanisme
  priorités existant.
- Pièce jointe « Reglement_Copropriete… » signalée par l'utilisateur :
  DIAGNOSTIC = le fichier est un Apple Pages (application/x-iwork-pages-
  sffpages), fidèlement transmis — l'expéditrice a joint son document
  source, pas un PDF. Rien à corriger côté Boxmail.

## 02/08 (3) — Le bug des « mails sans texte » : mono-partie non lus (4 462 extraits vides)

L'utilisateur a prouvé l'incohérence : le mail Outlook « name conflicts » a
DU texte, mais son extrait était vide. Diagnostic sur le serveur : le mail
est MONO-PARTIE (text/html à la racine, sans numéro de partie) ; findTextNode
exigeait `part` → « pas de partie texte trouvée » → snippet '' définitif.
readEmail, lui, marchait grâce à son repli « mail complet » (interdit dans le
rattrapage de masse). 4 462 mails dans ce cas (+1 415 jamais tentés).

Correctifs :
- findTextNode : racine mono-partie text/* sans `part` → BODY[1] (RFC 3501).
- Migration 20260802120000 : snippet '' → NULL (au boot) pour RETENTER avec
  le correctif ; les rares vraiment sans texte reviendront à ''.
- Demande utilisateur : un extrait VIDE reste ANALYSABLE — candidateWhere ne
  filtre plus '', le lot envoie « (pas de texte lisible — juge sur le sujet,
  l'expéditeur…) », compteurs alignés sur la même base (« analysables »).
- Octet nul littéral trouvé aussi dans mojibake.ts (chantier) — corrigé.

## 02/08 (2) — Virage « je t'assiste » : mode Traiter + Ménage guidé

Demande utilisateur : « passer de je t'affiche plein de choses à je t'assiste
suivant ce que tu as à faire ». Première marche livrée sur Aujourd'hui :
- « ▶️ Traiter une par une » (panneau À faire) : l'assistant présente chaque
  action seule avec les bons boutons selon sa nature — réponse attendue
  (répondre / pas de réponse à faire / dans 3 j), facture (c'est réglé /
  tâche), échéance (confirmer / écarter / fait), relance (faite / dans 3 j) —
  + « lire le mail avant de décider » (lecteur au-dessus), ⏭️ passer,
  récapitulatif final. APIs existantes (snooze/dismiss/deadlineAction/tasks),
  tout journalisé.
- « 🧹 Ménage guidé » (panneau Bruit) : enchaîne les familles une par une
  (les plus grosses d'abord), liste exacte + lecture avant décision à chaque
  étape, corbeille ou passer, récap final.
Testé sur seeds + captures Playwright des deux modes.

Réponse aussi apportée (mail Outlook « Junk name conflict » du 01/08 sur
thony56) : trace complète du traitement — indexé à 00:02, extrait tenté à
00:02:44 mais VIDE (pas de partie texte lisible) donc jamais analysable par
l'IA ; heuristiques : intent=reminder, confiance haute, expéditeur
postmaster=notification (source ai) ; AUTO_SENDER_RE l'écarte des réponses
attendues. Le dossier Junk est bien vu (rôle spam, 0 mails).

## 02/08 — « Réponses en attente » : sortir le transactionnel (81 → 34)

Retour utilisateur : des FACTURES apparaissaient dans « Réponses en
attente ». Deux causes, corrigées après SIMULATION avant/après sur les 7
boîtes réelles (81 éléments avant, 34 après, 47 retirés — tous vérifiés à
l'œil : factures EDF/Free/Pennylane/eau, confirmations Airbnb/Smoobu/Air
France, OTP impots/Arlo/AXA, avis PayPal…) :
1. AUTO_SENDER_RE ratait les variantes à underscore/point : no_reply@paypal,
   do_not_reply@arlo, no.reply@vilogi passaient la barrière. Séparateurs
   [-._] optionnels partout (profite aussi à categorize et followups).
2. Nouveau filtre : mail dont l'INTENTION est transactionnelle (otp, invoice,
   shipping, confirmation, promo, document) ET expéditeur non-« person » ⇒
   pas de réponse attendue. Les mails de PERSONNES restent listés quoi
   qu'ils contiennent (l'artisan qui envoie sa facture). Cas limites assumés
   (relances de facture → écran échéances/paiement, pas « réponses »).

Rappel du pipeline auto (question utilisateur) : chaque sync = extrait des
150 mails les plus récents → intention → confiance → règles auto →
échéances. La boucle Cowork ne voit que ce qui RESTE douteux après ça.

## 01/08 (5) — Correction d'intention par mail + état du rattrapage IA

Nouveau dans le lecteur : l'intention de CE mail se corrige via un sélecteur
(PATCH /messages/intent) — intentSource='manual', jamais écrasée, la
confiance passe à « forte » (la correction lève le doute, le mail sort du
scope douteux). intent:null = retour au calcul auto. Journalisé.

MESURE DU JOUR (prod) : le rattrapage Cowork horaire a TERMINÉ le scope
douteux — 0 restant sur les 7 boîtes (thony56_gtr : ~9 000 → 0 depuis le
30/07). 11 298 analysés / 14 659 lisibles (77 %). Restent 3 361 « sans
verdict » (confiance haute + intention précise — jamais visés par le scope
douteux, gain marginal) et 5 875 sans texte exploitable (non analysables).
Recommandation donnée à l'utilisateur : réduire la boucle Cowork horaire
(plus rien à rattraper), « tout analyser » = ~2-3 $ via Haiku ou des heures
de forfait pour un gain surtout côté verdicts « à archiver ».

## 01/08 (4) — Lecture auto-réparante + correction du classement dans le lecteur

Bug : « Lecture impossible : Input cannot be null or undefined » sur un mail
du dossier Sent — mailparser recevait undefined quand l'UID de l'index était
périmé (mail déplacé/re-rangé). Corrigé à trois étages :
- imap.ts : erreur claire en français quand le mail n'est plus à cet
  emplacement (fetchOne vide, download sans contenu) ;
- route de lecture : AUTO-RÉPARATION — le mail est recherché par son
  Message-ID ailleurs dans l'index, relu là-bas, l'ancienne ligne morte est
  retirée, la réponse porte relocated=true ;
- lecteur : suit le nouvel emplacement (actions sur le bon dossier/UID),
  bandeau « retrouvé dans X », et le message d'échec pointe vers la
  synchronisation.

Boucle de correction (réflexion « comment je te signale une erreur ») :
le panneau 🤖 Analyse du lecteur affiche désormais le CLASSEMENT (intention
du mail + badge auto/IA/corrigé, catégorie et priorité de l'expéditeur) avec
correction SUR PLACE (sélecteurs) via les API existantes — s'applique à tous
les mails de l'expéditeur, manual > ai > auto, journalisé. Rappels : la
lecture d'un mail ici le marque déjà lu côté Outlook (FETCH \Seen) ; l'écran
🔬 Vérifier l'analyse reste le canal « verdict » ; 💡 Suggestions le canal
règles.

## 01/08 (3) — Mise à jour production accélérée + patience de l'interface

Le bandeau « serveur pas revenu après 3 minutes » est apparu sur
boxmail.lb2i.com alors que la mise à jour avait RÉUSSI : elle dépassait juste
la patience de l'interface, et le message parlait de MailAssistant.bat sur un
serveur Linux. Corrigé :
- deploy/update.sh : étapes conditionnelles (mêmes empreintes que le
  superviseur, stockées dans logs/state-*) ; échec ⇒ empreintes effacées.
  Mesuré en réel sur la VM : mise à jour complète (install+generate+build
  incrémental) en 13,9 s, pm2 revenu aussitôt.
- Interface : attente 10 min (compteur de secondes), point d'étape rassurant
  à 3 min, message final selon VersionInfo.platform (PC → MailAssistant.bat,
  serveur → voir Paramètres → Mise à jour).

## 01/08 (2) — Mise à jour en ~10 s : superviseur à étapes conditionnelles

« Chaque mise à jour prend 3 minutes » : le superviseur refaisait npm install +
prisma generate + migrate + tsc à CHAQUE tour. Désormais chaque étape ne tourne
que si ses entrées ont changé (empreintes package-lock / schema.prisma / arbre
`git rev-parse HEAD:src` + tsconfig, état dans
`node_modules/.mailassistant-state.json`). Migrate retiré du superviseur (le
boot l'applique déjà via ensureMigrationsApplied). tsc incrémental activé
(dist/.tsbuildinfo). Modifs locales non commitées sur src/prisma/lock ⇒ passe
complète ; échec de build ⇒ état effacé, passe complète au tour suivant.
Testé en réel : voie rapide = pull 1,8 s + 3 « étape sautée » + serveur en
ligne ~5 s ; relance après arrêt idem. ATTENTION : le superviseur se charge en
mémoire au lancement — la version rapide ne prend effet qu'au prochain
double-clic sur MailAssistant.bat (la mise à jour qui la livre passera encore
par le chemin lent une fois).

## 01/08 — Clarté de l'interface : ordre des boîtes, quota expliqué, compteurs IA par boîte

Retour utilisateur : « tout est un peu noyé » — actions pas claires, comptes non
triables, quota jamais affiché malgré une synchro totale, et deux compteurs
d'analyse contradictoires (« il reste 4 500 » vs « 42 % analysés »).

1. **Ordre des boîtes choisi par l'utilisateur** : `Account.sortOrder`
   (migration `20260801090000`), boutons ↑/↓ dans Paramètres, route
   `PUT /api/accounts/order`. `globalOverview` et la route `/overview` trient
   par `(sortOrder, slug)` → barre latérale, tableaux, sélecteurs et MCP
   suivent tous le même ordre.
2. **Quota enfin diagnosticable** : `fetchQuotaDiagnostic` (imap.ts) dit
   POURQUOI la capacité est inconnue (capacité QUOTA non annoncée, réponse
   sans limite, commande en échec…) ; stocké dans `Account.quotaNote` +
   `quotaCheckedAt` à chaque sync ; bouton « 📏 Quota » dans Paramètres pour
   relire à la demande (`POST /api/accounts/:slug/quota/refresh`). Partout où
   l'interface disait « quota inconnu », elle affiche maintenant la raison.
   À VALIDER EN RÉEL par l'utilisateur : si Outlook n'annonce pas QUOTA, la
   note le dira noir sur blanc.
3. **Compteurs d'analyse réconciliés** : `analysisProgressByAccount()`
   (4 requêtes groupBy) → `/api/analysis/coverage` renvoie `aiAccounts` ;
   Paramètres affiche un tableau PAR BOÎTE (mails, texte connu, analysés IA,
   douteux restants, sans verdict) avec la légende : « douteux restants » =
   le « il reste N » annoncé par Cowork (portée uncertain), « analysés IA » =
   verdicts / mails lisibles. Les deux chiffres étaient vrais, personne ne
   pouvait les rapprocher.
4. **Provenance des mails** : légende cliquable « Provenance : [boîte]… » en
   tête de la vue unifiée (clic = filtre sur la boîte) ; les pastilles de
   compte existaient déjà sur les lignes.
5. **Tooltips explicites** sur les actions sensibles (corbeille en masse,
   lecteur, nettoyage, actualiser…) : chaque bouton dit ce qu'il fait et
   rappelle le garde-fou (corbeille récupérable ~30 j, confirmation).
6. **Piège évité** : le chantier mojibake non commité avait un OCTET NUL
   littéral dans `snippets.ts` (classe de caractères de contrôle) — ripgrep
   classait le fichier binaire et le sautait en silence. Remplacé par les
   échappements `\u0000-\u001F`. Le chantier reste non commité.

Testé : typecheck, node --check, migration sur base locale, serveur 8799,
seeds synthétiques (compteurs exacts : 3 lisibles / 1 analysé / 1 douteux),
captures Playwright des écrans Paramètres et boîte unifiée.

## État (session en cours)

**TOUR 3 D'ANALYSE + 4 RÈGLES CONVERGENTES CODÉES (30/07).** 1 809 mails jugés,
221 expéditeurs corrigés, 0 rejet. **Quatre boîtes bouclées** (Altoen, Brimmo,
Au-marais, Location_Brest — 0 douteux) ; Colocar 4, Econom 3 ; thony56_gtr
8 982 restants (13 % de couverture, mais lecture des extraits à 100 %).

**MÉTHODE : ne coder qu'une règle qui CONVERGE sur plusieurs boîtes.** Les
agents en ont proposé 23 ; 4 retenues. Une règle vraie sur une seule boîte est
une coïncidence.

1. **LE PLUS GROS TROU DU MOTEUR ÉTAIT LA PUBLICITÉ.** Sur Location_Brest,
   165 mails sur 323 (51 %) étaient de la pub classée `info` — donc invisible
   pour `promo30`. Les sujets réels n'emploient JAMAIS le mot « promo » :
   « ⏳ 72H Flash », « on vide les caisses », « 💸On baisse le prix »,
   « 17 500 € d'économie », « vos 10€ vous attendent ». Motifs élargis, et
   surtout la pub est désormais cherchée **dans l'extrait** — seul motif faible
   admis là, sous DEUX conditions : enveloppe marketing (`hasListUnsubscribe`,
   ce qui la distingue d'un contrat mentionnant « -20 % ») et aucun marqueur
   d'obligation. Mesure : +147 mails reconnus.
2. **VETO D'OBLIGATION** (`OBLIGATION_RE`) : `bonjour@comptastar.fr` envoie le
   parrainage ET « [ACTION REQUISE] – Mise en conformité », dont l'enjeu est la
   dissolution. Sans ce veto la règle 1 aurait balayé le second avec le premier.
3. **BOÎTE DE FONCTION ⇒ `company`, jamais `person`** (`compta@`, `agence-…@`,
   `recouvrement@`, `sav@`, `tcs@`). ~20 expéditeurs Brimmo étaient `person` —
   la catégorie la plus protégée — donc soustraits au nettoyage ET à l'analyse.
   Périmètre étroit EXPRÈS : ni `contact@`, ni `info@`, ni `service@` (adresses
   ordinaires des artisans, testées en contre-cas) ; aucune tentative de
   reconnaître les boîtes nommées d'après une ville — rien ne les distingue
   mécaniquement d'un surnom.
4. **DEUX MOTIFS PROTECTEURS** : « appel de fonds » était classé RENDEZ-VOUS à
   cause de la date (ni facture ni protection) ; les avis de versement (« Un
   versement de 1 629,58 € a été envoyé ») deviennent `document`, le montant en
   € étant exigé pour ne pas attraper « 500 GuestPoints offerts ».

**DÉFAUT DE CAPTURE CORRIGÉ** : sans partie `text/plain`, l'extrait stocké était
du balisage brut — les heuristiques le lisaient COMME DU TEXTE (elles pouvaient
s'accrocher à n'importe quel mot du HTML) et l'IA le jugeait inexploitable, donc
~110 mails de la boîte perso restaient protégés à vie. `cleanSnippet` dégage
maintenant le texte (détagage sans dépendance + décodage des entités : le
courrier français en est truffé, sans quoi « n&deg;2281 » devenait « n 2281 »).

**LA SIMULATION A ENCORE SAUVÉ LA MISE — 2e fois de la série.** Passage à blanc
sur les 21 167 mails réels AVANT d'appliquer : (a) « cadeau » attrapait « Re:
cadeau pour noah », un mail de famille ; (b) « à saisir » attrapait « Pensez à
saisir vos réponses » (saisir = renseigner) ; (c) ma règle de boîte de fonction
passait DEVANT la détection de newsletter, si bien que
`service.client@mails.totalenergies.fr` sortait de `newsletter90` — la règle
devait empêcher `person`, pas rendre un expéditeur MOINS nettoyable. Les trois
sont devenus des contre-cas du test (43 assertions).
**RÈGLE DE TRAVAIL : toujours simuler sur les données réelles avant d'appliquer
une règle de classement. Un test unitaire ne peut pas voir ces cas.**

**MÊME BUTÉE QU'AVANT, CONFIRMÉE** : +147 promos reconnues → +45 récupérables
seulement, parce que `promo30` exige `unseenOnly`. La classification n'est plus
le goulot, **les stratégies le sont**. D'où le preset **`promo365`** (« plus d'un
an, même déjà ouvertes », désactivé) : **1 979 visés, 105 protégés**.
Récupérable : 8 542 → **8 762 mails / 1,3 Go**.

**`npm run audit` LIVRÉ + 20 DÉFAUTS CORRIGÉS (30/07).** Déclencheur : « ce que
tu as découvert là doit se produire partout ailleurs » — chaque défaut trouvé
jusque-là avait demandé une capture d'écran de l'utilisateur.

**L'OUTIL** (`src/cli/audit.ts`, 6 familles A→G). Ce qui a de la valeur est la
partie DYNAMIQUE : on exécute les vrais services sur la vraie base, on capture
le SQL réellement émis (événements Prisma, activés par `BOXMAIL_SQL_TRACE=1`
pour ne rien coûter en prod) et on le passe à `EXPLAIN QUERY PLAN`. Les règles
statiques sont des regex sur 7 000 lignes de JS : marquées « à vérifier »,
JAMAIS « confirmé ». Persistance : `docs/audit-findings.json`, clé STABLE
`famille:fichier:fonction:règle` (jamais le n° de ligne) ; le script rafraîchit
tout ce qui est CALCULÉ (gravité, titre, mesure) et ne touche jamais aux trois
champs DÉCIDÉS (`status`, `note`, `firstSeen`). `docs/AUDIT.md` est régénéré.
⚠️ Sur le serveur : **`npm run audit -- --out logs`** — écrire dans `docs/`
salirait l'arbre Git et ferait échouer le `git merge --ff-only` de la mise à
jour. Les statuts sont toujours lus dans `docs/` (versionné).

**QUATRE DÉFAUTS DE L'OUTIL, tous trouvés en l'exécutant** — à relire avant
d'ajouter une règle : (1) la regex `class="…"` avalait les gabarits
`${x ? 'a' : 'b'}` → 103 faux positifs ; (2) beaucoup de classes n'ont
VOLONTAIREMENT aucun style, ce sont des crochets `querySelector` → 44 faux
positifs ; ne reste signalée que la classe ni stylée NI interrogée (c'est ainsi
qu'on trouve `.tablewrap`) ; (3) **`EXPLAIN QUERY PLAN` désigne les tables par
leur ALIAS** (« SCAN f », « SCAN main.AttentionState ») : la 1re version
extrayait « f » et « main », ne les trouvait pas, et les écartait EN SILENCE —
un « SCAN m » sur 34 877 lignes serait passé inaperçu, le faux feu vert qu'un
audit ne doit jamais donner ; (4) un passage `--static` faisait passer tous les
constats mesurés pour « disparus ». Et `nowrap` SEUL ne tronque pas : il faut
`ellipsis`, ou `nowrap` AVEC `overflow:hidden`.

**LE DÉFAUT CENTRAL CORRIGÉ : `openCleanupModal`**, jumeau exact du bug du
29/07 mais sur l'écran qui SUPPRIME. Quatre défauts imbriqués : le sujet était
dans un `<label>` englobant (cliquer COCHAIT la case), son `title` portait les
signaux et non le sujet (donc le sujet tronqué était irrécupérable), modale de
560 px, pas de `under-reader`. Cause racine côté API : `CleanupMessage` n'avait
ni `account` ni `folder` alors que la route connaissait le dossier. Corrigé
aux deux niveaux ; 14 vérifications navigateur dont le contre-cas « cliquer le
sujet ne bouge pas la case » et « lecteur z 96 au-dessus de l'overlay z 94 ».

**UNE CORRECTION DE MON PROPRE AUDIT** : j'avais classé « critique » le
`sampleSubjects: string[]` de `previewSenderCleanup` en le prenant pour
l'échantillon affiché avant suppression. Il n'était affiché NULLE PART — code
mort, supprimé. Vérifier qu'un constat atteint l'écran avant de le juger grave.

**AUTRES CORRECTIFS** : `openNoiseModal` (date en dernière colonne + expéditeur
`nowrap` sans plafond = le mécanisme d'hier), `openRulePreview` + `rules.ts`
(coordonnées jointes, sujets ouvrables), `renderToday` (date de réception et
ouverture au clic posées dans `todayRow`, donc les 4 listes d'un coup ; pour une
échéance c'est `msgDate`, la date du MAIL), `.tablewrap` (classe morte → règle
ajoutée), index `Deadline(messageId,status)` / `AnalysisFeedback(messageId)` /
`AttentionState(messageId)`, **`PRAGMA optimize`** au démarrage (l'`ANALYZE`
d'une migration ne joue qu'UNE fois — il fournissait la moitié du gain
40 s → 178 ms, et les statistiques auraient péri sans signal).

**OCTETS NULS dans `retention.ts` et `categorize.ts`** : ils étaient
INTENTIONNELS (séparateur de clé composite `` `${a}\0${b}` ``, bon choix) mais
ripgrep classait les fichiers « binaires » et les SAUTAIT en silence. Remplacés
par l'échappement `\u0000` — chaîne identique à l'exécution, source lisible.

**BILAN : 70 constats, 22 clos (20 corrigés + 2 faux positifs assumés),
48 ouverts — aucun critique, aucun grave.** Restent (dans `docs/AUDIT.md`,
`status: todo`) : les culs-de-sac analytiques (`report`/`learning`/
`unsubscribe` n'exposent aucun mail cliquable), `tasks.ts` sans `msgDate`,
`learning.ts` qui conserve l'auto-jointure par ligne que `Sender.engagedAt` a
éliminée ailleurs, les N+1 en écriture (`rebuildSenders` 3 677 upserts,
`linkThreads`, `unsubscribe` ×1000), `ORDER BY RANDOM()` ×10 dans `quality.ts`,
et 7 balayages de table mesurés — tous sous 700 ms aujourd'hui, donc classés
faible avec leur chrono : **un audit qui crie au loup ne sert à rien.**

**C3c LIVRÉ + LA PAGE DE NETTOYAGE PASSE DE 40 s À 0,2 s (29/07).** Trois
choses, toutes déclenchées par une mesure ou une capture de l'utilisateur.
1. **Stratégie « verdict IA »** (preset `ai_archive90`, désactivé comme les
   autres) : `RetentionPolicy.matchAiAction`. RAISON CHIFFRÉE — 3 263 mails
   jugés « à archiver » par l'IA dont **2 026 DÉJÀ LUS**, or `promo30` et
   `newsletter90` exigent `unseenOnly` : ces mails étaient hors d'atteinte de
   TOUTE stratégie alors qu'ils avaient été lus un par un. L'analyse n'était
   plus le goulot, les stratégies l'étaient. Exige `analysisConfidence='high'`
   (la protection centrale n'écarte que `low` — sans ce test un « peut-être »
   entrerait dans une purge). Vise 2 447 mails, 203 protégés.
2. **PERF, en deux temps, chaque fois en MESURANT au lieu de supposer.**
   (a) `engagedSenderClauses` rejouait PAR LIGNE et par requête un auto-join de
   Message sur threadId filtré par (compte, expéditeur) — 364×364 opérations
   pour Leroy Merlin seul, ×14 requêtes. Pré-calculé dans `Sender.engagedAt`
   par `computeSenderEngagement` (appelé depuis `rebuildSenders`) → 40 s →
   12,9 s. Sémantique identique, y compris « date inconnue = engagement
   d'aujourd'hui ». (b) Restait 12,9 s : chronométrage PAR STRATÉGIE →
   `newsletter90` 7,5 s, `social90` 2 s, les autres < 400 ms ; point commun =
   `Sender.category`, indexé nulle part. Index + **ANALYZE** (que SQLite ne
   lance jamais seul — sans statistiques son planificateur ignore les index)
   → **178 ms**. Vérifié en prod : listPolicies 235 ms, deletableUnion 141 ms.
   LEÇON : j'ai d'abord optimisé les clauses de protection ; elles ne
   coûtaient que 179 ms. Chronométrer avant de coder.
   ⚠️ `Sender.engagedAt` DOIT être backfillé après déploiement, sinon la
   protection graduée disparaît (fait : 1 155 / 3 676 expéditeurs engagés).
3. **Aperçu de stratégie lisible** (« pas de possibilité de lire le détail en
   cas de doute, pas de date de la réception, mail de 2020 pas traité pareil
   que 07/2026 »). La date ÉTAIT renvoyée par l'API — la table débordait du
   cadre et la colonne se retrouvait coupée à droite. `modal-wide`, colonne
   « Reçu le » remontée en 2e position, sujets ouvrables via `under-reader`
   (le lecteur s'ouvre AU-DESSUS de l'aperçu).
Récupérable : 7 050 → **8 225**. Test : 16 asserts (contre-cas compris :
confiance moyenne écartée, verdict « à lire » écarté, trop récent écarté,
protection graduée vérifiée dans les deux sens).

**C4 LIVRÉ (29/07) : les trois règles tirées de la passe, codées dans le
moteur.** Choix assumé : les règles vont dans `categorizeSender`, PAS dans un
écran de suggestions — c'est là qu'elles servent aux ~31 000 mails que l'IA
ne jugera jamais. Chaque règle est adossée à une requête en base, et la
CAUSE réelle différait de ce que la première passe laissait croire :
1. **Le raccourci « conversation » fabriquait les fausses personnes**
   (860 des 1 084 « personne » automatiques portaient la raison « vous avez
   déjà échangé »). Un accusé de non-remise EST une réponse à ton envoi : le
   fil contient un sortant ⇒ « conversation » ⇒ « personne », la catégorie la
   PLUS protégée. Et le test d'adresse automatique passait APRÈS, donc n'était
   jamais atteint. Ce n'était PAS le nom affiché, contrairement à ce que
   j'avais écrit d'abord. Correctif : garde-fou `isServiceAddress` DEVANT le
   test de conversation. Volontairement restreint : ni `info@`, ni `contact@`,
   ni `service@` (adresses ordinaires des artisans réels — testé).
2. **Caisses bancaires régionales invisibles** : elles écrivent depuis
   `ca-<region>.fr` sans jamais nommer « crédit agricole ». Ajout de
   `ca-*.fr`, `e-ca-*.fr`, `cmb.fr`, monabanq/oney/cofidis/bpp…
3. **Marque protégée refusée depuis une boîte GRATUITE.** PIÈGE ÉVITÉ DE
   JUSTESSE : ma première version n'acceptait la marque que dans l'adresse —
   la simulation sur les 2 996 expéditeurs réels a montré qu'elle déclassait
   23 organismes AUTHENTIQUES passant par un prestataire (`no-reply@xoom.com`
   pour PayPal, `bnpp-epargne-entreprise@s2e-net.com`, une agence AXA).
   Le bon critère était ailleurs : `team_execsales@accountant.com` est un
   webmail gratuit (famille mail.com) — une banque n'écrit jamais de là.
   **TOUJOURS simuler sur les données réelles avant de déployer une règle de
   classement** : le test unitaire seul n'aurait pas vu la régression.
Ajout des réseaux 2000 (hi5, Meetic, Badoo, Skyrock, Copains d'avant, WAYN,
Facebox, Viadeo, MySpace). Test : 37 asserts bâtis sur des expéditeurs
RELEVÉS EN BASE, contre-cas compris. Backfill lancé sur les 7 boîtes.
MESURE : récupérable 6 746 → **6 925** (+179), fausses « personnes » auto
1 084 → 1 013 (−71). Le gain en volume est modeste ; le vrai gain est la
sûreté (les documents bancaires ne sont plus du bruit).

**PREMIER RATTRAPAGE MASSIF EXÉCUTÉ (29/07) : 3 389 mails jugés, 677
expéditeurs corrigés.** Demande utilisateur : « répare les extraits et lance
ici par blocs de 500 les analyses de mails. Tu peux le donner à un agent
dédié. » Méthode : **un agent par boîte** (les scopes doivent être DISJOINTS
— `next_analysis_batch` n'a AUCUN mécanisme de réservation, deux agents sur
la même boîte recevraient les mêmes mails), 5 lots de 100 chacun, via la
recette PowerShell MCP (initialize → capturer `mcp-session-id` → tools/call ;
réponses en SSE, JSON dans `.result.content[0].text`). Résultat : 3 389
appliqués, **0 rejet**, Econom entièrement bouclée. Confiance faible :
4 071 → 3 405. Récupérable mesuré APRÈS : 6 746 (je n'avais pas pris la
mesure AVANT — à faire au prochain tour, c'est LA métrique de C5).
Actions proposées : archive 2 023 / read 1 162 / reply 74 / pay 44.

**CE QUE L'ANALYSE DE CONTENU A RÉVÉLÉ — matière brute pour C4.** Un motif
domine, confirmé sur les 7 boîtes : **les robots dont le nom affiché est un
nom humain étaient classés `person`**, donc protégés à vie par la garantie
« 0 mail personnel » et INNETTOYABLES. Exemples réels : `Yao Eve
<member@hi5.com>`, `Morgane Mahe <first_reminder@whereareyounow.net>`,
« Florian de Meilleurtaux », « Marc De Diego Ferrer » (MCA Andorra, ~30
mails), « Alerte PERCHE David » (agences immo), et `postmaster@outlook.com`
DANS CHAQUE BOÎTE. Règle à coder : nom affiché humain + adresse de service
(no-reply/member/notification/first_reminder/alerte) ⇒ jamais `person`.
Deux erreurs symétriques, plus graves que le bruit : **un faux PayPal
(`team_execsales@accountant.com`) était classé `bank` en confiance haute** —
l'hameçonnage héritait de la protection bancaire ; et **le Crédit Agricole
Morbihan était classé `newsletter`** sur Econom — ~60 mails de documents
bancaires traités comme du bruit, dont un « Avis Tiers Détenteur » (saisie
sur compte). Les heuristiques se trompaient dans les DEUX sens sur ce qui
compte le plus. Erreur inverse aussi : « Mes primes Travaux » classé
`social` alors que c'est un interlocuteur réel (primes CEE, 1 943 €).

**GARDE-FOU « DATABASE IS LOCKED » : JAMAIS INSTALLÉ (trouvé et corrigé).**
Découvert en lançant une mesure : chaque démarrage loggait « SQLite : PRAGMA
non appliqués — Execute returned results, which is not allowed in SQLite »,
jamais lu. CAUSE : `PRAGMA busy_timeout = 5000` RENVOIE une ligne, ce que
Prisma refuse sur `$executeRawUnsafe` ; les trois PRAGMA partageant un seul
`try`, l'exception emportait les deux derniers. En production : WAL était
bien posé (premier, et via `$queryRawUnsafe`), mais **busy_timeout restait à
0 et synchronous au défaut** — la protection P0.1, celle-là même dont
l'absence avait fait échouer une mise à jour, n'existait pas. Correctif :
tout par `$queryRawUnsafe`, un `try` PAR pragma, et RELECTURE des valeurs
journalisée (sans relecture une perte reste invisible — c'est exactement ce
qui s'est produit). Vérifié en production : `wal / 5000 / 1`, zéro
avertissement. Test : 4 asserts ; busy_timeout et synchronous étant des
réglages PAR CONNEXION, les voir posés prouve que c'est le code qui les met.

**Sur le contenu des boîtes (à ne plus redécouvrir).** `Colocar` n'est PAS
de la colocation immobilière malgré son nom : c'est la SASU de location et
négoce de VÉHICULES (salles des ventes, cartes grises, Getaround).
`Au-marais` est une location saisonnière parisienne (Airbnb puis
HomeExchange, Smoobu, Stripe). `Brimmo` tourne quasi entièrement autour du
rachat/réhabilitation du 46 rue de la République à Brest. `thony56_gtr` : le
plus ancien fond est de 2006-2008 (eBay, Assedic, réseaux sociaux morts).

**RESTE À FAIRE.** thony56_gtr = 10 115 douteux (4 % fait) — à ce rythme 20
tours ; c'est l'argument pour C3b (Haiku serveur, ~4,70 $ le reliquat,
~2,35 $ en Batch API — clé API Anthropic requise, PAS ENCORE DEMANDÉE à
l'utilisateur). Autres restes : Brimmo 1 126, Au-marais 859,
Location_Brest 822, Altoen 294, Colocar 184. La lecture des extraits n'est
pas finie sur thony56_gtr (15 333 / 20 220) : le nombre de douteux MONTERA
encore à mesure qu'elle avance. Puis C4 (coder les règles ci-dessus) et C5.

**C2 + C3a LIVRÉS (29/07) : l'IA peut enfin juger, et son verdict DÉBLOQUE le
nettoyage.** Migration `ai_verdict` (Message.aiSummary/aiAction/aiVerdictAt/
aiModel/intentSource). `services/analysis.ts` : `nextAnalysisBatch` (lot
compact — c'est le forfait qui paie ces jetons), `applyVerdicts` (CHEMIN
D'ÉCRITURE UNIQUE des deux moteurs), `analysisProgress`. 2 tools MCP
(`next_analysis_batch`, `submit_analysis_batch`) : la session Claude boucle
jusqu'à `remaining=0`. LE CHOIX QUI FAIT TOUT : l'IA écrit dans les champs
EXISTANTS avec `source='ai'` → aucun moteur à modifier. TROIS PROTECTIONS
indispensables, sans lesquelles la sync suivante effacerait le rattrapage :
`categorizeAccount` saute `intentSource='ai'`, `computeConfidenceForAccount`
saute `aiVerdictAt != null`, `rebuildSenders` traite `categorySource='ai'`
comme `'manual'`. L'IA ne remplit la catégorie d'un expéditeur que si elle vaut
`company`/vide ET si le verdict est sûr (sinon elle changerait au gré des
mails). Tests : 35 asserts, dont la preuve de bout en bout — `deletableUnion()`
passe de 0 à 1 quand le verdict remonte la confiance, et retombe à 0 si on la
rebaisse. **PRÉ-REQUIS UTILISATEUR pour le rattrapage : brancher le connecteur
MCP** (`https://boxmail.lb2i.com/mcp` + bearer) sur une session Claude, puis
demander « analyse mes mails ». RESTE : C3b (Haiku serveur, flux courant),
C4 (règles découvertes), C5 (mesure du gain).

## Accès au serveur de production (à ne plus rechercher)

- VM Oracle : `ubuntu@51.170.60.55` (hôte `instance-20260728-1911`), dépôt
  dans **`/home/ubuntu/boxmail`**, app sous pm2 (`boxmail-mcp`).
- Clé privée rangée sur le PC de l'utilisateur :
  `C:\Users\leberan\.ssh\oracle-boxmail.key` (droits restreints à son compte),
  avec un raccourci dans `~/.ssh/config` : **`ssh boxmail`** suffit.
- **PIÈGE (perdu ~1 h le 29/07)** : l'« Oracle Cloud Shell » de la console
  N'EST PAS la VM — c'est une machine de console séparée, avec son propre
  clone du dépôt dans `~/boxmail`. Une commande lancée là-bas met à jour ce
  clone et ne touche PAS la production ; le symptôme est
  `bash: pm2: command not found`. Toujours vérifier l'invite : `cloudshell`
  = mauvaise machine.
- Mise à jour désormais gérée par un **minuteur systemd**
  (`boxmail-update.timer`, chaque nuit 04:00 UTC) qui exécute
  `deploy/update-boot.sh` → `deploy/update.sh`. `AUTO_UPDATE_HOUR=-1` dans le
  `.env` du serveur : la mise à jour interne à l'app est éteinte, il n'y a
  qu'UN responsable.
- Vérification rapide qu'un déploiement a pris : `GET /api/analysis/coverage`
  répond **401** (route existante, session requise) et non 404.
- Ne JAMAIS déposer de clé dans le dossier du projet : `git add -A` la
  publierait. `.gitignore` couvre désormais `*.key`, `*.pem`, `id_rsa*`.

## État (fin de session précédente)

**LA MISE À JOUR DEPUIS L'INTERFACE NE POUVAIT PAS FONCTIONNER SOUS LINUX
(29/07) — corrigé.** Symptôme : serveur bloqué sur `01fbb4e` (23h03), 5
commits de retard, avec « ⚠️ dernier passage 06:00 : échec — npm run build
a échoué (code 2) : error TS2688 ». CAUSE, reproduite en local : pm2 lance
l'app avec `NODE_ENV=production` (ecosystem.config.cjs), donc tout
`npm install` lancé PAR l'app hérite de cet environnement et npm écarte les
devDependencies — `@types/node` disparaît (`typescript` survit, d'où un tsc
qui démarre puis meurt sur `TS2688: Cannot find type definition file for
'node'`, à cause de `"types": ["node"]` dans tsconfig). Le déploiement
initial passait, lui, par SSH — shell normal, devDependencies installées :
**le bouton de mise à jour n'avait donc jamais réussi sous Linux**.
CORRECTIF : `npm install --include=dev` dans update.ts ET autoupdate.ts
(vérifié : sans le flag `@types/node` disparaît et le build meurt ; avec, il
passe, à `NODE_ENV=production` inchangé). DEUX DÉFAUTS RÉVÉLÉS AU PASSAGE,
corrigés aussi : (1) `cachedVersion` n'était vidé qu'en fin de mise à jour
réussie — après un échec, l'interface affichait l'ANCIEN commit tout en
annonçant « ✅ à jour » (le dépôt, lui, était en avance après le pull) ;
c'est ce qui rendait la panne illisible. Le cache est maintenant vidé juste
après le pull. (2) `applyUpdate` (bouton) n'avait AUCUN retour arrière,
contrairement à `runAutoUpdate` — un échec laissait le dépôt en avance sur
le binaire en service. Retour arrière ajouté, symétrique.
**AMORÇAGE** : le correctif ne peut pas s'appliquer tout seul (le code qui
tourne est l'ancien, il relancera l'ancienne commande) — une intervention
SSH unique était nécessaire, cf. la commande donnée à l'utilisateur.

**SÉRIE C LANCÉE — C0 + C1 LIVRÉS : l'assistant lit enfin le TEXTE des
mails (29/07).** Déclencheur : « je ne suis pas du tout satisfait du
résultat […] rajoute un peu d'IA, au moins sur les 3 derniers mois ».
DIAGNOSTIC (vérifié dans le code) : tout le classement tenait sur deux
signaux — des listes de marques en dur (`categorizeSender`, hors listes ⇒
`company`, la case « je ne sais pas ») et des regex **sur le sujet seul**
(`detectIntent`, sans motif ⇒ `info`). Engrenage : `computeConfidence`
traite `company` comme non-signal, donc inconnu + `info` ⇒ **confiance
faible**, et `protectionClauses` (retention.ts) exclut la confiance faible
de tout nettoyage. **Tout mail non reconnu était donc à la fois mal analysé
ET non nettoyable** — le moteur était muet là où il devait travailler.
RACINE : l'index ne stockait AUCUN texte. Livré : `Message.snippet` /
`snippetAt` (migration), `imapService.fetchSnippets` (un verrou, plage
`a:b`, download de la SEULE partie texte — **aucun repli sur le mail
complet**, il aspirerait la boîte sur un rattrapage), `services/snippets.ts`
(backfill reprenable via job « extraits », passe post-sync limite 150 sur
les plus RÉCENTS, `analysisCoverage` = la mesure « avant » de C0),
`detectIntent` accepte l'extrait — consulté en DERNIER recours et sur les
seuls motifs FORTS (les motifs faibles « confirmation / document / promo »
classeraient la moitié de la boîte de travers). PIÈGE TRAITÉ : après
correction d'une intention on recalcule la confiance EN ENTIER — jamais de
remise à `null` pour forcer un « onlyMissing », parce qu'une confiance
nulle n'est pas « faible » et ne déclenche donc PAS la protection (une
rétention auto lancée entre-temps viserait ces mails). Interface : panneau
« 🔎 Compréhension des mails » dans Paramètres (couverture + boutons
3 mois / toute la boîte) et extrait sous le sujet dans la liste
(`SearchResultItem.snippet`, tronqué à 160 car. côté API — le stockage en
garde 500 pour l'analyse). Tests : 38 asserts, dont « la pièce jointe n'est
JAMAIS téléchargée » (client IMAP stubbé), l'idempotence du rattrapage et
« aucun mail laissé sans confiance ». Le test a aussi rattrapé une donnée
de test irréaliste : le sujet « Bulletin du mois » déclenche la règle
`document` par le SUJET — on aurait cru à tort que l'extrait servait.
**À FAIRE PAR L'UTILISATEUR** : lancer « 📖 3 derniers mois » dans
⚙️ Paramètres (long : chaque mail est ouvert une fois), puis regarder si le
tri s'améliore. **SUITE : C2 + C3a** (verdict IA écrit dans les champs
EXISTANTS `intent`/`category`/`analysisConfidence` avec source `'ai'`,
précédence manual > ai > auto, + 2 tools MCP `next_analysis_batch` /
`submit_analysis_batch` pour le rattrapage massif sur le forfait) — plan
détaillé dans ROADMAP.md § « Série C ».

**P2.3 — PROTECTION PAR LA NATURE DU MAIL (29/07).** Retour utilisateur
avec capture : la fenêtre proposait 364 mails de `no_reply@leroymerlin.fr`
TOUS cochés, « Votre facture » et « Votre ticket 378 » compris — « tu
confonds des mails de publicité avec des mails contenant des pièces jointes
de tickets ». DÉFAUT STRUCTUREL : on classait par EXPÉDITEUR (unsubscribe /
noreply), or un magasin envoie ses pubs ET tes tickets depuis la MÊME
adresse robot — aucun signal expéditeur ne peut les séparer. Corrigé aux
3 niveaux : (1) categorize.ts, motif `document` élargi (ticket de caisse,
votre ticket, reçu, bon d'achat, garantie, duplicata, certificat) — sans ça
« Votre ticket 378 » = `info` ; (2) cleanup.ts : `documentSignals()` +
3e catégorie `kind='document'` PRIORITAIRE sur `auto` (pièce jointe /
intention invoice-document / sujet nommant une pièce), `keepCount` +
`deletableCount` par expéditeur (groupBy) → l'estimation « N sûrs » exclut
les pièces, `documentUidsOf()` retire les pièces quand on nettoie « tout
l'expéditeur » sans sélection ; (3) retention.ts `protectionClauses()` +=
`m.hasAttachments = 0` et `intent NOT IN ('invoice','document')` → vaut
pour TOUTES les stratégies, y compris auto. UI : case **📄 À conserver**
décochée par défaut + badge vert par ligne + « 📄 N gardés » dans les
3 tableaux. Tests : 19 asserts rejouant sa capture (9 pubs/OTP supprimables,
6 tickets/factures gardés) + aperçu réel de la stratégie « promotions ».
**L'UTILISATEUR DOIT RELANCER 🏷️ Recalculer les catégories** — l'existant
porte l'ancienne intention.

**Journal ouvrable + boîte visible sur le nettoyage (retours utilisateur
29/07).** (1) « dans activité récente, on déploie les mails concernés mais
ensuite on ne peut pas les afficher, on a juste l'en-tête » : les items du
journal ne portaient que sujet+date. `OperationEntry.items` accepte
maintenant `folder`/`uid` OPTIONNELS — renseignés UNIQUEMENT quand le mail
est resté en place (detect_deadlines, tâches créées/terminées, marquage
lu/non-lu) et volontairement OMIS après suppression/déplacement (l'UID ne
pointerait plus sur rien ⇒ pas de lien mort). `validateUids` (search.ts)
renvoie l'uid par item, l'appelant décide. Front : `opLine` rend le sujet
en lien `[data-op-open]` quand folder+uid sont là, écouteur DÉLÉGUÉ dans
installGlobalUx (les lignes sont réécrites à chaque rafraîchissement).
(2) « il manque un indicateur de couleur permettant de dire dans quelle
boîte le ménage va être effectué » : `accountChip` sur les lignes du
panneau « Nettoyage conseillé », dans le titre de la modale, dans la phrase
d'intro ET sur le bouton d'action (« vers la corbeille de <boîte> ») —
`accountChip(slug, {onDark:true})` (pastille opaque, sinon illisible sur le
bouton vert). Tests : ui-oplog-open.mjs, 14 checks (dont le contre-cas
« mail supprimé non cliquable » et l'ouverture réelle du corps).

**L6.1 — LE SERVEUR SE MET À JOUR TOUT SEUL (28/07).** Déclencheur :
« on ne va pas faire des déploiements manuels pour le futur… », après une
mise à jour SSH en échec sur `database is locked`. CAUSE : la mise à jour
lançait `npm run db:setup` (= `prisma migrate deploy`) PENDANT que l'app
tenait le fichier SQLite — le moteur de migration exige l'exclusivité. Même
piège que sous Windows, jamais traité côté Linux ; automatiser sans corriger
aurait cassé CHAQUE nuit. RÈGLE POSÉE : **on ne migre jamais pendant que
l'app sert**. `scripts/db-setup.mjs` accepte `generate`/`migrate`
(npm run db:generate / db:migrate) ; `src/db/migrate.ts`
(`ensureMigrationsApplied` : compare prisma/migrations à
`_prisma_migrations`, ne lance le moteur que s'il reste du travail, ferme la
connexion avant) appelé dans index.ts AVANT `app.listen` — échec ⇒ on
démarre quand même (pas de boucle pm2) ; update.ts et autoupdate.ts font
`db:generate` seulement ; setup-oracle.sh arrête l'app avant db:setup s'il
est relancé. `services/autoupdate.ts` : passage quotidien à
`AUTO_UPDATE_HOUR` (défaut **4**, activé par défaut EXPRÈS pour que le
serveur déjà installé sans la variable se mette à jour ; ignoré sous
Windows) — check → note le commit → sauvegarde → pull → install → generate
→ build → exit(0) (pm2 relance) ; **échec ⇒ `git reset --hard` sur le commit
d'avant + rebuild**, on reste sur la version d'hier qui marche. État dans
GET /api/version → ligne « Mise à jour automatique » des Paramètres. Tests :
12 asserts migrations + 14 asserts autoupdate sur un vrai dépôt git jetable
(dont le retour arrière vérifié fichiers à l'appui) + démarrage réel sur
base neuve (16 migrations en 2,6 s puis /health OK).

**L6 DÉPLOIEMENT FAIT (28/07) — le serveur tourne en ligne.**
`https://boxmail.lb2i.com` — Oracle Cloud ARM (VM.Standard.A1.Flex, 6 Go,
Ubuntu 24.04 Minimal aarch64), région Madrid, IP `51.170.60.55`. Vérifié de
l'extérieur : /health OK, certificat Let's Encrypt valide, redirection
http→https, /mcp sans token = 401, HSTS + nosniff actifs.
PIÈGES RENCONTRÉS (tous corrigés dans le dépôt) : (1) shape `E5.Flex`
choisie par erreur = PAYANTE (~30 $/mois) → seules `A1.Flex` (ARM) et
`E2.1.Micro` sont Always Free ; (2) capacité Always Free saturée → il faut
passer le compte en Pay As You Go (reste gratuit) ; (3) image Minimal sans
`git` ni `curl` → installés en tout premier ; (4) iptables d'OCI bloque
tout sauf SSH → ouverture 80/443 ajoutée au script ; (5)
`ecosystem.config.js` refusé par pm2 (projet en modules ES) → renommé en
`.cjs` ; (6) session SSH mobile qui se coupe → le script accepte
BOXMAIL_DOMAIN/BOXMAIL_EMAIL/BOXMAIL_ADMIN_PASSWORD pour une installation
en UNE commande, lançable via `nohup` en arrière-plan.
Reste côté utilisateur : enrôler les boîtes, brancher le connecteur Claude
(URL `https://boxmail.lb2i.com/mcp` + bearer du récap).

**Transfert des boîtes entre installations (demande utilisateur : « une
fois renseignée en local ou sur le site, besoin de le faire seulement une
fois »).** `services/portability.ts` : exportAccounts déchiffre les
cacheBlob avec la clé LOCALE puis rechiffre le tout avec une phrase secrète
(scrypt + AES-256-GCM, 12 car. min) → le fichier ne dépend d'aucune
machine ; importAccounts fait l'inverse et ne remplace une boîte déjà
enrôlée QUE sur accord explicite (overwrite). POST /accounts/export et
/accounts/import. Panneau « 📦 Transférer mes boîtes » dans Paramètres,
avec DEUX avertissements : le fichier donne un accès complet aux boîtes, et
après transfert il ne faut utiliser QU'UNE installation (les jetons de
rafraîchissement tournent — deux installations actives se déconnecteraient
mutuellement). Tests : 15 asserts (aucun jeton en clair dans le fichier,
mauvaise phrase refusée sans indice, fichier altéré détecté par GCM, et
surtout le cache MSAL restitué IDENTIQUE = accès réellement utilisables)
+ 9 checks navigateur.

**PHASE 2 « NETTOYER POUR DE VRAI » (P2.1 + P2.2, 28/07).**
- **P2.1 protection graduée** : `ENGAGEMENT_HORIZON_DAYS = 730` dans
  retention.ts. `PROTECTION_CLAUSES` (const) remplacée par
  `protectionClauses()` et `ENGAGED_SENDER_CLAUSES` par
  `engagedSenderClauses()` — des FONCTIONS qui renvoient {clauses, params}
  (l'ordre des deux tableaux doit rester aligné dans policyWhere).
  ABSOLUES : étoilé, tâche todo, échéance active, expéditeur ⭐, confiance
  faible, catégorie person. GRADUÉES (2 ans) : mail répondu, fil avec
  sortant, expéditeur « engagé ». Date inconnue ⇒ on protège. PIÈGE
  rencontré : j'avais écrit « répondu ET RÉCENT ⇒ supprimable » au lieu de
  « répondu ET ANCIEN ⇒ supprimable » — trouvé par le test. Autre piège :
  la protection B5 est GLOBALE à l'expéditeur, donc chaque scénario de test
  doit avoir SON expéditeur, sinon un cas masque les autres. Tests : 11.
- **P2.2 désinscription** : migration `unsubscribe_links` (Sender.
  unsubscribeHttp/Mailto/OneClick/unsubscribedAt/unsubscribeNote — sur
  l'EXPÉDITEUR, pas sur chaque mail : on se désinscrit d'un expéditeur).
  `services/unsubscribe.ts` : parseListUnsubscribe (chevrons ou non),
  hasOneClick (RFC 8058), refreshUnsubscribeLinks (job : lit l'en-tête du
  DERNIER mail de chaque expéditeur liste via
  `imapService.fetchUnsubscribeHeaders` — 2 en-têtes, aucun corps),
  listUnsubscribable, unsubscribeSender (one-click = POST
  `List-Unsubscribe=One-Click` ; mail = SMTP ; lien = JAMAIS cliqué
  automatiquement, l'URL est rendue à l'utilisateur — cliquer chez un
  expéditeur douteux confirme que l'adresse est vivante), markUnsubscribed.
  Écran `#/unsubscribe` (sidebar 🚫 + badge). rebuildSenders ne touche pas
  ces champs (vérifié). Tests : 23 asserts (dont un VRAI serveur HTTP local
  qui vérifie méthode POST + corps RFC 8058, et le cas « serveur refuse ⇒
  aucune fausse confirmation ») + 13 checks navigateur.
- RESTE À FAIRE côté utilisateur : lancer « 🔍 Chercher les liens » une
  fois (les liens ne sont pas dans l'index existant), puis se désinscrire.

**PHASE 0 « FIABILISER » COMPLÈTE (P0.1→P0.4, 28/07) — issue d'une revue
croisée Gemini 3.1 Pro + ChatGPT 5.6 commandée par l'utilisateur.** Les deux
convergeaient : le projet manquait moins d'intelligence que de BOUCLE
OPÉRATIONNELLE FIABLE. Leurs affirmations ont été VÉRIFIÉES dans le code
avant d'agir (plusieurs étaient fausses — voir ci-dessous).
- **P0.1** : `applySqlitePragmas()` dans db/client.ts (WAL + busy_timeout 5 s
  + synchronous=NORMAL, appelé depuis ensureDbReady) — sans WAL une écriture
  bloquait TOUTES les lectures. Et `reconcileMoves()` dans sync.ts : IMAP n'a
  pas de notion de déplacement, donc un mail rangé ailleurs devenait une
  nouvelle ligne et les tâches/échéances/verdicts pointaient dans le vide.
  On identifie par `internetMessageId` (DÉJÀ stocké et indexé — ChatGPT
  affirmait le contraire, c'était faux : aucune migration nécessaire) et on
  repointe Task (+ folder/uid dénormalisés)/Deadline/AttentionState/
  AnalysisFeedback. `report.movedMessages`.
- **P0.2** : detectDeadlines branché post-sync, VOLONTAIREMENT avant
  runAutoRules/runAutoRetention (une échéance protège son mail : détecter
  après aurait pu supprimer un mail porteur d'une date). Nouvelle option
  `indexedSince` (filtre sur Message.createdAt) — sans elle le scan des
  corps relisait les mêmes mails toutes les 30 min. `report.deadlinesFound`.
- **P0.3** : `services/backup.ts` — VACUUM INTO (copie cohérente même en
  écriture, contrairement à une copie de fichier en WAL), rotation 7,
  horodatage à la SECONDE (sinon deux sauvegardes rapprochées s'écrasent —
  trouvé par le test), `backups/` gitignoré. Déclenché quotidiennement
  (startAutoBackup dans index.ts) ET avant chaque applyUpdate. API
  /api/backups (+ download avec anti-traversée via listBackups). Panneau
  « 💾 Sauvegardes » dans Paramètres. RAISON D'ÊTRE : l'index se reconstruit
  depuis IMAP, mais PAS les tâches/échéances/règles/corrections manuelles.
- **P0.4** : `services/health.ts` — signal principal = FRAÎCHEUR de
  `Account.lastSyncAt` (robuste par construction : quelle que soit la panne,
  la date cesse d'avancer ; aucune migration). Seuils adaptatifs (2 cycles
  d'auto-sync, sinon 24 h/72 h), + quota ≥90/95 %, + compteur de mails non
  analysés, + erreurs des jobs en mémoire. GET /api/health. Panneau
  « 🩺 État du système » (couverture N/N) + bandeau dashboard affiché
  UNIQUEMENT si problème (un bandeau permanent ne serait plus lu).
- Tests : 12 + 7 + 16 (dont une RESTAURATION RÉELLE de la sauvegarde ouverte
  comme base de travail) + 13 asserts, et 9 + 11 checks navigateur.
- Suite décidée avec l'utilisateur : **Phase 1** (Telegram — PAS d'email :
  « je veux nettoyer mes boîtes, pas recevoir des mails en plus » ; +
  engagements sortants), puis **Phase 2** (protection GRADUÉE dans le temps
  — aujourd'hui un fil répondu une fois est protégé à vie, ce qui bloquera
  le nettoyage de masse ; + désinscription), puis Phase 3.

**Pièces jointes compactes façon Outlook (retour utilisateur 10/07 :
« quand il y a plusieurs PJ, pouvoir réduire, affichage rapide et simple,
les uns à la suite, à la mode Outlook »).** renderReaderAttachments
(app.js) refait : puces horizontales `.att-chip` qui s'enroulent (icône
par type via `attIcon`, nom ellipsé, taille, boutons icônes 👁️/⬇️) au
lieu de lignes verticales hautes ; en-tête = compteur + TAILLE TOTALE +
`⬇️ Tout (.zip)` + bouton ▾/▸ `data-att-toggle` qui REPLIE la liste
(`.att-chips.collapsed`) quand il y a plusieurs PJ (le corps du mail n'est
plus repoussé). Tests : ui-attach-perf.mjs passé à 14 checks (puces,
taille totale, réduire/déplier). Capture 9 PJ : ~5 rangées au lieu de 9
lignes.

**Barre de chargement globale (retour utilisateur 10/07 : « affiche un
loader lors de l'affichage, fais-le pour tout, simple mais efficace »).**
Un seul branchement : `request()` (api.js) incrémente un compteur
`inFlight` et émet `api-activity` (0↔1) ; `installTopLoader()` (app.js,
appelé AU DÉMARRAGE du module, avant boot — pour couvrir même login/
overview) crée `#top-loader` (barre 3 px en haut, z 200 au-dessus de tout,
gradient accent animé, `prefers-reduced-motion` OK) et l'allume/éteint,
avec anti-clignotement (n'apparaît qu'après 120 ms). `api.activity.begin/
end` exposé pour les téléchargements de PJ (fetch direct) → la barre
s'allume aussi. Tests : ui-loader.mjs (5 checks : présence, repos, allumée
sur réponse lente 700 ms, éteinte après, z ≥ 101).

**Perf & confort lecture/PJ (retours utilisateur 10/07 : « 20 s pour
ouvrir un mail », « le téléchargement des PJ pareil, on ne sait pas si
c'est en cours ou en échec », « il manque l'année », « télécharger tout
d'un coup », « juste les consulter »).** CAUSE RACINE : `readEmail` et
`downloadAttachment` faisaient `client.download(uid)` = téléchargement du
MAIL ENTIER (PJ comprises) pour afficher le texte / extraire une pièce.
Corrigé dans imap.ts : helpers bodyStructure (`listAttachmentParts`,
`findTextNode`, `decodeText` via TextDecoder+charset, `streamToBuffer`,
`formatEnvelopeAddr`) ; `readEmail` = fetchOne(envelope+bodyStructure)
puis download de la SEULE partie texte (repli `readEmailFull` sur le mail
complet si structure atypique) ; `downloadAttachment` = download de la
SEULE partie demandée (même repli) ; `downloadAllAttachments` (mail
complet, une descente) pour le zip. Vérifié : imapflow met `type` en
`text/plain`, `part`, `parameters.charset`, `disposition` — l'optim
s'active vraiment. `fmtDateTime` (api.js) : année ajoutée (bug en-tête
lecteur). Nouveau `services/zip.ts` : générateur ZIP maison (deflate +
CRC32 + EOCD, dédup des noms) — ZÉRO dépendance (archiver essayé puis
abandonné : interop ESM capricieuse + alerte sécurité), testé au vrai
`unzip`. Routes admin.ts : `?inline=1` sur la PJ (Content-Disposition
inline → « 👀 Voir » dans un onglet, PDF/image, mise en cache navigateur) ;
`GET .../attachments.zip` (cap 25 Mo). Panneau lecteur (app.js) :
`renderReaderAttachments` (👁️ Voir si type voyable, ⬇️ Télécharger,
⬇️ Tout .zip si > 1) + `downloadWithFeedback` (fetch blob : « ⏳
Préparation… » → « ✅ Téléchargé » ou « ⚠️ Réessayer » + alerte). Tests :
zip au vrai unzip (intégrité/dédup/accents) + ui-attach-perf.mjs
(10 checks : année, Voir PDF-only, retour visuel, zip). NB : la VITESSE
réelle (IMAP) reste à valider par l'utilisateur sur son PC — pas d'IMAP
en dev. NB test : `npm remove`/`install` a purgé playwright-core (non
suivi par package.json) → le réinstaller `--no-save` avant les captures.

**Correctif bruit « Aujourd'hui » (retour utilisateur 10/07, capture à
l'appui : « supprimer des newsletters reçues aujourd'hui, stupidité
incommensurable »).** today.ts : `NOISE_MIN_AGE_DAYS = 7` — un mail des
7 derniers jours n'est JAMAIS du bruit supprimable (compteurs ET aperçu ;
il bascule dans « peut attendre ») ; aperçu trié ASC — le lot de 500
traite les PLUS ANCIENS d'abord (avant : DESC ⇒ les mails du jour
partaient en premier !). Modale bruit refaite : `.modal-wide` (1100 px),
table compacte (lignes 27 px), sujets cliquables → panneau de lecture
AU-DESSUS de la modale (`.modal-overlay.under-reader` z 94 < reader 96 ;
Échap ferme le panneau puis la modale ; suppression depuis le panneau ⇒
liste rechargée). Tests : test-noise.mts (7 asserts) + ui-noise.mjs
(16 checks). NB : les modales de compose depuis le panneau restent à
z 100 (au-dessus) — ne pas toucher au z-index global du reader.

**BL1 livrée : analyse fine via Cowork — SUR LE FORFAIT, pas de clé API.**
DÉCISION UTILISATEUR (10/07) : « je veux que ça décompte de mon forfait,
pas en mode clef api » — retour à la décision d'origine (« analyse fine
par Claude via MCP »). PAS de panneau clé API/modèle/tokens dans
Paramètres : l'IA, c'est la session Cowork connectée au serveur MCP.
Livré : 9 nouveaux tools MCP (52 au total) dans `mcp/tools/assist.ts` —
get_today, get_mailbox_report, list/preview_retention_policy (lecture
seule), get_learning_suggestions, get_analysis_quality (verdicts B2), et
l'analyse fine : list_uncertain_messages (confiance faible/moyenne B4
avec contexte complet ; service `listUncertainMessages` dans
categorize.ts) + set_sender_category / set_sender_priority (mécanismes
existants, journalisés, réversibles — descriptions : proposer d'abord,
corriger après accord). Instructions serveur MCP enrichies. Tests : seed
RECALÉ sur B5 (expéditeur engagé ⇒ 0 newsletter visée ; échéance seule ⇒
protection B1 par mail — les anciennes attentes 30/5 dataient d'avant
B5), 19 asserts service, 18 checks JSON-RPC réels sur /mcp (52 tools,
appels get_today / list_uncertain_messages / set_sender_category
aller-retour manuel→auto). Tout passe par le forfait UNIQUEMENT quand
une session Cowork est ouverte — le serveur seul reste 100 % gratuit.

**B5 livrée : stratégies affinées — LA SÉRIE B (FIABILISATION) EST
COMPLÈTE (B1→B5, livrées le 10/07).** retention.ts : exclusions par
sujets sensibles attachées à la CIBLE (confirmations hors résiliation/
assurance/contrat ; notifications hors sécurité/connexion/mot de passe/
banque ; livraisons hors litige/remboursement/garantie) ; newsletters/
promos jamais si l'expéditeur a déjà compté (conversation, ⭐/répondu,
tâche) ; tout compté en protection 🛡️, libellés presets mis à jour.
deletableUnion recalculé par UNION des policyWhere (rapport A4 exact,
B1+B4+B5 inclus). learning.ts : suggestions de priorité à 2 signaux
concordants (⭐ = tout lu ET interaction ; 🔕 = jamais lu ET zéro
interaction). Tests : 15 asserts + 6 checks + régressions B2/B4.
**VALIDATION RÉELLE à faire par l'utilisateur après mise à jour :
relancer le backfill 🏷️ (Paramètres) pour poser la confiance B4, puis
examiner ~50 détections dans 🔬 Vérifier l'analyse.**

**B4 livrée : confiance de l'analyse (forte/moyenne/faible).**
Migration Message.analysisConfidence(+Reason). computeConfidence
(categorize.ts) : forte = verdict B2 correct / catégorie manuelle /
expéditeur ET intention concordants ; moyenne = un signal fort ; faible =
mot générique seul — verdict B2 « incorrect » ⇒ faible et PRIME au
recalcul. Posée post-sync (onlyMissing, avant les automatismes) + backfill
🏷️ complet. PROTECTION_CLAUSES + clause « confiance faible ⇒ jamais
supprimé ». Ligne 🎚️ dans l'analyse du mail ouvert (raison en infobulle).
Tests : 20 asserts + 4 checks + régression B2. L'utilisateur doit
relancer le backfill 🏷️ (Paramètres) pour poser la confiance sur
l'existant.

**B3 livrée : réponse attendue v2 + importants « non traités ».**
attention.ts : detectRequestKind (réponse attendue/action/question/info,
motifs FR sans « ? »), stripQuotedText (texte cité ignoré), destinataire
principal vs copie (toEmails ; en copie ⇒ seuil normal + trié après) —
ReplyItem.requestKind/inCopy, badges 🗣️/❓/cc écran Réponses, ligne 🗣️
dans l'analyse du mail ouvert (corps déquoté). importance.ts :
treatState new/untreated/treated (non traité = ancien sans réponse/tâche
même lu), score enrichi (+5/10 sans traitement N j, +10 échéance liée,
+10 expéditeur a relancé) ; écran ⭐ en 3 groupes cap 10 + « ＋N autres »,
lus inclus par défaut. Tests : 20 asserts + 10 checks navigateur.

**B2 livrée : écran « Vérifier l'analyse » (contrôle qualité).**
Modèle AnalysisFeedback + services/quality.ts : échantillon aléatoire des
5 moteurs (réponses, importants, newsletters/notifications AUTO
uniquement, candidats nettoyage via sampleRetentionTargets — protection
B1 incluse), verdict ✓/✗/? avec raison, % de précision par moteur
(corrects/(corrects+incorrects)). Les corrections sur ✗ passent par les
mécanismes EXISTANTS (catégorie manuelle, priorité ⭐/🔕, dismiss réponse)
après confirmation. API /api/review/* (journal ui_analysis_feedback),
écran #/verify (sidebar 🔬). Tests : 16 asserts + 13 checks navigateur.
L'utilisateur doit VALIDER EN RÉEL : donner quelques verdicts sur ses
vraies boîtes et vérifier que les % de précision s'affichent.

**SÉRIE B lancée (audit externe accepté : fiabilisation > nouvelles
fonctions). B1 LIVRÉE : protection centrale.** `PROTECTION_CLAUSES`
(retention.ts) injecté dans policyWhere → hérité par stratégies, Grand
ménage et auto-rétention : jamais visé si étoilé / répondu / fil avec
sortant / tâche todo liée / échéance active liée / expéditeur ⭐ toujours
important (+ garantie person inchangée). listPolicies expose
protectedCount → badge « 🛡️ N protégés ». Tests : 42 asserts (6 signaux,
aperçu scopé, prioritaire → 0). Suite : B2 écran « Vérifier l'analyse »
→ B3 réponse attendue v2 + importants non traités → B4 confiance
high/medium/low (faible ⇒ protégé) → B5 stratégies affinées — plans dans
ROADMAP.md section « Série B ». La VALIDATION RÉELLE reste chez
l'utilisateur (backfill, syncs, examen des détections).

**A6 livrée : mode apprentissage — LA SÉRIE A (CAP V3) EST COMPLÈTE.**
services/learning.ts : listSuggestions() → 3 familles AVEC PREUVE
(règles L7 suggested relancées par compte ; rétention→auto si appliquée
à la main ≥ 2 fois — comptage journal ; priorités déduites de la
lecture : ⭐ ≥ 10 mails tous lus, 🔕 ≥ 20 mails ≥ 90 % jamais ouverts,
jamais person). Valider = endpoints existants ; Ignorer = mémorisé
(modèle SuggestionDismissal). GET /api/suggestions + POST dismiss.
Écran #/suggestions + badge sidebar. Tests : 11 asserts + 14 checks +
régressions. **L'utilisateur doit VALIDER EN RÉEL sur son PC : le
backfill 🏷️ des catégories (Paramètres), une application de stratégie
de rétention, un envoi de relance ✍️, et le Grand ménage (IMAP/SMTP
mockés en dev).**

**A5 livrée : relances pilotées + priorité par relation.** Escalade
FollowupItem.stage (waiting/due/urgent >2× seuil/stale >30 j) + suggestion
FR ; écran Relances : badges, 🗄️ Clôturer sur stale, ✍️ Relancer →
modale d'envoi pré-remplie (brouillon poli, replyRef) ; accueil enrichi.
Sender.priority (migration, jamais recalculée) : ⭐ always_important +40 /
🔕 never_urgent plafond 30 dans importance.ts (raisons explicites) ;
PATCH senders accepte category/priority (journalisé) ; sélecteur Priorité
dans le tableau des expéditeurs. Tests : 13 asserts + 11 checks.
L'utilisateur doit valider un envoi de relance EN RÉEL.

**A4 livrée : « Pourquoi ma boîte est pleine ? » + Grand ménage.**
services/report.ts : generateMailboxReport() (répartition par catégorie
A1 avec %, ancienneté 4 tranches, top expéditeurs nombre/poids, par
boîte, récupérable = union distincte des cibles A3) ; runGrandMenage
(cocher = activer + appliquer, rapport par stratégie). GARANTIE « 0 mail
personnel » ancrée dans policyWhere (catégorie person exclue de toutes
les stratégies). GET /api/report + POST /api/grand-menage (job). Écran
#/bigclean (sidebar 🧺) : KPI, barres, ancienneté, top poids, lancement
coché par défaut avec aperçus. Tests : 14 asserts + 13 checks.

**A3 livrée : stratégies de rétention.** Modèle RetentionPolicy global +
7 presets DÉSACTIVÉS (OTP 7 j, livraisons 30 j, notifs 90 j, réseaux
sociaux 90 j, confirmations 6 mois, newsletters jamais lues 90 j, promos
jamais lues 30 j). services/retention.ts : simulation live, aperçu exact
cap 500, applyPolicy dry-run par défaut + corbeille lots de 200 + journal
par boîte, updatePolicy (autoApply⇒enabled), runAutoRetention post-sync.
API /api/retention* (apply = job). UI : panneau en tête de #/cleanup
(toggle, badge simulation, auto avec confirmation, aperçu, appliquer).
Tests : 13 asserts + 12 checks. L'utilisateur doit valider une
application EN RÉEL.

**A2 livrée : accueil « Aujourd'hui » orienté actions.** `#/today` est la
PAGE D'ACCUEIL par défaut (le Tableau de bord reste en 2e position).
services/today.ts : generateToday() index-only — À FAIRE (réponses
attendues filtrées par intention A1 : jamais promo/otp/livraison/
confirmation ; factures non lues ; échéances dues ; relances), IMPORTANT
(top 5 ≥ 70 non lus), PEUT ATTENDRE (non-lus hors bruit), BRUIT (4 buckets
SQL disjoints : newsletters/notifications/réseaux sociaux/pubs) ;
listNoiseMessages = aperçu exact cap 500. GET /api/today +
/api/today/noise/:bucket. Modale bruit → suppression via les endpoints
bulk existants (journalisée). Badge sidebar = nb actions. Tests :
14 asserts + 19 checks navigateur + régressions.

**A1 livrée : moteur de catégorisation (fondation Cap V3).** Migration
Sender.category/Source/Reason + Message.intent/intentReason.
services/categorize.ts : categorizeSender (10 catégories explicables,
marques d'abord puis person/newsletter/notification/ad/company),
detectIntent (10 intentions par motifs sujet, forts > question > faibles),
categorizeAccount (backfill index-only idempotent), setSenderCategory
(manual jamais écrasé, null → auto). Sync : intent posé sur les nouveaux
entrants, rebuildSenders pose category. API : intent sur les 3 listings,
stats enrichies, PATCH /accounts/:slug/senders, POST /api/categorize
(job global). UI : colonne Catégorie (sélecteur + ✍️ + tooltip raison)
dans les stats, bouton 🏷️ Recalculer dans Paramètres. Tests : 36 asserts
+ 9 checks navigateur. L'utilisateur doit lancer le backfill depuis
⚙️ Paramètres après mise à jour.

**Cap V3 acté (10/07/2026) : « Mon assistant personnel de messagerie ».**
L'utilisateur a validé un changement de philosophie : l'objectif n'est plus
de gérer des mails mais de transformer la boîte en ACTIONS (« tu dois
répondre à 4 personnes, tu peux supprimer 842 newsletters ») — sensation de
boîte vide, zéro oubli important. Plan détaillé écrit dans ROADMAP.md
section « Cap V3 » : A1 moteur de catégorisation (fondation : qui écrit /
pourquoi, index-only, explicable, migration Sender.category +
Message.intent) → A2 accueil « Aujourd'hui » orienté actions (🔥 À FAIRE /
🟠 IMPORTANT / 🟢 PEUT ATTENDRE / ⚪ BRUIT) → A3 stratégies de rétention
(OTP 7 j, livraisons 30 j, notifs 90 j, confirmations 6 mois…) → A4
« Pourquoi ma boîte est pleine ? » + Grand ménage → A5 relances pilotées
(escalade) + priorité par relation → A6 apprentissage (décisions →
suggestions). L'existant est CONSERVÉ (les briques livrées sont les organes
de la vision, la consultation L5.x reste accessible) ; garde-fous
inchangés ; heuristiques d'abord, Sonnet dédié en 2e temps. L6 reste
orthogonal, prêt le jour J.

**L7 livrée : Règles de classement.** Modèle MailRule + migration,
services/rules.ts (suggestRules 2 heuristiques index-only idempotentes :
rangement manuel récurrent dossier custom + grosses newsletters ;
previewRule ; applyRule — createFolder au besoin, move par lots de 200,
journal items, suggested→active ; updateRule avec GARDE-FOU autoApply⇒
active ; createRule manuelle ; runAutoRules post-sync non bloquant pour
les règles cochées auto). 5 tools MCP (43 au total, apply en dryRun sans
confirm). API /accounts/:slug/rules*. UI : section sidebar « RÈGLES &
AUTOMATISATION » + badge suggestions, écran #/rules groupé par boîte
(aperçu modale avec liste exacte + bouton Déplacer N, valider/ranger/
auto/pause/supprimer, ＋ Nouvelle règle avec datalist des dossiers).
Sidebar resserrée (retour utilisateur). Dossiers intelligents → backlog.
Tests : seed 37 asserts + ui-rules.mjs 14 checks + régression navquota.
L'utilisateur doit VALIDER EN RÉEL l'application d'une règle (move IMAP
réel + création de dossier — mocké en dev).

**Rattrapage maquette 2 TERMINÉ (L5.12 → L5.18, retours utilisateur
10/07).** 6 livraisons poussées : dossiers, mails suivis, écran pièces
jointes, nettoyage global, dashboard maquette, arborescence sidebar. Restent de la SPEC V2
(hors multi-utilisateur) : L7 règles de classement + dossiers
intelligents, brouillons IMAP (préparer une réponse sans l'envoyer),
mémoire métier (entities/projects) + recherche dans le CONTENU des PJ —
ces deux derniers via le Sonnet dédié, décision : après déploiement L6.

**L5.18 livrée : navigation contextuelle + recherche consultation +
quota.** Sidebar Option 1 (choix utilisateur) : Tableau de bord seul,
COMPTES, « 🌐 TOUTES LES BOÎTES », ANALYSE & ACTIONS, OUTILS ; surlignage
CONTEXTUEL (boîte précise → compte+dossier dans l'arborescence auto-
dépliée ; unifié → entrée globale) ; titre #inbox-title explicite ; champ
🔎 de filtre dans la barre d'outils inbox (param q sur les deux listings,
quickTextFilter OR sujet/adresse/nom) ; quota IMAP par boîte (migration
Account.quota*, fetchQuota RFC 2087 à chaque sync, overview expose
used/limit/free/pct, colonne Espace utilisé orange ≥90 %/rouge ≥95 % +
libre, carte vue compte, bannière 🚨 dashboard). Épinglage local REFUSÉ
par l'utilisateur (pas de divergence avec Outlook) — ⭐ suivi = l'outil.
Tests : ui-navquota.mjs (20 checks) + régressions.

**L5.17 livrée : Arborescence des boîtes dans la sidebar.** Chaque compte
a un bouton +/− qui déplie ses dossiers (rôle trié, badge non-lus, clic →
#/inbox/<slug> sur ce dossier) ; nom du compte → vue compte ; dossiers
chargés à la demande (api.folders), cache vidé à chaque refreshOverview,
état déplié dans localStorage bm.sideOpen ; vues globales inchangées.
refreshOverview scindé en renderAccountsNav()/loadSideFolders(). NB
tests : rate-limit login 10/15 min → redémarrer le serveur de test entre
les salves playwright. Tests : ui-sidetree.mjs (13 checks) + 3 suites
repassées.

**L5.16 livrée : Dashboard maquette.** « Bonjour Anthony 👋 » + date,
6 cartes KPI (nouveaux mails aujourd'hui +delta vs hier — `newMails` dans
/api/overview —, importants, réponses, relances, échéances + prochaine,
supprimables), panneau ⚡ Actions rapides, KPI remplis par les loaders
des panneaux existants. **Rattrapage maquette 2 TERMINÉ (L5.12→L5.16).**

**L5.15 livrée : Nettoyage conseillé global.** Sidebar 🧹 + `#/cleanup` :
candidats de toutes les boîtes groupés par boîte, bannière totale, mêmes
colonnes que la vue compte, bouton 🧹 → modale d'aperçu existante ;
agrégation client (boucle api.cleanup), zéro nouveau backend ; bouton
« Voir et nettoyer » sur le panneau dashboard. Seed : 12 newsletters/boîte
(candidat « sûr » par boîte).

**L5.14 livrée : Écran Pièces jointes.** Sidebar 📎 + `#/attachments` :
mails avec PJ toutes boîtes au chargement (searchIndex withAttachments),
recherche q + filtre boîte + depuis, chip compte + badge dossier +
compteur 📎N, clic → panneau avec liens ⬇️, état vide rappelant la Sync
complète. Tests : ui-attach-screen.mjs (7 checks).

**L5.13 livrée : Mails suivis (⭐).** Pseudo-rôle `flagged` (tous dossiers
hors corbeille/spam), isFlagged exposé partout, actions flag/unflag
(\\Flagged IMAP + reflet index), étoile cliquable par ligne, bouton dans
le panneau, entrée sidebar + badge. Sidebar remise à plat ordre maquette
(retour utilisateur — plus de sous-liens sous Boîte de réception ; lien
Boîte de réception = #/inbox/@inbox explicite pour réinitialiser le rôle).

**L5.12 livrée : lire les mails dans TOUS les dossiers.** Sidebar :
sous-liens 📤 Envoyés / 📝 Brouillons / 🗑️ Corbeille (#/inbox/@role, vue
unifiée par rôle — `listUnifiedInbox({role})`, param `role` sur GET
/api/messages) ; en vue unifiée le sélecteur de dossier choisit le TYPE
(inbox/sent/drafts/trash/archive/spam, plus jamais grisé) ; vue compte :
panneau « 📂 Dossiers » cliquable (compteurs, 📖 Lire → inbox sur ce
dossier) ; garde-fou dossier mémorisé inexistant → INBOX. Tests : seed
étendu (22 asserts) + ui-folders.mjs (10 checks).

**L6-prep TERMINÉE (même session) : tout le déploiement Oracle préparable
sans l'utilisateur est prêt.** `TRUST_PROXY` (trust proxy 'loopback' —
rate limits par IP réelle derrière nginx, testé XFF) + cookie session
`Secure` auto si PUBLIC_BASE_URL https ; `deploy/env.production.example` ;
`deploy/setup-oracle.sh` (installation 1-commande idempotente : Node 20,
.env secrets générés, build, pm2+systemd, nginx SSE, certbot+HSTS, récap
bearer) ; `docs/DEPLOY-ORACLE.md` (guide pas-à-pas non technique FR) ;
README §8 réécrit. Le jour J (~45 min, utilisateur requis) : VM OCI +
Security List 80/443, DNS, le copier-coller SSH, décision firewall (défaut
443 monde), URI Entra, ré-enrôlement, connecteur Cowork — détail dans la
section L6 de ROADMAP.md.

**Batch L5.6 → L5.11 TERMINÉ (demande utilisateur : « Lance L5.6 à L5.11
à suivre », un commit/push par livraison — 6 livraisons poussées dans cette
session).** Ordre suivi : L5.6 → L5.9 (priorisée sur retour utilisateur
« pas de possibilité d'ouvrir les pièces jointes ») → L5.7 → L5.8 → L5.10 →
L5.11. L'utilisateur doit encore VALIDER EN RÉEL sur son PC : pièces
jointes (téléchargement réel IMAP), actions en masse multi-boîtes, envoi
SMTP (toujours testé mocké uniquement), renommage/suppression de compte.

**L5.11 livrée : Auto-sync périodique (pré-requis L6).**
`services/autosync.ts` : `startAutoSync()` au listen d'index.ts ;
`SYNC_INTERVAL_MINUTES` (config.sync, défaut 0=off, .env.example documenté,
30 recommandé serveur) → setInterval unref ; chaque tick SAUTE si un job
tourne, sinon `startSyncAllJob('recent')` (corps factorisé de /api/sync-all
qui le réutilise) → suivi par la pastille d'activité comme une sync
manuelle. `autoSyncStatus()` dans GET /api/version → ligne du panneau
Serveur des Paramètres (désactivée / toutes les X min · prochaine dans ~Y).
Testé en réel avec intervalle 1 min : job déclenché au tick.

**L5.10 livrée : Aide & finitions UX.** Page `#/help` (7 rubriques en
dépliants : démarrage, enrôlement, sync, nettoyage, lecture/envoi/PJ,
raccourcis, pépins). Tri par colonnes inbox côté SERVEUR (`sort=date|from|
subject` + `dir` sur les deux listings, en-têtes cliquables ▲▼) ; Échap
global (panneau puis modales, confirm si brouillon `#c-text` non vide —
installGlobalUx() au boot) ; bouton ⬆ `.scroll-top` (> 600 px) ; focus auto
recherche. Tests : ui-help.mjs (13 checks).

**L5.8 livrée : Paramètres (couleur, renommage, suppression de compte).**
Écran `#/settings` (sidebar ⚙️) : couleur par boîte (input color + « auto »,
migration `Account.color`, PATCH `/api/accounts/:slug`, overview expose
color, rebuildAccountColors lit la perso d'abord), ✏️ Renommer (POST
`.../rename`, renameAccount + purge index — cache reconstructible — +
Account recréé avec couleur conservée, invite resync), 🗑️ Supprimer
(DELETE, double confirmation avec nom tapé, mails Microsoft intacts),
panneau Serveur (version, superviseur, SMTP, totaux). Journal
ui_account_color/rename/remove. Tests : curl + ui-settings.mjs (13 checks).

**L5.7 livrée : Calendrier des échéances (vue mois).** Écran `#/calendar`
(sidebar 🗓️), grille lun→dim 6 semaines, ‹ mois › + Aujourd'hui, week-ends
grisés, aujourd'hui surligné. Échéances non ignorées (proposées en
POINTILLÉ) + tâches todo datées, chips emoji type + liseré couleur compte,
cap 3/jour + « +N ». Clic jour → liste latérale, clic échéance →
openReaderFor du mail source. Lecture seule, zéro nouveau backend. Tests :
seed étendu + ui-calendar.mjs (15 checks).

**L5.9 livrée : Pièces jointes (badge, filtre, téléchargement).**
Migration Message.hasAttachments/attachmentCount ; sync fetch
`bodyStructure` → `countAttachments()` exporté (feuille avec disposition
attachment OU nom de fichier) sur les nouveaux mails seulement — backfill =
resync complète (tooltip + état vide le signalent). Filtre `withAttachments`
sur searchIndex/listFolderMessages/listUnifiedInbox (`attachments=1`), badge
📎 inbox (compteur si > 1) + recherche. Téléchargement : GET
`.../messages/:folder/:uid/attachments/:index` — imapService.
downloadAttachment (download complet + mailparser, même ordre que la liste
du panneau), Content-Disposition filename* UTF-8, 413 si mail > 25 Mo
(sizeBytes via indexedMessage étendu), 404/502 propres, index marqué lu.
Panneau : liens ⬇️ directs (cookie même origine). Tests : seed-unified.mts
(16 asserts) + ui-attachments.mjs (9 checks, corps ET download mockés
page.route) + curl 400/404/413/502.

**L5.6 livrée : Boîte unifiée + code couleur par boîte.**
`listUnifiedInbox` (search.ts, Message role=inbox tous comptes hors
supprimés, tri date desc, pagination+total) + GET `/api/messages` ; inbox
par défaut sur « 🌐 Toutes les boîtes » (localStorage `bm.inboxAccount`),
colonne Boîte + liseré coloré par ligne (posé sur le 1er td — le fond
`.unread-row td` masque un box-shadow posé sur le tr), sélection par clés
`account|folder|uid`, bulk groupé par compte+dossier (appels séquentiels à
l'API existante, totaux agrégés, mention « (N boîtes) », déplacement masqué
en unifié — dossiers ambigus) ; couleurs : palette 10 teintes attribuées
par position d'enrôlement (`rebuildAccountColors` dans refreshOverview,
repli hash), helpers `accountColor`/`accountChip`, points colorés sidebar,
chips colorées sur tous les écrans (remplace les `badge blue`). Tests :
scratchpad seed-unified.mts (8 asserts service, purge les comptes de seeds
précédents d'accounts.json) + ui-unified.mjs (18 checks playwright, bulk
mocké via page.route).

**Rattrapage maquette TERMINÉ (L5.1 → L5.5, même session).**
- **L5.2 Boîte de réception navigable** : `listFolderMessages` (index only,
  pagination offset/limit + total, filtre non-lus), `validateUids` +
  `reflectBulkInIndex` ; GET `/api/accounts/:slug/messages`, POST
  `.../messages/bulk` (corbeille/déplacer/lu/non-lu, lots de 200, journal
  `ui_bulk_*`) ; écran `#/inbox[/slug]` (sélecteurs boîte+dossier, 50/page,
  clic → lecture, sélection multiple + barre d'actions), lien sidebar 📥.
- **L5.3 Envoi** : `smtp.ts` réécrit (MailComposer → RFC822 unique, headers de
  fil, `validateRecipients`), ENABLE_SMTP_SEND **true par défaut**,
  `appendToSent` (copie Envoyés), POST `/api/accounts/:slug/send` (original
  marqué \\Answered IMAP+index si réponse, journal `ui_send_mail`), boutons
  ↩️ Répondre / ➡️ Transférer dans le panneau (citation, Re:/Fwd:), modale de
  composition, ✉️ Nouveau mail (inbox), `/api/me` → `smtpEnabled`.
- **L5.4 Analyse du mail ouvert** : POST `.../messages/analysis` (importance
  + raisons, état du fil, échéances connues + dates extraites du sujet ET du
  corps fourni par le client — zéro IMAP en plus, zéro LLM), `proposeDeadline`
  + POST `.../messages/propose-deadline` (idempotent) ; section « 🤖 Analyse
  Mail Assistant » dans le panneau (bouton ➕ Proposer par date).
- **L5.5 Tâches** : modèle `Task` + migration, `services/tasks.ts`
  (list/create/complete/dismiss/reopen, `taskFromDeadline` idempotent), 4
  tools MCP (38 au total), API `/api/tasks` + `/deadlines/:id/task`, écran
  `#/tasks` (3 onglets, titre → mail d'origine, modale ＋), badge sidebar
  (rouge si retard), panneau dashboard, ☑️ Tâche dans le panneau de lecture,
  « ☑️ → tâche » sur échéance confirmée, rubrique `tasks` du brief (chip).
- Tests par livraison : scripts service (`test-inbox/send/tasks.mts`) +
  parcours playwright (`shot-inbox/compose/analysis/tasks.mjs`), corps IMAP
  et envoi SMTP mockés via `page.route`. Un bug UX réel trouvé et corrigé
  (panneau de lecture restait ouvert après envoi).

**L5.1 livrée : Lire les mails PARTOUT (début du rattrapage maquette).**
L'utilisateur a fourni une maquette cible et acté : combler les trous
fonctionnels AVANT la L6 — voir la section « Rattrapage maquette » de
ROADMAP.md (L5.2 boîte de réception navigable → L5.3 répondre/envoyer →
L5.4 analyse du mail ouvert → L5.5 tâches). Fait dans cette passe : panneau
de lecture généralisé (`openReader(item, row, {onSeen, onRemoved})` +
`openReaderFor` + `bindOpenables`) et branché partout — sujets cliquables et
bouton 📖 Lire dans ⭐ Importants, ↩️ Réponses, ⏰ Relances (relit le mail
ENVOYÉ, « Toi (mail envoyé) »), 📅 Échéances (mail d'origine), 4 panneaux du
dashboard, sections du brief. `listDeadlines` joint le mail source
(folder/uid/msgDate/isSeen, null si disparu — `loadSourceMeta`) ; les résumés
du brief (OverdueSummary/FollowupSummary) portent folder/uid. Les actions du
panneau rafraîchissent l'écran appelant. Tests : seed-brief.mts étendu
(25 asserts) + test playwright shot-reader.mjs (7 checks, corps IMAP mocké
via page.route). NB test : mettre RATE_LIMIT_MAX haut dans le .env de test
(le rate-limit 60/min sur /api fait des 429 sur les tests navigateur).

**L5 livrée : Brief quotidien & revue hebdo.** Modèle `BriefRun` + migration
(type daily/weekly, periodStart/End, summaryJson — chaque brief archivé tel
quel). `services/brief.ts` : `generateBrief({type})` agrège depuis l'index
(aucun IMAP) : nouveaux mails de la période (approx `Message.createdAt`, hors
corbeille/spam/brouillons), importants minScore 60 (fenêtre 7 j daily / 30 j
weekly), réponses & relances en retard (60 j), échéances proposées+confirmées
sous 14 j, candidats nettoyage, volumétrie par compte ; `previousBrief` =
nouveaux depuis le brief précédent du même type ; comptes en erreur →
`skippedAccounts` sans casser le brief ; `latestBrief(type)`. 2 tools MCP
`generate_daily_brief`/`generate_weekly_review` (34 au total, descriptions
« narrer en français, tutoyer, ne pas recopier le JSON »). API : GET
`/api/brief?type=` (dernier archivé — aucun calcul au chargement du
dashboard), POST `/api/brief/generate`. UI : panneau « ☀️ Brief du jour » en
tête de dashboard — repliable (mémorisé, localStorage `bm.briefCollapsed`),
sélecteur Jour (24 h)/Semaine (7 j), chips cliquables vers les écrans,
sections top 3 (importants/échéances/réponses/relances), ligne par compte,
bouton ☀️ Régénérer. Seed : scratchpad `seed-brief.mts` (2 comptes, 15 mails,
22 asserts) ; capture navigateur OK (panneau, repli, bascule hebdo).

**L4 livrée : Export contacts.** POST `/api/accounts/:slug/export-contacts`
({senders:[{address,name}], format:'vcard'|'csv'} → fichier en pièce jointe
`contacts-<slug>-<date>.vcf|csv`, emails invalides filtrés, cap 2000, 404 si
compte inconnu) ; réutilise services/export.ts (toVCard/toOutlookCsv, v1).
UI : colonne cases à cocher dans le tableau stats de la vue compte
(statsState.selected Map — persiste au tri, vidée au rechargement), case
« tout cocher », barre `.export-bar` (compteur, boutons .vcf/.csv, tout
décocher, rappel import Outlook.com → Contacts → Gérer → Importer),
téléchargement blob avec nom de fichier issu du Content-Disposition.
Seed : scratchpad `seed-export.mts` ; test download réel via playwright.

**L3 livrée : Recherche & lecture dans l'interface.** `services/search.ts`
(recherche métadata index-only multi-comptes : q = OR sujet/adresse/nom,
filtres account/folder/from/subject/since/before/unseen, tri date desc,
limite 500 ; `indexedMessage` revalide un UID + fournit sujet/date pour le
journal ; `reflectActionInIndex` répercute delete/move/seen dans l'index sans
attendre la sync). API : GET `/api/search`, GET `/api/accounts/:slug/messages/
:folder/:uid` (corps via `imapService.readEmail` — 502 avec message clair si
boîte injoignable ; marque lu dans l'index car le FETCH pose \Seen), POST
`/api/accounts/:slug/messages/actions` (delete soft/move/seen/unseen sur UN
mail, UID revalidé contre l'index, journal `ui_delete_message`/
`ui_move_message`/`ui_mark_message` avec sujet+date). Écran `#/search` (lien
sidebar 🔎) : barre + filtres repliables, résultats groupés par compte,
panneau latéral `.reader` (corps texte scrollable, pièces jointes listées,
note de troncature, actions corbeille/déplacer/lu-non lu avec confirm ;
erreur IMAP affichée proprement, actions restent dispo). **DÉCISION
UTILISATEUR (07/2026) : aucun LLM dans cette boucle** — pas de lecture ni
d'analyse de contenu de mails par le LLM de la session de dev (trop cher) ;
l'analyse fine par LLM viendra dans un 2e temps via un Sonnet dédié (backlog
ROADMAP). Seed : scratchpad `seed-search.mts` (2 comptes, 7 mails, 13
asserts) ; test du panneau de lecture via playwright `page.route` (mock JSON).

**Phase 4 brique 4 (L2) livrée : Échéances.** Modèle `Deadline` + migration,
`services/deadlines.ts` : parseur de dates FR maison (14 tests — tournures
fortes conf 0.9, dates nues avec contexte typé conf 0.6, année implicite →
prochaine occurrence avec tolérance 45 j, heures « à 14h30 », rejets 31/02 et
« 15/300 € »), détection sujets (index) + deep corps (IMAP, cap 50/boîte),
newsletters exclues, upsert idempotent qui n'écrase jamais un statut validé.
6 tools MCP (32 au total), API + job `deadlines:<slug>`, écran `#/deadlines`
(bouton Analyser + case analyse approfondie, onglets Proposées/Confirmées/
Passées-faites/Ignorées, extrait du mail affiché), badge sidebar (proposées +
confirmées ≤ 7 j), panneau dashboard. Seed : scratchpad `seed-deadlines.mts`.

Fait : serveur MCP complet, index SQLite + syncs (incrémentales, résilientes,
« Tout synchroniser », suivi global), interface (dashboard, stats, nettoyage
fin auto/perso avec liste cochable, journal détaillé, enrôlement popup,
mise à jour 1-clic, détection superviseur). ~18 000 mails indexés, 2 boîtes.

**Phase 4 brique 3 (L1) livrée : Mails importants.** `services/importance.ts`
(score additif 0-100 plafonné, chaque règle ajoute sa raison en français :
banque/admin +30, sujet urgent +20, personne +15 / conversation +10, non lu
récent +15, question +10, montant +10, attend une réponse +10, newsletter/
notification −40 ; level high ≥ 70 / medium 40-69 / low < 40 ;
`explainImportance` par messageId ou threadId). `Sender.kind` recalculé à
chaque sync dans `rebuildSenders()` (newsletter si ≥ 80 % unsubscribe,
notification si AUTO_SENDER_RE, person si un fil de l'expéditeur contient un
sortant, sinon company — recalcul systématique v1, écraserait un kind manuel).
2 tools MCP (get_important_emails, explain_importance — 26 tools au total),
API GET `/api/attention/important` (agrégée, lecture seule en v1 : pas
d'AttentionState), écran `#/important` (KPIs par niveau, filtres minScore
40/50/70 + fenêtre 7-90 j + lus/non lus, pastille de score colorée
`.score-pill`, raisons affichées), panneau dashboard top 5, badge sidebar =
nb high. Seed : scratchpad `seed-important.mts` (2 comptes, 7 mails, asserts
Sender.kind + scores + tri + explain).

**Phase 4 briques 1 ET 2 livrées.** Brique 2 (Relances) :
`services/followups.ts` (dernier message du fil SORTANT, dossier Envoyés,
sans réponse externe ; correspondant = dernier entrant du fil sinon
destinataire ; no-reply et mails à soi-même exclus ; seuils sujet pressant
3 j / banque-admin-pro 5 j / normal 7 j), état AttentionState kind=followup
(helpers génériques snooze/dismiss/restore mutualisés dans attention.ts),
4 tools MCP (get_followups_due, snooze_followup, mark_followup_done,
restore_followup — 24 tools au total), API `/api/attention/followups`,
écran `#/followups` (onglets À relancer / En retard / Reportées / Traitées,
badge sidebar, panneau dashboard).

**Phase 4 brique 1 : Réponses oubliées.** `services/attention.ts`
(détection index-only : dernier message entrant du fil, inbox, sans réponse
sortante depuis ; newsletters/no-reply exclus ; catégories urgent 24 h /
banque-admin 48 h — IMPORTANT_SENDER_RE prudente, pas de domaines grand
public — / normal 7 j ; `reason` explicite en français), table
`AttentionState` (snooze/dismiss par fil, lié au dernier message → caduc si
un nouveau mail arrive), 5 tools MCP (get_unanswered_emails,
get_overdue_replies, snooze_reply, dismiss_reply, restore_reply), API
`/api/attention/replies` (+ snooze/dismiss/restore par compte), écran
« Réponses en attente » (onglets À traiter / En retard / Reportés / Ignorés,
badge sidebar, panneau dashboard). Journal : désormais UNE entrée par
opération de nettoyage (plus une par lot — les lots de 200 restent un
garde-fou d'exécution IMAP). Seed de test : voir scratchpad session
(2 comptes factices + 13 mails couvrant tous les cas, accounts.json factice).

## PROCHAINE ÉTAPE

**Séries A (Cap V3), B (fiabilisation) et BL1 (analyse fine MCP sur le
forfait) COMPLÈTES (livrées le 10/07).** La façade MCP est prête pour
Cowork : le sens de L6 est décuplé (c'est le déploiement qui « allume »
l'IA sur forfait). Prochaine étape logique : **L6 déploiement Oracle**
(~45 min avec l'utilisateur, tout est prêt — docs/DEPLOY-ORACLE.md :
VM OCI, DNS, script 1-commande, Entra, connecteur Cowork). Restent
aussi : VALIDATION RÉELLE de la série B par l'utilisateur (backfill 🏷️
pour poser la confiance B4, examen de détections dans 🔬 Vérifier
l'analyse, verdicts → % de précision), et le backlog (dossiers
intelligents, désinscription newsletters, brouillons IMAP, extraction
PDF factures ; « analyse LLM Sonnet dédiée » ABANDONNÉE au profit du
forfait via Cowork — décision utilisateur 10/07).
IMPORTANT avant/pendant L6 : l'utilisateur doit valider en réel (sur son
PC) les pièces jointes, les actions en masse multi-boîtes et l'ENVOI
(testé uniquement mocké — pas d'IMAP/SMTP dans l'environnement de dev).
Une livraison par session ; lire CLAUDE.md + la livraison visée uniquement ;
à la fin, cocher dans ROADMAP.md et mettre à jour l'« État » ci-dessus.

