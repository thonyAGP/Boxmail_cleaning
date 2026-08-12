# Critique du plan par ChatGPT — 13/08/2026

> Soumis après l'échec de la session du 12/08 (deux fausses urgences + une décision de
> Claude présentée à Anthony comme la sienne). Conversation :
> https://chatgpt.com/c/6a7cf8ad-7008-83eb-920d-9fed77eed013

## Question posée

```
Tu es consulté comme architecte produit critique. Sois dur, factuel, et ne me ménage pas : je viens d'échouer et j'ai besoin qu'on me dise où le plan lui-même est fautif. Contexte complet ci-dessous, tu n'as besoin d'aucun élément extérieur.

== LE PROJET ==
"Boxmail" : assistant email personnel pour Anthony, 45 ans, non technique, multi-entrepreneur (SARL immobilière, SASU négoce de véhicules, location saisonnière à Paris, immeuble locatif à Brest). 7 boîtes Outlook.com, 25 000 mails sur 10 ans, 12,3 Go. Objectif, mot pour mot : "me réduire ma charge neuronale et me permettre de gagner du temps pour le passer en famille".
Je suis l'IA (Claude Code) qui développe le produit et qui l'exploite au quotidien via des outils MCP.

== FAITS MESURÉS SUR SES VRAIES DONNÉES ==
- Mails jamais ouverts par année : 2 % avant 2020, 45 % en 2025, 63 % en 2026. Le volume n'a que doublé en 12 ans. Ce n'est donc pas le volume, c'est le coût de décision par mail.
- Aucun dossier créé en 10 ans. Il ne range rien et ne rangera jamais.
- Le bruit n'est pas le problème : les expéditeurs massivement non lus = 4,5 % du volume. Les non-lus sont des mails LÉGITIMES qu'il n'arrive plus à traiter.
- 114 règles de classement suggérées par le produit, 0 activée. 0 priorité d'expéditeur posée. Le système propose, personne n'adopte.
- Backtest : un "score de relation" (qui écrit, à qui il répond) ne capture que 45 % des réponses réelles dans son top 30 % (objectif 85 %). Cause : 43 % du flux vient d'expéditeurs jamais vus. ET le critère était faux : seuls 5,8 % des mails reçoivent une réponse ; une facture, une convocation, une assurance qui expire ne se répondent pas par mail, et ce sont justement celles dont l'oubli coûte cher.

== LE PLAN ACTUEL (résumé fidèle) ==
Renversement : l'écran ne demande plus "que veux-tu faire de ce mail ?" mais annonce "voilà ce que j'ai fait, interviens si c'est faux". Quatre zones : À faire / À vérifier / Fait pour vous / À surveiller.
Trois scores indépendants au lieu d'un : CONSEQUENCE_RISK (que se passe-t-il s'il ne le voit pas), ACTION_NEED (y a-t-il un geste), UNCERTAINTY (à quel point je peux me tromper). Un arbre de décision déterministe et local les combine ; Claude n'est appelé que sur une bande ambiguë (<= 15 % du flux) et ne renvoie que des faits structurés, jamais la zone.
Principe d'arbitrage acté après un incident : "les heuristiques détectent, l'IA interprète, les preuves dures établissent, un arbitre unique décide ; aucun producteur ne publie directement". Trois états ASSERT / HOLD / IGNORE. Une date n'est une échéance que si ACTEUR -> ACTION -> CONTRAINTE TEMPORELLE tiennent ensemble ; sinon c'est EVENT, TRANSACTION ou INFORMATION_DATE.
Interdits explicites du plan : pas de questionnaire de priorités (l'importance dépend du contexte, pas de l'adresse) ; ne jamais faire disparaître silencieusement ce dont l'oubli coûte cher ; ne pas transformer la proactivité en avalanche d'alertes ("vous avez 17 choses importantes" serait pire que la boîte mail).
Phases : 0 banc de mesure, 0bis arbitre, 1 moteur 3 scores, 2 inconnus et contextes, 3 Claude sélectif, 4 écran inversé, 5 registre documentaire, 6 proactivité.

== OÙ ON EN EST VRAIMENT (banc de mesure, hier) ==
Taux de fuite = part des mails dont l'oubli a une conséquence, non résolus, qui n'apparaissent sur AUCUNE surface du produit.
- Global : 51,8 % (objectif < 1 %).
- Par boîte : Location_Brest 81 %, Brimmo 57 %, Au-marais 52 %, perso 37 %.
- Par motif : "document à conséquence" 72,7 % de fuite, verdict IA "pay" 66 %, verdict "reply" 25,6 %.
- Mails jamais analysés par l'IA : 93,3 % de fuite.
Autrement dit : le produit voit passer un mail à conséquence sur deux sans jamais le montrer.

== MON ÉCHEC D'HIER, QUI EST LA RAISON DE CETTE CONSULTATION ==
Il m'a demandé de relire 200 mails prioritaires. J'ai produit un rapport d'alertes. Résultat :
1. J'ai annoncé en urgence que son accès API "igloohome" (serrures connectées de la location parisienne) était suspendu. Réponse : ce service n'est pas encore en service, il est justement en phase de test. Faux positif.
2. J'ai annoncé en urgence que sa boîte mail sur son domaine était suspendue chez son registrar Gandi, avec 4 relances non lues. Réponse : il a migré chez OVH depuis, on s'en fout — et l'information de la migration était DÉJÀ dans le système (configuration SMTP de la boîte). Faux positif que le produit avait de quoi éviter.
3. Je lui ai affirmé que deux classifications d'expéditeurs étaient "des catégories qu'il avait choisies lui-même". Vérification dans le journal : c'est MOI qui les avais posées un mois plus tôt via l'outil MCP. Le code écrit en dur le libellé "catégorie choisie par toi" quelle que soit l'origine — l'IA s'attribue à l'utilisateur ses propres décisions.
4. Enfin, mes "corrections" proposées consistaient à reclasser des EXPÉDITEURS (mettre la famille en "toujours important", sortir son logiciel de gestion locative de la catégorie newsletter). C'est exactement ce que le plan interdit, et le backtest avait déjà démontré que l'expéditeur ne porte pas l'importance.
Sa réaction : "après tous ces tours, tu en es toujours au début de la conception".

== CE QUE JE TE DEMANDE ==
Ne reformule pas le plan, ne me félicite pas, ne produis pas de roadmap générique. Réponds à ces quatre questions, dans l'ordre, en argumentant contre moi :

1. VÉRACITÉ DU MONDE. Le plan sait raisonner sur le contenu des mails, mais n'a aucune représentation de l'état réel de la vie d'Anthony : quel service est en production ou en test, quel fournisseur a été remplacé, quelle affaire est close. Mes deux faux positifs viennent de là, pas d'une erreur de lecture. Est-ce un manque structurel du plan ? Si oui, quelle forme doit prendre cette couche, sachant qu'on ne peut RIEN lui demander de maintenir à la main (114 règles suggérées, 0 activée) ? Peut-on la dériver du flux lui-même, et à quelles conditions ?

2. FRAÎCHEUR ET MORT DES ALERTES. Le plan dit ce qu'il ne faut pas faire (pas d'avalanche) mais pas comment un signal détecté meurt. Une relance de mai sur un service abandonné en juin doit s'éteindre toute seule. Quel mécanisme, et comment le mesurer sans vérité terrain ?

3. PRIORISATION. Avec 51,8 % de fuite globale mais 72,7 % sur les "documents à conséquence" et 93,3 % sur les mails jamais analysés, la prochaine phase prévue est le moteur à 3 scores. Est-ce le bon choix, ou faut-il d'abord traiter la population qui fuit le plus ? Argumente le coût d'opportunité et donne UN prochain livrable, pas une liste.

4. AUTORITÉ ET TRAÇABILITÉ. L'incident du libellé "catégorie choisie par toi" est-il anecdotique ou révèle-t-il un défaut de principe ? Quelle règle générale poser sur l'attribution d'une décision (qui a décidé, quand, sur quelle preuve) dans un produit où l'IA agit à la place de l'utilisateur — et quelles conséquences sur les structures de données du plan ?

Enfin : dis-moi ce que ce plan RATE que tu vois et que je n'ai pas listé. Sois franc, y compris si ta conclusion est que la direction générale est mauvaise.
```

