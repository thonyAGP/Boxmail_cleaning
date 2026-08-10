# Connecteur Fiscal-Manager — proposition de design (07/08/2026)

> Statut : **PROPOSITION, non validée par Anthony**. Conçue en session,
> contrastée avec ChatGPT (2 tours contradictoires via navigateur piloté,
> compte Plus d'Anthony), puis CORRIGÉE par Anthony en direct : Fiscal-Manager
> n'est PAS local-only, il est **déployé sur Vercel** (le CLAUDE.md du repo
> Fiscal-Manager est périmé — à mettre à jour lors d'une session là-bas).
> Rien n'est implémenté.

## Le problème

Anthony paye souvent des frais pro avec sa **carte personnelle** puis se fait
rembourser. Risque réel : une facture/un reçu arrive par mail dans l'une des
7 boîtes, n'est jamais transmis à la comptable, le frais n'est jamais
remboursé ni déduit. Objectif : **zéro pièce comptable perdue** + faciliter
l'envoi à la comptable (Cerfrance, canal SMTP déjà présent dans
Fiscal-Manager).

## Principe retenu (après débat)

**« Boxmail détecte, Fiscal-Manager qualifie. »** Pont strictement
unidirectionnel, en PULL : Fiscal-Manager (local, PC) vient chercher chez
Boxmail (VPS public) les « candidats pièces comptables » ; Boxmail ne sait
jamais ce qu'ils deviennent.

```
Outlook/Hotmail ──IMAP──▶ Boxmail (VPS Oracle)   Fiscal-Manager (Vercel)
                          détecte, mémorise      télécharge la PJ à la demande,
                          MÉTADONNÉES seulement  SHA-256, qualifie, crée le
                          (jamais les PDF)  ◀──2 GET── frais si pertinent
```

Fiscal-Manager réel (repo exploré 07/08, bien plus riche que son CLAUDE.md) :
Vercel + NextAuth (middleware protège tout — le « P0 auth » soulevé par
ChatGPT est en fait déjà réglé), 8 crons Vercel, LLM serveur Gemini (mémos
Telegram voix/photo/texte, embeddings), Gmail API, Telegram bot. Le canal
« ticket papier → photo Telegram » existe déjà ; le connecteur ajoute le canal
« facture email → file unique ». ⚠️ Sur Vercel le filesystem est éphémère :
l'import devra stocker le PDF dans la colonne `invoicePdf Bytes` (existe déjà
dans le schéma) ou un blob store, PAS dans `data/invoices/`.

Options écartées :
- **Transfert SMTP automatique vers la comptable** : rejeté (faux positifs
  chez un humain externe, casse le garde-fou « jamais d'envoi auto », et un
  mail transféré ne crée AUCUN état exploitable — on ne sait plus ce qui a
  été traité/remboursé/rapproché). La version saine = lot mensuel validé (V2).
- **File de commandes type Rentila phase 2** : complexité inutile ici — un
  protocole HTTP déterministe suffit, l'IA ne doit être ni le transport ni le
  moteur d'intégration.
