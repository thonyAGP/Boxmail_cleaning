(A) Repenser « À dépouiller »

Le problème de l'écran actuel n'est pas qu'il manque d'intelligence dans ses boutons. Le problème est que l'utilisateur reste le moteur de décision. Le système analyse, puis remet quand même la décision à Anthony.

Je changerais trois unités fondamentales :

Unité de travail = l'affaire, pas le mail.
Unité d'interface = la décision, pas le message.
Unité d'apprentissage = la correction, pas le paramétrage.

1. L'écran ne devrait plus demander « que faire de ce mail ? »

Il devrait essentiellement dire :

« Voilà ce que j'ai fait. Voilà les 4 choses sur lesquelles j'ai besoin de toi. »

Exemple d'écran d'accueil :

Aujourd'hui

187 messages traités automatiquement

6 affaires nécessitent ton attention

2 décisions incertaines à vérifier

1 échéance approche

Le « 187 messages traités » est replié par défaut. Anthony n'a aucune raison de les regarder.

Ensuite, plutôt que :

Mail de X
[Vu] [Corbeille] [Garder] [Plus tard] [Passer]

il faut quelque chose comme :

URSSAF — LB2I
Échéance détectée : 14 août · 1 823 €
Aucune réponse demandée.

J'ai déjà :

rattaché le message à LB2I ;

extrait et classé le PDF ;

créé l'échéance ;

considéré le mail comme traité.

Contester · Voir l'affaire

Il n'y a même pas de bouton « Valider ».

L'absence d'action signifie que le système avait raison.

C'est beaucoup plus important qu'un swipe ou qu'un meilleur design.

Ce que le système doit faire sans demander

Je définirais la frontière non pas selon « IA / pas IA », mais selon trois dimensions :

risque d'erreur × conséquence × réversibilité.

Niveau 1 — faire automatiquement

Sans demander :

rattacher société / bien / personne / affaire ;

catégoriser ;

identifier échéance, montant, facture, réservation, contrat ;

regrouper les mails ;

détecter doublons ;

indexer les pièces jointes ;

extraire leurs métadonnées ;

renommer une copie d'un document ;

marquer localement un message comme bruit / référence / action ;

créer une tâche interne ;

créer une échéance interne ;

faire disparaître les OTP expirés de la file d'attention ;

regrouper newsletters, notifications, confirmations similaires ;

proposer ou générer un brouillon de réponse ;

considérer comme « résolue » une conversation dont la réponse a manifestement été reçue.

Tout cela est soit interne, soit facilement réversible.

Niveau 2 — exécuter automatiquement sous conditions fortes

Je serais également prêt à faire automatiquement :

déplacer vers la Corbeille un message lorsque le système dispose d'un signal extrêmement fort.

Par exemple :

OTP vieux de 24 h ;

notifications techniques sans valeur documentaire ;

promotions d'un expéditeur déjà systématiquement éliminé ;

newsletter jamais consultée depuis six mois ;

confirmation transitoire dont l'événement est passé et dont aucune pièce utile n'est attachée.

Avec tes contraintes, c'est acceptable parce que :

Corbeille ≠ destruction.

Tout est journalisé et peut être annulé.

En revanche, je ne ferais pas immédiatement :

« Le système pense que ce mail est une publicité, donc corbeille. »

sur un expéditeur inconnu.

Il faut d'abord acquérir de la confiance sur le comportement.

Niveau 3 — ne jamais exécuter seul

Le système peut préparer, mais pas décider à la place d'Anthony, lorsqu'il agit sur le monde extérieur :

envoyer un email ;

accepter/refuser un rendez-vous ;

confirmer une réservation ;

payer ;

résilier ;

se désinscrire ;

accepter un devis ;

prendre un engagement juridique ;

modifier une déclaration administrative ;

supprimer définitivement quelque chose.

Et j'ajouterais une deuxième interdiction :

ne jamais faire disparaître silencieusement quelque chose dont le coût potentiel d'oubli est élevé.

Fiscalité, banque, assurance, salarié, avocat, copropriété, impôts, fournisseur stratégique, échéance contractuelle, etc.

Même avec 98 % de confiance.

2. La contestation doit être l'interaction principale

Aujourd'hui, le système demande une décision positive :

« Que veux-tu faire ? »

Il faudrait inverser :

« J'ai fait X. Dis-moi uniquement si c'est faux. »

Cela change complètement le volume d'interactions.

Exemple :

Amazon — 37 messages

J'ai placé 35 notifications commerciales dans la Corbeille.
J'ai conservé 2 factures et classé leurs PDF dans Documents.

↶ Annuler

C'est tout.

Si Anthony annule, là seulement le système peut proposer :