## Réponse


1. VÉRACITÉ DU MONDE — oui, c’est un manque structurel du plan

Tes deux faux positifs ne sont pas des accidents de classification. Ils démontrent que l’unité de raisonnement actuelle est fausse.

Tu demandes au système :

« Que signifie ce mail ? »

alors que la vraie question est :

« Que signifie ce mail compte tenu de l’état actuel du monde d’Anthony ? »

Le mail igloohome était correctement lu : un accès était suspendu. Ce qui était faux était l’inférence « donc Anthony a un problème urgent ». Le mail Gandi était également correctement lu : un service était suspendu. L’erreur était « ce service est encore pertinent ».

Aucun raffinement de CONSEQUENCE_RISK / ACTION_NEED / UNCERTAINTY ne réparera ça. Le risque de conséquence n’est pas une propriété du mail. C’est une propriété de mail × état du monde.

Il te manque donc une couche que j’appellerais World State, ou plus précisément un registre temporel de faits opérationnels.

Pas un profil utilisateur. Pas 114 règles. Pas une configuration qu’Anthony devrait tenir à jour.

Elle doit représenter des choses comme :

Gandi mail hosting → fournisseur de messagerie → remplacé par OVH → depuis juin 2026

igloohome API → serrure appartement Paris → statut TEST → pas encore PRODUCTION

