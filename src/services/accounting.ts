/**
 * Connecteur Fiscal-Manager — V1 « zéro facture perdue » (07/08).
 * Design : docs/CONNECTEUR-FISCAL-MANAGER.md (débattu avec ChatGPT, corrigé
 * par Anthony). Principe : « Boxmail détecte, Fiscal-Manager qualifie ».
 *
 * Ce module DÉTECTE les mails « pièce comptable » et les mémorise en
 * MÉTADONNÉES seulement — jamais le PDF : l'IMAP reste le stockage durable, la
 * pièce est streamée à la demande par l'API (server/accounting.ts).
 * Fiscal-Manager tire la liste par curseur (seq monotone) et décide seul de ce
 * que chaque pièce devient.
 *
 * BASCULÉ SUR LE SOCLE au lot 4i (12/08) — la contre-revue l'a placé AVANT le
 * nettoyage : « une mauvaise extraction comptable est une erreur métier
 * réelle, même sans suppression ». Deux régimes, comme partout depuis 4c :
 *  - quand le VERDICT sémantique existe, LUI SEUL décide : un mail est
 *    candidat parce que l'analyse déclare un DOCUMENT comptable (facture,
 *    reçu), plus jamais parce qu'un mot du sujet a fait dire « invoice » à une
 *    regex — et les champs pré-remplis (fournisseur, montant, référence)
 *    viennent de `getAccountingFacts()` ;
 *  - sans verdict, le critère historique (intention facture + pièce jointe)
 *    reste, en REPLI, et l'avoue dans ses raisons.
 *
 * LE POINT QUI COMMANDE TOUT : `sent_by` n'est pas `issued_by`. Le scan d'une
 * facture d'opérateur transmis par sa mère est une pièce comptable de
 * l'OPÉRATEUR, pas d'elle — le fournisseur envoyé au logiciel comptable est
 * l'ÉMETTEUR lu par l'analyse, jamais l'expéditeur du mail.
 *
 * PROTECTION — ce paragraphe a menti jusqu'au 27/08. Il affirmait qu'« un
 * candidat est par définition un mail À PIÈCE JOINTE », donc que la clause
 * `m.hasAttachments = 0` de retention.ts suffisait, « aucune clause
 * supplémentaire ». L'hypothèse tenait tant que la détection exigeait une pièce
 * jointe. Elle tombe avec les JUSTIFICATIFS PORTÉS PAR LE CORPS (billets
 * d'avion, § plus bas) : ces mails cochent `hasAttachments = 0` ET
 * `intent NOT IN ('invoice','document')` — les deux conditions de suppression
 * en même temps. Et comme Boxmail ne stocke aucun PDF, supprimer le mail
 * détruit le justificatif pour de bon.
 * La protection est donc explicite depuis : une clause de retention.ts protège
 * tout mail portant un `AccountingCandidate` ACTIF, avec ou sans pièce jointe.
 * TOUTE extension de la détection doit rester couverte par CETTE clause.
 */

import { randomUUID } from 'node:crypto';
import { db, ensureDbReady } from '../db/client.js';
import { logger } from '../logger.js';
import { documentHints } from './attachment-text.js';
import { imapService } from './imap.js';
import { recordOperation } from './oplog.js';
import type { AccountRecord } from './accounts.js';
import {
  getAccountingFacts,
  resolveMailSemanticState,
  type EtatSemantique,
} from './semantique.js';
import {
  justificatifDansLeCorps,
  nomDeFichier,
  type JustificatifCorps,
} from './justificatif-corps.js';
import { mailEnPdf } from './pdf.js';

/**
 * Boîte → société par défaut. PROPOSITION, jamais « vérifiée » : Anthony a
 * confirmé (07/08) que de vieux comptes de commande internet et des
 * fournisseurs qui l'ont en client pour PLUSIEURS sociétés peuvent envoyer
 * une facture sur la mauvaise boîte — l'écran « Pièces reçues » de
 * Fiscal-Manager pré-remplit cette société mais la laisse modifiable.
 * Boîtes absentes de la carte (perso thony56_gtr, Au-marais non tranchée) :
 * companyCandidate=null, companyBasis=NONE — à qualifier à la main.
 */
const COMPANY_BY_MAILBOX: Record<string, string> = {
  brimmo: 'BRIMMO',
  econom: 'ECONOM',
  colocar: 'COLOCAR',
  altoen: 'ALTOEN',
  // Gestion locative Rentila du 46 rue de la République (Brest) → SARL BRIMMO.
  location_brest: 'BRIMMO',
};

export function companyForMailbox(slug: string): { company: string | null; basis: string } {
  const key = slug.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  const company = COMPANY_BY_MAILBOX[key] ?? null;
  return { company, basis: company ? 'MAILBOX_DEFAULT' : 'NONE' };
}

