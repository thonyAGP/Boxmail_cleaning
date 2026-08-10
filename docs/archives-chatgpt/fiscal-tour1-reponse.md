Ta direction est bonne, mais je modifierais assez nettement le découpage métier. Je choisirais B, mais dans une version plus étroite que celle que tu décris. Je ne ferais surtout pas de create_expense depuis Boxmail au départ.

1) Là où ton analyse me paraît faible

Le principal défaut est ici :

facture détectée → rapprochement avec un frais ou création d'un frais

Tu supposes implicitement qu'une facture reçue par mail est un objet du module Frais. C'est faux dans beaucoup de cas.

Une pièce reçue peut être :

une facture payée avec la carte personnelle → frais/remboursement ;

une facture payée directement par la société → aucun remboursement ;

une facture à payer ;

un avoir ;

une facture déjà transmise par un autre canal ;

une facture concernant une autre société ;

un justificatif sans facture ;

une facture correspondant à plusieurs opérations bancaires ou inversement.

Je créerais donc un objet indépendant :

AccountingDocument
- id
- source: EMAIL
- sourceMessageId
- attachmentHash
- documentType
- supplier
- invoiceNumber
- invoiceDate
- amountGross
- amountVat
- companyCandidate
- confidence
- status

avec un cycle du genre :

DETECTED
→ TO_REVIEW
→ CLASSIFIED
→ LINKED / NO_EXPENSE_REQUIRED
→ SENT_TO_ACCOUNTANT
→ ARCHIVED

Et seulement ensuite :

AccountingDocument ─── éventuellement ───> Expense

C'est une distinction importante. Fiscal Manager devient le système de vérité comptable ; Boxmail reste un système de détection.

2) Ton architecture B : oui, mais simplifie-la

Ton PULL est probablement le meilleur choix architectural.

Je ferais :

                    Internet
                       │
               ┌───────▼───────┐
               │    Boxmail    │
               │ VPS / SQLite  │
               │               │
Email ────────►│ détection     │
               │ extraction    │
               │ hash PJ       │
               │ candidats     │
               └───────┬───────┘
                       │
                  HTTPS PULL
                       │
               ┌───────▼─────────┐
               │ Fiscal Manager │
               │     LOCAL      │
               │                │
               │ Pièces reçues  │
               │ rapprochement  │
               │ frais          │
               │ banque         │
               │ comptable      │
               └────────────────┘

Mais Boxmail ne devrait idéalement exposer que quelque chose de très bête :

http
GET /accounting-documents?after=cursor
GET /accounting-documents/:id/attachments/:attachmentId

Fiscal Manager importe les éléments de manière idempotente.

Pas d'agent IA entre les deux. Pas de commandes asynchrones complexes. Pas de workflow distribué.

Le PC peut être éteint trois jours : aucune importance. Boxmail conserve simplement les candidats et Fiscal Manager rattrape le retard au prochain lancement.

C'est précisément le genre de situation où le PULL est excellent.

3) Je supprimerais même ta phase C

L'option :

Boxmail prépare create_expense, puis un agent IA l'exécute localement

me semble être une mauvaise abstraction.

Tu introduis :

Boxmail
  ↓
commande
  ↓
queue
  ↓
agent
  ↓
Fiscal Manager

pour faire quelque chose qui pourrait être :

Fiscal Manager
  ↓
GET candidats
  ↓
import

L'IA peut proposer les données :

Société probable : LB2I
Fournisseur : OVH
Date : 03/08/2026
TTC : 127,20 €
TVA : 21,20 €
Confiance : 96 %

mais elle ne devrait pas être le transport ni le moteur d'intégration.

Un protocole applicatif déterministe doit relier les applications.

4) Tu n'as pas tort concernant le transfert automatique

Pour transférer automatiquement à la comptable, je suis d'accord avec ton rejet.

Pas uniquement à cause des faux positifs.

Le vrai problème est que :

mail reçu
→ mail transféré

ne crée quasiment aucune information exploitable.

Tu ne sais plus correctement :

si le document a été traité ;

à quelle société il appartient ;

à quelle dépense il correspond ;

s'il a déjà été transmis ;

si le remboursement a été demandé ;

s'il manque un justificatif ;

si l'opération bancaire a été rapprochée.

