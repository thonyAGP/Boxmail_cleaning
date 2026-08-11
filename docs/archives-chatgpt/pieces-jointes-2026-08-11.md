# Pièces jointes — échange ChatGPT du 11/08/2026

Conversation dédiée : <https://chatgpt.com/c/6a7afae0-f8b8-83eb-8239-140fe529aaed>

Sujets : critique du référencement des pièces, détection des doublons,
et faisabilité de supprimer UNE pièce sans supprimer le mail.

---

## Ma question

```
Sujet autonome : les PIÈCES JOINTES dans un assistant email — les retrouver, repérer les doublons, et éventuellement en supprimer une SANS supprimer le mail. Deux questions distinctes, la seconde est technique et délicate. Sois concret et sévère, et dis-moi franchement ce que tu déconseilles.

LE CONTEXTE, EN BREF
Anthony, non technique, 7 boîtes Outlook.com/Hotmail personnelles, ~25 000 mails, accès en IMAP (bibliothèque imapflow, OAuth XOAUTH2), index local SQLite sur un petit VPS. Aucune IA payante côté serveur. Garde-fous non négociables du produit : suppression = mise à la CORBEILLE uniquement, jamais d'EXPUNGE, aperçu obligatoire avant toute action, lots de 200, tout journalisé avec la liste exacte des mails, tout réversible.

CE QUE J'AI MESURÉ SUR SES VRAIES BOÎTES
- Boîte de réception : 18 035 mails, 7 471 Mo.
- Le « bruit » réellement supprimable (vieilles promos, codes périmés, rappels passés) : 966 mails, 137 Mo. Moins de 2 % du volume.
- Les mails porteurs d'une pièce jointe : 7 019, pour 6 062 Mo.
Autrement dit : le poids n'est pas dans les newsletters, il est dans les pièces jointes. C'est LUI qui l'a dit avant moi, et les chiffres lui donnent raison.
- Composition : 3 365 PDF, 1 312 JPG, 222 fichiers Office, le reste divers.
- Répartition des tailles de mail : 1 814 sous 100 Ko, 3 320 entre 100 et 500 Ko, 1 161 entre 500 Ko et 2 Mo, 615 entre 2 et 10 Mo, 109 au-dessus de 10 Mo (1 625 Mo à eux seuls).

CE QUE J'AI CONSTRUIT (première question : critique-le)
Objectif affiché : « retrouver sans classer ». Il ne range rien et ne rangera jamais ; aucun mail n'est déplacé, l'organisation est virtuelle en base.
1) NOMS des pièces. La synchronisation lisait déjà la structure du mail (BODYSTRUCTURE) pour compter les pièces, et jetait le nom du fichier. Je le conserve désormais. Coût nul, aucune pièce téléchargée. J'écarte les images de décoration des newsletters (image non déclarée en pièce jointe, ou < 30 Ko), sinon un mail Leroy Merlin apportait « appstore_lm.gif », « quote_lm.gif »… qui noyaient le vrai « 723767.pdf ».
2) CONTENU des pièces. Extraction locale du texte, sans dépendance : PDF (y compris les polices à codes, via les tables ToUnicode du fichier), Office (.docx/.xlsx/.pptx, qui sont des ZIP de XML), texte/CSV. Les photos et PDF scannés sont marqués « scan » — non lisibles ici, éventuellement lus par une IA à la demande. Le texte extrait est stocké (max 200 Ko/mail), jamais le fichier.
3) RECHERCHE. Un seul champ, « Que cherches-tu ? », avec des exemples cliquables tirés de ses boîtes (une quittance, un avis d'imposition, un bail…). Je cherche dans : sujet, expéditeur, texte du mail, résumé d'analyse, NOM des pièces, CONTENU des pièces. Chaque résultat affiche POURQUOI il ressort (« trouvé dans le nom de la pièce jointe »).
4) PRÉSENTATION. Plus de liste à plat de 200 lignes triées par date : les résultats sont groupés par INTERLOCUTEUR (les deux adresses d'un même fournisseur fusionnent ; deux adresses gmail restent deux personnes), avec les noms de fichiers en évidence, 3 mails montrés et le reste dépliable. Un mot entier passe devant un fragment (chercher « RIB » ne devait pas remonter « Cabinet Ribéroux », 48 mails).
Résultats réels : « quittance » remonte des mails dont le sujet ne dit que « Votre document est disponible » ; une facture IKEA rend « Facture · SCI ALTOEN · Numéro de Facture FRINV25000003159229 · Numéro de TVA ».

MES QUESTIONS SUR CE POINT
a) Qu'est-ce que ce dispositif rate ? Où va-t-il le décevoir en usage réel, sur dix ans d'archives ?
b) Le regroupement par interlocuteur est-il la bonne unité pour retrouver un DOCUMENT, ou faudrait-il regrouper par autre chose (type de document ? période ? dossier métier — un bien immobilier, une société) ? Il dirige 5 sociétés et possède plusieurs biens.
c) Faut-il une entité « document » distincte du mail en base (un même PDF pouvant arriver dans plusieurs mails), ou est-ce de la sur-ingénierie à cette échelle ?
d) Sur SQLite, dois-je passer à un index plein texte (FTS5) plutôt qu'à des `LIKE %terme%` ? À 25 000 mails avec ~200 Ko de texte possible par mail, où est le point de bascule ? Et que perd-on (accents, recherche partielle) ?

DEUXIÈME QUESTION — LES DOUBLONS ET LA SUPPRESSION D'UNE SEULE PIÈCE
Son idée, et je la trouve juste : puisque je passe de toute façon sur toutes les pièces jointes, autant repérer celles qui sont EN DOUBLE. Il pense — à raison d'après mes mesures — que ça pèse plus lourd que les newsletters.
Ce que j'ai sous la main sans rien télécharger : pour chaque pièce, son NOM et sa TAILLE EXACTE en octets (la structure IMAP les donne). Je peux donc repérer « même nom + même taille » à coût nul sur les 25 000 mails. Je ne télécharge le contenu que des pièces lisibles, ce qui me permettrait d'y ajouter une empreinte (hachage) au passage, mais pas pour les photos, que je ne télécharge pas aujourd'hui.
e) « Même nom + même taille exacte » suffit-il pour annoncer un doublon à un non-technicien, ou faut-il exiger une empreinte ? Quel taux de faux positifs redouter en pratique ?
f) Et surtout : PEUT-ON supprimer une seule pièce jointe en gardant le mail ? À ma connaissance IMAP ne sait pas modifier un message existant : il faudrait reconstruire le mail sans la pièce, l'APPEND dans le dossier, puis supprimer l'original — ce qui change l'UID, risque de casser le fil de discussion, peut altérer la date interne, les drapeaux, la signature du message, et n'est pas vraiment réversible. Sur Outlook.com en particulier. Est-ce que tu le ferais ? Si oui, quelle est la manière la MOINS risquée, et quelles garanties je dois offrir avant (aperçu ? copie de sauvegarde de la pièce quelque part ? période de rétractation ?). Si non, quelle est la bonne alternative pour lui faire gagner de la place — sachant qu'il paie surtout en encombrement mental et que ses boîtes ne sont pas encore pleines ?
g) Y a-t-il un ordre d'attaque évident au vu de mes chiffres — par exemple les 109 mails de plus de 10 Mo qui pèsent 1 625 Mo à eux seuls ?

Réponds en distinguant FAIT / INFÉRENCE / HYPOTHÈSE quand c'est utile, et donne des règles codables plutôt que des principes.
```