// Types de pièces exploitables par Fiscal-Manager (mêmes règles que son
// upload : PDF/JPG/PNG/WEBP). Les images MINUSCULES ou « en ligne » (logos de
// signature, pixels) sont écartées : une vraie photo de ticket pèse plus de
// 30 Ko et n'est pas référencée par le HTML.
const ALLOWED_TYPES = /^(application\/pdf|image\/(jpe?g|png|webp))$/i;
const MIN_IMAGE_BYTES = 30_000;

interface CandidateAttachment {
  attachmentId: string;
  /** Position dans listAttachmentParts — même ordre que downloadAttachment. */
  index: number;
  filename: string;
  contentType: string;
  sizeBytes: number;
}

function usableAttachments(
  parts: { filename: string; contentType: string; sizeBytes: number; contentId: string | null }[],
): CandidateAttachment[] {
  const out: CandidateAttachment[] = [];
  parts.forEach((p, index) => {
    if (!ALLOWED_TYPES.test(p.contentType)) return;
    const isImage = p.contentType.toLowerCase().startsWith('image/');
    if (isImage && (p.contentId || p.sizeBytes < MIN_IMAGE_BYTES)) return;
    out.push({
      attachmentId: `a${index + 1}`,
      index,
      filename: p.filename,
      contentType: p.contentType,
      sizeBytes: p.sizeBytes,
    });
  });
  return out;
}

/**
 * L'IDENTIFIANT DE LA PIÈCE SYNTHÉTIQUE — le corps rendu en PDF.
 *
 * ⚠️ IL DOIT ÊTRE STABLE ET DÉTERMINISTE. Fiscal-Manager porte une contrainte
 * unique `(sourceSystem, sourceCandidateId, sourceAttachmentId)` : un
 * identifiant qui changerait d'un passage à l'autre créerait un DOUBLON à
 * chaque « Actualiser ». D'où une constante, et non un identifiant calculé.
 * Il ne peut pas entrer en collision avec les pièces réelles, numérotées
 * `a1`, `a2`, … par `usableAttachments`.
 */
export const PIECE_CORPS = 'body';

/**
 * Les mots du SUJET qui rendent un mail sans pièce jointe digne d'être lu.
 * Présélection SQL grossière et volontairement courte : elle borne le coût
 * (une descente IMAP par mail retenu), la vraie décision revient à
 * `justificatifDansLeCorps`. Cherchés dans `searchShort` — la copie dépliée
 * sans accents et en minuscules, seule colonne où un LIKE est fiable sous
 * SQLite (`contains` y est sensible à la casse).
 */
const SUJETS_JUSTIFICATIF_CORPS = [
  'reservation', 'confirmation', 'commande', 'billet', 'e-ticket', 'booking',
];

/**
 * Types de documents du verdict qui font une PIÈCE COMPTABLE. Volontairement
 * étroit : un devis, un relevé ou un contrat ne sont pas des pièces de frais —
 * mieux vaut qu'Anthony transmette à la main (bouton « Envoyer à la compta »)
 * que d'inonder Fiscal-Manager de faux candidats.
 */
const KINDS_PIECE_COMPTABLE = ['invoice', 'receipt'];

/**
 * Ce que le VERDICT sémantique dit de la pièce comptable d'un mail, ou null
 * quand il ne dit rien (pas de verdict, ou aucun document comptable déclaré —
 * le repli `documentHints` reprend alors la main). Fonction PURE, éprouvée par
 * le banc avec des états résolus en mémoire.
 *
 * `supplier` est l'ÉMETTEUR du document (`issuer`, à défaut la mention
 * `issued_by`) — JAMAIS l'expéditeur du mail : c'est le cas Sosh/maman, celui
 * qui a déclenché la refonte.
 */
export interface PieceComptableVerdict {
  supplier: string | null;
  amountTtc: number | null;
  invoiceNumber: string | null;
  /** Qui a TRANSMIS le mail (mention sent_by) — informatif, jamais le fournisseur. */
  transmisPar: string | null;
  /** Justifications en français, affichables telles quelles. */
  reasons: string[];
}

export function pieceComptableDuVerdict(
  etat: EtatSemantique | null | undefined,
): PieceComptableVerdict | null {
  if (!etat?.analyse.verdictPresent) return null;
  const faits = getAccountingFacts(etat);
  const doc = faits.documents.find((d) => KINDS_PIECE_COMPTABLE.includes(d.kind)) ?? null;
  if (!doc) return null;
  const supplier = doc.emetteur ?? faits.emisPar[0]?.nameRaw ?? null;
  const transmisPar = faits.envoyePar[0]?.nameRaw ?? null;
  const reasons: string[] = [];
  if (supplier) {
    reasons.push(
      `fournisseur « ${supplier} » : l'émetteur du document lu par l'analyse — jamais l'expéditeur du mail`,
    );
  }
  if (transmisPar && supplier && transmisPar !== supplier) {
    reasons.push(`transmis par « ${transmisPar} » — la pièce reste celle de « ${supplier} »`);
  }
  if (doc.montant !== null) {
    reasons.push(
      `montant ${doc.montant.toFixed(2).replace('.', ',')} ${doc.devise ?? 'EUR'} lu par l'analyse`,
    );
  }
  if (doc.reference) reasons.push(`référence « ${doc.reference} » lue par l'analyse`);
  if (reasons.length === 0) {
    reasons.push(
      "l'analyse déclare une pièce comptable, sans avoir pu lire l'émetteur ni le montant",
    );
  }
  return {
    supplier,
    amountTtc: doc.montant,
    invoiceNumber: doc.reference,
    transmisPar,
    reasons,
  };
}

