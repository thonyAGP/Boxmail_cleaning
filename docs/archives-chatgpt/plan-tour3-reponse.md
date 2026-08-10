Oui. Le backtest oblige à corriger le modèle, pas seulement les coefficients. Je change d'avis sur le cœur du moteur : le score de relation ne doit plus être le prédicteur principal de l'attention. Il devient un prior faible. Le cœur doit être « conséquence potentielle si ignoré » + « action détectée » + « contexte » + « incertitude ».

1. Les 7 102 verdicts « manquants »

FAIT MESURÉ — Les 24 295 verdicts sont entièrement expliqués : archive 9 810, read 7 010, none 6 136, reply 1 067, pay 272. L'écart venait du filtre isDeleted=0.

INFÉRENCE — Il n'y a donc aucun problème de vocabulaire IA ou de migration à résoudre avant d'utiliser ce stock.

HYPOTHÈSE — Aucune nécessaire ici.

Je change d'avis : ma demande précédente de rechercher d'éventuelles autres valeurs aiAction est close. On peut figer ces cinq valeurs comme contrat historique.

2. Les verdicts IA sont effectivement un actif très fort

FAIT MESURÉ — Probabilité d'une réponse humaine réelle :

reply : 49 %

pay : 28 %

none : 22 %

read : 19 %

archive : 8 %

reply est donc associé à une réponse réelle 6,1 fois plus souvent qu'archive.

INFÉRENCE — aiAction contient une vraie information discriminante. Il serait absurde de refaire analyser ces 24 295 mails.

Mais attention : cette mesure démontre que aiAction prédit assez bien un comportement de réponse. Elle ne démontre pas que reply > pay en termes d'importance.

Au contraire :

pay doit probablement avoir une conséquence potentielle supérieure à reply, même si Anthony répond moins souvent aux mails pay.

Je change d'avis : je donne désormais à aiAction une place centrale dans le moteur, mais comme signal sémantique/actionnable, pas comme score d'importance appris sur les réponses.

3. Le score de relation : échec confirmé, mais avec une nuance

FAIT MESURÉ — Sur 4 152 mails 2025–2026 :

top 10 % → 29 % des réponses ;

top 20 % → 42 % ;

top 30 % → 45 % ;

top 50 % → toujours 45 %.

Et 1 787 mails, soit 43 %, viennent d'expéditeurs jamais vus avant 2025.

INFÉRENCE — Le modèle relationnel est structurellement incapable de classer correctement une part énorme des nouveaux flux. Le plateau montre aussi que son pouvoir discriminant s'épuise extrêmement vite.

Nuance importante : les données fournies ne permettent pas encore de prouver que les nouveaux correspondants expliquent à eux seuls l'essentiel des 55 % de réponses ratées. Pour le démontrer, il faudrait connaître :

nombre des 240 réponses provenant des 1 787 expéditeurs nouveaux.

Mais ce n'est pas nécessaire pour la décision architecturale : 43 % de score à zéro est déjà rédhibitoire pour en faire le moteur principal.

Je change d'avis nettement :

ancien modèle : relation jusqu'à 40 points, cœur du score
nouveau modèle : relation maximum ±10 points, seulement comme prior/tie-breaker.

Je garderais ton calcul historique, parce qu'il est utile. Mais je ne chercherais plus à beaucoup l'améliorer.

4. Oui : « réponse » était le mauvais critère de validation

Ta critique est correcte.

FAIT MESURÉ — Seulement 240 mails sur 4 152 ont reçu une réponse : 5,8 %.

FAIT MESURÉ — Tu disposes par ailleurs de catégories pay, d'échéances détectées et de documents dont l'utilité ne nécessite aucune réponse.

INFÉRENCE — Optimiser le moteur sur reply revient à confondre :

« Anthony communique avec quelqu'un »

et :

« Anthony subit une conséquence s'il ignore ce message ».

Ce sont deux choses différentes.

Je change d'avis : je retire complètement :

« ≥85 % des réponses dans le top 30 % »

comme KPI du moteur d'attention.

Quel ground truth utiliser à la place ?

Il y a une limite méthodologique importante :

tu ne peux pas reconstruire avec certitude l'« importance pour Anthony » sans aucun label humain.