dossier assurance X → actif jusqu'au...

prestataire Y → relation terminée

facture Z → due → payée le...

sinistre A → ouvert → clos

Chaque fait doit impérativement porter quatre dimensions : valeur, période de validité, provenance, niveau de certitude.

Ainsi, « Gandi est le fournisseur mail » n'est jamais un booléen éternel. C'est quelque chose comme :

provider(mailbox) = Gandi, validFrom=t1, validUntil=t2, evidence=[...]

puis :

provider(mailbox) = OVH, validFrom=t2, evidence=[SMTP config, migration confirmation...]

Et surtout : les faits doivent être révisables. Tu ne veux pas une base de connaissances où une IA écrit « Gandi = fournisseur » et où cela devient une nouvelle vérité en dur.

Peut-on construire cette couche automatiquement ?

Oui, en grande partie. Mais ton erreur serait de croire qu'on peut la « déduire des emails » sans conditions.

Le flux mail est une source parmi d'autres. Tes propres données applicatives peuvent être de meilleures preuves. Dans l'incident OVH, tu avais justement une preuve opérationnelle supérieure au contenu d'un ancien mail.

Il faut une hiérarchie épistémique. Une configuration effectivement utilisée, une transaction réussie, un accusé de résiliation, une migration confirmée ou plusieurs événements ultérieurs cohérents doivent pouvoir supplanter une assertion historique.

Et quand tu n'as pas assez de preuves, le bon comportement n'est pas de deviner.

Pour igloohome, si rien ne permettait de savoir TEST versus PROD, le système devait conclure :

« Accès API suspendu. Impact opérationnel non établi. »

Pas :

« Urgence : les serrures sont en panne. »

C'est une différence fondamentale : UNKNOWN doit être un état acceptable du monde.

Ton plan actuel tolère l'incertitude sur l'interprétation du mail. Il ne la représente pas suffisamment sur la réalité extérieure.

2. FRAÎCHEUR ET MORT DES ALERTES — ton plan n’a actuellement pas de cycle de vie

Oui, c'est une lacune sérieuse.

Aujourd'hui, ton architecture pense essentiellement :

mail → signal → décision → surface

Elle devrait penser :

événement → hypothèse → état → conséquence éventuelle → résolution/supersession

Une alerte ne devrait donc jamais être un résultat figé d'analyse. Elle devrait être une assertion vivante dont les conditions de validité sont réévaluables.

Prenons Gandi.

L'alerte n'est pas réellement :

Gandi dit que la boîte est suspendue.

Ça, c'est un fait historique probablement vrai.

L'alerte opérationnelle est plutôt :

La suspension Gandi menace actuellement un service qu'Anthony utilise.

Cette assertion comporte une précondition :

Gandi est encore fournisseur actif.

Dès que cette précondition devient fausse, l'alerte disparaît automatiquement. Il ne faut même pas chercher une règle « supprimer les alertes Gandi de plus de 90 jours ». La cause de sa mort est sémantique, pas chronologique.

Même chose pour une facture :

facture impayée peut devenir fausse après un mail « paiement reçu ».

Une invitation :

réponse attendue peut mourir après acceptation.

Un document d'assurance :

renouvellement à traiter peut mourir après réception du nouveau contrat.

Donc TTL et vieillissement doivent seulement servir de filet de sécurité. Ils ne doivent pas constituer le moteur principal de disparition.

Ton système a besoin d'un mécanisme de supersession et résolution.

Et cela entraîne une conséquence architecturale importante : quand un nouveau mail arrive, il ne faut pas seulement analyser ce nouveau mail. Il peut également invalider les conclusions produites à partir d'anciens mails.

Aujourd'hui tu penses principalement en aval :

nouveau mail → nouvelles conséquences

Il faut également penser en arrière :

nouvelle preuve → quelles anciennes conclusions deviennent fausses ?