export interface DetectReport {
  scanned: number;
  created: number;
  skippedNoAttachment: number;
  sourceMissingMarked: number;
  /** Candidats créés parce que le VERDICT déclare une pièce comptable. */
  viaVerdict: number;
  /** Candidats créés par le critère historique (pas encore de verdict). */
  viaRepli: number;
  /** Candidats dont le JUSTIFICATIF EST LE CORPS (billets d'avion). */
  viaCorps: number;
  /** Corps qu'il a fallu descendre en IMAP faute de texte indexé. */
  corpsLusEnImap: number;
}

/**
 * Le mail lui-même est-il le justificatif ? Renvoie de quoi créer le candidat,
 * ou null. Coût : ZÉRO descente IMAP quand le texte indexé suffit à conclure
 * NON — c'est le cas de l'immense majorité des mails présélectionnés.
 *
 * Le PDF est rendu ICI pour connaître sa taille exacte : Fiscal-Manager
 * annonce `sizeBytes` à ses utilisateurs, refuse une pièce vide et plafonne à
 * 10 Mo. Il n'est pas conservé — le rendu est déterministe, la route de
 * téléchargement le refabrique à l'identique depuis le même corps.
 */
async function candidatDepuisLeCorps(
  rec: AccountRecord,
  m: {
    id: number;
    uid: number;
    subject: string | null;
    fromName: string | null;
    fromEmail: string | null;
    date: Date | null;
    analysisInput: string | null;
    snippet: string | null;
    folder: { path: string };
  },
  report: DetectReport,
): Promise<{ piece: CandidateAttachment; doc: JustificatifCorps } | null> {
  const indexe = (m.analysisInput ?? m.snippet ?? '').trim();
  let texte = indexe;

  // Sans texte indexé, on ne peut RIEN juger — et conclure « non » serait un
  // faux négatif silencieux, exactement le piège du § 53 (« un mail sans
  // extrait est invisible, pas en attente »). On descend donc le corps.
  if (texte.length < 40) {
    try {
      const corps = await imapService.readEmail(rec, m.folder.path, m.uid);
      texte = (corps.text || '').trim();
      report.corpsLusEnImap++;
    } catch {
      return null; // repris au prochain passage
    }
  }

  const doc = justificatifDansLeCorps({
    subject: m.subject,
    fromName: m.fromName,
    fromEmail: m.fromEmail,
    texte,
  });
  if (!doc) return null;

  // Le PDF se rend sur le corps COMPLET, jamais sur l'extrait tronqué : un
  // justificatif amputé n'est pas un justificatif.
  let complet = texte;
  try {
    const corps = await imapService.readEmail(rec, m.folder.path, m.uid);
    if ((corps.text || '').trim().length > complet.length) complet = corps.text.trim();
  } catch {
    return null;
  }

  const pdf = mailEnPdf({
    subject: m.subject ?? '(sans objet)',
    fromName: m.fromName,
    fromEmail: m.fromEmail,
    date: m.date,
    texte: complet,
    entetes: [
      `Fournisseur : ${doc.supplier}`,
      `Montant payé : ${doc.amountTtc.toFixed(2).replace('.', ',')} ${doc.devise}`,
      ...(doc.reference ? [`Référence : ${doc.reference}`] : []),
    ],
  });

  return {
    piece: {
      attachmentId: PIECE_CORPS,
      index: -1, // pas une partie MIME : le corps
      filename: nomDeFichier(doc, m.id),
      contentType: 'application/pdf',
      sizeBytes: pdf.length,
    },
    doc,
  };
}

/**
 * Détecte les nouveaux candidats d'un compte. `indexedSince` (post-sync) :
 * seuls les mails indexés pendant cette sync ; `sinceDays` (rattrapage) :
 * fenêtre sur la date du mail. Chaque candidat coûte UNE lecture IMAP de
 * structure (bodystructure, aucun téléchargement) — plafonnée par `limit`.
 */