Il n'existe pas dans les 10 ans d'emails une colonne secrète important=1.

Donc je ne fabriquerais surtout pas un pseudo-ground-truth unique.

Je construirais plutôt trois jeux de validation indépendants.

Jeu A — « conséquences observables »

Un mail appartient au set MUST_SURFACE s'il présente au moins un de ces faits :

réponse humaine ultérieure
OR aiAction = reply
OR aiAction = pay
OR échéance détectée
OR document à conséquence détectable

La dernière catégorie comprend par règles locales :

facture/appel de fonds ;

contrat/avenant ;

convocation ;

mise en demeure ;

échéance assurance ;

fiscalité/impôt ;

paiement/prélèvement ;

signature ;

document juridique.

Ce n'est pas la vérité absolue.

C'est un filet de sécurité observable.

KPI

Parmi MUST_SURFACE :

≥98 % ne doivent jamais finir automatiquement dans « Fait pour vous » à faible visibilité.

Et séparément :

pay : 100 %

échéance : 100 %

réponse réelle : cible ≥95 %

document à conséquence : ≥98 %

La réponse devient donc un test de sécurité parmi plusieurs, plus la cible principale.

Jeu B — « candidats à faible risque »

Crée un LIKELY_LOW_RISK volontairement strict :

aiAction = archive
AND aucune réponse ultérieure
AND aucune échéance
AND aucune pièce à conséquence
AND aucun contexte actif détecté

Éventuellement avec signal historique expéditeur/domaine faible.

KPI

Le moteur doit pouvoir envoyer directement :

≥80 % de ce set dans « Fait pour vous »

sans intervention.

Cela mesure sa capacité à enlever de la charge.

Jeu C — l'intersection réellement dangereuse

Le KPI le plus important devient :

False Auto-Done Rate

Parmi tous les mails que le moteur veut traiter sans Anthony :

nombre présentant ensuite un signal MUST_SURFACE
/
nombre total auto-traité

Je fixerais :

<1 % de red flags dans Auto-Done

et :

<2 % de mails ayant ensuite reçu une réponse humaine.

Cela correspond beaucoup mieux à ton produit :

« combien de choses potentiellement coûteuses aurais-je cachées en voulant économiser de l'attention ? »

Attention à la fuite de données dans le backtest

Si aiAction=pay donne +35 au score et que ton test consiste ensuite à vérifier que les aiAction=pay remontent, tu testes essentiellement ton if.

Il faut donc deux mesures :

Production

Tout utiliser.

Validation par ablation

Pour chaque signal important, retire-le momentanément et demande :

les autres signaux récupèrent-ils le message ?

Par exemple :

test deadlines → recalcul sans feature deadline.

test aiAction → recalcul sans aiAction.

test relation → recalcul sans relation.

Ça permettra de connaître la résilience du moteur, et pas seulement sa capacité à recopier ses entrées.

5. Les 43 % d'expéditeurs inconnus : ne pas leur inventer une relation

Le changement conceptuel est simple :

inconnu doit augmenter l'incertitude, pas diminuer l'importance.

relationScore = 0 est correct.

Le problème était d'avoir donné 40 % du score total à la relation.

Pour un inconnu, je regarderais dans cet ordre :

1. Le message lui-même

Détecteurs locaux :

échéance ;

montant ;

demande explicite ;

paiement ;

réponse demandée ;

signature ;

rendez-vous ;

contrat ;

juridique ;

fiscal ;

bancaire ;

assurance.

2. Les pièces

Le texte des PDF est potentiellement extrêmement discriminant ici.

Un nouveau correspondant avec :

ACTE DE VENTE
adresse d'un bien connu
numéro de dossier

ne doit pas avoir besoin d'une réputation historique.

3. Le contexte connu

Exemples :

adresse connue d'un appartement : + fort signal contextuel
nom d'une société : signal
numéro de dossier déjà vu : très fort
référence d'une affaire active : très fort.

4. Le domaine

Pas seulement l'email exact.

Un nouveau :

marie.dupont@comptastar.fr

peut être inconnu personnellement alors que :

@comptastar.fr

a 400 messages historiques.

Je construirais donc deux priors :

senderPrior
domainPrior

Et le domaine peut parfaitement fonctionner sur une partie des 43 %.

5. Claude uniquement à la fin