## Réponse

Il y a une très bonne base, mais je changerais trois choses maintenant, avant d'aller plus loin :

FTS5 tout de suite ; les LIKE '%...%' ne doivent pas devenir le moteur historique.

Une entité “document binaire” distincte de l'occurrence dans un mail ; avec les doublons, ce n'est plus de la sur-ingénierie.

Je n'implémenterais surtout pas la suppression d'une pièce par reconstruction MIME+APPEND IMAP. Pour Outlook.com, il existe une voie nettement meilleure via Microsoft Graph. Mais je ne ferais malgré tout pas de “nettoyage de pièces jointes” une fonction normale tant que la place disque n'est pas réellement un problème.

a) Ce que ton dispositif va rater

Le plus gros trou n'est pas la recherche. C'est l'illusion de couverture.

Un utilisateur tape « acte de vente 2021 », ne trouve rien, et en conclut que le document n'existe pas. Or il peut se trouver dans scan00042.pdf, sans couche texte. À ce moment-là ton système n'a pas “mal classé” : il est aveugle.

Je rendrais donc l'état d'indexation explicite pour chaque pièce :

OK_TEXT
SCAN_NO_TEXT
ENCRYPTED
UNSUPPORTED
TRUNCATED
EXTRACTION_ERROR
EMPTY

Et dans la recherche :

47 documents trouvés
+ 12 scans potentiellement pertinents non lisibles

avec « Lire ce scan » pour lancer OCR/IA seulement à la demande.

Deuxième point où je serais sévère : ne développe pas ton propre parseur PDF au-delà d'un prototype. Gérer ToUnicode est bien, mais ce n'est pas synonyme de parseur PDF robuste. PDF.js est précisément un parseur généraliste maintenu par Mozilla et distribué en pdfjs-dist. 
Mozilla GitHub
+1
 Si par « sans dépendance » tu voulais dire « sans service externe/payant », parfait. Si cela signifie réellement « aucun package de parsing », je déconseille.

Troisième problème : ton filtre des petites images. Je coderais :

si Content-Disposition=attachment
    => NE JAMAIS ignorer uniquement à cause de la taille

si inline && Content-ID référencé dans le HTML && size < 30 Ko
    => décoration probable

Un PNG de 18 Ko explicitement joint peut être un QR code, une signature ou un justificatif utile.

Quatrième problème : 200 Ko par mail est la mauvaise frontière. Un mail contenant quatre pièces peut avoir son premier PDF qui consomme le quota et rendre invisibles les trois suivantes. Mets la limite par pièce, avec TRUNCATED=1, ou indexe tout ce qui est raisonnable.

Enfin, les vieux formats vont te rattraper : .doc/.xls/.ppt, fichiers chiffrés, PDF protégés, .xlsb, pièces encapsulées, etc. Ce n'est pas grave à condition qu'ils soient affichés comme non indexés, et non silencieusement absents.

