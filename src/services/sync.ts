import type { ImapFlow } from 'imapflow';
import { db, ensureDbReady } from '../db/client.js';
import { logger } from '../logger.js';
import { imapService, normalizeSubject } from './imap.js';
import { AUTO_SENDER_RE, isAutoReplySubject } from './attention.js';
import { categorizeSender, detectIntent } from './categorize.js';
import type { AccountRecord } from './accounts.js';

/**
 * Mail Sync Engine (SPEC V2 §8.1) — synchronisation incrémentale IMAP → SQLite.
 *
 * Principes :
 *  - métadonnées uniquement (envelope, flags, taille, List-Unsubscribe) ;
 *    les corps restent lus à la demande via read_email (jamais indexés en masse) ;
 *  - incrémental par dossier via lastUidSeen + invalidation par UIDVALIDITY ;
 *  - réconciliation des suppressions (mails disparus → isDeleted) ;
 *  - rattachement des fils (In-Reply-To puis sujet normalisé) ;
 *  - agrégats par expéditeur recalculés à chaque sync.
 *
 * Modes :
 *  - recent : INBOX + Sent (nouveaux mails + réconciliation) — rapide ;
 *  - full   : tous les dossiers + rafraîchissement des flags (lu/non lu).
 */

export interface SyncOptions {
  mode?: 'recent' | 'full';
  /** Limiter la sync à ces chemins de dossiers. */
  folders?: string[];
  onProgress?: (message: string) => void;
}

export interface SyncReport {
  account: string;
  mode: 'recent' | 'full';
  foldersSynced: string[];
  newMessages: number;
  deletedMessages: number;
  /** Mails rangés ailleurs, rattachés à leur nouvelle place (P0.1). */
  movedMessages?: number;
  /** Échéances détectées automatiquement sur les nouveaux mails (P0.2). */
  deadlinesFound?: number;
  flagUpdates: number;
  threadsLinked: number;
  sendersUpdated: number;
  durationMs: number;
  /** Dossiers en échec (la sync continue sur les autres). */
  errors: { folder: string; message: string }[];
}

const FETCH_CHUNK = 500;

function specialUseToRole(specialUse: string | null | undefined, path: string): string {
  switch (specialUse) {
    case '\\Inbox':
      return 'inbox';
    case '\\Sent':
      return 'sent';
    case '\\Trash':
      return 'trash';
    case '\\Archive':
      return 'archive';
    case '\\Junk':
      return 'spam';
    case '\\Drafts':
      return 'drafts';
    default:
      return path.toUpperCase() === 'INBOX' ? 'inbox' : 'custom';
  }
}