Si :

expéditeur inconnu ;

aucun verdict IA existant ;

contenu ambigu ;

décision automatique aurait une conséquence ;

score intermédiaire ;

alors Claude.

Pas avant.

6a. Architecture que je coderais maintenant

Je supprimerais l'idée d'un score unique faisant tout.

Il faut trois sorties distinctes.

1. CONSEQUENCE_RISK   0..100
2. ACTION_NEED        0..100
3. UNCERTAINTY        0..100

Puis un arbre transforme cela en zone.

C'est beaucoup plus robuste.

Étape 1 — extraction locale des faits

Tout ceci est local :

aiAction existant
deadline
type de document
montant
demande explicite
réponse ultérieure / état du thread
expéditeur
domaine
mailbox
entités reconnues
adresse de bien
numéro dossier
profil historique sender
profil historique domain
pièce jointe / texte extrait

Pas de Claude.

CONSEQUENCE_RISK

Je partirais de cette V1 exacte.

Verdict historique IA
pay       +35
reply     +20
read      +8
none       0
archive  -20

Pourquoi pay > reply malgré tes statistiques ?

Parce que ce score mesure le coût de l'oubli, pas la probabilité de réponse.

Échéance
<= 7 jours       +35
8–30 jours       +25
31–90 jours      +15
> 90 jours        +8
Nature détectée localement
juridique / mise en demeure / convocation        +30
fiscal / prélèvement rejeté / banque critique    +25
assurance expiration / contrat / signature       +22
facture / appel de fonds / paiement              +20
rendez-vous ou réservation avec date             +15
document administratif                            +8

Maximum de ce bloc, pas somme de toutes les catégories :

max +30

Sinon une facture juridique avec date exploserait artificiellement le score.

Contexte
numéro de dossier déjà connu          +18
entité/affaire active                  +15
adresse de bien connue                 +12
société explicitement reconnue          +5

Cap contexte :

+20
Relation

Désormais :

sender prior     -5 .. +8
domain prior     -5 .. +8

Cap combiné :

-10 .. +10

Plus jamais +40.

Puis :

CONSEQUENCE =
clamp(
  aiVerdict
+ deadline
+ nature
+ context
+ relation,
0, 100)
ACTION_NEED

Deuxième score totalement séparé :

aiAction=pay                     +45
aiAction=reply                   +40
demande explicite locale         +35
échéance <=7 j                   +25
échéance <=30 j                  +15
signature / paiement requis      +30
dernier mail entrant non répondu +20
simple information                0
archive                         -20

Cap 100.

Le point important :

Une assurance expirant bientôt peut avoir :

CONSEQUENCE = 80
ACTION_NEED = 30

Elle mérite attention même si aucune réponse n'est nécessaire.

UNCERTAINTY

C'est ici que tu traites les nouveaux correspondants.

aucun verdict IA                  +20
expéditeur jamais vu              +15
domaine jamais vu                 +10
classification locale conflictuelle +20
pièce utile non extraite          +20
entité ambiguë                    +10

Réductions :

numéro dossier exact              -20
adresse exacte connue             -15
verdict IA présent                -15
domaine historique très stable    -10
UNCERTAINTY = clamp(..., 0, 100)

Un expéditeur inconnu n'est donc pas +15 important. Il est +15 incertain.

C'est la correction architecturale essentielle.

Arbre de décision

Je coderais cette politique avant d'essayer d'optimiser les coefficients.

SI action explicite ET ACTION_NEED >= 50
    → À FAIRE

SINON SI état = attente d'un tiers
    → À SURVEILLER

SINON SI CONSEQUENCE >= 70
    → À FAIRE
      ou À VÉRIFIER si l'action exacte est inconnue

SINON SI UNCERTAINTY >= 45
     ET CONSEQUENCE >= 35
    → À VÉRIFIER

SINON SI CONSEQUENCE <= 25
     ET ACTION_NEED <= 20
     ET UNCERTAINTY <= 35
    → FAIT POUR VOUS

SINON
    → À VÉRIFIER

Et ensuite le score de conséquence sert uniquement à ordonner les éléments dans une zone.

Quand appeler Claude

Je mettrais un portail très strict :