b) Je ne garderais pas l'interlocuteur comme unité principale

Pour retrouver un document, l'interlocuteur n'est pas l'objet naturel.

Exemple typique : un même dossier immobilier peut produire :

agence → compromis
notaire → acte
banque → offre
syndic → appel de fonds
assureur → attestation

Le regroupement expéditeur éclate artificiellement le dossier.

Mais je ne remplacerais surtout pas « interlocuteur » par un autre regroupement obligatoire « société » ou « bien immobilier ». Tu reconstruirais exactement le classement que le produit cherchait à éviter.

Ma recommandation :

un résultat principal = DOCUMENT

Sous le document :
  Facture IKEA FRINV...
  PDF · 428 Ko
  Trouvé dans le contenu : "SCI ALTOEN"
  Présent dans 3 emails
  IKEA · 12/03/2025
  IKEA · 15/03/2025
  comptable@... · 02/04/2025

Puis des facettes, non des dossiers :

[SCI ALTOEN] [Appartement Brest] [Facture] [2025] [IKEA]

Interlocuteur devient une facette parmi d'autres.

Les contextes « société » ou « bien » peuvent être extrêmement utiles ici, mais uniquement lorsque la confiance est forte. Ne force pas une classification complète des archives.

c) Oui à l'entité document — mais très minimale

Avec les doublons, elle devient quasiment indispensable.

Je ferais exactement cette distinction :

attachment_instance
-------------------
id
mail_id
part_id
filename
mime_type
transfer_size
decoded_size NULL
sha256 NULL
document_id NULL
extraction_status

document
--------
id
sha256 UNIQUE
decoded_size
mime_type
extracted_text

Une pièce jointe est une occurrence.

Un document signifie uniquement :

« ces occurrences contiennent exactement les mêmes octets ».

Pas :

« ce sont probablement les mêmes factures ».

Si deux PDF représentent la même facture mais ont un timestamp interne différent et donc deux hashes différents : deux documents.

C'est précisément ce qui évite la sur-ingénierie.

Et bonus important : le deuxième exemplaire du même PDF n'a plus besoin de conserver ni de ré-extraire le même texte.

d) FTS5 : oui, maintenant

Je ne regarderais même pas le nombre de mails. 25 000 lignes n'est pas le vrai sujet ; le volume de texte l'est.

Tes LIKE '%terme%' doivent parcourir les contenus, alors que FTS5 maintient un véritable index plein texte. FTS5 fournit aussi le ranking BM25, les snippets, les recherches de préfixes et des pondérations différentes selon les colonnes. 
SQLite
+1

Pour ton cas :

SQL
tokenize = 'unicode61 remove_diacritics 2'

Donc impot pourra notamment correspondre à impôt; SQLite prend en charge explicitement la suppression des diacritiques latins. 
SQLite

Je ferais deux niveaux de recherche.

Recherche normale :

FTS5 unicode61
mot entier / phrase / préfixe

C'est elle qui empêchera naturellement :

RIB

de considérer :

Ribéroux

comme une correspondance équivalente.

Puis seulement comme fallback :

substring / trigram

SQLite dispose justement d'un tokenizer trigram permettant les sous-chaînes. 
SQLite

Donc :

1. résultats mot entier
2. résultats préfixe
3. si peu/pas de résultats :
   "Correspondances partielles"

Pas un grand mélange pondéré incompréhensible.

Je pondérerais approximativement :

nom pièce        × 12
sujet            × 8
contenu pièce    × 5
expéditeur       × 4
corps mail        × 2
résumé IA         × 1

Le résumé IA doit rester faible : c'est une représentation dérivée, pas la preuve documentaire.

Et avec beaucoup de texte, regarde les tables FTS5 external content ou contentless pour ne pas stocker une deuxième copie complète de tout ton corpus uniquement pour l'index. SQLite documente explicitement cette optimisation de stockage. 
SQLite

Deuxième sujet : les doublons
e) Non : « même nom + même taille » ne doit jamais devenir « doublon »

Et il y a même un piège dans ce que tu appelles « taille exacte ».

FAIT : dans BODYSTRUCTURE, la taille d'un body part est celle de sa représentation avec son Content-Transfer-Encoding, pas nécessairement la taille des octets du fichier après décodage. Le RFC le précise explicitement. 
RFC Editor

Donc :

même nom + même BODYSTRUCTURE.size

signifie :

CANDIDAT_DOUBLON

et rien de plus.

Cela produit les deux erreurs possibles :

faux positif :
invoice.pdf + même taille
mais contenu différent

faux négatif :
même fichier binaire
mais représentation MIME différente

Je ne donnerais aucun « taux de faux positifs » générique : il serait inventé. Sur scan.pdf, invoice.pdf, image001.jpg, il peut être mauvais. Sur un nom UUID de 50 caractères, il sera probablement excellent.

Tu peux en revanche mesurer ton taux réel en quelques heures après implémentation.

La règle produit devrait être :

POSSIBLE_DUPLICATE
    normalized_filename identique
    + MIME compatible
    + transfer_size identique

EXACT_DUPLICATE
    SHA-256(decoded attachment bytes) identique
    + decoded_size identique

