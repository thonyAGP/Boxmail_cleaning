Oui : sur 1, 3 et 4, ton ajustement est meilleur que ma proposition initiale. Sur 2, je valide l'absence de stockage de PJ sur le VPS, mais je refuse ton choix de (boîte, UID, index PJ, taille) comme identité durable. C'est un locator IMAP, pas une identité métier.

1. Société par boîte : tu as raison, avec une nuance importante

Dans ton terrain réel, ma hiérarchie était trop générique.

Si six boîtes sur sept sont structurellement dédiées à une société, je ferais :

mailboxId → companyId

comme règle déterministe de premier niveau.

Exemple :

brimmo@...  → BRIMMO
econom@...  → ECONOM
lb2i@...    → LB2I

Et non :

PDF → OCR → raison sociale → SIREN → IA → société

Ce serait absurde de dépenser du CPU et de la complexité pour redécouvrir une information déjà portée presque gratuitement par le routage du mail.

Je garderais seulement une distinction sémantique :

companyCandidate = BRIMMO
companyBasis = MAILBOX_DEFAULT

et pas :

companyVerified = BRIMMO

Parce qu'un fournisseur peut envoyer exceptionnellement une facture ECONOM sur la boîte BRIMMO, quelqu'un peut transférer un mail, etc.

Mais je ne construirais rien pour détecter automatiquement ces exceptions en V1. L'utilisateur voit la facture et dispose de [Changer de société].

Pour la boîte personnelle :

companyCandidate = null
companyBasis = NONE

C'est là seulement qu'un futur moteur de règles peut devenir intéressant :

Adobe → probablement LB2I
fournisseur X → probablement BRIMMO
...

Donc : oui à ton attribution par boîte comme défaut fort.

2. Pas de PJ sur Boxmail : je concède, mais pas avec ton identité proposée

Je préfère finalement ton architecture :

Outlook / IMAP
      │
      │ stockage durable original
      ▼
Boxmail
SQLite = métadonnées uniquement
      │
      │ PJ streamée à la demande
      ▼
Fiscal Manager
stockage définitif du document

C'est plus propre.

Tu évites d'avoir :

Outlook
+ VPS Boxmail
+ PC Fiscal Manager

qui conservent tous les trois le même PDF.

Mais (mailbox, UID, index PJ, taille) ne doit pas devenir l'identité.

Un UID IMAP n'est stable que dans le contexte d'un mailbox/folder et d'un UIDVALIDITY.

Un déplacement :

Inbox UID=4862
       ↓ move
Factures UID=917

peut casser ton pointeur.

Donc je séparerais strictement :

IDENTITÉ
candidateId = UUID/ULID généré par Boxmail
attachmentId = identifiant interne au candidat

de :

LOCATOR IMAP
account
folder
uidValidity
uid
mimePart

Le locator peut changer.

L'identité ne change jamais.

Boxmail garde donc seulement quelque chose de cet ordre :

candidateId
mailboxId
messageIdHeader
receivedAt

currentImapLocator {
    folder
    uidValidity
    uid
}

attachments [
    {
        attachmentId,
        mimePart,
        filename,
        size,
        contentType
    }
]

Si Boxmail lui-même déplace le message, il actualise le locator.

Et en récupération, je mettrais un fallback raisonnable :

locator connu
↓ échec
recherche Message-ID
↓
vérification filename + taille

Pas davantage.

Le vrai invariant à ajouter

Une fois un message marqué ACCOUNTING_CANDIDATE :

Boxmail n'a jamais le droit de le supprimer automatiquement.

Déplacement : oui.

Archivage : oui.

Suppression/expunge automatique : non.

Si l'utilisateur le supprime lui-même avant que Fiscal Manager l'ait importé, il reste un risque résiduel assumé.

Mais Boxmail doit alors conserver le candidat dans SQLite et signaler :

SOURCE_MISSING

au lieu de faire disparaître silencieusement le candidat.

Donc à ta question :

est-ce grave si le lien casse alors que l'import se fait généralement sous quelques jours ?

“Généralement” n'est pas assez fort pour un système dont l'objectif est “aucun document perdu”.

Mais il n'est pas nécessaire de stocker les PDF pour résoudre ça. Il suffit surtout de ne pas supprimer automatiquement les mails candidats.

3. Zéro extraction en V1/V2 : tu as raison

Je vais même aller plus loin : je préfère maintenant ta solution à la mienne.

Le piège classique des projets IA serait de construire :

PDF
→ extraction texte
→ OCR
→ LLM
→ parsing montant
→ parsing TVA
→ scoring
→ cas limites

pour éviter à quelqu'un de taper :

122,40

C'est un très mauvais rapport coût/valeur ici.

Le problème coûteux pour l'utilisateur n'est pas :

