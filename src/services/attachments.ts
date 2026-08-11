/**
 * Lecture des pièces jointes des mails (10/08) — le pendant de snippets.ts
 * pour ce qui est ATTACHÉ au mail, pas écrit dedans.
 *
 * Déclencheur : un mail de la mère de l'utilisateur portant le scan d'une
 * facture Sosh était classé « payer maman ». L'expéditeur ne dit pas de quoi
 * parle le document ; la pièce, si.
 *
 * Garde-fous : on ne télécharge QUE des pièces plausiblement lisibles
 * (PDF/texte/images sous plafond), une par mail au maximum pour le texte, et
 * RIEN n'est conservé sur disque — seul le texte extrait est stocké, tronqué.
 * Les images ne sont pas téléchargées ici du tout : on note « scan », et c'est
 * Claude qui la regardera à la demande (read_attachment).
 */

import { db, ensureDbReady } from '../db/client.js';
import { logger } from '../logger.js';
import { imapService } from './imap.js';
import { attachmentToText, documentHints, type DocumentHints } from './attachment-text.js';
import { detectIntent } from './categorize.js';
import type { AccountRecord } from './accounts.js';

/** Plafond de téléchargement pour l'extraction de texte (le VPS est petit). */
const MAX_FETCH_BYTES = 8 * 1024 * 1024;
/**
 * Texte conservé par MAIL, toutes pièces confondues. Volontairement large : la
 * recherche doit porter sur le CONTENU des documents, y compris au milieu d'un
 * long relevé (demande 10/08). ~200 Ko par mail au pire ; en pratique une
 * facture pèse 2 à 5 Ko.
 */
const MAX_STORED_TEXT = 200_000;
const READABLE = /(pdf|text\/plain|text\/csv|openxmlformats-officedocument)/i;
/**
 * Certains serveurs annoncent `application/octet-stream` pour un PDF ou un
 * .docx : sans ce repli par extension, ces pièces n'étaient jamais lues
 * (constaté sur ses boîtes — 222 fichiers Office et une part des PDF).
 */
const READABLE_NAME = /\.(pdf|txt|csv|md|docx|xlsx|pptx)$/i;
const IMAGE = /^image\//i;

export interface ReadReport {
  scanned: number;
  read: number;
  scans: number;
  failures: number;
  /** Volume approximatif descendu (taille des mails traités). */
  bytes: number;
  /** Mails à pièce jointe encore jamais regardés sur ce compte. */
  remaining: number;
}

/**
 * Remplit `attachmentText` / `attachmentKind` pour les mails à pièce jointe qui
 * n'ont pas encore été regardés. `limit` borne le travail (une descente IMAP
 * par mail). Les plus RÉCENTS d'abord : c'est le flux courant qui compte.
 */
export async function readAttachmentsForAccount(
  rec: AccountRecord,
  opts: {
    limit?: number;
    sinceDays?: number;
    onlyMissing?: boolean;
    /** Plafond de volume par appel : le VPS ne doit pas descendre 6 Go d'un coup. */
    maxBytes?: number;
    /** 'newest' (defaut) pour le flux courant, 'oldest' pour purger le fonds. */
    order?: 'newest' | 'oldest';
    onProgress?: (message: string) => void;
  } = {},
): Promise<ReadReport> {
  await ensureDbReady();
  const report: ReadReport = { scanned: 0, read: 0, scans: 0, failures: 0, bytes: 0, remaining: 0 };
  const limit = Math.min(opts.limit ?? 60, 500);
  const maxBytes = opts.maxBytes ?? Number.POSITIVE_INFINITY;
  const progress = opts.onProgress ?? (() => {});

  const where = {
      accountSlug: rec.account,
      hasAttachments: true,
      isDeleted: false,
      isOutbound: false,
      folder: { role: { notIn: ['trash', 'spam'] } },
      ...(opts.onlyMissing === false ? {} : { attachmentTextAt: null }),
      ...(opts.sinceDays
        ? { date: { gte: new Date(Date.now() - opts.sinceDays * 86_400_000) } }
        : {}),
  };

  const messages = await db.message.findMany({
    where,
    orderBy: { date: opts.order === 'oldest' ? 'asc' : 'desc' },
    take: limit,
    select: {
      id: true,
      uid: true,
      subject: true,
      fromEmail: true,
      sizeBytes: true,
      hasListUnsubscribe: true,
      intent: true,
      intentSource: true,
      folder: { select: { path: true } },
    },
  });

  for (const m of messages) {
    // Plafond de volume : on s'arrête PROPREMENT, les mails restants seront
    // repris au prochain lot (rien n'est perdu, `remaining` dit la verite).
    if (report.bytes >= maxBytes) break;
    report.scanned++;
    report.bytes += m.sizeBytes ?? 0;
    try {
      const r = await readOne(rec, m.folder.path, m.uid);
      await db.message.update({
        where: { id: m.id },
        data: {
          attachmentKind: r.kind,
          attachmentText: r.text || null,
          attachmentTextAt: new Date(),
        },
      });
      if (r.kind === 'text') report.read++;
      else if (r.kind === 'scan') report.scans++;

      // Le document peut CONTREDIRE l'expéditeur (c'est tout l'objet du
      // correctif) : on rejoue la détection avec le texte de la pièce. On ne
      // touche jamais à un intent posé par l'IA ou à la main (précédence
      // manual > ai > auto), et on ne change que si le document dit mieux.
      if (r.kind === 'text' && r.hints?.isInvoice && m.intentSource === 'auto' && m.intent !== 'invoice') {
        const d = detectIntent({
          subject: m.subject,
          hasListUnsubscribe: m.hasListUnsubscribe,
          fromEmail: m.fromEmail,
          attachmentText: r.text,
        });
        if (d.intent === 'invoice') {
          await db.message.update({
            where: { id: m.id },
            data: { intent: d.intent, intentReason: d.reason },
          });
          logger.info('intention corrigée par la pièce jointe', {
            account: rec.account,
            uid: m.uid,
            avant: m.intent,
            apres: d.intent,
            fournisseur: r.hints.supplier,
          });
        }
      }
    } catch (err) {
      report.failures++;
      logger.warn('lecture de pièce jointe en échec', {
        account: rec.account,
        uid: m.uid,
        error: (err as Error).message,
      });
    }
    if (report.scanned % 25 === 0) {
      progress(`${report.scanned} mail(s) examinés, ${report.read} document(s) lu(s)…`);
    }
  }
  report.remaining = await db.message.count({ where });
  return report;
}