Et dès que tu télécharges déjà une pièce pour l'extraction :

JavaScript
download stream
   ├─> SHA-256
   └─> parser texte

Aucun téléchargement supplémentaire.

Encore mieux : une fois le hash calculé, ignore le nom du fichier pour la déduplication. facture.pdf et FRINV3159229.pdf peuvent être exactement le même document.

Pour les JPG que tu ne télécharges pas, ne les télécharge que lorsque :

candidate_count >= 2
AND potentiel_de_gain >= seuil

et traite les plus gros groupes en premier.

f) Suppression d'une seule pièce : surprise, Outlook.com offre une meilleure solution que ton APPEND

Ton diagnostic IMAP est correct.

FAIT : pour un UID donné, IMAP considère le message comme immuable : taille, enveloppe, BODYSTRUCTURE et contenu ne doivent pas changer. 
RFC Editor
+1

Et APPEND ajoute explicitement un nouveau message, auquel le serveur assigne un nouvel UID. Tu peux fournir les flags et l'InternalDate, mais ce n'est pas une modification du message original. 
RFC Editor
+1

Donc je te le dis clairement :

je déconseille la reconstruction MIME + APPEND + suppression de l'original.

Pour tes comptes Outlook.com/Hotmail, Microsoft fournit maintenant dans Graph v1.0 :

http
DELETE /me/messages/{message-id}/attachments/{attachment-id}

et Mail.ReadWrite est explicitement supporté en délégation pour les comptes Microsoft personnels. 
Microsoft Learn

Encore mieux : Graph sait ajouter une pièce à un message existant, donc une fonction Undo est techniquement possible. 
Microsoft Learn
 Pour les gros fichiers, Microsoft prévoit des sessions d'upload jusqu'à 150 Mo. 
Microsoft Learn

Cela change complètement mon choix technique :

IMAP
    lecture / sync / index

Graph
    modification d'une pièce jointe Outlook

Mais cela ne change pas ma recommandation produit.

Je ne l'activerais pas maintenant comme fonction normale de nettoyage.

Pourquoi ? Parce que tu modifies réellement un mail reçu.

Même avec Graph :

le message brut n'est plus celui reçu ;

une signature S/MIME/PGP peut être détruite ;

une vérification cryptographique sur le MIME original n'a plus le même sens ;

ton index IMAP peut observer une mutation comme un nouvel objet/UID ;

« remettre le fichier » est une restauration fonctionnelle, pas forcément une restauration bit-à-bit du MIME d'origine.

Graph dispose d'identifiants Outlook « ImmutableId » stables pendant la vie de l'élément dans la même boîte, ce qui est très utile pour ton suivi. 
Microsoft Learn
 Mais je ne supposerais jamais que l'UID IMAP restera identique après une mutation Graph : remappe et resynchronise.

Si tu implémentes tout de même la fonction, mon contrat serait très strict :

AUTORISÉ seulement si :
  fileAttachment
  AND non-inline
  AND pas de CID utilisé dans le HTML
  AND pas S/MIME / PGP / multipart/signed / encrypted
  AND SHA-256 connu
  AND sauvegarde locale vérifiée
  AND aperçu utilisateur validé

Pour un doublon :
  AND au moins une autre occurrence EXACT_DUPLICATE existe

PROCÉDURE :
  1. télécharger la pièce
  2. SHA256(backup) == SHA256(index)
  3. stocker backup chiffré + métadonnées
  4. Graph DELETE attachment
  5. relire message + attachments
  6. resynchroniser IMAP
  7. journaliser anciens/nouveaux identifiants
  8. conserver backup 30 jours

UNDO :
  Graph POST attachment
  ou uploadSession si >3 Mo
  vérifier SHA-256 après restauration

Et je limiterais les premières opérations à 10–20 pièces, pas 200, même si ton plafond global est de 200.

Une distinction UX est également indispensable :

"Supprimer le doublon"

est trop rassurant.

Je l'appellerais plutôt :

"Alléger ce mail"

avec :

Le mail sera modifié. Une copie de cette pièce sera conservée 30 jours pour annulation.

Mais dans ton cas actuel, je ne le ferais probablement pas du tout

C'est le point important.

Tu dis que le problème principal est l'encombrement mental, pas encore le quota.

Alors la meilleure fonction est :

Facture.pdf · 4 exemplaires identiques · 18,7 Mo au total
[voir les 4 mails]

et dans la recherche :

1 document
4 occurrences

au lieu de quatre résultats.

Tu obtiens immédiatement la déduplication cognitive sans toucher aux archives.

La suppression physique pourra venir le jour où Outlook dira réellement « stockage presque plein ».

g) Oui : les 109 mails >10 Mo sont un excellent point d'attaque, mais pas comme une liste “à supprimer”

Je ferais cet ordre exact :

1. Passer à FTS5 + attachment_instance/document.

2. SHA-256 systématique de TOUTE pièce déjà téléchargée
   pour extraction.
   => coût réseau supplémentaire = zéro.

3. Sur les pièces non téléchargées :
   construire les groupes CANDIDAT_DOUBLON
   à partir de nom + MIME + taille BODYSTRUCTURE.

4. Calculer pour chaque groupe :
   potentiel = taille × (occurrences - 1)