pas de verdict IA disponible
AND
35 <= CONSEQUENCE_LOCAL <= 69
AND
UNCERTAINTY >= 45

OU :

pièce jointe potentiellement importante
mais classification locale ambiguë

Claude doit répondre sur une structure fermée :

actionRequired
actionType
deadline
consequenceType
entities
confidence
shortReason

Puis le moteur local recalcule lui-même la décision.

Claude ne doit jamais dire directement :

zone = À faire.

C'est le moteur déterministe qui décide.

Cas du nouveau notaire

Premier mail historique.

sender relation     0
sender unknown      uncertainty +15
domain éventuellement connu
PDF "projet acte vente"
nature juridique    +30
adresse bien connue +12
deadline éventuelle +25

Même sans relation :

CONSEQUENCE probablement >70

→ À FAIRE / À VÉRIFIER.

Exactement ce qu'on veut.

Cas d'une nouvelle plateforme promotionnelle
sender unknown          uncertainty +15
domain unknown          +10
aucune échéance
aucun contexte
aucune pièce importante
nature promo/local      consequence faible

Elle ne deviendra pas importante parce qu'elle est nouvelle.

Si le classifieur local est sûr :

→ Fait pour vous.

S'il est ambigu :

→ éventuellement À vérifier une fois.

Puis l'historique de domaine prendra le relais.

6b. Roadmap corrigée

Je la réduirais maintenant à quatre vrais chantiers.

Phase	Ce qu'on construit	Test rétrospectif
0 — Banc de validation	MUST_SURFACE, LIKELY_LOW_RISK, métriques par sous-population	100 % des 4 152 mails 2025–26 évaluables ; métriques séparées connus/inconnus
1 — Moteur conséquence/action/incertitude	scores + arbre ci-dessus, sans Claude nouveau	≥98 % des MUST_SURFACE hors Auto-Done ; 100 % pay/échéances ; ≥95 % des réponses réelles hors Auto-Done
2 — Nouveaux correspondants/contextes	domain prior + entités + biens + dossiers + texte PJ	Sur les 1 787 inconnus : ≥95 % des MUST_SURFACE hors Auto-Done et ≥40 % des faibles risques résolus sans À vérifier
3 — Résolution sélective Claude	Claude uniquement sur bande ambiguë	≤15 % du flux aurait besoin de Claude ; cette tranche doit concentrer ≥3× plus de MUST_SURFACE que le flux moyen
4 — Écran inversé	quatre zones + exécution/contestation	En replay 2025–26 : ≥40 % des mails en Fait pour vous, ≤20 % en À vérifier, avec False Auto-Done <1 %

Les seuils 40 % Fait pour vous et 20 % À vérifier sont des objectifs de départ, pas une vérité issue de tes données. Ils doivent céder devant la sécurité : je préférerais 30 % auto-traités avec 0,5 % de fuite que 70 % avec 5 %.

Une métrique supplémentaire que je considérerais comme obligatoire

Ne regarde jamais uniquement le résultat global.

Ton rapport de backtest devrait être systématiquement découpé en :

KNOWN SENDER
UNKNOWN SENDER

WITH ATTACHMENT
WITHOUT ATTACHMENT

AI VERDICT PRESENT
AI VERDICT ABSENT

WITH DEADLINE
WITHOUT DEADLINE

2021 / 2022 / 2023 / 2024 / 2025 / 2026

Sinon une excellente performance sur les expéditeurs connus pourrait continuer à masquer exactement le trou que tu viens de découvrir sur les 43 % d'inconnus.

Ce que je figerais maintenant

Je ne recoderais plus le relation score.

Je conserverais sa sortie avec un poids maximal de ±10 et je passerais directement au backtest de ce moteur à trois dimensions.

Le premier tableau que je voudrais voir ensuite n'est plus un « recall top 30 % ». Ce serait :

                         TOTAL   CONNUS   INCONNUS
mails
MUST_SURFACE
Auto-Done
À vérifier
À faire
À surveiller

MUST_SURFACE → Auto-Done %
réponses réelles → Auto-Done %
pay → Auto-Done %
deadline → Auto-Done %
documents critiques → Auto-Done %

% du flux Auto-Done
% du flux À vérifier

C'est ce tableau qui dira si l'assistant peut réellement commencer à prendre les devants sans devenir dangereux.