Verdict

FAIT. Sur ton échantillon, 11 échéances sur 15 étaient proposées alors que l'analyse IA existante disait déjà read/archive/none, et 3 propositions étaient des doublons exacts. Après mise en place du veto IA, 10/15 ont été écartées.

INFÉRENCE. Vous avez tous les deux raison, mais pas au même niveau :

l'utilisateur a raison sur le symptôme produit : un système qui transforme « paiement + 12 mai » en « échéance de paiement » donne effectivement l'impression de classer n'importe comment ;

tu as raison sur la cause architecturale : l'IA était présente, avait compris correctement le mail, mais un producteur de sens inférieur avait le droit de publier une conclusion contradictoire.

La conclusion « il faut de l'IA partout » ne découle donc pas de cet incident. La vraie conclusion est :

Un détecteur n'a pas le droit de transformer un indice lexical en vérité métier lorsqu'une interprétation sémantique supérieure existe.

Et je vais même plus loin : le problème n'est pas seulement l'absence de hiérarchie. Il y a eu confusion entre extraction et interprétation.
Trouver paiement, 12 mai 2026 est une extraction. Dire échéance de paiement = 12 mai est une interprétation.

1. Qui a raison, et comment le démontrer à l'écran
FAIT

Pour PayFiP :

le détecteur local avait correctement trouvé un mot et une date ;

il avait incorrectement établi la relation sémantique entre les deux ;

l'IA avait correctement établi cette relation : date d'une indisponibilité, pas date d'une action à réaliser.

INFÉRENCE

Je ne supprimerais donc surtout pas le moteur local. Je lui retirerais le droit d'affirmer ce qu'il ne sait pas établir.

Le moteur local aurait dû produire quelque chose ressemblant conceptuellement à :

date trouvée = 12/05/2026
contexte = paiement
nature de la date = inconnue

et non :

échéance paiement = 12/05/2026.

Ce que je montrerais à l'utilisateur

Pas un discours sur « l'architecture hybride ». Une preuve observable.

Sur ce mail, dans un petit panneau « Analyse » :

Aucune action requise
France Titres informe d'une interruption PayFiP le 12 mai.

Date détectée : 12 mai 2026
Elle concerne l'indisponibilité du service, pas une échéance vous concernant.

✓ Une proposition d'échéance a été écartée.

Et éventuellement derrière « Pourquoi ? » :

Analyse sémantique : information — confiance haute
Détection locale : « paiement » + date — signal insuffisant

C'est beaucoup plus convaincant que « crois-moi, mon architecture est bonne ».

Le meilleur écran de confiance serait même un petit historique :

15 dates détectées · 10 écartées après analyse contradictoire · 3 doublons fusionnés · N échéances réellement conservées.

Attention : ne qualifie pas les 10 de « fausses » tant qu'elles n'ont pas été humainement validées comme telles.

2. La hiérarchie exacte entre producteurs de sens

Je ne ferais pas une hiérarchie universelle du genre IA > pièce jointe > contenu > sujet.

Ce serait une erreur d'architecture.

Pourquoi ? Parce qu'ils ne répondent pas tous à la même question.

Une date écrite dans une facture peut être une meilleure source factuelle que l'IA. En revanche, le comportement historique de l'utilisateur peut être une bonne source pour savoir quoi faire du mail, mais une très mauvaise source pour déterminer ce que signifie une date.

Il faut donc une hiérarchie par type de conclusion.

Conclusion recherchée	Autorité décroissante
Fait brut : date, montant, identifiant	champ structuré / texte exact > extraction locale > IA
Nature sémantique : information, demande, obligation	preuve explicite structurée > IA haute confiance > heuristique contenu > heuristique sujet
Nature d'une date	relation explicite action↔date > IA haute confiance > heuristique sémantique stricte > sinon abstention
Action recommandée	règle utilisateur explicite > état réel du thread > IA haute confiance > comportement historique > heuristique
Doublon	identité déterministe > tout le reste
Et surtout : les niveaux faibles n'ont pas un droit général de contradiction.

Une heuristique de sujet :

paiement + date

ne peut jamais battre :