- **Push Boxmail→Fiscal-Manager** : possible depuis la correction d'Anthony
  (URL Vercel publique), mais NON retenu : le PULL reste plus simple (pas
  d'outbox/retry côté Boxmail, rattrapage naturel après indisponibilité) et
  s'automatise en V2 par un Vercel Cron — infra déjà en place.

## Décisions issues du débat ChatGPT (2 tours)

1. **Objet séparé** : `AccountingCandidate` (Boxmail) ≠ `AccountingDocument`
   (Fiscal-Manager) ≠ `Expense`. Une pièce reçue n'est PAS forcément un frais
   (facture payée par la société, avoir, déjà transmise, autre société,
   justificatif sans facture…). Fiscal-Manager seul décide.
2. **Société par boîte = règle n°1** (j'ai gagné ce point) : 6 boîtes sur 7
   sont mono-société → `companyCandidate` déterministe avec
   `companyBasis=MAILBOX_DEFAULT`, jamais « verified » ; bouton
   [Changer de société] côté Fiscal-Manager. Boîte perso `thony56_gtr` →
   `companyCandidate=null` (c'est LE cas à qualifier à la main).
3. **Aucun stockage de PDF sur le VPS** (concédé par ChatGPT) : l'IMAP est le
   stockage durable, Boxmail streame la pièce à la demande. MAIS identité ≠
   locator (point gagné par ChatGPT) : `candidateId` ULID stable + locator
   IMAP (folder, uidValidity, uid, mimePart) actualisable, avec repli
   recherche par Message-ID puis filename+taille.
4. **Invariant nouveau** : un mail marqué candidat comptable ne peut JAMAIS
   être supprimé automatiquement par Boxmail (déplacement oui, expunge non).
   S'il disparaît quand même : le candidat reste en base, état
   `SOURCE_MISSING`, et l'API répond **410 Gone** (pas 404).
5. **Zéro extraction en V1/V2** (j'ai gagné) : pas d'OCR, pas de montants,
   pas de TVA. On automatise **la mémoire, pas la frappe** : taper 122,40 €
   prend 3 s ; se souvenir d'une facture OVH d'il y a 18 jours, c'est ça le
   problème. Expéditeur/date mail = indices UI (`senderName`, `receivedAt`),
   surtout PAS des champs comptables `supplier`/`invoiceDate`.
6. **Pas d'import des relevés de carte perso** (ChatGPT a retiré sa
   proposition) : périmètre énorme pour un trou non mesuré. Risque résiduel
   assumé : achat carte perso SANS facture par mail reste invisible. À
   re-mesurer dans 6 mois.
7. **Doublons** : idempotence par contrainte unique
   `(sourceSystem, sourceCandidateId, sourceAttachmentId)` côté
   Fiscal-Manager + SHA-256 calculé à l'import (signal « document identique
   probable », non bloquant au départ).
8. **Sécurité** : token dédié **lecture seule** scope pièces comptables
   (PAS le bearer générique de l'API Boxmail), HTTPS, rate-limit, audit des
   téléchargements. Tailscale/WireGuard : pas obligatoire en V1.

## Contrat d'API (2 endpoints, unidirectionnel)

```
GET /api/v1/accounting-candidates?cursor=<opaque>&limit=100
  → { items: [ { candidateId, detectedAt, mailboxId,
        companyCandidate, companyBasis,
        message: { receivedAt, fromName, fromAddress, subject },
        attachments: [ { attachmentId, filename, contentType, sizeBytes } ] } ],
      nextCursor, hasMore }
  Curseur = seq AUTOINCREMENT SQLite (jamais date ni UID).

GET /api/v1/accounting-candidates/{candidateId}/attachments/{attachmentId}
  → 200 stream du PDF (résolution du locator IMAP) | 410 Gone si source disparue
```

Aucun POST/ack/webhook : Fiscal-Manager garde son curseur localement.

## Phases

- **V1 — tranche verticale « zéro facture perdue »** (quelques jours) :
  détection existante (intent `invoice` + verdicts IA) → table
  `accounting_candidate` (métadonnées) → 2 endpoints GET → écran « Pièces
  reçues » dans Fiscal-Manager (bouton Actualiser = pull manuel, actions :
  Créer un frais / Associer à un frais / Payé par la société / Ignorer) →
  PDF stocké en DB (`invoicePdf Bytes`). Critère de succès : un PDF arrivé
  dans n'importe laquelle des 7 boîtes finit visible dans UNE file unique.
- **V2 — pull automatique + envoi comptable** : Vercel Cron quotidien pour le
  pull (pattern CRON_SECRET existant) ; lot mensuel idempotent (batch_id,
  manifest, document_ids) → canal SMTP Cerfrance existant. Semi-automatique :
  liste validée par Anthony, jamais d'envoi spontané.
- **V3 — rapprochement intelligent** : croiser documents × frais × banque
  société (M5) → anomalies « justificatif manquant », « paiement sans
  frais », « doublon probable ». (Relevés perso : NON, cf. décision 6.)
  Extraction éventuelle des montants à l'import = réutiliser le Gemini déjà
  présent dans Fiscal-Manager, jamais un moteur IA côté Boxmail.
- **Hors scope durable** : OCR/extraction TVA en V1/V2 (réévaluer seulement
  si le besoin est prouvé), agent IA comme transport, synchro
  bidirectionnelle, import des relevés de carte perso.

## À valider par Anthony avant d'implémenter

1. Le principe PULL + écran « Pièces reçues » dans Fiscal-Manager (plutôt
   qu'un transfert auto vers la comptable).
2. La liste boîte→société par défaut (Brimmo→BRIMMO, Econom→ECONOM,
   Colocar→COLOCAR, Altoen→ALTOEN, Au-marais→?, Location_Brest→BRIMMO ?,
   thony56_gtr→aucune).
3. Côté Fiscal-Manager : OK pour ajouter l'écran + le stockage PDF en DB
   (repo séparé, session Claude dédiée dans ce repo ; en profiter pour
   remettre à jour son CLAUDE.md périmé).
4. V1 d'abord, envoi Cerfrance en V2.

## Archives du débat

Transcriptions complètes : `docs/archives-chatgpt/fiscal-tour{1,2,3}*` —
tour 1 = critique initiale, tour 2 = arbitrages sur mes 4 contestations,
tour 3 = delta après la correction Vercel d'Anthony.
