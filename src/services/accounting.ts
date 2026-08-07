/**
 * Connecteur Fiscal-Manager — V1 « zéro facture perdue » (07/08).
 * Design : docs/CONNECTEUR-FISCAL-MANAGER.md (débattu avec ChatGPT, corrigé
 * par Anthony). Principe : « Boxmail détecte, Fiscal-Manager qualifie ».
 *
 * Ce module DÉTECTE les mails « pièce comptable » (intention facture + pièce
 * jointe exploitable) et les mémorise en MÉTADONNÉES seulement — jamais le
 * PDF : l'IMAP reste le stockage durable, la pièce est streamée à la demande
 * par l'API (server/accounting.ts). Fiscal-Manager tire la liste par curseur
 * (seq monotone) et décide seul de ce que chaque pièce devient.
 *
 * Protection : un candidat est par définition un mail à pièce jointe
 * d'intention invoice — la protection centrale (retention.ts) exclut déjà ces
 * mails de TOUTE suppression automatique. Aucune clause supplémentaire.
 */

import { randomUUID } from 'node:crypto';
import { db, ensureDbReady } from '../db/client.js';
import { logger } from '../logger.js';
import { imapService } from './imap.js';
import { recordOperation } from './oplog.js';
import type { AccountRecord } from './accounts.js';

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

export interface DetectReport {
  scanned: number;
  created: number;
  skippedNoAttachment: number;
  sourceMissingMarked: number;
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
  const report: DetectReport = { scanned: 0, created: 0, skippedNoAttachment: 0, sourceMissingMarked: 0 };
  const limit = Math.min(opts.limit ?? 300, 1000);

  const messages = await db.message.findMany({
    where: {
      accountSlug: rec.account,
      intent: 'invoice',
      hasAttachments: true,
      isDeleted: false,
      isOutbound: false,
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

  for (const m of messages) {
    if (byMessageId.has(m.id)) continue;
    if (m.internetMessageId && byMsgIdHeader.has(m.internetMessageId)) continue;
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
    if (status === 'ACTIVE') report.created++;
    else report.skippedNoAttachment++;
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
  const items = page.map((r) => {
    const atts = JSON.parse(r.attachmentsJson) as CandidateAttachment[];
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