IA haute confiance = information sans action.

En revanche :

PDF : "Montant à régler : 1 250 € — Date d'échéance : 31/08/2026"

est une preuve dure. Si l'IA historique dit read, je ne laisse ni l'un ni l'autre gagner silencieusement :

CONFLIT → HOLD / à vérifier.

C'est là que je modifierais ton correctif actuel.

Ton veto actuel :

IA haute confiance + rien à faire ⇒ aucune échéance

devrait devenir :

IA haute confiance + rien à faire ⇒ veto sur tous les signaux faibles, mais pas sur une preuve dure contradictoire.

3. « Date qui m'engage » contre « date qui informe »

C'est exactement ici qu'un moteur lexical classique est insuffisant.

FAIT

Les mêmes mots apparaissent des deux côtés :

« paiement indisponible le 12 mai »

« paiement à effectuer avant le 12 mai ».

paiement et 12 mai ne suffisent donc pas.

Règle exacte

Une date ne devient une échéance que si le système peut établir les trois relations suivantes :

ACTEUR → ACTION → CONTRAINTE TEMPORELLE

Autrement dit :

quelqu'un que l'utilisateur représente ou contrôle
doit / devrait effectuer une action
et la date contraint l'exécution de cette action.

Par exemple :

« Merci de régler cette facture avant le 12 mai. »

acteur = destinataire ;

action = régler ;

contrainte = avant le 12 mai ;

⇒ échéance.

« Les paiements seront indisponibles le 12 mai. »

événement = indisponibilité du système ;

paiement n'est pas une action demandée au destinataire ;

la date qualifie l'événement ;

⇒ date informative.

« Votre prélèvement sera effectué le 12 mai. »

événement financier ;

aucune action manuelle demandée ;

⇒ date transactionnelle, mais pas échéance utilisateur.

Je créerais d'ailleurs au minimum quatre types internes :

DEADLINE — action à réaliser avant/à une date
EVENT — rendez-vous, intervention, réservation…
TRANSACTION — prélèvement, virement programmé…
INFORMATION_DATE — maintenance, tarif, lancement, changement réglementaire…

Cela évite de vouloir faire rentrer toutes les dates dans échéance / pas échéance.

Règle déterministe stricte

Sans IA, le moteur local ne peut promouvoir une date en DEADLINE que si l'une de ces choses est explicitement présente :

champ structuré : Date d'échéance, Due date, etc. ;

construction syntaxique explicite du type à payer avant, à transmettre avant, merci de répondre avant, à retourner au plus tard, etc. ;

relation structurée équivalente reconnue dans un document.

Sinon :

date candidate, nature inconnue. Pas d'échéance.

C'est volontairement conservateur.

4. L'abstention est effectivement le cœur du problème

INFÉRENCE. Oui : le défaut le plus grave est moins « avoir mal classé » que transformer une incertitude en affirmation utilisateur.

Il te manque un troisième état.

Pas :

OUI / NON

mais :

ASSERT / HOLD / IGNORE.

ASSERT

Le système a suffisamment de preuve pour créer une échéance visible, notifier, proposer une action.

HOLD

Il existe un risque réel mais le système ne comprend pas suffisamment.

Il mémorise :

date candidate = 12 mai
raison = ambiguë

mais ne crée aucune échéance.

Selon le risque, HOLD peut apparaître dans une revue légère « 3 éléments à vérifier », sans contaminer la vraie liste des tâches.

IGNORE

Les éléments disponibles indiquent qu'il ne s'agit pas d'une action utilisateur.

Cela règle le conflit entre deux coûts :

trop d'ASSERT ⇒ charge mentale + perte de confiance ;

trop d'IGNORE ⇒ échéances ratées.

Le HOLD absorbe cette zone intermédiaire.

Comment le mesurer

Ne mesure surtout pas seulement « combien le moteur détecte ».

Mesure au minimum :

Precision visible

vraies échéances proposées / toutes les échéances proposées

C'est ton indicateur de confiance.

Miss rate

échéances réelles retrouvées lors de l'audit des HOLD + IGNORE.

C'est ton indicateur de danger lié à l'abstention.