5. Télécharger/hash uniquement les candidats
   à plus fort potentiel.

6. Écran "Pièces jointes lourdes" :
   priorité A : doublons exacts
   priorité B : 109 mails > 10 Mo
   priorité C : gros fichiers uniques
   priorité D : doublons possibles non vérifiés.

Tes 109 mails représentent une population assez petite pour être humainement révisable, tout en concentrant 1 625 Mo. C'est exactement le genre de Pareto qu'il faut exploiter. Mais une vidéo familiale de 30 Mo ou un acte notarié de 15 Mo ne devient pas du bruit parce qu'il est gros.

Mon choix final

Ton axe « retrouver sans classer » est bon. Je garderais le concept et je changerais l'unité : document d'abord, mail comme provenance, interlocuteur comme facette.

Je passerais immédiatement à FTS5 et au couple document / attachment_instance.

Pour les doublons : nom+taille = candidat ; SHA-256 = doublon. Jamais autrement.

Et pour la suppression : jamais de chirurgie MIME via IMAP. Graph rend la chose techniquement propre sur Outlook.com, mais comme les boîtes ne sont pas pleines, je construirais aujourd'hui la déduplication visuelle et la mesure du gain, pas la mutation de dix ans d'archives. Le rapport risque/bénéfice n'est pas encore favorable.
---

## Deuxième question — la boîte d'archive (idée de l'utilisateur)

```
Suite du même sujet. L'utilisateur propose une TROISIÈME voie, et je la trouve meilleure que les deux qu'on a discutées. Je viens de la chiffrer.

SON IDÉE
Plutôt que de supprimer une pièce jointe (chirurgie MIME) ou de renoncer, créer une BOÎTE MAIL D'ARCHIVE dédiée — un compte gratuit séparé — et y DÉPLACER les mails les plus lourds, rangés par boîte d'origine. Le mail n'est pas modifié, il change juste d'endroit. Ça libèrerait la place là où elle manque, en profitant du stockage gratuit d'un compte supplémentaire.

CE QUE ÇA DONNE SUR SES DONNÉES RÉELLES
Volume par boîte (index local) :
  thony56_gtr (perso) 9,10 Go — Brimmo 1,56 — Location_Brest 1,20 — Altoen 0,84 — Au-marais 0,52 — Colocar 0,31 — Econom 0,08. Total ~13,6 Go.
Ce que déplacerait une archive selon le seuil :
  > 20 Mo :    35 mails →  0,79 Go ( 6 % du total)
  > 10 Mo :   297 mails →  4,42 Go (32 %)
  >  5 Mo :   673 mails →  7,00 Go (51 %)
  >  2 Mo : 1 391 mails →  9,28 Go (68 %)
En se limitant au lourd ET ancien (plus de 2 ans) : 262 mails de plus de 10 Mo = 3,92 Go.

Autrement dit : déplacer 262 mails libère 3,9 Go. À comparer avec tout ce dont on a parlé jusqu'ici — le nettoyage complet ne libérait que 137 Mo, et la déduplication ~1,4 Go. C'est un Pareto écrasant : 1,6 % des mails portent 32 % du poids.

Contrainte : Outlook.com n'annonce PAS le quota en IMAP (commande QUOTA refusée), donc je ne peux pas lire son taux d'occupation réel ni déclencher sur « boîte presque pleine ». Je ne connais que le volume que j'ai indexé.

MES QUESTIONS
1. Le déplacement entre DEUX COMPTES n'est pas un MOVE IMAP : c'est télécharger le message complet, l'APPEND dans le compte d'archive, puis mettre l'original à la corbeille. Le message reste-t-il vraiment intact (signature, en-têtes, pièces) ? Qu'est-ce que je perds au passage, et que dois-je impérativement préserver à l'APPEND (INTERNALDATE, drapeaux, quoi d'autre) ? Est-ce que tu considères ça comme sûr, contrairement à la chirurgie MIME que tu déconseillais ?
2. Quel seuil retenir, et sur quel critère ? Taille seule, ou taille × ancienneté ? Faut-il exclure des catégories entières (un fil encore actif, un mail auquel il n'a pas répondu, une facture de l'année en cours) ?
3. Le fil de discussion : si j'archive UN mail d'un échange et pas les autres, est-ce que je casse quelque chose d'important pour lui ? Faut-il raisonner par fil entier ?
4. La recherche : mon outil indexe déjà plusieurs boîtes et sait chercher dans toutes à la fois. Le compte d'archive devient donc juste une boîte de plus, et le mail reste retrouvable. Est-ce que ça suffit, ou faut-il autre chose pour qu'il ne perde jamais un document (par exemple garder dans la boîte d'origine un mail-repère qui pointe vers l'archive) ?
5. Le transfert : 4,4 Go à descendre puis à remonter depuis un petit VPS, sur des comptes Outlook.com qui limitent le débit. Comment structurerais-tu ça pour que ce soit reprenable, vérifiable, et sans perte possible ? Quel ordre d'opérations garantit qu'on ne supprime JAMAIS avant d'avoir la certitude que la copie est arrivée ?
6. Y a-t-il un piège que je ne vois pas — sur la durée de vie d'un compte gratuit inactif, sur les limites d'un compte Outlook.com, ou sur le fait de concentrer 4 Go d'archives dans un compte qui devient un point de défaillance unique ?
7. Compte tenu de tout ça, quel est le bon ordre : déduplication d'abord (1,4 Go, sans rien déplacer), ou archivage d'abord (3,9 Go, en déplaçant 262 mails) ?

Réponds concrètement, et dis-moi franchement si tu déconseilles.
```