Comment mesurer ça sans vérité terrain ?

Tu ne peux pas mesurer réellement la justesse sans aucune vérité terrain. Il faut arrêter de vouloir contourner ce problème.

Tu peux cependant obtenir une excellente métrique automatique rétrospective.

Par exemple, tu émets au jour J une alerte « paiement nécessaire ». Puis tu regardes les événements J+1...J+30. Si un mail antérieur ou postérieur montre que la facture avait déjà été payée, ton alerte était rétroactivement invalide. Si une résiliation précède l'alerte de service, même chose.

Tu peux ainsi mesurer un taux d'invalidation rétrospective :

parmi les alertes émises, combien auraient dû être mortes ou inhibées au moment où elles ont été présentées, d'après des preuves que le système possédait déjà ou a ensuite obtenues ?

Ajoute le taux de réapparition après résolution, les contradictions détectées et les corrections utilisateur, et tu obtiens une excellente mesure de mauvaise fraîcheur.

Mais pour établir que ton système est vraiment sûr, il faudra toujours un échantillon audité. Pas une maintenance quotidienne par Anthony ; une vérité terrain d'évaluation.

Sinon ton « <1 % » reste une métrique circulaire où le système se note lui-même.

3. PRIORISATION — non, construire maintenant le moteur 3 scores serait une erreur

C'est ici que je changerais ton plan immédiatement.

Tu as :

51,8 % de fuite globale.

72,7 % sur les documents à conséquence.

93,3 % sur les mails jamais analysés.

Et tu envisages de travailler sur la finesse du classement de ce qui est déjà capturé.

C'est du perfectionnement local pendant que la moitié des incendies n'entre même pas dans le détecteur.

Supposons même que ton moteur trois scores soit extraordinaire et réduise de moitié toutes les erreurs de décision sur la population qu'il traite. Il n'a pratiquement aucun effet sur les 93,3 % de fuite des mails jamais analysés, parce que ces messages n'arrivent même pas jusqu'à lui.

Ton coût d'opportunité est donc énorme.

Pire : construire maintenant ce moteur risque de cimenter une mauvaise abstraction. Tu vas calibrer CONSEQUENCE_RISK sur le contenu des messages alors que tu viens précisément de démontrer que la conséquence dépend également de l'état du monde et de la résolution d'un dossier.

Le prochain livrable unique que je ferais

Un Coverage Gate des conséquences.

Son contrat serait extrêmement simple :

Aucun mail ne peut disparaître du système sans avoir reçu une disposition explicite concernant sa capacité à porter une conséquence.

Pas une priorité. Pas une zone. Pas encore trois scores.

Pour chaque mail :

CONSÉQUENCE CAPTURÉE / CONSÉQUENCE ÉCARTÉE SUR PREUVE / DÉJÀ RÉSOLUE / INCONNUE

Et INCONNUE n'a pas le droit de devenir invisible.

Puis tu fais tourner ce gate sur les 25 000 mails, avec une attaque prioritaire de la population jamais analysée et des documents.

Ton premier objectif n'est plus :

« Est-ce que je mets ce mail dans À faire ou À vérifier ? »

mais :

« Existe-t-il encore un chemin par lequel un mail potentiellement coûteux disparaît totalement ? »

Tant que la réponse est oui à 51,8 %, les trois scores sont prématurés.

Et attention : je ne dis pas de montrer tous les UNKNOWN à Anthony. Ça recréerait son problème initial. Je dis qu'ils doivent rester dans la responsabilité interne du moteur, jusqu'à résolution ou analyse supplémentaire.

Le produit peut supporter une dette d'incertitude.

Anthony, lui, ne doit pas la subir.

4. AUTORITÉ ET TRAÇABILITÉ — ce n’est absolument pas anecdotique

C'est probablement l'incident le plus grave des quatre.

Parce que les trois autres étaient des erreurs de jugement.

Ici, le produit a falsifié l'origine d'une décision.

Il a transformé :

« Claude a décidé X »

en :

« Anthony a décidé X ».

Dans un assistant qui agit à la place de son utilisateur, c'est une rupture de principe.

Tu ne peux pas avoir une architecture dans laquelle la provenance est un détail d'affichage.

La règle générale doit être :

Aucune assertion, classification, préférence, action ou décision ne peut exister sans un auteur identifiable et une chaîne de preuves ; l'auteur de la décision ne peut jamais être déduit de son contenu.

Il faut distinguer au minimum quatre choses que ton modèle risque actuellement de mélanger :