Abstention rate

part des candidats envoyés en HOLD.

Rescue rate

part des HOLD qui se révèlent être de vraies échéances.

HYPOTHÈSE à tester

Pour ce produit personnel, je privilégierais une très forte précision dans la liste principale, probablement de l'ordre de 97–99 %, quitte à envoyer davantage de cas ambigus en HOLD.

Mais ce seuil doit être déterminé sur ton corpus, pas choisi philosophiquement.

Surtout, fais des audits stratifiés :

factures ;

administrations ;

banques ;

assurances ;

réservations ;

mails ordinaires.

Sinon 500 newsletters faciles peuvent masquer cinq échéances fiscales ratées.

5. Les heuristiques doivent-elles se taire lorsqu'une IA existe ?

Presque oui pour la sémantique. Non pour le reste.

C'est la distinction la plus importante de ma réponse.

Tu as 17 186 mails avec intention IA et 7 751 avec intention heuristique. Au passage :

FAIT : 17 186 + 7 751 = 24 937, alors que tu annonces 24 945 mails. Il reste donc 8 mails hors de ces deux populations si celles-ci sont censées être exhaustives et disjointes.

Sur les 17 186 mails disposant déjà d'un verdict IA valable, je transformerais les heuristiques de :

producteurs concurrents

en :

auditeurs / extracteurs / garde-fous.

Elles continuent à tourner, mais ne publient généralement plus une seconde interprétation.

Une heuristique peut contredire l'IA uniquement dans quelques cas précis :

preuve structurée dure contradictoire : Date d'échéance : 31/08/2026, montant dû, etc. ;

information absente de l'entrée IA : pièce jointe non analysée, texte mal extrait ;

état postérieur à l'analyse IA : réponse désormais envoyée, paiement enregistré, nouveau message dans le thread ;

règle explicite de l'utilisateur qui modifie l'action à effectuer ;

preuve d'identité/doublon : elle peut supprimer une proposition IA dupliquée.

En revanche :

« paiement » dans le sujet

date quelque part dans le contenu

n'est jamais une raison suffisante pour contredire une analyse IA haute confiance.

Comportement passé

Je serais particulièrement prudent.

Le comportement historique peut dire :

« Anthony archive presque toujours ces notifications ».

Il ne peut pas conclure :

« ce mail n'est pas une facture ».

Donc comportement passé :

fort pour personnaliser l'action,
faible ou nul pour établir les faits et la sémantique.

6. Ce qui doit rester déterministe et ce qui revient à l'IA

Je ferais une séparation beaucoup plus nette que celle que tu as aujourd'hui.

Moteur local : constater, gérer, faire respecter

Il doit posséder :

ingestion et normalisation ;

identité expéditeur / message / thread ;

déduplication ;

état read/replied/archived ;

extraction brute des dates, montants, références ;

extraction des champs structurés stricts ;

reconnaissance des formulations d'obligation sans ambiguïté ;

gestion de durée de vie : une maintenance du 12 mai devient obsolète le 13 ;

regroupement et idempotence des échéances ;

application des règles utilisateur ;

historique des décisions ;

arbitrage entre sources ;

abstention ;

fonctionnement offline ;

stockage et réutilisation des analyses IA existantes.

Et surtout :

le moteur local peut affirmer des faits déterministes ; il ne doit interpréter librement du langage que dans un domaine fermé où la règle est non ambiguë.

IA : comprendre les relations

Elle est responsable de :

intention du message ;

« qui demande quoi à qui » ;

action réellement attendue ;

distinction information / obligation ;

rôle sémantique des dates ;

compréhension d'une pièce jointe en prose ;

résumé ;

besoin réel de réponse ;

résolution d'ambiguïtés linguistiques.

Ton analyse IA historique doit donc devenir une sorte de cache sémantique persistant, pas un commentaire parmi d'autres.

Je lui ajouterais des métadonnées :

analyzed_at
content_hash
attachment_hashes / attachment_coverage
analyzer_version
confidence

Ainsi, le serveur sait :

« cette interprétation IA portait exactement sur cette version du contenu et de ses pièces jointes ».

