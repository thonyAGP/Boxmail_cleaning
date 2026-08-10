Oui, son verdict est juste. Ce que tu as construit ressemble moins à un assistant qu’à un centre de validation des décisions prises par une machine. Et c’est précisément l’inverse de « réduire ma charge neuronale ».

1. Ce qui fait « 1990 / opérateur de saisie »

FAIT — le mécanisme principal fautif est la file de contrôle.

Ton modèle implicite est :

machine détecte → machine propose → humain ouvre une liste → humain contrôle chaque ligne → humain choisit un statut → ligne change de file.

C’est exactement un logiciel de back-office.

Les mécanismes qui produisent cette sensation sont très précis :

A. Tu exposes la plomberie interne

« Proposées / Confirmées / Passées / Ignorées / Écartées » sont des états de ton moteur, pas des concepts appartenant à Anthony.

Anthony ne se réveille jamais en se disant :

« Je vais consulter mes dates écartées par l'analyse. »

Il pense :

« Qu'est-ce qui mérite mon attention aujourd'hui ? »

Ton architecture d'information est donc organisée selon la façon dont le logiciel travaille, pas selon la façon dont l'utilisateur vit.

B. Tu transformes chaque détection en tâche humaine

C'est probablement ton erreur la plus coûteuse.

Une IA trouve 22 dates.

Ton interface répond :

22 objets potentiellement intéressants que l'humain peut contrôler.

Un assistant devrait répondre :

« Une seule de ces dates nécessite ton attention. Je me suis occupé du reste. »

Tu convertis de l'automatisation en travail de vérification.

C. Chaque ligne est une mini-formulaire

Une ligne avec :

Confirmer · Fait · Ignorer · Lire · Rétablir · Passer

demande successivement :

comprendre l'objet ;

comprendre son état ;

comprendre les boutons disponibles ;

décider ;

vérifier qu'on n'a pas choisi le mauvais verbe.

C'est une interface de traitement transactionnel.

Le sentiment « opérateur de saisie » vient énormément de là.

D. Tu demandes à l'utilisateur de gérer l'incertitude de la machine

« Confirmer », « écartée », « confiance », « rétablir » reviennent implicitement à dire :

« Voilà mon travail. Merci de le contrôler. »

Pour un outil IA, c'est une inversion de responsabilité.

L'utilisateur devrait intervenir quand le système n'arrive pas à décider, pas confirmer ce qu'il a bien décidé.

E. Tu utilises la réversibilité comme interface principale

Que tout soit réversible est excellent.

Mais la possibilité de revenir en arrière ne doit pas produire des boutons Rétablir partout.

C'est comme si Gmail affichait en permanence un bouton « Restaurer depuis la corbeille » à côté de chaque message.

La bonne mécanique est :

action → disparition immédiate → toast « Fait — Annuler »

Et ensuite historique si nécessaire.

La réversibilité doit rendre l'interface plus audacieuse, pas plus complexe.

F. Tout a la même importance visuelle

Une facture à payer demain, une newsletter, une date de maintenance PayFiP passée et un mail auquel personne n'attend de réponse deviennent tous des lignes.

Une liste détruit une information essentielle :

la hiérarchie de l'attention.

Un assistant doit précisément fabriquer cette hiérarchie.

La règle générale que tu violes

Un assistant réduit le nombre de décisions que l'utilisateur doit prendre.
Un workflow manager organise les décisions que l'utilisateur doit prendre.

Aujourd'hui, tu as construit le second.

2. À quoi devrait ressembler l'écran principal

Je supprimerais complètement le concept de dashboard classique.

Pas de :

14 compteurs ;

tableau ;

inbox condensée ;

onglets ;

sidebar de 15 entrées ;

« 22 dates trouvées ».

Je ferais un écran éditorial, presque comme un briefing humain.

Desktop : colonne centrale de 800–950 px maximum.

Mobile : exactement la même logique en vertical.

Écran en arrivant
Bonjour Anthony.

3 choses méritent ton attention aujourd'hui.
Le reste est sous contrôle.

────────────────────────────────────

EDF Entreprises
1 842 € à payer avant demain

Je te le montre parce que la facture jointe indique
une échéance au 11 août et je n'ai trouvé aucun paiement.

                     [ Marquer comme payé ]

────────────────────────────────────

Pierre — LB2I
Attend ta réponse depuis 3 jours

Il t'a posé une question directe vendredi sur la date
de démarrage. Aucun message de ta part depuis.

                         [ Répondre ]

────────────────────────────────────

URSSAF
À lire aujourd'hui

Le message concerne une modification concernant ECONOM.
Aucune action ni échéance détectée.

                           [ Lu ]