## Réponse

Oui, cette troisième voie est nettement meilleure que la chirurgie MIME. Je la retiendrais comme stratégie de capacité, avec une réserve majeure : elle ne fonctionne vraiment que si tu acceptes qu’après une période de sécurité, l’original disparaisse définitivement de la boîte source.

Et j’ai trouvé deux contraintes Outlook.com qui empêchent d’en faire naïvement « un compte gratuit de 15 Go pour déporter 10 Go ».

FAIT : un compte Outlook.com gratuit a 15 Go de boîte mail, mais aussi seulement 5 Go de stockage cloud Microsoft, et les pièces jointes Outlook.com comptent dans ces 5 Go. Si cette seconde limite est dépassée, Outlook.com peut cesser d’envoyer/recevoir alors même que les 15 Go de boîte mail ne sont pas atteints. 
Support Microsoft
+1

Donc ton compte d’archive gratuit n’est pas réellement un coffre mail de 15 Go de pièces jointes.

1. APPEND inter-comptes : oui, je considère ça suffisamment sûr

FAIT : IMAP APPEND prend un message RFC 5322 complet et crée un nouveau message dans la boîte cible. Il accepte séparément les flags et l’INTERNALDATE. Si tu ne fournis pas l’INTERNALDATE, il prend la date actuelle, donc il faut absolument la recopier. 
IETF Datatracker
+1

La bonne source n'est surtout pas un MIME que tu reparses puis reconstruis. C'est :

source IMAP
BODY.PEEK[]      -> octets RFC822 bruts

puis exactement ces octets en entrée du :

destination IMAP
APPEND

Dans ce cas, tu ne touches ni aux headers, ni aux boundaries MIME, ni aux pièces jointes.

Je préserverais séparément :

RAW MESSAGE       obligatoire
INTERNALDATE      obligatoire

\Seen             oui
\Answered         oui
\Flagged          oui
\Draft            oui si présent

\Deleted          NON
\Recent           NON

keywords custom   seulement si destination les supporte

Le nouvel UID sera nécessairement différent : l'UID identifie le nouveau message dans sa nouvelle mailbox. Un APPEND réussi peut retourner son nouvel APPENDUID. 
IETF Datatracker

En revanche, tu perds forcément l'identité de stockage d'origine :

account source
mailbox source
UIDVALIDITY source
UID source

        ≠

account archive
mailbox archive
UIDVALIDITY archive
UID archive

Donc ces quatre valeurs doivent rester dans SQLite comme provenance historique.

Ma garantie serait plus forte que le protocole

Le RFC autorise même un serveur incapable de conserver correctement certains contenus 8 bits à effectuer une conversion MIME réversible. 
IETF Datatracker

Je ne veux même pas de ça dans ton produit.

Je poserais :

sha256(raw_source) == sha256(raw_destination)

comme condition obligatoire avant de toucher à l'original.

Si c'est vrai, tu sais alors beaucoup plus que « APPEND a réussi » :

les headers + MIME + pièces + Message-ID + signature embarquée sont exactement les mêmes octets.

Donc :

APPEND OK
mais SHA différent
=> ARCHIVAGE ÉCHOUÉ
=> original totalement intact

C'est précisément pour cela que je considère cette technique beaucoup plus sûre que la chirurgie d'une pièce jointe.

Le premier piège : ta Corbeille

Avec ton contrat actuel :

suppression = Corbeille, jamais EXPUNGE

le gain n'est pas immédiat.

Outlook.com compte les éléments de Deleted Items dans le quota jusqu'à ce qu'ils soient supprimés définitivement ou automatiquement supprimés après 30 jours. 
Support Microsoft

Donc ton fonctionnement réel serait :

J0
archive vérifiée
original -> Éléments supprimés

J0 à J30
0 Go réellement récupéré sur cet original
mais rollback très simple

~J30
Outlook purge automatiquement
espace récupéré

Ça me convient puisque tu précises que les boîtes ne sont pas encore pleines.

Mais il faut modifier le vocabulaire du garde-fou :

Jamais de suppression définitive effectuée par l'assistant. Toute migration reste récupérable dans la boîte source pendant la période Outlook, et indéfiniment depuis la copie d'archive vérifiée.

Si ton invariant signifie réellement « aucun original ne devra jamais être définitivement supprimé », alors cette solution ne peut pas libérer durablement de capacité.

2. Le seuil : surtout pas taille × ancienneté

Je ne ferais pas un score continu. Je ferais des portes d'éligibilité, puis taille décroissante.

Ta première cohorte est pratiquement déjà trouvée :

message_size >= 10 MiB
AND age >= 2 ans

262 messages → 3,92 Go.

C'est excellent.

Puis j'ajouterais pour la V1 :