Si le contenu n'a pas changé, tu peux la réutiliser indéfiniment sans refaire un appel.

En mode sans IA

C'est là que ton architecture doit assumer son compromis :

elle doit perdre en rappel avant de perdre en précision.

Autrement dit, elle continue à détecter une facture portant explicitement Date d'échéance, mais elle ne fabrique plus une obligation à partir de paiement + 12 mai.

C'est un mode dégradé acceptable.

Un mode dégradé qui invente des échéances ne l'est pas.

Deux défauts distincts dans ton incident

INFÉRENCE. Je traiterais également les 3 doublons séparément.

Ils n'ont rien à voir avec Claude ou la compréhension du langage.

Trois doublons exacts signifient que ton pipeline de création d'artefacts n'est pas suffisamment idempotent.

Même une analyse parfaite aurait produit trois bonnes échéances identiques.

Donc ton pipeline devrait être conceptuellement :

extraction → interprétation → arbitrage → déduplication/idempotence → publication

et aucun producteur ne crée directement une échéance utilisateur.

Tous produisent uniquement des claims ou candidates.

Un arbitre central est le seul composant autorisé à créer l'objet métier Deadline.

C'est probablement la correction structurelle la plus importante.

La règle d'arbitrage que je coderais telle quelle
RULE ARBITRATE_DEADLINE(message):

1. Aucun détecteur ne crée directement une échéance.
   Tous produisent uniquement des EVIDENCE.

2. Classer les preuves positives en deux catégories :

   HARD_POSITIVE:
   - champ explicitement nommé "date d'échéance" / équivalent ;
   - ou relation explicite ACTEUR_UTILISATEUR -> ACTION_REQUISE -> DATE_LIMITE ;
   - ou règle utilisateur explicite.

   WEAK_POSITIVE:
   - mot-clé de paiement ;
   - date isolée ;
   - montant ;
   - heuristique de sujet ;
   - cooccurrence mot-clé + date ;
   - comportement historique.

3. Si une HARD_POSITIVE existe :
      si un verdict IA HIGH contradictoire existe:
          résultat = HOLD_CONFLICT
      sinon:
          résultat = ASSERT_DEADLINE

4. Sinon, si un verdict IA HIGH existe :
      si IA conclut qu'une action utilisateur est requise
         ET relie explicitement une date à cette action:
             résultat = ASSERT_DEADLINE
      sinon:
             résultat = IGNORE_DEADLINE
             même si une ou plusieurs WEAK_POSITIVE existent

5. Sinon, si aucun verdict IA HIGH exploitable n'existe :
      si une preuve locale peut établir explicitement
         ACTEUR_UTILISATEUR -> ACTION_REQUISE -> DATE_LIMITE:
             résultat = ASSERT_DEADLINE
      sinon si le message appartient à une catégorie à risque
         et contient une date candidate:
             résultat = HOLD
      sinon:
             résultat = IGNORE_DEADLINE

6. Le comportement passé de l'utilisateur :
      - peut modifier l'ACTION ou la VISIBILITÉ ;
      - ne peut jamais transformer une date informative en échéance ;
      - ne constitue jamais seul une HARD_POSITIVE.

7. Une heuristique de SUJET ne peut jamais contredire :
      - une HARD_POSITIVE,
      - une HARD_NEGATIVE,
      - ou un verdict IA HIGH.

8. Une heuristique de CONTENU faible ne peut jamais contredire
   un verdict IA HIGH.

9. Une preuve structurée contradictoire avec l'IA ne remplace pas
   silencieusement l'IA :
      résultat = HOLD_CONFLICT.

10. Avant publication :
      appliquer une clé d'idempotence métier.
      Si une échéance équivalente existe déjà :
          MERGE, jamais CREATE.

11. Seuls ASSERT_DEADLINE deviennent des échéances utilisateur.
    HOLD et HOLD_CONFLICT ne déclenchent ni notification
    ni échéance ferme.

La phrase d'architecture que je garderais est donc : les heuristiques détectent, l'IA interprète, les preuves dures établissent, et un arbitre unique décide. Aucun de ces producteurs ne publie directement.