Tu transformes un problème de workflow en problème de boîte mail.

C'est KISS techniquement, mais pas KISS métier.

En revanche, je ne rejetterais pas complètement l'idée de transfert automatique.

Une version raisonnable serait :

MAIL
 ↓
copie automatique
 ↓
boîte "documents-comptables@..."

que tu contrôles, et non celle de la comptable.

Cela peut servir de parachute très simple.

Mais puisque Boxmail possède déjà les sept boîtes IMAP, je ne vois pas vraiment l'intérêt : un dossier virtuel ou un état ACCOUNTING_CANDIDATE dans Boxmail fait mieux.

5) Le vrai risque numéro 1 : les doublons

Beaucoup plus important que je ne le vois dans ton analyse.

Une même facture peut arriver :

mail original
+ relance fournisseur
+ forward
+ copie sur une autre boîte
+ téléchargement manuel
+ import bancaire

Message-ID ne suffit absolument pas.

Je commencerais avec deux niveaux.

Identité physique :

SHA-256 du fichier

permet :

exactement le même PDF = même document

Puis identité comptable probable :

company
+ supplier
+ invoiceNumber

et éventuellement :

supplier
+ invoiceDate
+ amountGross

comme heuristique.

Attention à ne pas rendre le second critère bloquant : certains fournisseurs rééditent les PDF et certains numéros de facture sont mal extraits.

6) Mauvaise société : risque majeur

Avec cinq structures juridiques, c'est probablement le risque fonctionnel principal.

Je ne laisserais jamais l'IA décider uniquement à partir du fournisseur.

Exemple :

Amazon
Adobe
OVH
Orange
SNCF
Booking

peuvent facturer plusieurs sociétés.

Je construirais des preuves de classement par priorité :

1. raison sociale inscrite sur la facture
2. SIREN / SIRET / numéro TVA
3. adresse de facturation
4. compte email destinataire
5. moyen de paiement connu
6. habitudes fournisseur
7. IA

L'IA doit arriver assez bas dans cette hiérarchie.

Et surtout :

confidence < seuil
→ société inconnue

plutôt que :

confidence < seuil
→ meilleure supposition

C'est une différence fondamentale.

7) TVA : je serais beaucoup plus conservateur

Je ne ferais jamais :

PDF → IA → TVA → comptabilité

sans validation.

Les factures européennes vont rapidement te donner :

HT + TVA ;

TTC avec TVA incluse ;

plusieurs taux ;

TVA intracommunautaire ;

autoliquidation ;

TVA non récupérable ;

factures étrangères ;

tickets sans TVA exploitable ;

avoirs ;

arrondis.

L'extraction automatique est utile pour préremplir :

HT       100,00 €
TVA 20 % 20,00 €
TTC      120,00 €

mais ce sont des données proposées.

Je séparerais même :

extractedVat

de :

validatedVat

si Fiscal Manager commence un jour à produire de la donnée comptable réellement utilisée.

8) Les pièces jointes créent une vraie frontière de sécurité

Ton Boxmail est sur un VPS public.

Il va désormais accumuler :

factures ;

noms ;

adresses ;

coordonnées bancaires ;

éventuellement IBAN ;

données personnelles ;

documents financiers.

Je durcirais donc beaucoup le PULL.

Au minimum :

HTTPS
token dédié en lecture seule
rotation du token
scope accounting:read
rate limit
audit des téléchargements
pas d'accès générique aux mails

Et surtout pas :

Bearer token permettant d'appeler toute l'API Boxmail

Je préfère :

FiscalManagerToken
permissions:
  documents:list
  documents:read

et rien d'autre.

Si tu veux pousser la séparation encore plus loin, le VPS et le PC peuvent communiquer via WireGuard/Tailscale et l'endpoint comptable ne pas être publiquement accessible.

Mais je ne rendrais pas cela obligatoire en V1.

9) PJ malveillantes : petit risque statistique, gros impact potentiel

Les PDF et Office reçus par mail sont une entrée non fiable.

Donc :

ne jamais exécuter
ne jamais convertir via shell de façon naïve
ne jamais faire confiance au MIME déclaré

Validation minimale :

taille maximum
magic bytes
extension réelle
SHA-256
type autorisé
PDF / JPG / PNG