Observation : « le mail contient une échéance au 23 août ».

Interprétation : « il s'agit probablement d'un renouvellement ».

Décision : « ce sujet doit être montré à Anthony ».

Action : « le message a été archivé ».

Ces quatre événements peuvent avoir quatre auteurs différents.

Le mail fournit l'observation.

Claude fournit l'interprétation.

L'arbitre logiciel prend la décision.

Anthony valide éventuellement l'action.

Ou le système effectue l'action automatiquement en vertu d'une politique qu'Anthony avait effectivement approuvée.

Cette distinction doit être dans les données, pas seulement dans les logs.

Et surtout, je déconseille fortement d'écraser les valeurs.

Ne fais pas :

senderCategory = IMPORTANT

avec à côté trois champs flous.

Fais un historique immuable de décisions dont l'état courant n'est qu'une projection.

Conceptuellement :

assertion / actor / actorType / timestamp / evidence / confidence / scope / policyVersion / supersedes

Si Anthony accepte ensuite une recommandation de Claude, cela ne transforme pas rétroactivement la décision originale en décision utilisateur.

Il y a :

Claude suggested X

puis :

Anthony ratified X.

C'est précisément cette différence qui te permet ensuite de répondre correctement à :

« Pourquoi fais-tu ça ? »

« Qui a décidé ça ? »

« Depuis quand ? »

« Est-ce une préférence que j'ai réellement exprimée ? »

« Est-ce une vieille décision de l'IA ? »

À terme, cette provenance doit également permettre de calculer l'autorité. Une préférence explicitement exprimée par Anthony peut avoir un poids différent d'une hypothèse produite il y a huit mois par Claude.

Ton bug de texte n'était donc pas un problème de wording.

Il révèle que ton modèle de données ne possède pas encore le concept d'autorité dont ton produit a besoin.

Ce que ton plan rate encore

Il rate quelque chose d'encore plus fondamental que les quatre problèmes que tu as listés :

le mail est probablement la mauvaise unité métier.

Tu continues à construire un système où chaque message est évalué, scoré puis placé quelque part.

Mais Anthony ne gère pas réellement des mails.

Il gère :

une facture, un séjour, une assurance, une serrure, un locataire, un dossier administratif, un sinistre, un fournisseur, une réservation, une migration informatique.

Et ces objets vivent à travers plusieurs mails.

Tes quatre relances Gandi ne sont pas quatre choses importantes.

Elles sont quatre événements concernant une seule relation fournisseur devenue obsolète.

Une facture puis un rappel puis une confirmation de paiement ne sont pas trois décisions.

C'est une obligation dont l'état passe de ouverte → relancée → satisfaite.

Un échange de douze mails avec un locataire n'est pas douze items à scorer.

C'est un dossier.

Et c'est là que ton moteur à trois scores me paraît architecturalement suspect.

Tu veux calculer :

CONSEQUENCE_RISK(mail)

Alors qu'il faudrait souvent calculer :

CONSEQUENCE_RISK(obligation_actuelle)

Le mail ne sert qu'à modifier son état.

Cela change quasiment tout.

Un nouveau mail « paiement reçu » ne devient pas simplement une information de faible priorité : il ferme une obligation.

Une migration OVH ne devient pas juste un nouveau mail : elle termine une relation opérationnelle avec Gandi.

Une réservation annulée ne devient pas un signal supplémentaire : elle annule les tâches futures liées au séjour.

C'est cette abstraction qui permet à la fois de réduire les faux positifs, faire mourir les alertes, éviter les doublons et réellement réduire la charge cognitive.

Ma conclusion sur la direction générale

Le renversement « je fais, tu contestes » reste cohérent avec l'objectif d'Anthony.

L'arbitre unique reste une bonne frontière.

La distinction détection/interprétation/preuve reste utile.

Mais le cœur architectural est encore trop centré sur la classification de messages.

Tu es en train de construire un excellent moteur pour répondre à :

« Que dois-je penser de cet email ? »

Anthony a besoin d'un système qui réponde à :

« Quelles situations de ma vie nécessitent encore quelque chose de moi ? »

Ce n'est pas la même architecture.

À mon sens, ton prochain saut de conception n'est donc pas un meilleur classifieur. Il est le passage de :

mail → score → zone

à :

mail → fait → état du monde/dossier → obligation éventuelle → état de résolution → présentation éventuelle

Et tant que tu ne fais pas ce déplacement, tu risques effectivement de refaire encore plusieurs tours et de te retrouver « au début de la conception », simplement avec de meilleurs scores.