« Je corrige seulement ces 35 messages »
ou
« Je considère désormais les messages Amazon de ce type comme utiles. »

Mais je ne lui présenterais surtout pas un écran :

Voulez-vous créer une règle Amazon ?
[Oui] [Non]

C'est exactement le modèle des 114 règles / zéro activée.

Les règles doivent pratiquement disparaître de l'interface utilisateur.

3. Ne surtout pas tout basculer en « dossier »

Je suis favorable aux affaires, mais avec une nuance importante.

Tout mail ne mérite pas une affaire.

Sinon tu vas remplacer 25 000 mails par 8 000 dossiers, ce qui ne résout rien.

Je ferais trois niveaux.

Message isolé

Exemple :

Votre code de connexion est 384922.

Il vit et meurt seul.

Conversation

Les réponses d'un même fil.

Banque → Anthony → banque.

C'est naturellement une unité.

Affaire

Plusieurs conversations, participants et documents qui concernent le même sujet réel.

Exemples :

« Sinistre appartement Brest »

avec :

assurance ;

syndic ;

artisan ;

locataire ;

devis ;

facture ;

photos.

Ou :

« Comptes annuels Econom 2026 »

avec :

expert-comptable ;

banque ;

justificatifs ;

impôts ;

PDF.

C'est là que l'IA devient vraiment intéressante.

Le mail n'est alors plus le produit principal.

Le produit devient :

Situation actuelle
Ce qui s'est passé
Documents disponibles
Ce qui manque
Prochaine action
Échéance

L'utilisateur ouvre l'affaire uniquement s'il en a besoin.

4. L'écran « À dépouiller » devrait donc devenir « À surveiller »

Je conserverais le nom actuel éventuellement au début, mais conceptuellement ce serait autre chose.

Je verrais quatre zones.

À faire

Seulement les situations nécessitant réellement une action humaine.

AXA — dégât des eaux Brest
Ils attendent les photos avant le 13 août.
Action proposée : envoyer les 4 photos déjà trouvées.
Préparer la réponse

Pas dix emails AXA.

Une affaire. Une action.

À vérifier

Le système a pris une décision mais estime que le risque d'erreur mérite un regard humain.

Brimmo — facture 6 820 €
J'ai identifié ce document comme facture travaux et l'ai classé dans Brimmo.
Le fournisseur n'est reconnu qu'à 72 %.
Corriger

Cette file devrait être très courte.

Fait pour vous

Résumé fermé :

181 messages traités
43 promotions → Corbeille
17 confirmations classées
4 PDF enregistrés
2 conversations clôturées

Avec un bouton Voir, pour confiance/audit.

À surveiller

Cas sans action immédiate mais dont le système suit l'évolution :

Expert-comptable Econom — réponse attendue depuis 4 jours.

Anthony n'a rien à décider maintenant.

5. Ton diagnostic sur « zéro priorité d'expéditeur » est juste… mais je n'implémenterais pas la solution évidente

Tu pourrais conclure :

Il faut demander à Anthony quels expéditeurs sont importants.

Je ne le ferais pas.

Et je ne ferais même pas de « ⭐ toujours important ».

C'est trop grossier.

Un même expéditeur peut envoyer :

une facture importante ;

une newsletter ;

une notification automatique ;

une demande urgente.

L'importance appartient au contexte, pas à l'adresse email.

La vraie représentation devrait plutôt être :

expéditeur × société × sujet × type de message × historique

Par exemple :

Crédit Agricole + Brimmo + prélèvement refusé

peut être extrêmement important.

Alors que :

Crédit Agricole + newsletter placements

ne vaut rien.

Comment apprendre « important pour MOI » sans questionnaire

C'est probablement la partie la plus importante techniquement.

Il faut utiliser les comportements qu'Anthony produit naturellement.

Quelques signaux très puissants :

Anthony répond à cet expéditeur ;

délai entre réception et réponse ;

il revient plusieurs fois sur le message ;

il recherche cet expéditeur ;

il ouvre systématiquement ses PDF ;

il conserve ses documents ;

il transforme le message en tâche ;

il corrige une décision de bruit ;

il sort un message de la Corbeille ;

il ignore systématiquement cette famille de messages ;

il existe déjà une affaire active avec ce correspondant ;

ce message contient argent / échéance / contrat / réservation ;

une réponse est attendue ;

l'expéditeur est associé à une société donnée.

Et surtout :

exploiter les contradictions

Supposons :

Le système considère les mails du syndic comme secondaires.

Anthony ouvre trois fois l'un d'entre eux et répond.

Le système ne devrait pas demander :

« Le syndic est-il important ? »

Il devrait apprendre directement :