────────────────────────────────────

✓ Je me suis occupé de 143 autres mails
  91 newsletters archivées · 38 sans action · 14 doublons

────────────────────────────────────

Tout voir                         Rechercher

Et c'est presque tout.

Il ne devrait pas y avoir « Factures », « Dates », « Relances » dans cet écran.

La catégorie est secondaire.

L'importance est primaire.

Quand Anthony agit

Il clique :

Marquer comme payé

La carte disparaît immédiatement.

En bas :

✓ Facture EDF classée comme traitée                  Annuler

Le texte devient :

2 choses méritent encore ton attention.

Pas de confirmation.

Pas de popup.

Pas de nouvelle page.

Pas de « Voulez-vous vraiment ? ».

Tu disposes justement d'une journalisation et d'une réversibilité : sers-t'en pour supprimer les confirmations.

Quand il veut comprendre davantage

Il clique simplement sur la carte elle-même.

Pas sur « Détails ».

Desktop : un panneau latéral apparaît.

Mobile : bottom sheet plein écran.

EDF Entreprises
Objet : Votre facture août 2026

Résumé
Facture d'électricité de 1 842 €, échéance demain.

Pourquoi je te la montre
La pièce jointe contient une facture de 1 842 €.
La date du 11 août est indiquée comme date limite de paiement.
Je n'ai trouvé aucun élément indiquant qu'elle est déjà réglée.

──────────────────

Extrait du mail
[...]

Pièce jointe
Facture_082026.pdf

Puis l'action en bas.

L'écran principal n'est jamais quitté.

3. Oui : abandonne « un écran par catégorie »

INFÉRENCE FORTE — ces écrans reflètent ton pipeline de détection.

Dates, factures, réponses attendues, relances, nettoyage sont utiles comme dimensions de recherche.

Pas comme destinations.

Je garderais seulement trois univers conceptuels.

1. Aujourd'hui

Le poste de travail.

Il répond uniquement :

Qu'est-ce qui mérite mon cerveau maintenant ?

2. Recherche

« Le devis de plomberie », « les mails de Jean », « les factures Orange », etc.

Filtres possibles si nécessaire.

C'est ici que « Factures », « Pièces jointes », « Dates » peuvent réapparaître.

3. Activité

Ce que l'assistant a fait.

Pas pour être consulté tous les jours.

Pour restaurer de la confiance quand Anthony se pose une question.

Aujourd'hui

143 mails traités automatiquement

91 newsletters archivées
38 informations sans action
12 mails regroupés
2 dates ignorées car non actionnables

Et ensuite éventuellement détail.

Tout le reste — état des boîtes, désabonnements, règles, paramètres — part dans un menu secondaire.

4. Conversation Claude ou interface web ?

Ne fais surtout pas de Claude l'unique poste de commande.

Ce serait remplacer une mauvaise interface par une interface invisible qu'Anthony doit penser à invoquer.

Et il y a un problème cognitif énorme avec le chat :

il faut savoir quoi demander.

Quelqu'un qui est déjà submergé ne devrait pas avoir à se lever le matin et réfléchir :

« Quel prompt dois-je faire aujourd'hui ? »

La page web doit faire le contraire :

« Voilà ce qui nécessite ton attention. »

Je donnerais donc deux rôles très différents.

Web = assistant proactif.

Il pousse les exceptions, les décisions et le briefing.

Claude = délégation ad hoc.

Très puissant pour :

« Nettoie-moi toutes les newsletters de ces trois derniers mois. »

« Qu'est-ce que j'ai raté chez Club Med cette semaine ? »

« Retrouve la facture du plombier. »

« Est-ce que quelqu'un attend une réponse de moi concernant Brest ? »

Donc :

Web = cockpit quotidien.
Conversation = super-pouvoir.

Pas l'inverse.

5. Montrer le raisonnement sans ajouter d'interface

C'est probablement le changement le plus important.

Ne montre surtout pas le raisonnement interne.

Montre la justification utile à la décision.

Et elle doit être située exactement à côté de la décision.

Mauvais
Échéance : 12 mai 2026
Confiance : 82 %
                     Confirmer
Bon
Aucune action nécessaire

La date du 12 mai correspond à une interruption temporaire
de PayFiP, pas à une échéance qui te concerne.

Terminé.

Pour une facture :

À payer avant demain

La facture PDF indique 1 842 € à régler avant le 11 août.
Je n'ai trouvé aucun signe qu'elle ait déjà été payée.

Pour une réponse :

Pierre attend probablement une réponse