export async function detectAccountingCandidates(
  rec: AccountRecord,
  opts: { indexedSince?: Date; sinceDays?: number; limit?: number } = {},
): Promise<DetectReport> {
  await ensureDbReady();
  const report: DetectReport = {
    scanned: 0,
    created: 0,
    skippedNoAttachment: 0,
    sourceMissingMarked: 0,
    viaVerdict: 0,
    viaRepli: 0,
    viaCorps: 0,
    corpsLusEnImap: 0,
  };
  const limit = Math.min(opts.limit ?? 300, 1000);

  const messages = await db.message.findMany({
    where: {
      accountSlug: rec.account,
      isDeleted: false,
      isOutbound: false,
      // DEUX RÉGIMES (lot 4i). Le discriminant est l'existence d'une ligne
      // MailVerdict — JAMAIS la colonne aiVerdictAt : elle est posée par
      // l'ancienne analyse plate sur 17 207 mails sans verdict sémantique, qui
      // tomberaient sinon ENTRE les deux chemins (régression mesurée le 12/08).
      //  1. verdict présent : c'est LUI qui décide — candidat si l'analyse
      //     déclare un document comptable, même quand l'ancienne étiquette
      //     disait autre chose qu'« invoice » ;
      //  2. pas de verdict : le critère historique (intention facture), en
      //     repli, en attendant l'analyse.
      //
      //  ⚠️ TROISIÈME VOIE (27/08) : le JUSTIFICATIF PORTÉ PAR LE CORPS. Les
      //     mails de réservation de vol ne portent aucune pièce jointe, et le
      //     verdict les analyse comme « confirmation » ou « voyage », jamais
      //     comme « facture » : ils échouaient aux DEUX voies ci-dessus et
      //     n'atteignaient jamais Fiscal-Manager. La présélection est ici un
      //     simple mot du sujet ; c'est `justificatifDansLeCorps` qui tranche.
      OR: [
        {
          AND: [
            { hasAttachments: true },
            {
              OR: [
                { verdict: { is: { documents: { some: { kind: { in: KINDS_PIECE_COMPTABLE } } } } } },
                { AND: [{ verdict: { is: null } }, { intent: 'invoice' }] },
              ],
            },
          ],
        },
        {
          AND: [
            { hasAttachments: false },
            { OR: SUJETS_JUSTIFICATIF_CORPS.map((mot) => ({ searchShort: { contains: mot } })) },
          ],
        },
      ],
      folder: { role: { notIn: ['trash', 'spam', 'sent', 'drafts'] } },
      ...(opts.indexedSince ? { createdAt: { gte: opts.indexedSince } } : {}),
      ...(opts.sinceDays
        ? { date: { gte: new Date(Date.now() - opts.sinceDays * 86_400_000) } }
        : {}),
    },
    orderBy: { date: 'desc' },
    take: limit,
    select: {
      id: true,
      uid: true,
      internetMessageId: true,
      subject: true,
      fromName: true,
      fromEmail: true,
      date: true,
      hasAttachments: true,
      // Le texte indexé sert au PRÉ-jugement, avant toute descente IMAP.
      analysisInput: true,
      snippet: true,
      folder: { select: { path: true } },
    },
  });
  if (messages.length === 0) {
    report.sourceMissingMarked = await sweepSourceMissing(rec.account);
    return report;
  }

  // Déjà candidats (par mail, et par Message-ID pour les copies inter-dossiers).
  const existing = await db.accountingCandidate.findMany({
    where: { accountSlug: rec.account },
    select: { messageId: true, internetMessageId: true },
  });
  const byMessageId = new Set(existing.map((c) => c.messageId));
  const byMsgIdHeader = new Set(
    existing.map((c) => c.internetMessageId).filter((v): v is string => !!v),
  );

  const { company, basis } = companyForMailbox(rec.account);

  // L'état sémantique du lot, résolu en une passe (14 requêtes constantes,
  // jamais mail par mail) : la présélection SQL ci-dessus est grossière, c'est
  // `getAccountingFacts` (via pieceComptableDuVerdict) qui REVALIDE au moment
  // d'agir — un verdict peut avoir changé entre-temps.
  const etats = await resolveMailSemanticState(messages.map((m) => m.id));

  for (const m of messages) {
    if (byMessageId.has(m.id)) continue;
    if (m.internetMessageId && byMsgIdHeader.has(m.internetMessageId)) continue;
    const etat = etats.get(m.id);
    const viaVerdict = !!etat?.analyse.verdictPresent;

    // ── VOIE DU CORPS ──────────────────────────────────────────────────
    // Elle passe AVANT le portillon du verdict, et c'est tout l'enjeu : une
    // confirmation de réservation EST analysée — le verdict existe — mais il
    // la déclare « confirmation » ou « voyage », jamais « facture ». La
    // laisser franchir le portillon ci-dessous reviendrait à l'écarter pour
    // toujours, ce qui est précisément ce qui se passait.
    if (!m.hasAttachments) {
      const issu = await candidatDepuisLeCorps(rec, m, report);
      if (!issu) continue;
      report.scanned++;
      await db.accountingCandidate.create({
        data: {
          candidateId: randomUUID(),
          accountSlug: rec.account,
          messageId: m.id,
          internetMessageId: m.internetMessageId,
          companyCandidate: company,
          companyBasis: basis,
          status: 'ACTIVE',
          receivedAt: m.date,
          fromName: m.fromName,
          fromEmail: m.fromEmail,
          subject: m.subject,
          attachmentsJson: JSON.stringify([issu.piece]),
          bodyDocJson: JSON.stringify(issu.doc),
        },
      });
      if (m.internetMessageId) byMsgIdHeader.add(m.internetMessageId);
      report.created++;
      report.viaCorps++;
      continue;
    }

    // Verdict présent mais plus aucun document comptable déclaré : pas un
    // candidat — et pas de repli non plus, l'analyse a parlé.
    if (viaVerdict && !pieceComptableDuVerdict(etat)) continue;
    report.scanned++;
    let parts;
    try {
      parts = await imapService.listAttachments(rec, m.folder.path, m.uid);
    } catch (err) {
      logger.warn('candidat comptable : structure IMAP illisible, mail sauté', {
        account: rec.account,
        uid: m.uid,
        error: (err as Error).message,
      });
      continue; // retenté au prochain passage
    }
    const usable = usableAttachments(parts);
    // Négatif mémorisé (status SKIPPED) : sans lui, chaque passe relirait la
    // structure des mêmes mails « facture » sans pièce exploitable.
    const status = usable.length > 0 ? 'ACTIVE' : 'SKIPPED';
    await db.accountingCandidate.create({
      data: {
        candidateId: randomUUID(),
        accountSlug: rec.account,
        messageId: m.id,
        internetMessageId: m.internetMessageId,
        companyCandidate: company,
        companyBasis: basis,
        status,
        receivedAt: m.date,
        fromName: m.fromName,
        fromEmail: m.fromEmail,
        subject: m.subject,
        attachmentsJson: JSON.stringify(usable),
      },
    });
    if (m.internetMessageId) byMsgIdHeader.add(m.internetMessageId);
    if (status === 'ACTIVE') {
      report.created++;
      if (viaVerdict) report.viaVerdict++;
      else report.viaRepli++;
    } else {
      report.skippedNoAttachment++;
    }
  }

  report.sourceMissingMarked = await sweepSourceMissing(rec.account);

  if (report.created > 0) {
    await recordOperation({
      account: rec.account,
      tool: 'accounting_detect',
      params: { scanned: report.scanned },
      result: `${report.created} pièce(s) comptable(s) candidate(s) pour Fiscal-Manager`,
    });
  }
  return report;
}