AND aucune action ouverte
AND aucune réponse attendue connue
AND non Flagged
AND conversation inactive depuis >= 12 mois

Je n'utiliserais pas \Seen comme protection : sur dix ans de boîte, lu/non-lu est un très mauvais proxy de valeur.

Et je n'exclurais pas :

facture
contrat
acte
document fiscal

Ils sont précisément parmi les meilleurs candidats à l'archive : on veut les conserver, pas les supprimer.

Donc la logique est :

éligibilité métier d'abord
puis ORDER BY message_size DESC

pas :

score = taille × ancienneté

qui pourrait donner des effets absurdes.

3. Je ne déplacerais pas les fils entiers

INFÉRENCE : si tu retires un message d'une conversation du compte A et qu'il passe dans le compte Archive, Outlook du compte A ne peut évidemment plus afficher ce message dans la conversation native.

Donc oui, le fil Outlook sera visuellement incomplet.

Mais déplacer tout le thread pour éviter ça serait une mauvaise réaction.

Un thread peut contenir :

2018 : PDF de 18 Mo
2018 : "merci"
2019 : échange
2026 : nouvelle demande active

Tu finirais par déplacer le courrier actif pour accompagner un PDF de 2018.

Je préfère :

archive au niveau MESSAGE
mais continuité au niveau CONVERSATION dans ton assistant

Ton UI devrait afficher par exemple :

Conversation avec le notaire
7 messages ici · 2 anciens messages archivés

Et lorsque l'utilisateur ouvre le fil, les neuf apparaissent chronologiquement.

Là ton assistant devient meilleur qu'Outlook plutôt que d'essayer de préserver artificiellement son modèle.

Pour la première version, ta règle conversation inactive depuis 12 mois réduit déjà énormément le problème.

4. Surtout pas de « mail-repère »

Je le déconseille très fortement.

Tu transformerais :

« je n'altère pas les boîtes »

en :

« j'injecte des faux mails dans les archives pour expliquer où sont les vrais ».

C'est du bruit permanent.

Tu as déjà SQLite. Fais plutôt de la migration une notion de premier ordre :

logical_message
---------------
id
origin_account
origin_mailbox
origin_uidvalidity
origin_uid

current_account
current_mailbox
current_uidvalidity
current_uid

archived_at
raw_sha256
migration_id

Résultat de recherche :

Facture IKEA.pdf
Reçue sur Altoen le 12/03/2022
Archivée le 11/08/2026
[Ouvrir le mail]

L'utilisateur ne devrait même pas avoir besoin de savoir physiquement dans quelle boîte elle vit.

Et surtout, ne réindexe pas le mail archivé comme un second mail : rattache la nouvelle occurrence au même logical_message_id, sinon ton archivage va créer lui-même des doublons de recherche pendant les 30 jours où les deux copies coexistent.

5. Le transfert : je ferais une machine à états très stricte

Pas un script du genre :

JavaScript
fetch()
append()
moveToTrash()

mais :

SELECTED
   ↓
SOURCE_FETCHED
   ↓
SOURCE_HASHED
   ↓
DEST_APPENDING
   ↓
DEST_APPENDED
   ↓
DEST_REFETCHED
   ↓
DEST_VERIFIED
   ↓
SOURCE_TO_TRASH
   ↓
QUARANTINED
   ↓
COMPLETE

SOURCE_FETCHED doit contenir au minimum :

source account
source mailbox
UIDVALIDITY
UID

RFC822.SIZE
INTERNALDATE
FLAGS
Message-ID

raw SHA-256

Je téléchargerais un seul .eml temporaire à la fois sur le VPS.

Puis :

APPEND raw.eml
    flags = original_flags_without_deleted
    internalDate = original_internalDate

Ensuite re-FETCH depuis l'archive, pas confiance au simple OK :

sha256(destination_raw) === sha256(source_raw)
destination_size === source_size
INTERNALDATE cohérent
flags cohérents

Et seulement après :

DB:
DEST_VERIFIED = true

COMMIT

puis source -> Deleted Items

Ainsi tous les crashs sont sûrs :

crash avant APPEND
=> original seul

crash pendant APPEND
=> original existe toujours

crash après APPEND
=> au pire deux exemplaires

crash après VERIFY
=> au pire deux exemplaires

crash après MOVE source
=> archive vérifiée + original dans Corbeille

Il n'existe aucun état où zéro copie existe.

Il y a un cas vicieux : « APPEND réussi mais réponse perdue »

Connexion coupée exactement après que Microsoft a enregistré le message, mais avant que ton VPS reçoive OK [APPENDUID ...].

Au redémarrage, tu ne sais pas si APPEND a réussi.

Il ne faut surtout pas refaire aveuglément l'APPEND.

Recherche d'abord dans la destination :

Message-ID
+ RFC822.SIZE
+ INTERNALDATE proche

puis téléchargement du/des candidat(s)
+ comparaison SHA-256

Si le hash existe déjà :

=> reprendre à DEST_VERIFIED

C'est ce détail qui rend le job réellement idempotent.

Attention aussi aux très gros mails

Il existe une extension IMAP APPENDLIMIT permettant au serveur d'annoncer la taille maximale acceptable ; si elle n'est pas annoncée, cela ne signifie pas qu'il n'existe aucune limite. Un APPEND trop gros peut encore échouer. 
RFC Editor
+1