/**
 * Lit les pièces d'UN mail. Renvoie le texte concaténé des pièces lisibles ;
 * si aucune n'est lisible mais qu'il y a une image ou un PDF scanné, renvoie
 * kind='scan' (Claude ira regarder). Aucun fichier n'est conservé.
 */
export async function readOne(
  rec: AccountRecord,
  folder: string,
  uid: number,
): Promise<{ kind: 'text' | 'scan' | 'other'; text: string; hints: DocumentHints | null }> {
  const parts = await imapService.listAttachments(rec, folder, uid);
  if (parts.length === 0) return { kind: 'other', text: '', hints: null };

  // TOUTES les pièces sont lues (demande 10/08), pas seulement les premières :
  // une facture arrive souvent en 3e position derrière des logos, et la
  // recherche doit pouvoir la trouver.
  const chunks: string[] = [];
  let total = 0;
  let sawImage = false;
  for (let i = 0; i < parts.length && total < MAX_STORED_TEXT; i++) {
    const p = parts[i];
    // Une image « en ligne » (logo de signature) n'est pas un document.
    if (IMAGE.test(p.contentType)) {
      if (!p.contentId && p.sizeBytes >= 30_000) sawImage = true;
      continue;
    }
    const lisible = READABLE.test(p.contentType) || READABLE_NAME.test(p.filename ?? '');
    if (!lisible || p.sizeBytes > MAX_FETCH_BYTES) continue;
    const dl = await imapService.downloadAttachment(rec, folder, uid, i);
    if (!dl) continue;
    const r = attachmentToText(dl.filename, dl.contentType, dl.content);
    if (r.kind === 'text') {
      // Le NOM du fichier est conservé dans le texte indexé : chercher
      // « facture.pdf » doit marcher, y compris quand le nom ne dit rien.
      const chunk = `--- ${dl.filename} ---\n${r.text}`;
      chunks.push(chunk);
      total += chunk.length;
    } else if (r.kind === 'scan') sawImage = true;
  }

  if (chunks.length > 0) {
    const text = chunks.join('\n\n').slice(0, MAX_STORED_TEXT);
    return { kind: 'text', text, hints: documentHints(text) };
  }
  if (sawImage) return { kind: 'scan', text: '', hints: null };
  return { kind: 'other', text: '', hints: null };
}

/**
 * Une pièce précise, prête à être REGARDÉE par Claude : texte quand on sait le
 * lire, image en base64 sinon (le protocole MCP sait porter une image, et
 * Claude sait la lire — c'est exactement le cas du scan de facture).
 */
export async function attachmentForVision(
  rec: AccountRecord,
  folder: string,
  uid: number,
  index?: number,
): Promise<
  | { kind: 'text'; filename: string; text: string; hints: DocumentHints }
  | { kind: 'image'; filename: string; mimeType: string; base64: string }
  | { kind: 'none'; reason: string }
> {
  const parts = await imapService.listAttachments(rec, folder, uid);
  if (parts.length === 0) return { kind: 'none', reason: 'Ce mail n\'a aucune pièce jointe.' };

  // Sans index précisé : la première pièce « document » (on saute les logos).
  const candidates = parts
    .map((p, i) => ({ p, i }))
    .filter(({ p }) => !(IMAGE.test(p.contentType) && (p.contentId || p.sizeBytes < 30_000)));
  const chosen =
    index !== undefined ? candidates.find(({ i }) => i === index) ?? { p: parts[index], i: index } : candidates[0];
  if (!chosen?.p) return { kind: 'none', reason: 'Pièce jointe introuvable.' };
  if (chosen.p.sizeBytes > MAX_FETCH_BYTES) {
    return { kind: 'none', reason: `Pièce trop volumineuse (${Math.round(chosen.p.sizeBytes / 1024 / 1024)} Mo).` };
  }

  const dl = await imapService.downloadAttachment(rec, folder, uid, chosen.i);
  if (!dl) return { kind: 'none', reason: 'Pièce jointe illisible.' };

  const r = attachmentToText(dl.filename, dl.contentType, dl.content);
  if (r.kind === 'text') {
    return { kind: 'text', filename: dl.filename, text: r.text, hints: documentHints(r.text) };
  }
  const ct = dl.contentType.toLowerCase();
  // Formats d'image que Claude sait regarder.
  if (/^image\/(jpe?g|png|webp|gif)$/.test(ct)) {
    return { kind: 'image', filename: dl.filename, mimeType: ct, base64: dl.content.toString('base64') };
  }
  return {
    kind: 'none',
    reason: `${r.note} (${dl.filename}) — format non regardable directement.`,
  };
}