/**
 * Envoie UN mail vers Fiscal-Manager à la demande (10/08) — depuis le lecteur
 * ou le dépouillement, sans attendre que la détection automatique l'ait vu.
 * C'est le même objet que la détection produit : Fiscal-Manager le tirera au
 * prochain « Actualiser ». Idempotent : renvoyer deux fois le même mail ne
 * crée pas deux pièces.
 */
export async function sendMessageToAccounting(
  rec: AccountRecord,
  folder: string,
  uid: number,
): Promise<{ ok: boolean; already: boolean; attachments: number; reason?: string }> {
  await ensureDbReady();
  const m = await db.message.findFirst({
    where: { accountSlug: rec.account, uid, isDeleted: false, folder: { path: folder } },
    select: {
      id: true, uid: true, subject: true, fromName: true, fromEmail: true,
      date: true, internetMessageId: true,
    },
  });
  if (!m) return { ok: false, already: false, attachments: 0, reason: "Mail introuvable dans l'index — resynchronise la boîte." };

  const existing = await db.accountingCandidate.findFirst({
    where: { accountSlug: rec.account, messageId: m.id },
  });
  if (existing && existing.status !== 'SKIPPED') {
    return { ok: true, already: true, attachments: JSON.parse(existing.attachmentsJson).length };
  }

  const parts = await imapService.listAttachments(rec, folder, uid);
  let usable = usableAttachments(parts);
  let corpsDoc: JustificatifCorps | null = null;

  // AUCUNE PIÈCE JOINTE ? Le corps est peut-être LUI-MÊME le justificatif
  // (billet d'avion). Le même verrou que la détection automatique tombait ici :
  // Anthony cliquait « Envoyer à la compta » sur une confirmation de vol et
  // s'entendait répondre « rien à transmettre ».
  if (usable.length === 0) {
    let texte = '';
    try {
      texte = ((await imapService.readEmail(rec, folder, uid)).text || '').trim();
    } catch {
      texte = '';
    }
    corpsDoc = texte
      ? justificatifDansLeCorps({
          subject: m.subject, fromName: m.fromName, fromEmail: m.fromEmail, texte,
        })
      : null;
    if (corpsDoc) {
      const pdf = mailEnPdf({
        subject: m.subject ?? '(sans objet)',
        fromName: m.fromName, fromEmail: m.fromEmail, date: m.date, texte,
        entetes: [
          `Fournisseur : ${corpsDoc.supplier}`,
          `Montant payé : ${corpsDoc.amountTtc.toFixed(2).replace('.', ',')} ${corpsDoc.devise}`,
          ...(corpsDoc.reference ? [`Référence : ${corpsDoc.reference}`] : []),
        ],
      });
      usable = [{
        attachmentId: PIECE_CORPS,
        index: -1,
        filename: nomDeFichier(corpsDoc, m.id),
        contentType: 'application/pdf',
        sizeBytes: pdf.length,
      }];
    }
  }

  if (usable.length === 0) {
    return {
      ok: false, already: false, attachments: 0,
      reason: 'Ce mail ne porte aucune pièce exploitable (PDF, JPG, PNG), et son corps ne contient pas de montant payé identifiable — rien à transmettre.',
    };
  }

  const { company, basis } = companyForMailbox(rec.account);
  const data = {
    companyCandidate: company,
    companyBasis: basis,
    status: 'ACTIVE',
    receivedAt: m.date,
    fromName: m.fromName,
    fromEmail: m.fromEmail,
    subject: m.subject,
    attachmentsJson: JSON.stringify(usable),
    bodyDocJson: corpsDoc ? JSON.stringify(corpsDoc) : null,
  };
  // Un candidat SKIPPED (vu sans pièce exploitable à l'époque) est réveillé
  // plutôt que doublé — l'unicité compte+mail l'interdirait de toute façon.
  if (existing) {
    await db.accountingCandidate.update({ where: { seq: existing.seq }, data });
  } else {
    await db.accountingCandidate.create({
      data: {
        candidateId: randomUUID(),
        accountSlug: rec.account,
        messageId: m.id,
        internetMessageId: m.internetMessageId,
        ...data,
      },
    });
  }
  await recordOperation({
    account: rec.account,
    tool: 'ui_accounting_send',
    folder,
    params: { count: 1, attachments: usable.length },
    affectedUids: [uid],
    items: [{ subject: m.subject ?? '(sans sujet)', date: m.date?.toISOString() ?? null, folder, uid }],
    result: `pièce comptable transmise à Fiscal-Manager (${usable.length} fichier(s))`,
  });
  return { ok: true, already: false, attachments: usable.length };
}