function toDate(d: Date | string | undefined | null): Date | null {
  if (!d) return null;
  const date = d instanceof Date ? d : new Date(d);
  return Number.isNaN(date.getTime()) ? null : date;
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// Nœud de bodyStructure imapflow (typé au minimum nécessaire).
type BodyStructNode = {
  type?: string;
  disposition?: string;
  dispositionParameters?: { filename?: string };
  parameters?: { name?: string };
  size?: number;
  childNodes?: BodyStructNode[];
};

/**
 * Compte les pièces jointes d'un bodyStructure (L5.9) : toute partie feuille
 * avec une disposition « attachment » OU un nom de fichier (les images inline
 * nommées comptent — mailparser les liste aussi dans le panneau de lecture).
 */
export function countAttachments(node: BodyStructNode | undefined | null): number {
  if (!node) return 0;
  let count = 0;
  const walk = (n: BodyStructNode) => {
    if (n.childNodes?.length) {
      for (const c of n.childNodes) walk(c);
      return;
    }
    const filename = n.dispositionParameters?.filename ?? n.parameters?.name;
    if (n.disposition?.toLowerCase() === 'attachment' || filename) count++;
  };
  walk(node);
  return count;
}

/**
 * NOMS des pièces jointes d'un bodyStructure (11/08). Même parcours que
 * `countAttachments` — l'information était déjà là, on la jetait.
 *
 * C'est la matière première de « retrouver sans classer » : Anthony ne range
 * rien, mais ses fournisseurs nomment leurs fichiers (« quittance_juin.pdf »,
 * « avis_imposition_2025.pdf », « bail_signe.pdf »). Chercher ce mot doit
 * suffire, même quand le sujet du mail ne dit rien.
 *
 * Les noms sont dédoublonnés et renvoyés séparés par des retours à la ligne ;
 * chaîne vide si aucune pièce nommée.
 */
export function collectAttachmentNames(node: BodyStructNode | undefined | null): string {
  return collectAttachmentInfo(node)
    .map((p) => p.n)
    .join('\n');
}

/**
 * Nom ET TAILLE de chaque pièce (11/08). La taille vient de la même lecture
 * de structure : elle ne coûte rien de plus, et c'est elle qui permet de
 * distinguer un vrai doublon d'une homonymie — « photo.jpg » présent dans
 * sept mails, ce sont sept photos différentes ; le même nom AVEC la même
 * taille à l'octet près, c'est le même fichier.
 */
export function collectAttachmentInfo(
  node: BodyStructNode | undefined | null,
): { n: string; s: number }[] {
  if (!node) return [];
  const noms: { n: string; s: number }[] = [];
  const vus = new Set<string>();
  const walk = (n: BodyStructNode) => {
    if (n.childNodes?.length) {
      for (const c of n.childNodes) walk(c);
      return;
    }
    const brut = n.dispositionParameters?.filename ?? n.parameters?.name;
    if (!brut) return;
    // Décoration de newsletter, écartée (constaté en réel dès la première
    // passe : un mail Leroy Merlin apportait « appstore_lm.gif »,
    // « quote_lm.gif », « loc_lm.gif »… noyant le vrai « 723767.pdf »).
    // Règle : une image NON déclarée en pièce jointe, ou minuscule, est un
    // élément de mise en page. Une photo de facture, elle, arrive bien en
    // disposition « attachment » — même règle que usableAttachments().
    //
    // CORRECTION 11/08 : une pièce explicitement JOINTE n'est jamais écartée
    // pour sa taille. La règle précédente jetait toute image jointe de moins
    // de 30 Ko — or un PNG de 18 Ko peut être un QR code, une signature ou un
    // justificatif. Seule une image EN LIGNE et petite est de la décoration.
    const estImage = (n.type ?? '').toLowerCase().startsWith('image/');
    const jointe = n.disposition?.toLowerCase() === 'attachment';
    if (estImage && !jointe && (n.size ?? 0) < 30_000) return;
    // Un nom peut arriver encodé (RFC 2231/2047) ou avec des espaces parasites.
    const nom = String(brut).replace(/\s+/g, ' ').trim().slice(0, 200);
    if (!nom) return;
    const cle = nom.toLowerCase();
    if (vus.has(cle)) return;
    vus.add(cle);
    noms.push({ n: nom, s: Math.max(0, Math.trunc(n.size ?? 0)) });
  };
  walk(node);
  // Une newsletter peut embarquer trente images nommées : on borne.
  return noms.slice(0, 25);
}

/**
 * Plage IMAP compacte "premier:dernier" pour un lot d'UIDs triés.
 * Une liste explicite de milliers d'UIDs dépasse la longueur de commande
 * acceptée par Outlook ("Command failed") ; une plage reste minuscule, et les
 * UIDs absents de la plage sont simplement ignorés par le serveur.
 */
function uidRange(sortedUids: number[]): string {
  return `${sortedUids[0]}:${sortedUids[sortedUids.length - 1]}`;
}

export async function syncAccount(rec: AccountRecord, opts: SyncOptions = {}): Promise<SyncReport> {
  await ensureDbReady();
  const started = Date.now();
  const mode = opts.mode ?? 'recent';
  const progress = opts.onProgress ?? (() => {});
  const report: SyncReport = {
    account: rec.account,
    mode,
    foldersSynced: [],
    newMessages: 0,
    deletedMessages: 0,
    flagUpdates: 0,
    threadsLinked: 0,
    sendersUpdated: 0,
    durationMs: 0,
    errors: [],
  };

  const selfEmail = rec.username.toLowerCase();
  // Mails disparus de leur dossier pendant CE run : candidats à un
  // déplacement (rangement, mise à la corbeille…) — voir reconcileMoves.
  const goneMessageIds: number[] = [];

  await db.account.upsert({
    where: { slug: rec.account },
    create: { slug: rec.account, emailAddress: rec.username },
    update: { emailAddress: rec.username },
  });

  await imapService.withClient(rec, async (client) => {
    // --- 1. Synchroniser la liste des dossiers --------------------------------
    progress('Synchronisation des dossiers…');
    const imapFolders = await client.list();
    const seenPaths = new Set<string>();
    for (const f of imapFolders) {
      seenPaths.add(f.path);
      await db.folder.upsert({
        where: { accountSlug_path: { accountSlug: rec.account, path: f.path } },
        create: {
          accountSlug: rec.account,
          path: f.path,
          name: f.name,
          delimiter: f.delimiter,
          role: specialUseToRole(f.specialUse, f.path),
        },
        update: {
          name: f.name,
          delimiter: f.delimiter,
          role: specialUseToRole(f.specialUse, f.path),
        },
      });
    }
    // Dossiers disparus du serveur → on retire l'index correspondant.
    await db.folder.deleteMany({
      where: { accountSlug: rec.account, path: { notIn: [...seenPaths] } },
    });

    // --- 2. Choisir les dossiers à synchroniser -------------------------------
    const dbFolders = await db.folder.findMany({ where: { accountSlug: rec.account } });
    let targets = dbFolders;
    if (opts.folders?.length) {
      const wanted = new Set(opts.folders);
      targets = dbFolders.filter((f) => wanted.has(f.path));
      const missing = opts.folders.filter((p) => !dbFolders.some((f) => f.path === p));
      if (missing.length) throw new Error(`Dossiers inconnus : ${missing.join(', ')}`);
    } else if (mode === 'recent') {
      targets = dbFolders.filter((f) => f.role === 'inbox' || f.role === 'sent');
    }

    // --- 3. Sync par dossier ---------------------------------------------------
    for (const folder of targets) {
      progress(`Dossier ${folder.path}…`);
      try {
        await syncFolder(folder);
        report.foldersSynced.push(folder.path);
      } catch (err) {
        const message = (err as Error).message;
        report.errors.push({ folder: folder.path, message });
        progress(`  ⚠️ ${folder.path} en échec (${message}) — on continue.`);
        logger.warn('échec sync dossier', { account: rec.account, folder: folder.path, message });
      }
    }

    async function syncFolder(folder: (typeof targets)[number]): Promise<void> {
      const lock = await client.getMailboxLock(folder.path);
      try {
        const mailbox = client.mailbox;
        if (!mailbox || typeof mailbox === 'boolean') return;

        // Invalidation : si UIDVALIDITY a changé, l'index du dossier est caduc.
        let lastUidSeen = folder.lastUidSeen;
        if (folder.uidValidity !== null && mailbox.uidValidity !== folder.uidValidity) {
          progress(`  UIDVALIDITY changé pour ${folder.path}, réindexation complète.`);
          await db.message.deleteMany({ where: { folderId: folder.id } });
          lastUidSeen = 0;
        }

        // UIDs présents sur le serveur (sert aux nouveautés ET aux suppressions).
        const serverUids = ((await client.search({ all: true }, { uid: true })) || []).sort(
          (a, b) => a - b,
        );
        const serverUidSet = new Set(serverUids);

        // 3a. Nouveaux messages (uid > lastUidSeen).
        const newUids = serverUids.filter((u) => u > lastUidSeen);
        let folderNew = 0;
        for (const uids of chunk(newUids, FETCH_CHUNK)) {
          const rows: {
            accountSlug: string;
            folderId: number;
            uid: number;
            internetMessageId: string | null;
            inReplyTo: string | null;
            subject: string | null;
            normalizedSubject: string | null;
            fromName: string | null;
            fromEmail: string | null;
            toEmails: string | null;
            date: Date | null;
            isSeen: boolean;
            isAnswered: boolean;
            isFlagged: boolean;
            isAutoReply: boolean;
            isOutbound: boolean;
            sizeBytes: number;
            hasListUnsubscribe: boolean;
            hasAttachments: boolean;
            attachmentCount: number;
            attachmentNames: string | null;
            attachmentMeta: string | null;
            intent: string | null;
            intentReason: string | null;
          }[] = [];
          // Plage compacte plutôt que liste d'UIDs (limite de longueur de
          // commande Outlook). Les UIDs du trou éventuel n'existent pas côté
          // serveur, donc la plage renvoie exactement ce lot.
          for await (const msg of client.fetch(
            uidRange(uids),
            {
              uid: true,
              envelope: true,
              flags: true,
              size: true,
              internalDate: true,
              bodyStructure: true,
              headers: ['list-unsubscribe'],
            },
            { uid: true },
          )) {
            const from = msg.envelope?.from?.[0];
            const fromEmail = from?.address?.toLowerCase() ?? null;
            const flags = msg.flags ?? new Set<string>();
            const attachmentCount = countAttachments(msg.bodyStructure as BodyStructNode);
            const piecesInfo = collectAttachmentInfo(msg.bodyStructure as BodyStructNode);
            const attachmentNames = piecesInfo.map((x) => x.n).join('\n');
            const hasListUnsubscribe =
              !!msg.headers && /list-unsubscribe\s*:/i.test(msg.headers.toString('utf8'));
            // Intention (A1) : sur les entrants uniquement, depuis le sujet indexé.
            const intentInfo =
              fromEmail === selfEmail
                ? null
                : detectIntent({ subject: msg.envelope?.subject, hasListUnsubscribe, fromEmail });
            rows.push({
              accountSlug: rec.account,
              folderId: folder.id,
              uid: msg.uid,
              internetMessageId: msg.envelope?.messageId ?? null,
              inReplyTo: msg.envelope?.inReplyTo ?? null,
              subject: msg.envelope?.subject ?? null,
              normalizedSubject: normalizeSubject(msg.envelope?.subject) || null,
              fromName: from?.name ?? null,
              fromEmail,
              toEmails: msg.envelope?.to
                ? JSON.stringify(
                    msg.envelope.to.map((a) => a.address?.toLowerCase()).filter(Boolean),
                  )
                : null,
              date: toDate(msg.internalDate ?? msg.envelope?.date),
              isSeen: flags.has('\\Seen'),
              isAnswered: flags.has('\\Answered'),
              isFlagged: flags.has('\\Flagged'),
              isAutoReply: isAutoReplySubject(msg.envelope?.subject),
              isOutbound: fromEmail === selfEmail,
              sizeBytes: msg.size ?? 0,
              hasListUnsubscribe,
              hasAttachments: attachmentCount > 0,
              attachmentCount,
              attachmentNames: attachmentNames || null,
              attachmentMeta: piecesInfo.length ? JSON.stringify(piecesInfo) : null,
              intent: intentInfo?.intent ?? null,
              intentReason: intentInfo?.reason ?? null,
            });
          }
          if (rows.length) {
            // Écarte les doublons éventuels (re-sync partielle interrompue).
            const existing = await db.message.findMany({
              where: { folderId: folder.id, uid: { in: rows.map((r) => r.uid) } },
              select: { uid: true },
            });
            const existingUids = new Set(existing.map((e) => e.uid));
            const fresh = rows.filter((r) => !existingUids.has(r.uid));
            if (fresh.length) await db.message.createMany({ data: fresh });
            folderNew += fresh.length;
            progress(`  ${folder.path} : +${folderNew} nouveaux messages…`);
          }
        }
        report.newMessages += folderNew;

        // 3b. Réconciliation des suppressions.
        const known = await db.message.findMany({
          where: { folderId: folder.id, isDeleted: false },
          select: { id: true, uid: true },
        });
        const goneIds = known.filter((m) => !serverUidSet.has(m.uid)).map((m) => m.id);
        if (goneIds.length) {
          for (const ids of chunk(goneIds, 900)) {
            await db.message.updateMany({
              where: { id: { in: ids } },
              data: { isDeleted: true },
            });
          }
          report.deletedMessages += goneIds.length;
          goneMessageIds.push(...goneIds);
        }
        // Réapparitions (rare : déplacement aller-retour).
        const returned = await db.message.findMany({
          where: { folderId: folder.id, isDeleted: true, uid: { in: serverUids } },
          select: { id: true },
        });
        if (returned.length) {
          await db.message.updateMany({
            where: { id: { in: returned.map((r) => r.id) } },
            data: { isDeleted: false },
          });
        }

        // 3c. Rafraîchissement des flags (mode full uniquement).
        if (mode === 'full' && serverUids.length) {
          let flagUpdates = 0;
          const dbFlags = new Map(
            (
              await db.message.findMany({
                where: { folderId: folder.id, isDeleted: false },
                select: { id: true, uid: true, isSeen: true, isAnswered: true, isFlagged: true },
              })
            ).map((m) => [m.uid, m]),
          );
          // "1:*" = tout le dossier en une seule commande courte (streamée),
          // au lieu d'une liste d'UIDs qui dépasse la limite Outlook.
          for await (const msg of client.fetch(
            '1:*',
            { uid: true, flags: true },
            { uid: true },
          )) {
            const dbMsg = dbFlags.get(msg.uid);
            if (!dbMsg) continue;
            const flags = msg.flags ?? new Set<string>();
            const seen = flags.has('\\Seen');
            const answered = flags.has('\\Answered');
            const flagged = flags.has('\\Flagged');
            if (
              seen !== dbMsg.isSeen ||
              answered !== dbMsg.isAnswered ||
              flagged !== dbMsg.isFlagged
            ) {
              await db.message.update({
                where: { id: dbMsg.id },
                data: { isSeen: seen, isAnswered: answered, isFlagged: flagged },
              });
              flagUpdates++;
            }
          }
          report.flagUpdates += flagUpdates;
        }

        // 3d. Compteurs + état du dossier.
        const [messageCount, unseenCount] = await Promise.all([
          db.message.count({ where: { folderId: folder.id, isDeleted: false } }),
          db.message.count({ where: { folderId: folder.id, isDeleted: false, isSeen: false } }),
        ]);
        await db.folder.update({
          where: { id: folder.id },
          data: {
            uidValidity: mailbox.uidValidity ?? null,
            lastUidSeen: serverUids.length ? serverUids[serverUids.length - 1] : lastUidSeen,
            messageCount,
            unseenCount,
            lastSyncedAt: new Date(),
          },
        });
      } finally {
        lock.release();
      }
    }
  });

  // --- 3d. Mails DÉPLACÉS : on suit le mail, pas sa position ------------------
  // Un mail rangé dans un autre dossier disparaît d'un côté et réapparaît de
  // l'autre avec un nouvel UID : sans ça, la tâche/échéance/verdict qui y était
  // rattaché pointerait vers une ligne morte (« mail introuvable »).
  if (goneMessageIds.length) {
    try {
      report.movedMessages = await reconcileMoves(rec.account, goneMessageIds);
      if (report.movedMessages) {
        progress(`${report.movedMessages} mail(s) déplacé(s) rattaché(s) à leur nouvelle place.`);
      }
    } catch (err) {
      logger.warn('rattachement des mails déplacés en échec', {
        account: rec.account,
        error: (err as Error).message,
      });
    }
  }

  // --- 4. Rattachement des fils de discussion --------------------------------
  progress('Rattachement des fils de discussion…');
  report.threadsLinked = await linkThreads(rec.account);

  // --- 5. Agrégats par expéditeur ---------------------------------------------
  progress('Calcul des statistiques expéditeurs…');
  report.sendersUpdated = await rebuildSenders(rec.account);

  // NOMS des pièces jointes (11/08) — placé en TÊTE des passes de contenu :
  // c'est la moins chère (structures seules, aucun téléchargement) et elle
  // répare au passage `hasAttachments` sur les mails indexés avant que la
  // sync ne le calcule. Or « ce mail porte une pièce » protège le mail dans
  // tout le nettoyage : mieux vaut le savoir AVANT le reste.
  // Import dynamique : attachment-names.ts dépend d'ici (countAttachments).
  try {
    const { backfillAttachmentNames } = await import('./attachment-names.js');
    const noms = await backfillAttachmentNames(rec, { limit: 300, order: 'newest' });
    if (noms.named > 0 || noms.repaired > 0) {
      progress(
        `Pièces jointes : ${noms.named} mail(s) documentés par nom de fichier` +
          `${noms.repaired ? `, ${noms.repaired} corrigé(s)` : ''}.`,
      );
    }
  } catch (err) {
    logger.warn('noms des pièces post-sync en échec', {
      account: rec.account,
      error: (err as Error).message,
    });
  }

  // Extraits de texte (C1) des mails les plus RÉCENTS d'abord : le flux
  // courant doit toujours avoir son extrait. Placé AVANT le calcul de
  // confiance, parce qu'un extrait peut préciser l'intention du mail — et la
  // confiance découle de l'intention. `recomputeConfidence: false` : la passe
  // ci-dessous s'en charge (les nouveaux mails n'ont pas encore de confiance).
  // Le rattrapage des VIEUX mails, lui, se lance à la main depuis Paramètres.
  try {
    const { backfillSnippets } = await import('./snippets.js');
    const snip = await backfillSnippets(rec, {
      limit: 150,
      order: 'newest',
      recomputeConfidence: false,
    });
    if (snip.filled > 0) progress(`Extraits : ${snip.filled} mail(s) lus.`);
  } catch (err) {
    logger.warn('extraits post-sync en échec', {
      account: rec.account,
      error: (err as Error).message,
    });
  }

  // Contenu des PIÈCES JOINTES (10/08) — AVANT la confiance et les échéances :
  // une facture scannée par un proche ne se voit que dans la pièce, et tout ce
  // qui suit (intention, échéance, pièce comptable) en dépend.
  try {
    const { readAttachmentsForAccount } = await import('./attachments.js');
    // Cadence relevée le 11/08 : à 40 mails sur 60 jours, le fonds (7 019
    // mails à pièce jointe) n'était JAMAIS attaqué — 27 documents lus en
    // tout. Sans borne de date et avec un plafond de volume, chaque sync
    // grignote le stock ; le rattrapage complet reste lançable à la main.
    const att = await readAttachmentsForAccount(rec, {
      limit: 60,
      maxBytes: 40 * 1024 * 1024,
    });
    if (att.read > 0 || att.scans > 0) {
      progress(`Pièces jointes : ${att.read} lue(s), ${att.scans} scan(s) repéré(s).`);
    }
  } catch (err) {
    logger.warn('lecture des pièces jointes post-sync en échec', {
      account: rec.account,
      error: (err as Error).message,
    });
  }

  // Confiance de l'analyse (B4) : posée sur les mails qui n'en ont pas encore
  // — AVANT les automatismes, pour que « confiance faible ⇒ protégé » tienne.
  try {
    const { computeConfidenceForAccount } = await import('./categorize.js');
    await computeConfidenceForAccount(rec.account, { onlyMissing: true });
  } catch (err) {
    logger.warn('confiance post-sync en échec', {
      account: rec.account,
      error: (err as Error).message,
    });
  }

  // Échéances des NOUVEAUX mails (P0.2). Placé ici volontairement : AVANT les
  // automatismes de rangement/suppression, parce qu'une échéance protège son
  // mail (PROTECTION_CLAUSES) — détecter après, ce serait risquer de mettre à
  // la corbeille un mail porteur d'une date avant de l'avoir vue.
  // `indexedSince` limite le travail aux mails arrivés pendant CETTE sync :
  // sans lui, le scan des contenus relirait les mêmes mails toutes les 30 min.
  try {
    const { detectDeadlines } = await import('./deadlines.js');
    const det = await detectDeadlines(rec, {
      sinceDays: 30,
      deep: true,
      indexedSince: new Date(started),
    });
    report.deadlinesFound = det.created;
    if (det.created > 0) progress(`Échéances : ${det.created} nouvelle(s) détectée(s).`);
  } catch (err) {
    logger.warn('détection des échéances post-sync en échec', {
      account: rec.account,
      error: (err as Error).message,
    });
  }

  // Candidats « pièce comptable » (connecteur Fiscal-Manager V1) : les mails
  // facture avec pièce jointe arrivés pendant CETTE sync deviennent visibles
  // dans l'écran « Pièces reçues » de Fiscal-Manager. Une lecture de
  // structure IMAP par nouveau candidat, aucun téléchargement.
  try {
    const { detectAccountingCandidates } = await import('./accounting.js');
    const acc = await detectAccountingCandidates(rec, { indexedSince: new Date(started) });
    if (acc.created > 0) progress(`Pièces comptables : ${acc.created} candidat(s) repéré(s).`);
  } catch (err) {
    logger.warn('détection des pièces comptables post-sync en échec', {
      account: rec.account,
      error: (err as Error).message,
    });
  }

  // Règles de classement automatiques (L7) : UNIQUEMENT celles validées
  // avec l'option auto — non bloquant, chaque application est journalisée.
  try {
    const { runAutoRules } = await import('./rules.js');
    const auto = await runAutoRules(rec, progress);
    if (auto.moved > 0) progress(`Règles automatiques : ${auto.moved} mails rangés.`);
  } catch (err) {
    logger.warn('règles auto post-sync en échec', {
      account: rec.account,
      error: (err as Error).message,
    });
  }

  // Stratégies de rétention automatiques (A3) : UNIQUEMENT celles activées
  // ET cochées auto — non bloquant, chaque passage est journalisé.
  try {
    const { runAutoRetention } = await import('./retention.js');
    const auto = await runAutoRetention(rec, progress);
    if (auto.deleted > 0) progress(`Rétention automatique : ${auto.deleted} mails à la corbeille.`);
  } catch (err) {
    logger.warn('rétention auto post-sync en échec', {
      account: rec.account,
      error: (err as Error).message,
    });
  }

  // Quota de la boîte (taille max / utilisé) — non bloquant si le serveur
  // ne l'expose pas ou si la commande échoue. La NOTE (pourquoi inconnu) est
  // stockée sur le compte et affichée dans l'interface : « quota inconnu »
  // sans explication était indiagnosticable (retour utilisateur 01/08).
  let quota: { usedBytes: number; limitBytes: number } | null = null;
  let quotaNote: string | null = null;
  try {
    const diag = await imapService.fetchQuotaDiagnostic(rec);
    quota = diag.quota;
    quotaNote = diag.note;
    if (!quota) {
      logger.warn('quota non exposé par le serveur', { account: rec.account, note: quotaNote });
    }
  } catch (err) {
    quotaNote = `lecture du quota en échec : ${(err as Error).message}`;
    logger.warn('lecture du quota en échec (valeurs précédentes conservées)', {
      account: rec.account,
      error: (err as Error).message,
    });
  }

  await db.account.update({
    where: { slug: rec.account },
    data: {
      lastSyncAt: new Date(),
      quotaCheckedAt: new Date(),
      quotaNote,
      ...(quota
        ? { quotaUsedBytes: BigInt(quota.usedBytes), quotaLimitBytes: BigInt(quota.limitBytes) }
        : {}),
    },
  });

  report.durationMs = Date.now() - started;
  logger.info('sync terminée', { ...report, foldersSynced: report.foldersSynced.length });
  return report;
}

/**
 * Rattache les messages sans fil à un thread : d'abord par In-Reply-To
 * (chaînage exact), sinon par sujet normalisé, sinon nouveau fil.
 */
/**
 * Rattache ce qui dépend d'un mail DÉPLACÉ (P0.1).
 *
 * IMAP n'a pas de notion de « déplacement » : le mail disparaît du dossier
 * source (nouvel UID ailleurs). Sans traitement, une tâche, une échéance, un
 * verdict de qualité ou un report de réponse rattaché à l'ancienne ligne
 * pointerait dans le vide — l'utilisateur verrait « mail introuvable » après
 * un simple rangement, y compris quand c'est NOTRE règle de classement qui a
 * déplacé le mail.
 *
 * On identifie le mail par son en-tête Message-ID (`internetMessageId`), stable
 * quel que soit le dossier, et on repointe les références vers la ligne vivante.
 * L'ancienne ligne reste en place (isDeleted) : c'est une trace, exclue de tous
 * les écrans.
 */
export async function reconcileMoves(accountSlug: string, goneIds: number[]): Promise<number> {
  let moved = 0;
  for (const ids of chunk(goneIds, 500)) {
    const gone = await db.message.findMany({
      where: { id: { in: ids }, isDeleted: true, internetMessageId: { not: null } },
      select: { id: true, internetMessageId: true },
    });
    if (gone.length === 0) continue;

    // Le même Message-ID, toujours vivant ailleurs = le mail a été déplacé.
    const live = await db.message.findMany({
      where: {
        accountSlug,
        isDeleted: false,
        internetMessageId: { in: gone.map((g) => g.internetMessageId as string) },
      },
      select: { id: true, uid: true, internetMessageId: true, folder: { select: { path: true } } },
    });
    if (live.length === 0) continue;
    const liveByMsgId = new Map(live.map((m) => [m.internetMessageId as string, m]));

    for (const g of gone) {
      const target = liveByMsgId.get(g.internetMessageId as string);
      if (!target || target.id === g.id) continue;
      await relinkMessageReferences(g.id, target);
      moved++;
    }
  }
  return moved;
}

/** Repointe les références d'un mail vers sa nouvelle ligne (voir reconcileMoves). */
async function relinkMessageReferences(
  oldId: number,
  target: { id: number; uid: number; folder: { path: string } },
): Promise<void> {
  // Les contraintes d'unicité (une échéance par mail+date, un verdict par
  // moteur+mail) peuvent déjà être prises côté cible : dans ce cas on laisse
  // l'ancienne référence telle quelle plutôt que de faire échouer la sync.
  const safeUpdate = async (label: string, run: () => Promise<unknown>) => {
    try {
      await run();
    } catch (err) {
      logger.warn('rattachement partiel', { label, oldId, newId: target.id, error: (err as Error).message });
    }
  };

  await safeUpdate('tasks', () =>
    db.task.updateMany({
      where: { messageId: oldId },
      // folder/uid sont dénormalisés pour ouvrir le mail source : à remettre à jour.
      data: { messageId: target.id, folder: target.folder.path, uid: target.uid },
    }),
  );
  await safeUpdate('deadlines', () =>
    db.deadline.updateMany({ where: { messageId: oldId }, data: { messageId: target.id } }),
  );
  await safeUpdate('attention', () =>
    db.attentionState.updateMany({ where: { messageId: oldId }, data: { messageId: target.id } }),
  );
  await safeUpdate('feedback', () =>
    db.analysisFeedback.updateMany({ where: { messageId: oldId }, data: { messageId: target.id } }),
  );
  // Le candidat comptable suit son mail (l'unicité accountSlug+messageId peut
  // être prise si les deux lignes ont chacune un candidat : safeUpdate ignore).
  await safeUpdate('accounting', () =>
    db.accountingCandidate.updateMany({ where: { messageId: oldId }, data: { messageId: target.id } }),
  );
}

export async function linkThreads(accountSlug: string): Promise<number> {
  const orphans = await db.message.findMany({
    where: { accountSlug, threadId: null },
    orderBy: { date: 'asc' },
    select: {
      id: true,
      internetMessageId: true,
      inReplyTo: true,
      normalizedSubject: true,
      date: true,
      isOutbound: true,
    },
  });
  if (orphans.length === 0) return 0;

  // Cartes en mémoire pour éviter 2 requêtes par message.
  const linked = await db.message.findMany({
    where: { accountSlug, threadId: { not: null } },
    select: { internetMessageId: true, normalizedSubject: true, threadId: true },
  });
  const byMsgId = new Map<string, number>();
  const bySubject = new Map<string, number>();
  for (const m of linked) {
    if (m.internetMessageId && m.threadId) byMsgId.set(m.internetMessageId, m.threadId);
    if (m.normalizedSubject && m.threadId) bySubject.set(m.normalizedSubject, m.threadId);
  }

  const touchedThreads = new Set<number>();
  const threadLatest = new Map<number, { date: Date | null; isOutbound: boolean }>();

  for (const msg of orphans) {
    let threadId: number | undefined;
    if (msg.inReplyTo && byMsgId.has(msg.inReplyTo)) {
      threadId = byMsgId.get(msg.inReplyTo);
    } else if (msg.normalizedSubject && bySubject.has(msg.normalizedSubject)) {
      threadId = bySubject.get(msg.normalizedSubject);
    }
    if (threadId === undefined) {
      const thread = await db.thread.create({
        data: { accountSlug, normalizedSubject: msg.normalizedSubject },
      });
      threadId = thread.id;
    }
    await db.message.update({ where: { id: msg.id }, data: { threadId } });
    if (msg.internetMessageId) byMsgId.set(msg.internetMessageId, threadId);
    if (msg.normalizedSubject) bySubject.set(msg.normalizedSubject, threadId);
    touchedThreads.add(threadId);
    const latest = threadLatest.get(threadId);
    if (!latest || (msg.date && latest.date && msg.date > latest.date) || !latest.date) {
      threadLatest.set(threadId, { date: msg.date, isOutbound: msg.isOutbound });
    }
  }

  // Agrégats des fils touchés.
  for (const ids of chunk([...touchedThreads], 500)) {
    const aggs = await db.message.groupBy({
      by: ['threadId'],
      where: { threadId: { in: ids }, isDeleted: false },
      _count: { _all: true },
      _min: { date: true },
      _max: { date: true },
    });
    for (const agg of aggs) {
      if (agg.threadId === null) continue;
      const latest = threadLatest.get(agg.threadId);
      await db.thread.update({
        where: { id: agg.threadId },
        data: {
          messageCount: agg._count._all,
          firstMessageAt: agg._min.date,
          lastMessageAt: agg._max.date,
          ...(latest ? { lastDirection: latest.isOutbound ? 'outbound' : 'inbound' } : {}),
        },
      });
    }
  }

  return orphans.length;
}

/** Valeur date brute SQLite (Prisma stocke les DateTime en numérique) → Date. */
function rawToDate(v: string | number | bigint | null): Date | null {
  if (v === null || v === undefined) return null;
  const d = typeof v === 'string' ? new Date(v) : new Date(Number(v));
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Classification déterministe d'un expéditeur (Sender.kind, Phase 4 L1) :
 *  - newsletter    : ≥ 80 % de ses mails portent un lien de désinscription ;
 *  - notification  : adresse automatique (no-reply, mailer-daemon…) ;
 *  - person        : au moins un fil avec lui contient un message sortant
 *                    (vraie conversation) ;
 *  - company       : le reste (services, boutiques, plateformes…).
 * v1 : recalculée à chaque sync (un kind posé à la main serait écrasé — assumé,
 * aucun outil ne permet encore de le poser à la main).
 */
function classifySenderKind(
  email: string,
  messageCount: number,
  unsubscribeCount: number,
  conversational: Set<string>,
): string {
  if (messageCount > 0 && unsubscribeCount / messageCount >= 0.8) return 'newsletter';
  if (AUTO_SENDER_RE.test(email)) return 'notification';
  if (conversational.has(email)) return 'person';
  return 'company';
}

/** Recalcule les agrégats Sender depuis l'index des messages (entrants). */
export async function rebuildSenders(accountSlug: string): Promise<number> {
  type Row = {
    fromEmail: string;
    fromName: string | null;
    cnt: bigint;
    unseen: bigint;
    unsub: bigint;
    size: bigint | null;
    first: string | number | bigint | null;
    last: string | number | bigint | null;
  };
  // La CORBEILLE et le SPAM sont exclus du comptage (10/08). Sans ça,
  // l'écran Nettoyage affichait « Brico Privé — 615 mails » sur Altoen alors
  // qu'il n'en restait 3 en boîte de réception : les 623 autres étaient DÉJÀ
  // à la corbeille. Il proposait donc de nettoyer la poubelle, et gonflait
  // toutes les estimations (« X mails récupérables ») d'autant.
  const rows = await db.$queryRaw<Row[]>`
    SELECT m.fromEmail                                       AS fromEmail,
           MAX(m.fromName)                                   AS fromName,
           COUNT(*)                                          AS cnt,
           SUM(CASE WHEN m.isSeen = 0 THEN 1 ELSE 0 END)     AS unseen,
           SUM(CASE WHEN m.hasListUnsubscribe = 1 THEN 1 ELSE 0 END) AS unsub,
           SUM(m.sizeBytes)                                  AS size,
           MIN(m.date)                                       AS first,
           MAX(m.date)                                       AS last
    FROM Message m
    JOIN Folder f ON f.id = m.folderId
    WHERE m.accountSlug = ${accountSlug}
      AND m.isDeleted = 0
      AND m.isOutbound = 0
      AND m.fromEmail IS NOT NULL
      AND f.role NOT IN ('trash', 'spam')
    GROUP BY m.fromEmail
  `;

  // Expéditeurs « en conversation » : au moins un de leurs fils contient un
  // message sortant de l'utilisateur.
  const conversationalRows = await db.$queryRaw<{ fromEmail: string }[]>`
    SELECT DISTINCT m.fromEmail
    FROM Message m
    WHERE m.accountSlug = ${accountSlug}
      AND m.isDeleted = 0
      AND m.isOutbound = 0
      AND m.fromEmail IS NOT NULL
      AND m.threadId IN (
        SELECT threadId FROM Message
        WHERE accountSlug = ${accountSlug}
          AND isDeleted = 0
          AND isOutbound = 1
          AND threadId IS NOT NULL
      )
  `;
  const conversational = new Set(conversationalRows.map((r) => r.fromEmail));

  // Catégories posées à la main (A1) ou par l'analyse IA (C2) : jamais
  // écrasées par le recalcul heuristique. Précédence manual > ai > auto — sans
  // 'ai' ici, la sync suivante effacerait le travail du rattrapage.
  const manual = new Set(
    (
      await db.sender.findMany({
        where: { accountSlug, categorySource: { in: ['manual', 'ai'] } },
        select: { email: true },
      })
    ).map((s) => s.email),
  );

  const present = new Set<string>();
  for (const r of rows) {
    present.add(r.fromEmail);
    const domain = r.fromEmail.includes('@') ? r.fromEmail.split('@')[1] : null;
    const kind = classifySenderKind(r.fromEmail, Number(r.cnt), Number(r.unsub), conversational);
    const cat = categorizeSender({
      email: r.fromEmail,
      displayName: r.fromName,
      messageCount: Number(r.cnt),
      unsubscribeCount: Number(r.unsub),
      conversational: conversational.has(r.fromEmail),
    });
    const autoCategory = manual.has(r.fromEmail)
      ? {}
      : { category: cat.category, categoryReason: cat.reason };
    await db.sender.upsert({
      where: { accountSlug_email: { accountSlug, email: r.fromEmail } },
      create: {
        accountSlug,
        email: r.fromEmail,
        displayName: r.fromName,
        domain,
        messageCount: Number(r.cnt),
        unseenCount: Number(r.unseen),
        unsubscribeCount: Number(r.unsub),
        totalSizeBytes: BigInt(r.size ?? 0),
        firstMessageAt: rawToDate(r.first),
        lastMessageAt: rawToDate(r.last),
        kind,
        category: cat.category,
        categoryReason: cat.reason,
      },
      update: {
        displayName: r.fromName ?? undefined,
        domain,
        messageCount: Number(r.cnt),
        unseenCount: Number(r.unseen),
        unsubscribeCount: Number(r.unsub),
        totalSizeBytes: BigInt(r.size ?? 0),
        firstMessageAt: rawToDate(r.first),
        lastMessageAt: rawToDate(r.last),
        kind,
        ...autoCategory,
      },
    });
  }

  // Expéditeurs qui n'ont plus aucun message indexé : compteurs à zéro, mais on
  // conserve la fiche (kind/category/notes seront enrichis en Phase 4).
  await db.sender.updateMany({
    where: { accountSlug, email: { notIn: [...present] } },
    data: { messageCount: 0, unseenCount: 0, unsubscribeCount: 0, totalSizeBytes: 0 },
  });

  // Engagement pré-calculé (P2.1) : c'est ICI qu'on paie le coût, une fois,
  // plutôt que dans chaque simulation de stratégie. Non bloquant — une base
  // sans `engagedAt` protège moins mais ne casse rien, et la protection
  // absolue (étoilé, tâche, échéance) reste posée par ailleurs.
  try {
    const { computeSenderEngagement } = await import('./retention.js');
    await computeSenderEngagement(accountSlug);
  } catch (err) {
    logger.warn('engagement des expéditeurs non recalculé', {
      accountSlug,
      error: (err as Error).message,
    });
  }

  return rows.length;
}