syndic + Brimmo + travaux → poids d'attention +X

Et éventuellement afficher discrètement :

« Je vais désormais remonter davantage les messages de ce type. »

Annuler

Encore une fois : décision puis possibilité de contestation.

Une correction importante à ta lecture des chiffres

Tes quatre conclusions sont globalement bonnes.

Mais j'en modifierais deux.

« 114 règles / zéro active »

Oui, c'est un problème produit.

Mais cela ne démontre pas nécessairement que les règles sont mauvaises.

Cela démontre surtout que la notion même d'activation d'une règle est trop coûteuse cognitivement.

Une règle devrait devenir une conséquence de l'apprentissage.

Pas un objet que l'utilisateur administre.

« 1,3 % des pièces lues »

Oui, c'est un gros trou.

Mais je ne chercherais surtout pas à atteindre artificiellement :

« 100 % des pièces analysées par Claude ».

10 191 pièces, sur un VPS 1 vCPU et sans API IA autonome, ce serait probablement une mauvaise utilisation des ressources.

Il faut plutôt arriver à :

100 % inventoriées
100 % typées aussi loin que possible localement
lecture profonde des pièces susceptibles d'avoir de la valeur

C'est très différent.

(B) Le reste du produit
1. Abandonner « intention » comme classification principale

info / confirmation / invoice / document / reminder...

peut rester comme métadonnée.

Mais elle ne devrait plus piloter l'interface.

Je créerais trois axes indépendants.

Axe 1 — coût pour Anthony

Par exemple :

Action

Attente

À connaître

Référence

Bruit

Périmé

C'est celui qui pilote l'écran.

Axe 2 — nature

Facture, réservation, contrat, RH, banque, assurance, commercial, administratif, etc.

Utile pour la compréhension.

Axe 3 — contexte

société ;

bien immobilier ;

personne ;

client ;

affaire.

C'est lui qui apporte la personnalisation.

Ton info = 34 % peut alors parfaitement devenir :

référence : 12 %
bruit : 15 %
attente : 3 %
à connaître : 4 %

Et soudain la donnée devient exploitable.

2. Définir « important » comme le coût de rater le message

Pas :

« Ce message semble important. »

Mais :

« Qu'est-ce qui se passe si Anthony ne voit pas ce message ? »

C'est une meilleure définition.

Les facteurs de score les plus forts seraient :

Échéance proche + argent + engagement + réponse attendue + affaire active + comportement personnel.

L'IA peut aider à identifier les faits.

Mais le score final peut parfaitement être local et déterministe.

C'est important avec ton architecture :

Claude ne devrait pas être dans le chemin critique de chaque écran.

Le serveur doit fonctionner correctement même lorsque Claude n'est pas disponible.

3. Le bruit : ne plus seulement le détecter, le faire disparaître

Aujourd'hui tu détectes probablement :

promo

mais tu continues à montrer le mail.

Cela n'a pratiquement aucun intérêt.

À terme :

promo connue → rien à dépouiller

OTP expiré → rien à dépouiller

notification répétitive → rien à dépouiller

newsletter jamais utile → rien à dépouiller

Anthony doit seulement voir les anomalies.

Exemple :

Fnac : 37 promotions éliminées, mais j'ai conservé une facture.

Ça, c'est une assistance.

4. Pièces jointes : créer un vrai registre documentaire

Là, tu as probablement l'une des plus grosses sources de valeur latente.

Je créerais une table documents indépendante du mail :

hash ;

nom original ;

MIME ;

société ;

affaire ;

type documentaire ;

émetteur ;

date document ;

montant ;

numéro de facture / contrat ;

échéance ;

email source ;

chemin d'export ;

texte extrait ;

niveau de confiance.

Le document cesse d'être :

« la pièce jointe du mail du 12 mai ».

Il devient :

Facture Engie — Brimmo — 18/05/2026 — 148,37 €

Et l'email n'est plus qu'une provenance.

Renommage

Très bonne idée, mais uniquement sur la copie exportée.

Par exemple :

BRIMMO_Facture_ENGIE_2026-05-18_148.37EUR_883764.pdf

Jamais toucher au fichier original du mail.

Et jamais faire dépendre l'identité du document du nom généré : utilise le hash comme vérité interne.

5. La proactivité doit déboucher sur des résultats, pas des alertes

Je me méfierais énormément d'un système qui devient simplement :

« Vous avez 17 choses importantes ! »

Ce serait pire que la boîte mail.

La bonne proactivité ressemble plutôt à :

Trois choses nécessitent ton attention aujourd'hui.

AXA attend les photos du sinistre avant demain.
J'ai retrouvé les quatre photos correspondantes et préparé le mail.