/**
 * Mail source disparu (supprimé par l'utilisateur avant l'import) : le
 * candidat ne disparaît JAMAIS en silence — il passe SOURCE_MISSING et
 * Fiscal-Manager l'affiche comme tel (l'API pièce répond 410). Un mail
 * restauré repasse ACTIVE.
 */
export async function sweepSourceMissing(accountSlug: string): Promise<number> {
  const rows = await db.accountingCandidate.findMany({
    where: { accountSlug, status: { in: ['ACTIVE', 'SOURCE_MISSING'] } },
    select: { seq: true, status: true, messageId: true },
  });
  if (rows.length === 0) return 0;
  const messages = await db.message.findMany({
    where: { id: { in: rows.map((r) => r.messageId) } },
    select: { id: true, isDeleted: true },
  });
  const deleted = new Map(messages.map((m) => [m.id, m.isDeleted]));
  let marked = 0;
  for (const r of rows) {
    const gone = deleted.get(r.messageId) !== false; // ligne absente = disparu
    const wanted = gone ? 'SOURCE_MISSING' : 'ACTIVE';
    if (r.status !== wanted) {
      await db.accountingCandidate.update({ where: { seq: r.seq }, data: { status: wanted } });
      if (wanted === 'SOURCE_MISSING') marked++;
    }
  }
  return marked;
}

// ---------------------------------------------------------------------------
// Lecture pour l'API (server/accounting.ts)
// ---------------------------------------------------------------------------

export interface CandidateView {
  candidateId: string;
  detectedAt: string;
  mailboxId: string;
  companyCandidate: string | null;
  companyBasis: string;
  status: string;
  message: {
    receivedAt: string | null;
    fromName: string | null;
    fromAddress: string | null;
    subject: string | null;
  };
  attachments: { attachmentId: string; filename: string; contentType: string; sizeBytes: number }[];
  /**
   * Ce que la pièce dit d'elle-même, pour pré-remplir le frais côté
   * Fiscal-Manager. Depuis le lot 4i, la source première est le VERDICT
   * sémantique (`getAccountingFacts`) : fournisseur = l'ÉMETTEUR du document,
   * jamais l'expéditeur du mail (un proche peut transférer une facture Sosh :
   * le fournisseur est Sosh). Sans verdict, la lecture heuristique du texte de
   * la pièce (documentHints) reste, en repli avoué. Ce sont des PROPOSITIONS :
   * l'utilisateur garde la main sur chaque champ.
   * `needsVision` = pièce scannée dont il manque encore l'essentiel, à faire
   * lire par l'IA (read_attachment).
   */
  document?: {
    supplier: string | null;
    amountTtc: number | null;
    invoiceNumber: string | null;
    needsVision: boolean;
    reasons: string[];
  };
}