Donc :

si CAPABILITY contient APPENDLIMIT:
    precheck taille

sinon:
    tenter
    gérer proprement NO / TOOBIG

Outlook.com annonce actuellement 25 Mo comme limite pour les pièces jointes lors de l'envoi, mais je ne transposerais surtout pas ce chiffre à IMAP APPEND : ce sont deux opérations différentes. 
Support Microsoft

Tes 35 messages >20 Mo sont donc justement ceux que je testerais lors du pilote.

6. Le compte gratuit est le point qui me plaît le moins

Il y a deux vrais problèmes.

FAIT : quota double. L'archive gratuite a 15 Go de mail mais 5 Go de Microsoft Storage, et les pièces jointes Outlook sont comptées dans les deux univers de stockage. Dépasser les 5 Go peut bloquer l'email. 
Support Microsoft

Donc je n'enverrais pas directement les 4,42 Go >10 Mo dans un compte neuf.

Je ferais plutôt :

phase pilote : <= 3,0 Go

puis contrôle humain de Paramètres > Stockage du compte archive.

Ensuite seulement tu continues.

INFÉRENCE : pour un compte gratuit dédié, je mettrais un plafond interne d'environ 3,5 Go de pièces/inline indexées, pas 5 Go. Ce n'est pas une limite Microsoft : c'est une marge de sécurité produit.

Deuxième problème, beaucoup plus dangereux pour une archive :

FAIT : Microsoft exige de se connecter à la boîte Outlook.com au moins une fois par période d'un an ; sinon la boîte Outlook.com peut être fermée et ses emails supprimés. Le compte Microsoft global a quant à lui une règle générale de deux ans, mais Outlook.com a cette exigence spécifique d'un an. 
Support Microsoft
+1

Donc il faut un invariant produit :

ARCHIVE ACCOUNT:
last_interactive_signin < 10 months

avec rappel obligatoire.

Je ne supposerais pas qu'une connexion IMAP OAuth périodique satisfait cette exigence : la documentation parle explicitement d'une connexion à la boîte Outlook.com. Je prévoirais une vraie ouverture Outlook.com annuelle.

Et je n'irais surtout pas construire :

archive1@hotmail...
archive2@hotmail...
archive3@hotmail...
archive4@hotmail...

pour multiplier artificiellement les quotas.

Les conditions Microsoft interdisent notamment de contourner les restrictions d'accès/usage/disponibilité. Je n'ai trouvé aucune disposition disant qu'un second compte personnel d'archive est interdit ; je ne prétends donc pas que ton idée viole les règles. Mais une architecture de sharding destinée à multiplier les quotas gratuits deviendrait contractuellement et opérationnellement beaucoup plus contestable. 
Microsoft

Un compte archive, oui. Une ferme de comptes gratuits, non.

Enfin :

le compte archive est une relocalisation, pas une sauvegarde.

Après disparition de la copie source, sa perte devient la perte du mail.

Je conserverais donc au minimum le SHA-256 de chaque .eml archivé et j'effectuerais périodiquement un contrôle d'intégrité.

7. Archive ou déduplication d'abord ?

Il faut distinguer analyse des doublons et action sur les doublons.

Je ferais dans cet ordre :

1. Hash / détection des doublons
   immédiatement
   car peu risqué et utile à tout le reste.

2. Aucun nettoyage physique des pièces jointes.

3. Pilote d'archivage :
   >10 MiB
   >2 ans
   conversation inactive
   aucune action en cours

4. Maximum ~3 Go au premier passage.

5. Contrôle du stockage réel Outlook.com.

6. Puis extension éventuelle jusqu'aux ~262 messages.

7. Déduplication visuelle dans la recherche.

Car ta « déduplication = 1,4 Go » a une faiblesse conceptuelle :

repérer 1,4 Go de doublons ne libère pas 1,4 Go.

Pour les libérer il faut ensuite soit supprimer des mails, soit retirer leurs pièces, donc retomber sur les problèmes précédents.

Alors que ton archivage :

262 messages → potentiel de ~3,92 Go relocalisés

est une action physique simple et cohérente.

Mon verdict

Je recommande cette voie, contrairement à la chirurgie MIME.

Mais je la renommerais mentalement :

migration vérifiée vers stockage froid

et non « déplacement de mails ».

Le contrat que je signerais est :

Jamais modifier le message.
Jamais toucher à la source avant copie.
Jamais croire APPEND sur parole.
SHA-256 RAW source == destination obligatoire.
INTERNALDATE préservé.
Provenance conservée dans SQLite.
Source ensuite en Corbeille seulement.
Recherche unifiée masque le changement de boîte.
Pas de thread entier.
Pas de mail-repère.
Pas de ferme de comptes gratuits.

Et ton >10 Mo + >2 ans = 262 mails / 3,92 Go me paraît précisément le bon premier périmètre fonctionnel. Le seul changement que je lui imposerais est de ne pas envoyer d'un coup 3,92 Go vers un compte gratuit sans surveiller sa limite Microsoft Storage de 5 Go. C'est désormais le facteur limitant le plus important de la proposition. 
Support Microsoft
+1