recopier 122,40 €.

Le problème est :

se souvenir qu'une facture OVH reçue il y a 18 jours doit être rattachée à une dépense.

Donc :

automatiser la mémoire, pas la frappe.

Je supprimerais complètement OCR/extraction du backlog initial.

Une correction toutefois à ta formulation :

fournisseur = expéditeur mail
date = date mail

Je ne les appellerais surtout pas supplier et invoiceDate.

Ce sont :

senderName
senderAddress
receivedAt

Ce sont des indices UI, pas des données comptables.

Parce que :

facturation@stripe.com

n'est pas nécessairement le fournisseur, et une facture datée du 31 juillet peut être reçue le 2 août.

Fiscal Manager peut afficher :

OVHcloud <billing@ovh.com>
Reçu le 02/08/2026

Puis lors de [Créer un frais] :

Fournisseur : [          ]
Date        : [          ]
Montant TTC : [          ]

Éventuellement l'utilisateur choisit un fournisseur déjà connu avec autocomplétion.

Je n'automatiserais rien de plus.

4. Carte personnelle : je tranche clairement contre l'import

N'importe pas les relevés de carte personnelle.

Pas maintenant.

Je retire ma proposition précédente.

Tu augmenterais énormément le périmètre pour résoudre un trou dont tu n'as pour l'instant même pas mesuré la fréquence :

500 transactions personnelles
        ↓
Fiscal Manager
        ↓
filtrage de 480 transactions inutiles
        ↓
pour éventuellement retrouver 20 dépenses pro

avec en plus :

davantage de données personnelles ;

davantage de règles ;

davantage de bruit ;

davantage de rapprochements ambigus ;

nouvelle banque/source à maintenir.

C'est contraire au problème initial.

Ton scope doit rester :

SIGNAL 1
une pièce comptable arrive
→ ne pas la perdre
→ la qualifier
→ éventuellement créer Expense

et :

SIGNAL 2
une transaction existe sur un compte SOCIÉTÉ
→ vérifier qu'un justificatif existe

Le cas :

achat professionnel carte perso
+
aucun mail
+
aucune facture

reste invisible.

Je l'accepterais explicitement comme risque résiduel.

Si dans six mois l'utilisateur dit :

chaque mois j'ai 5 achats personnels pro pour lesquels je cherche les tickets

alors tu auras une preuve qu'il faut traiter le problème.

Et même là, je ne commencerais probablement pas par importer tout le relevé personnel. Je regarderais d'abord une capture manuelle extrêmement légère du frais.

Une simplification supplémentaire que je ferais

Je ne ferais même pas du serveur une véritable API de synchronisation de AccountingDocument.

Conceptuellement :

Boxmail
    AccountingCandidate

et :

Fiscal Manager
    AccountingDocument

Ce sont deux objets différents.

Un candidat Boxmail dit seulement :

« J'ai vu quelque chose qui ressemble à une pièce comptable ici. »

Fiscal Manager transforme cette observation en document métier.

Cela garde ta règle très nette :

Boxmail détecte. Fiscal Manager qualifie.

(a) Contrat API minimal exact

Je resterais réellement à deux endpoints.

GET /api/v1/accounting-candidates

Authentification :

http
Authorization: Bearer <fiscal-manager-read-token>

Paramètres :

cursor=<opaque>
limit=100

Réponse :

JSON
{
  "items": [
    {
      "candidateId": "01K2...",
      "detectedAt": "2026-08-07T12:42:16Z",

      "mailboxId": "brimmo",
      "companyCandidate": "BRIMMO",
      "companyBasis": "MAILBOX_DEFAULT",

      "message": {
        "receivedAt": "2026-08-07T12:38:02Z",
        "fromName": "OVHcloud",
        "fromAddress": "billing@ovhcloud.com",
        "subject": "Votre facture OVHcloud"
      },

      "attachments": [
        {
          "attachmentId": "a1",
          "filename": "facture-202608.pdf",
          "contentType": "application/pdf",
          "sizeBytes": 84217
        }
      ]
    }
  ],

  "nextCursor": "eyJzZXEiOjEyOTR9",
  "hasMore": false
}

Pour la boîte personnelle :

JSON
{
  "companyCandidate": null,
  "companyBasis": "NONE"
}
Sémantique du curseur

Dans SQLite Boxmail :

accounting_candidate
--------------------
seq INTEGER AUTOINCREMENT
candidate_id UNIQUE
...

L'API renvoie :

seq > cursor.seq
ORDER BY seq ASC
LIMIT n

Le curseur peut être opaque extérieurement.

Il n'est pas basé sur :

date du mail
UID IMAP
date de détection

Le seq évite les problèmes de même timestamp et donne une sémantique extrêmement claire.