export async function listCandidates(
  cursor: number,
  limit: number,
): Promise<{ items: CandidateView[]; nextCursor: string | null; hasMore: boolean }> {
  await ensureDbReady();
  const take = Math.min(Math.max(limit, 1), 200);
  const rows = await db.accountingCandidate.findMany({
    where: { seq: { gt: cursor }, status: { in: ['ACTIVE', 'SOURCE_MISSING'] } },
    orderBy: { seq: 'asc' },
    take: take + 1,
  });
  const hasMore = rows.length > take;
  const page = hasMore ? rows.slice(0, take) : rows;

  // Ce que disent les documents eux-mêmes : lu une fois pour toute la page.
  const docs = new Map<number, { text: string | null; kind: string | null }>();
  if (page.length) {
    for (const m of await db.message.findMany({
      where: { id: { in: page.map((r) => r.messageId) } },
      select: { id: true, attachmentText: true, attachmentKind: true },
    })) {
      docs.set(m.id, { text: m.attachmentText, kind: m.attachmentKind });
    }
  }

  // L'état sémantique de la page, résolu en une passe (lot 4i — 14 requêtes
  // constantes pour ≤ 200 candidats) : c'est lui qui fournit fournisseur,
  // montant et référence quand le verdict existe.
  const etats = page.length
    ? await resolveMailSemanticState(page.map((r) => r.messageId))
    : new Map<number, EtatSemantique>();

  const items = page.map((r) => {
    const atts = JSON.parse(r.attachmentsJson) as CandidateAttachment[];
    const doc = docs.get(r.messageId);
    // Le verdict d'abord ; la lecture heuristique du texte de la pièce ne
    // reprend la main que s'il ne dit rien (repli avoué dans les raisons).
    const verdictDoc = pieceComptableDuVerdict(etats.get(r.messageId));
    // LE JUSTIFICATIF PORTÉ PAR LE CORPS prime sur tout : il n'a ni verdict
    // comptable (l'analyse dit « confirmation ») ni texte de pièce jointe (il
    // n'y en a pas). Ses faits ont été lus à la détection et stockés — les
    // recalculer ici les ferait dépendre de l'état d'indexation du moment.
    const corpsDoc: JustificatifCorps | null = r.bodyDocJson
      ? (JSON.parse(r.bodyDocJson) as JustificatifCorps)
      : null;
    const hints = !verdictDoc && !corpsDoc && doc?.text ? documentHints(doc.text) : null;
    return {
      candidateId: r.candidateId,
      detectedAt: r.detectedAt.toISOString(),
      mailboxId: r.accountSlug,
      companyCandidate: r.companyCandidate,
      companyBasis: r.companyBasis,
      status: r.status,
      message: {
        receivedAt: r.receivedAt ? r.receivedAt.toISOString() : null,
        fromName: r.fromName,
        fromAddress: r.fromEmail,
        subject: r.subject,
      },
      attachments: atts.map((a) => ({
        attachmentId: a.attachmentId,
        filename: a.filename,
        contentType: a.contentType,
        sizeBytes: a.sizeBytes,
      })),
      ...(corpsDoc
        ? {
            document: {
              supplier: corpsDoc.supplier,
              amountTtc: corpsDoc.amountTtc,
              invoiceNumber: corpsDoc.reference,
              // Rien à faire lire par la vision : le justificatif est du TEXTE,
              // déjà lu. C'est même l'intérêt de cette voie.
              needsVision: false,
              reasons: corpsDoc.reasons,
            },
          }
        : verdictDoc
        ? {
            document: {
              supplier: verdictDoc.supplier,
              amountTtc: verdictDoc.amountTtc,
              invoiceNumber: verdictDoc.invoiceNumber,
              // La vision ne sert plus que si le verdict n'a pas suffi : une
              // pièce scannée dont l'analyse a déjà lu l'émetteur ET le
              // montant n'a plus rien à demander à read_attachment.
              needsVision:
                doc?.kind === 'scan' &&
                (verdictDoc.supplier === null || verdictDoc.amountTtc === null),
              reasons: verdictDoc.reasons,
            },
          }
        : hints || doc?.kind === 'scan'
          ? {
              document: {
                supplier: hints?.supplier ?? null,
                amountTtc: hints?.amountTtc ?? null,
                invoiceNumber: hints?.invoiceNumber ?? null,
                needsVision: doc?.kind === 'scan',
                reasons: [
                  ...(hints?.reasons ?? ['pièce scannée : son contenu doit être lu par l\'IA']),
                  'repli heuristique — le verdict d\'analyse ne fournit pas encore ces champs',
                ],
              },
            }
          : {}),
    };
  });
  const last = page[page.length - 1];
  return { items, nextCursor: last ? String(last.seq) : null, hasMore };
}