Il t'a posé une question directe vendredi et aucun mail
de ta part n'apparaît ensuite dans la conversation.

Pour un événement rejeté :

Je n'en ai rien fait

La date mentionnée décrit une maintenance déjà passée,
pas quelque chose que tu devais faire.

C'est ça, l'explicabilité UX.

Décision + éléments de preuve + conséquence.

Pas :

décision + score + accès au laboratoire de la décision.

Et la confiance IA ?

Je supprimerais presque tous les pourcentages.

Un utilisateur non technique ne sait pas quoi faire de :

confiance 78 %

Expose l'incertitude uniquement lorsqu'elle change son comportement.

Je ne suis pas certain que cette facture soit déjà réglée.

Je vois un prélèvement du même montant le 8 août,
mais aucune référence ne permet de les relier.

Là tu demandes une décision.

Sinon, silence.

6. Combien d'éléments sur l'accueil ?

Je ne raisonnerais pas en nombre de composants graphiques.

Je raisonnerais en nombre de décisions simultanées.

Ma limite : 3 décisions visibles.

Éventuellement 5 lorsqu'il y a réellement une journée chargée.

Jamais 17.

Au-delà :

5 autres sujets moins urgents

Pas encore visibles.

Sur mobile, je serais encore plus sévère : 1 à 3 cartes.

L'écran pourrait contenir environ six objets perceptibles :

Bonjour Anthony
↓
3 choses méritent ton attention
↓
Carte 1
Carte 2
Carte 3
↓
Je me suis occupé de 143 autres mails

C'est suffisant.

Le menu peut être réduit à :

Aujourd'hui
Recherche
Activité
Paramètres

Et peut même être derrière un menu sur mobile.

Boîte de réception ?

Accessible depuis Recherche / Tous les mails.

Elle n'a aucune raison d'être le cœur de l'expérience.

C'est précisément la boîte de réception qu'Anthony n'arrive plus à gérer. Pourquoi reconstruire une meilleure boîte de réception ?

7. Les trois changements à coder cette semaine
Changement 1 — tue immédiatement la homepage en listes

C'est celui qui produira le plus gros choc perceptuel.

Transforme Aujourd'hui en briefing utilisant tes données actuelles.

Algorithme très simple au début :

action = payer       → priorité haute
réponse attendue     → priorité haute
échéance imminente   → priorité haute
action = lire        → priorité moyenne
confiance faible     → priorité à décider
archive/none         → ne pas montrer

Tu affiches les 3 premiers objets nécessitant réellement Anthony.

Tout le reste :

✓ 143 autres mails gérés sans avoir besoin de toi

Même si ton moteur est imparfait au début, la forme du produit changera immédiatement.

Changement 2 — une recommandation, pas cinq boutons

Sur chaque carte :

[action recommandée]

et éventuellement une échappatoire discrète :

⋯

Le menu ⋯ peut contenir :

Ouvrir le mail
Me le rappeler
Ignorer
Autre action

Mais 90 % du temps Anthony ne doit jamais l'ouvrir.

Après action :

✓ Fait                                       Annuler

Tu peux supprimer une quantité énorme de :

Confirmer / Passer / Écarter / Fait / Ignorer / Rétablir.

Ce seul changement fera beaucoup moins « logiciel métier 1998 ».

Changement 3 — injecte la justification directement dans chaque carte

Tu as déjà presque tout ce qu'il faut :

résumé IA ;

intention ;

action ;

échéance ;

fournisseur ;

montant ;

pièce jointe ;

conversation précédente.

Construis côté serveur ou côté JS une phrase de justification déterministe.

Pas besoin d'appeler Claude.

Par exemple :

PAYMENT
→ "La facture jointe indique {montant} à régler avant {date}."

REPLY
→ "{nom} t'a posé une question {âge} et aucune réponse de ta part n'apparaît ensuite."

READ
→ "Je te le signale car {résumé}."

DISMISSED_DATE
→ "Cette date décrit {type d'événement} et ne correspond pas à une action à effectuer."

Et le résumé IA existant enrichit la phrase lorsqu'il est disponible.

La différence fondamentale

Ton application actuelle dit implicitement :

« J'ai analysé tes mails. Viens vérifier mon travail. »

Le produit que je construirais doit dire :

« Je me suis occupé de tes mails. J'ai besoin de toi sur trois choses. »

Cette phrase devrait presque être ton test de conception.

Chaque fois que tu ajoutes un écran, un onglet, un badge ou un bouton, pose une seule question :

Est-ce que cela demande à Anthony de gérer ses mails, ou est-ce que cela lui évite de les gérer ?

Si la réponse est la première, le composant mérite probablement de disparaître.