Une analyse antivirus type ClamAV est raisonnable si tu commences à automatiser leur traitement.

Je serais particulièrement prudent si un LLM ou une bibliothèque de conversion transforme les documents.

10) RGPD : le vrai sujet est probablement l'IA

Stocker une facture pour la gestion d'une société n'est pas en soi le problème le plus compliqué.

Ce que je surveillerais surtout est :

facture complète
→ fournisseur IA externe

Une facture peut contenir :

nom personnel ;

adresse ;

téléphone ;

email ;

IBAN ;

identité d'un salarié ;

client ;

informations commerciales.

Donc il faut savoir ce qui quitte ton infrastructure.

L'approche la plus saine serait :

extraction locale quand possible
      ↓
texte minimal nécessaire
      ↓
IA

plutôt que d'expédier systématiquement tous les PDF.

Ce n'est pas indispensable pour une V1, mais il faut que l'architecture permette de le faire.

11) Ton rapprochement bancaire inverse est plus qu'un « bonus »

Je le monterais presque au même niveau que l'ingestion email.

Parce que ton objectif réel est :

aucune dépense professionnelle ne doit disparaître.

Il existe deux trous symétriques :

FACTURE reçue
mais aucune dépense connue

et :

DÉPENSE bancaire
mais aucune facture connue

Tu veux donc une sorte de matrice :

Banque	Document	État
✓	✓	OK
✓	✗	Justificatif manquant
✗	✓	Document à qualifier
✗	✗	invisible au système

C'est beaucoup plus puissant que la simple chasse aux factures dans les emails.

Et dans ton cas particulier il faut ajouter :

carte personnelle

comme source de paiement.

Sinon ton rapprochement bancaire société ne découvrira précisément pas les frais personnels à rembourser.

12) Je changerais légèrement tes phases

Ta séquence actuelle :

détection → pull → envoi comptable

Je proposerais plutôt :

V1 — Zéro facture perdue

Boxmail :

détecter
dédoublonner
classifier société probable
conserver la PJ
état "à traiter"

Interface :

23 pièces comptables à traiter

C'est déjà énormément de valeur.

V2 — Fiscal Manager récupère les pièces

PULL.

Mais uniquement :

AccountingDocument

Pas encore de création automatique de frais.

Fiscal Manager affiche :

────────────────────────────────────
OVHcloud — 122,40 € — 02/08/2026
Société probable : LB2I   97 %

[Associer à un frais]
[Créer un frais]
[Payé par la société]
[Ignorer]
────────────────────────────────────
V3 — Rapprochement intelligent

Croiser :

document
+
frais déclaré
+
opération bancaire
+
carte personnelle

Et générer des anomalies :

justificatif manquant
paiement sans frais
facture sans paiement
doublon probable
société incertaine
V4 — Comptable

Seulement ensuite :

documents validés
      ↓
batch mensuel
      ↓
manifest
      ↓
SMTP Cerfrance

Avec quelque chose comme :

Lot août 2026 — LB2I

27 documents
4 287,30 € TTC
5 frais personnels
22 dépenses société
0 document non validé

Le lot doit être idempotent :

batch_id
sent_at
document_ids
attachment_hashes

Ainsi un clic accidentel ne renvoie pas trente factures une deuxième fois.

Mon choix architectural

Entre tes quatre options :

Option	Avis
A transfert comptable automatique	❌
B PULL Fiscal Manager	✅ clairement
C commandes exécutées par agent	❌ complexité inutile
D push vers local	❌ inutile à résoudre

Mais je modifierais B en :

Boxmail produit des AccountingDocumentCandidate. Fiscal Manager les importe. Fiscal Manager seul décide ensuite si cela devient un Expense.

C'est, à mon sens, la frontière la plus propre.

Et je garderais une règle architecturale extrêmement simple :

Boxmail sait qu'un document existe. Fiscal Manager sait ce qu'il signifie financièrement.

Cette séparation te protège étonnamment bien contre la majorité des dérives futures.

Enfin, je ne construirais ni broker, ni RabbitMQ, ni webhook, ni agent permanent, ni synchronisation bidirectionnelle pour ce besoin. Un curseur d'import, une clé d'idempotence et deux endpoints HTTP suffisent probablement pour très longtemps.