export type AttachmentResolution =
  | { ok: true; filename: string; contentType: string; content: Buffer }
  | { ok: false; code: 404 | 410; reason: string };

/**
 * Résout et télécharge UNE pièce d'un candidat. Le locator IMAP est lu au
 * moment T sur la ligne Message (relinkée si le mail a changé de dossier).
 * Source disparue → 410 Gone (le candidat existe toujours) + SOURCE_MISSING.
 */
export async function resolveAttachment(
  candidateId: string,
  attachmentId: string,
  getRecord: (slug: string) => Promise<AccountRecord | null>,
): Promise<AttachmentResolution> {
  await ensureDbReady();
  const cand = await db.accountingCandidate.findUnique({ where: { candidateId } });
  if (!cand || cand.status === 'SKIPPED') return { ok: false, code: 404, reason: 'Candidat inconnu.' };
  const atts = JSON.parse(cand.attachmentsJson) as CandidateAttachment[];
  const att = atts.find((a) => a.attachmentId === attachmentId);
  if (!att) return { ok: false, code: 404, reason: 'Pièce inconnue pour ce candidat.' };

  const markMissing = async (reason: string): Promise<AttachmentResolution> => {
    await db.accountingCandidate.update({
      where: { seq: cand.seq },
      data: { status: 'SOURCE_MISSING' },
    });
    return { ok: false, code: 410, reason };
  };

  const msg = await db.message.findUnique({
    where: { id: cand.messageId },
    select: { uid: true, isDeleted: true, folder: { select: { path: true } } },
  });
  if (!msg || msg.isDeleted) return markMissing('Le mail source a disparu du serveur.');

  const rec = await getRecord(cand.accountSlug);
  if (!rec) return { ok: false, code: 404, reason: 'Compte mail introuvable.' };

  // ── LA PIÈCE SYNTHÉTIQUE : le corps du mail rendu en PDF ────────────────
  // Rendu À LA DEMANDE, jamais stocké (décision n° 3 du connecteur : l'IMAP
  // est le stockage durable). Le rendu est déterministe, donc deux
  // téléchargements donnent le même octet — c'est ce qui permet à
  // Fiscal-Manager de retirer la pièce deux fois sans créer de doublon.
  if (att.attachmentId === PIECE_CORPS) {
    const doc: JustificatifCorps | null = cand.bodyDocJson
      ? (JSON.parse(cand.bodyDocJson) as JustificatifCorps)
      : null;
    try {
      const corps = await imapService.readEmail(rec, msg.folder.path, msg.uid);
      const texte = (corps.text || '').trim();
      if (!texte) return markMissing('Le corps du mail est vide : plus de justificatif.');
      const pdf = mailEnPdf({
        subject: cand.subject ?? corps.subject ?? '(sans objet)',
        fromName: cand.fromName,
        fromEmail: cand.fromEmail,
        date: cand.receivedAt,
        texte,
        entetes: doc
          ? [
              `Fournisseur : ${doc.supplier}`,
              `Montant payé : ${doc.amountTtc.toFixed(2).replace('.', ',')} ${doc.devise}`,
              ...(doc.reference ? [`Référence : ${doc.reference}`] : []),
            ]
          : [],
      });
      if (cand.status === 'SOURCE_MISSING') {
        await db.accountingCandidate.update({ where: { seq: cand.seq }, data: { status: 'ACTIVE' } });
      }
      return { ok: true, filename: att.filename, contentType: 'application/pdf', content: pdf };
    } catch (err) {
      logger.warn('rendu du justificatif porté par le corps en échec', {
        candidateId,
        error: (err as Error).message,
      });
      return markMissing('Le mail source est inaccessible.');
    }
  }

  try {
    let dl = await imapService.downloadAttachment(rec, msg.folder.path, msg.uid, att.index);
    // Repli si la structure a bougé : on recherche la pièce par son nom.
    if (dl && att.filename !== '(sans nom)' && dl.filename !== att.filename) {
      const parts = await imapService.listAttachments(rec, msg.folder.path, msg.uid);
      const byName = parts.findIndex((p) => p.filename === att.filename);
      if (byName >= 0) dl = await imapService.downloadAttachment(rec, msg.folder.path, msg.uid, byName);
    }
    if (!dl) return markMissing('La pièce jointe est introuvable dans le mail.');
    if (cand.status === 'SOURCE_MISSING') {
      await db.accountingCandidate.update({ where: { seq: cand.seq }, data: { status: 'ACTIVE' } });
    }
    return { ok: true, filename: dl.filename, contentType: dl.contentType, content: dl.content };
  } catch (err) {
    logger.warn('téléchargement pièce comptable en échec', {
      candidateId,
      attachmentId,
      error: (err as Error).message,
    });
    return markMissing('Le mail source est inaccessible.');
  }
}