GET /api/v1/accounting-candidates/{candidateId}/attachments/{attachmentId}

Boxmail résout son locator IMAP et streame directement la pièce.

Réponse normale :

http
200 OK
Content-Type: application/pdf
Content-Length: 84217
Content-Disposition: attachment; filename="facture-202608.pdf"

Si le mail source a disparu :

http
410 Gone

Pas 404.

Le candidat existe toujours ; c'est sa source qui n'existe plus.

C'est une distinction utile.

Idempotence

Elle appartient principalement à Fiscal Manager.

À l'import :

sourceSystem = BOXMAIL
sourceCandidateId
sourceAttachmentId

avec contrainte unique :

UNIQUE (
    sourceSystem,
    sourceCandidateId,
    sourceAttachmentId
)

Puis Fiscal Manager télécharge le fichier et calcule :

SHA-256

qu'il stocke dans :

contentSha256

Le SHA sert à signaler un deuxième niveau de doublon :

candidate différent
+
même SHA-256
→ document identique probable

Mais je ne bloquerais pas forcément l'import uniquement sur le SHA au départ.

Aucun endpoint :
POST /ack
POST /processed
POST /expense
PUT /candidate
webhook

en V1.

Fiscal Manager garde son curseur localement.

Boxmail n'a pas besoin de savoir ce qu'est devenu le document.

C'est une propriété architecturale intéressante : le pont est strictement unidirectionnel.

(b) V1 exact que je livrerais en quelques jours

Je ferais maintenant un thin vertical slice complet, plutôt qu'un V1 Boxmail isolé.

DANS V1	PAS DANS V1
Détection facture existante de Boxmail	Nouveau modèle IA
AccountingCandidate SQLite	OCR
Société par mailbox dédiée	Extraction montant
Boîte personnelle → société inconnue	Extraction TVA
Override manuel société dans Fiscal Manager	Lecture SIREN/SIRET
Métadonnées des PJ, sans stockage VPS	Classification sophistiquée du PDF
Protection contre suppression automatique des candidats	Antivirus complexe si aucune chaîne de conversion/exécution n'existe
Les 2 endpoints GET ci-dessus	POST / ACK
Bearer token dédié read-only	OAuth complexe
HTTPS	VPN/Tailscale obligatoire
Curseur monotone	Message broker
Écran Pièces reçues dans Fiscal Manager	WebSockets
Bouton manuel Actualiser	Synchronisation temps réel
Import PJ à la demande	Agent IA
SHA-256 calculé à l'import	Commandes create_expense distantes
Idempotence candidateId + attachmentId	Synchronisation bidirectionnelle
AccountingDocument séparé de Expense	Import relevé carte personnelle
Actions Créer un frais / Associer / Pas un frais / Ignorer	Nouveau rapprochement bancaire personnel
Création de frais avec saisie manuelle montant/date/fournisseur	Extraction automatique fournisseur/date facture
Utilisation du mécanisme d'upload déjà existant	Nouveau système documentaire
Indication visible SOURCE_MISSING	Résolution automatique de toutes les PJ disparues
Journal minimal de l'import	Workflow comptable complexe

Et surtout je mettrais hors V1 le nouveau système de lots Cerfrance.

Pas parce qu'il est mauvais, mais parce qu'il n'est pas nécessaire pour vérifier la première hypothèse :

Est-ce que centraliser automatiquement les pièces détectées dans Fiscal Manager élimine réellement les oublis ?

Si la réponse est oui, le batch comptable arrive juste après.

Mon architecture finale devient donc encore plus petite
                 Outlook / Hotmail
                        │
                       IMAP
                        │
                 ┌──────▼──────┐
                 │   Boxmail   │
                 │             │
                 │ détecte     │
                 │ mémorise    │
                 │ métadonnées │
                 │             │
                 │ PAS de PDF  │
                 └──────┬──────┘
                        │
                     2 GET
                        │
                 ┌──────▼──────────┐
                 │ Fiscal Manager │
                 │                │
                 │ télécharge PDF │
                 │ SHA-256        │
                 │ qualifie       │
                 │ AccountingDoc  │
                 │      ↓         │
                 │ Expense ?      │
                 └────────────────┘

Et je serais assez strict sur la limite : si le V1 commence à parler OCR, TVA, agent, Tailscale, rapprochement de carte perso, moteur de dédoublonnage comptable ou analyse du contenu du PDF, le scope a déjà dérivé.

Le premier livrable doit essentiellement prouver une chose : un PDF de facture arrivé dans n'importe laquelle des sept boîtes finit systématiquement visible dans une file unique de Fiscal Manager, sans que l'utilisateur ait eu à se souvenir de le transférer. C'est là que se trouve presque toute la valeur initiale.