Facture Brimmo 6 820 €.
Aucun paiement correspondant trouvé dans les emails ; échéance vendredi.

L'expert-comptable Econom n'a pas répondu depuis 7 jours.
J'ai préparé une relance.

Et en dessous :

J'ai traité 143 autres messages sans intervention.

C'est exactement l'inversion que recherche Anthony.

Ce que je supprimerais du produit

Je retirerais progressivement de l'interface principale :

« gérer les règles » ;

« définir la priorité des expéditeurs » ;

les catégories techniques ;

le traitement systématique mail par mail ;

le bouton « Passer ».

Passer est particulièrement révélateur.

S'il faut régulièrement passer un mail, c'est le système qui aurait dû décider qu'il n'avait pas besoin d'être présenté.

(C) Découpage en phases

Je ne commencerais absolument pas par davantage d'IA.

Tu disposes déjà de 24 295 verdicts IA.

Le problème n'est plus principalement l'analyse.

Le problème est l'exploitation de l'analyse.

Phase	Livraison	Critère de réussite
1 — Inverser le dépouillement	Écran « décisions prises / à vérifier / à faire », actions automatiques réversibles, contestation en 1 geste	≥70 % des mails entrants ne sont plus présentés individuellement ; <20 décisions manuelles / 100 mails
2 — Apprendre Anthony	Score d'attention issu du comportement, correction implicite, expéditeur × contexte	Sur les 20 éléments les plus hauts d'une semaine, ≥85 % jugés réellement pertinents ; plus besoin de définir manuellement des priorités
3 — Affaires	Conversations + regroupement société/bien/sujet, état courant + prochaine action	≥60 % des mails avec action rattachés automatiquement à une affaire ; réduction d'au moins 40 % du nombre d'objets à examiner
4 — Documents	Inventaire complet, extraction locale, classification, renommage des copies	≥95 % des PJ inventoriées, ≥80 % des PDF textuels utiles extraits, ≥90 % des factures détectées correctement rattachées à une société
5 — Autopilote bruit	Corbeille automatique sous politiques apprises, détection des exceptions	≥80 % du bruit éliminé sans intervention et <1 % de décisions de Corbeille annulées
6 — Assistant proactif	Vue quotidienne « ce qui mérite ton attention », brouillons, relances, échéances	Temps quotidien de traitement <5 min sur une semaine normale et aucune échéance connue ratée
Et je mettrais une condition de passage entre phases

Ne pas passer de Phase 1 à Phase 2 parce que « la feature est développée ».

Passer lorsque :

le nombre de décisions demandées à Anthony diminue réellement.

C'est ton KPI directeur.

Pas le taux de classification.
Pas le nombre de verdicts Claude.
Pas le nombre de règles créées.
Pas le nombre de pièces analysées.

Le KPI que je mettrais tout en haut du projet

Je créerais une mesure très simple :

Décisions humaines pour 100 emails reçus

Aujourd'hui, ton écran est probablement très proche d'un modèle où un grand nombre de messages génèrent une décision ou une inspection.

Ton objectif devrait être quelque chose comme :

100 emails → 10 à 20 décisions maximum

puis :

100 emails → 5 à 10 décisions.

Et ces décisions doivent concerner principalement :

argent ;

engagement ;

délais ;

relations humaines ;

ambiguïtés véritables.

Tout le reste devrait être absorbé.

Une conséquence architecturale importante

Avec 1 vCPU + SQLite + Claude via abonnement, je ferais volontairement un système à deux cerveaux :

Le cerveau opérationnel local, toujours disponible :

historique ;

scoring ;

règles apprises ;

regroupement ;

FTS SQLite ;

échéances ;

documents ;

comportements ;

décisions réversibles.

Claude, utilisé lorsqu'il apporte réellement quelque chose :

comprendre un message complexe ;

résumer une affaire ;

identifier une action dans un document ;

rédiger une réponse ;

résoudre une ambiguïté.

Je ne construirais surtout pas un assistant dont chaque décision quotidienne dépend d'un nouvel appel à Claude.

Avec les 24 295 verdicts déjà accumulés, tu as déjà une énorme matière pour construire le premier cerveau.

Ma priorité immédiate

Je ne toucherais ni aux pièces jointes ni au moteur IA en premier.

Je prendrais l'écran actuel À dépouiller et je ferais la Phase 1 :

mail entrant → décision calculée → décision éventuellement exécutée → seulement les exceptions arrivent devant Anthony.

C'est la première modification qui peut réellement transformer le produit de « logiciel qui aide à gérer ses mails » en « assistant qui gère les mails et vient chercher Anthony quand il a besoin de lui ».

Et je pense que c'est précisément la frontière que ton produit n'a pas encore franchie.