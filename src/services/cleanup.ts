import { db, ensureDbReady } from '../db/client.js';
import { imapService } from './imap.js';
import { rebuildSenders } from './sync.js';
import { recordOperation } from './oplog.js';
import type { AccountRecord } from './accounts.js';

/**
 * Cleanup Engine — version 1 (heuristiques déterministes, SPEC V2 §8.8).
 * Propose des candidats au nettoyage à partir de l'index, avec niveau de
 * risque et justification (`reason`). AUCUNE action ici : lecture seule,
 * l'exécution passe par les tools de suppression avec leurs garde-fous.
 */

export interface CleanupCandidate {
  sender: string;
  senderName: string;
  messageCount: number;
  unseenCount: number;
  totalSizeBytes: number;
  unsubscribePct: number;
  oldestMessageAt: string | null;
  newestMessageAt: string | null;
  riskLevel: 'safe' | 'medium';
  reason: string;
  /** Mails porteurs d'une pièce (facture, ticket…) — jamais dans l'estimation. */
  keepCount: number;
  /** Ce qui peut réellement partir : messageCount − keepCount. */
  deletableCount: number;
}

export async function getCleanupCandidates(
  account: string,
  opts: { minCount?: number } = {},
): Promise<{ candidates: CleanupCandidate[]; totalDeletableEstimate: number }> {
  await ensureDbReady();
  const minCount = opts.minCount ?? 10;

  const senders = await db.sender.findMany({
    where: { accountSlug: account, messageCount: { gte: minCount } },
    orderBy: { messageCount: 'desc' },
  });

  // Combien de mails « à conserver » chaque expéditeur a-t-il envoyés ?
  // Une seule requête groupée : un expéditeur publicitaire qui envoie aussi
  // tes tickets ne doit pas afficher un total de suppressions gonflé.
  const keepRows = senders.length
    ? await db.message.groupBy({
        by: ['fromEmail'],
        where: {
          accountSlug: account,
          isDeleted: false,
          fromEmail: { in: senders.map((s) => s.email) },
          OR: [{ hasAttachments: true }, { intent: { in: ['invoice', 'document'] } }],
        },
        _count: { _all: true },
      })
    : [];
  const keepBySender = new Map(keepRows.map((r) => [r.fromEmail ?? '', r._count._all]));

  const candidates: CleanupCandidate[] = [];
  for (const s of senders) {
    const unsubPct = s.messageCount
      ? Math.round((s.unsubscribeCount / s.messageCount) * 100)
      : 0;
    const unreadPct = s.messageCount ? s.unseenCount / s.messageCount : 0;

    let riskLevel: 'safe' | 'medium' | null = null;
    const reasons: string[] = [];

    if (unsubPct >= 80) {
      riskLevel = 'safe';
      reasons.push(`${unsubPct}% des mails portent un lien de désinscription (newsletter/notification)`);
    } else if (unsubPct >= 40) {
      riskLevel = 'medium';
      reasons.push(`${unsubPct}% de mails type newsletter`);
    }

    if (riskLevel && unreadPct >= 0.8) {
      reasons.push(`${Math.round(unreadPct * 100)}% jamais lus`);
    }

    if (!riskLevel) continue;
    const keepCount = keepBySender.get(s.email) ?? 0;
    if (keepCount > 0) {
      reasons.push(`${keepCount} mail(s) porteurs d'une pièce sont mis de côté`);
    }
    candidates.push({
      keepCount,
      deletableCount: Math.max(0, s.messageCount - keepCount),
      sender: s.email,
      senderName: s.displayName ?? '',
      messageCount: s.messageCount,
      unseenCount: s.unseenCount,
      totalSizeBytes: Number(s.totalSizeBytes),
      unsubscribePct: unsubPct,
      oldestMessageAt: s.firstMessageAt?.toISOString() ?? null,
      newestMessageAt: s.lastMessageAt?.toISOString() ?? null,
      riskLevel,
      reason: reasons.join(' ; '),
    });
  }

  return {
    candidates,
    totalDeletableEstimate: candidates
      .filter((c) => c.riskLevel === 'safe')
      .reduce((sum, c) => sum + c.deletableCount, 0),
  };
}

// ---------------------------------------------------------------------------
// Aperçu + exécution du nettoyage d'un expéditeur (interface web, passe 2)
// ---------------------------------------------------------------------------

export interface SenderCleanupPreview {
  sender: string;
  folder: string;
  count: number;
  totalSizeBytes: number;
  oldestMessageAt: string | null;
  newestMessageAt: string | null;
  sampleSubjects: string[];
}

/** Aperçu instantané depuis l'index : ce qui SERAIT déplacé en corbeille. */
export async function previewSenderCleanup(
  account: string,
  folder: string,
  sender: string,
): Promise<SenderCleanupPreview> {
  await ensureDbReady();
  const f = await db.folder.findUnique({
    where: { accountSlug_path: { accountSlug: account, path: folder } },
    select: { id: true },
  });
  if (!f) throw new Error(`Dossier "${folder}" absent de l'index.`);

  const where = { folderId: f.id, isDeleted: false, fromEmail: sender.toLowerCase() };
  const [agg, samples] = await Promise.all([
    db.message.aggregate({
      where,
      _count: { _all: true },
      _sum: { sizeBytes: true },
      _min: { date: true },
      _max: { date: true },
    }),
    db.message.findMany({
      where,
      orderBy: { date: 'desc' },
      take: 10,
      select: { subject: true },
    }),
  ]);

  return {
    sender,
    folder,
    count: agg._count._all,
    totalSizeBytes: agg._sum.sizeBytes ?? 0,
    oldestMessageAt: agg._min.date?.toISOString() ?? null,
    newestMessageAt: agg._max.date?.toISOString() ?? null,
    sampleSubjects: samples.map((s) => s.subject ?? '(sans sujet)'),
  };
}

// ---------------------------------------------------------------------------
// Classification par MESSAGE : automatique vs possiblement personnel.
// Un même expéditeur peut envoyer les deux (ex. une banque : relevés
// automatiques ET messages du conseiller). Par prudence, tout mail SANS
// marqueur d'automatisation est classé « personnel ».
// ---------------------------------------------------------------------------

const AUTO_SENDER_RE =
  /(no-?reply|nepasrepondre|ne-pas-repondre|donotreply|do-not-reply|notification|mailer-daemon|newsletter|automat)/i;

export interface CleanupMessage {
  uid: number;
  subject: string;
  date: string | null;
  isSeen: boolean;
  sizeBytes: number;
  /**
   * `document` = mail porteur d'une pièce (ticket, facture, attestation) :
   * jamais coché par défaut, même quand l'expéditeur est un robot publicitaire.
   */
  kind: 'auto' | 'personal' | 'document';
  /** Pourquoi ce classement (affiché dans l'interface). */
  signals: string[];
}

/**
 * Un mail « porteur de document » se reconnaît à sa NATURE, pas à son
 * expéditeur — c'est tout l'enjeu du retour utilisateur du 29/07 :
 * no_reply@leroymerlin.fr envoie les soldes ET les tickets de caisse.
 * Signaux (index seulement) : une pièce jointe, une intention facture/document,
 * ou un sujet qui nomme une pièce.
 */
const DOCUMENT_SUBJECT_RE =
  /(factur|(votre|vos|ton) ticket|ticket de caisse|ticket n[°o]|re[çc]u de|votre re[çc]u|bon d'achat|bon de commande|attestation|contrat|devis|justificatif|garantie|remboursement|avoir\b|duplicata|certificat|relev[ée]|bulletin)/i;

export function documentSignals(m: {
  subject?: string | null;
  intent?: string | null;
  hasAttachments?: boolean | null;
  attachmentCount?: number | null;
}): string[] {
  const out: string[] = [];
  if (m.hasAttachments) {
    const n = m.attachmentCount ?? 0;
    out.push(n > 1 ? `📎 ${n} pièces jointes` : '📎 pièce jointe');
  }
  if (m.intent === 'invoice') out.push('facture ou paiement');
  else if (m.intent === 'document') out.push('document (ticket, attestation…)');
  if (out.length === 0 && DOCUMENT_SUBJECT_RE.test(m.subject ?? '')) {
    out.push('le sujet annonce une pièce à conserver');
  }
  return out;
}

/**
 * Liste complète et classée des mails d'un expéditeur dans un dossier
 * (depuis l'index — instantané, ne touche à rien).
 */
export async function listCleanupMessages(
  account: string,
  folder: string,
  sender: string,
  limit = 2000,
): Promise<{ messages: CleanupMessage[]; total: number; truncated: boolean }> {
  await ensureDbReady();
  const f = await db.folder.findUnique({
    where: { accountSlug_path: { accountSlug: account, path: folder } },
    select: { id: true },
  });
  if (!f) throw new Error(`Dossier "${folder}" absent de l'index.`);

  const where = { folderId: f.id, isDeleted: false, fromEmail: sender.toLowerCase() };
  const total = await db.message.count({ where });
  const msgs = await db.message.findMany({
    where,
    orderBy: { date: 'desc' },
    take: limit,
    select: {
      uid: true,
      subject: true,
      date: true,
      isSeen: true,
      isAnswered: true,
      isFlagged: true,
      hasListUnsubscribe: true,
      sizeBytes: true,
      threadId: true,
      fromEmail: true,
      hasAttachments: true,
      attachmentCount: true,
      intent: true,
    },
  });

  // Fils dans lesquels l'utilisateur a écrit → conversation personnelle.
  const threadIds = [...new Set(msgs.map((m) => m.threadId).filter((t): t is number => t !== null))];
  const outbound = threadIds.length
    ? await db.message.findMany({
        where: { accountSlug: account, isOutbound: true, threadId: { in: threadIds } },
        select: { threadId: true },
        distinct: ['threadId'],
      })
    : [];
  const conversationThreads = new Set(outbound.map((o) => o.threadId));

  const messages: CleanupMessage[] = msgs.map((m) => {
    const signals: string[] = [];
    if (m.isAnswered) signals.push('tu y as répondu');
    if (m.isFlagged) signals.push('marqué/suivi');
    if (m.threadId && conversationThreads.has(m.threadId)) signals.push('conversation avec toi');
    if (/^(re|tr|fwd?|aw)\s*:/i.test(m.subject ?? '')) signals.push('sujet de réponse');
    const personal = signals.length > 0;

    // Un mail qui porte une pièce passe AVANT le classement « automatique » :
    // l'expéditeur peut être un robot, le contenu se garde quand même.
    const docs = personal ? [] : documentSignals(m);
    const isDocument = docs.length > 0;
    if (isDocument) signals.push(...docs);

    if (!personal && !isDocument) {
      if (m.hasListUnsubscribe) signals.push('lien de désinscription');
      if (AUTO_SENDER_RE.test(m.fromEmail ?? '')) signals.push('expéditeur automatique');
    }
    const auto = !personal && !isDocument && signals.length > 0;
    if (!personal && !isDocument && !auto) signals.push("aucun marqueur d'automatisation");

    return {
      uid: m.uid,
      subject: m.subject ?? '(sans sujet)',
      date: m.date?.toISOString() ?? null,
      isSeen: m.isSeen,
      sizeBytes: m.sizeBytes,
      kind: isDocument ? 'document' : auto ? 'auto' : 'personal',
      signals,
    };
  });

  return { messages, total, truncated: total > limit };
}

const CLEANUP_BATCH = 200;

/**
 * Parmi ces UIDs, lesquels portent une pièce à conserver ? (index seulement)
 * Sert de filet quand on nettoie « tout un expéditeur » sans sélection fine.
 */
export async function documentUidsOf(
  account: string,
  folder: string,
  uids: number[],
): Promise<Set<number>> {
  const keep = new Set<number>();
  if (uids.length === 0) return keep;
  const f = await db.folder.findUnique({
    where: { accountSlug_path: { accountSlug: account, path: folder } },
    select: { id: true },
  });
  if (!f) return keep;
  for (let i = 0; i < uids.length; i += 900) {
    const rows = await db.message.findMany({
      where: { folderId: f.id, uid: { in: uids.slice(i, i + 900) } },
      select: {
        uid: true,
        subject: true,
        intent: true,
        hasAttachments: true,
        attachmentCount: true,
      },
    });
    for (const r of rows) {
      if (documentSignals(r).length > 0) keep.add(r.uid);
    }
  }
  return keep;
}

/**
 * Exécute le nettoyage d'un expéditeur : déplacement vers la corbeille par
 * lots de 200, journalisation de chaque lot, puis mise à jour de l'index.
 * Jamais d'EXPUNGE — récupérable ~30 j.
 *
 * Si `selectedUids` est fourni (sélection fine dans l'interface), seuls ces
 * mails sont traités — après validation qu'ils appartiennent bien à cet
 * expéditeur dans ce dossier (aucun UID arbitraire ne peut passer).
 * Sinon : tous les mails de l'expéditeur (recherche IMAP = vérité serveur).
 */
export async function executeSenderCleanup(
  rec: AccountRecord,
  folder: string,
  sender: string,
  progress: (message: string) => void,
  selectedUids?: number[],
): Promise<{ deleted: number; batches: number; destination: string }> {
  let uids: number[];
  if (selectedUids?.length) {
    progress(`Validation de la sélection (${selectedUids.length} mails)…`);
    const f = await db.folder.findUnique({
      where: { accountSlug_path: { accountSlug: rec.account, path: folder } },
      select: { id: true },
    });
    if (!f) throw new Error(`Dossier "${folder}" absent de l'index.`);
    const valid = await db.message.findMany({
      where: {
        folderId: f.id,
        isDeleted: false,
        fromEmail: sender.toLowerCase(),
        uid: { in: selectedUids },
      },
      select: { uid: true },
    });
    uids = valid.map((v) => v.uid);
    if (uids.length < selectedUids.length) {
      progress(
        `${selectedUids.length - uids.length} mails écartés (n'appartiennent pas à cet expéditeur/dossier).`,
      );
    }
  } else {
    progress(`Recherche des mails de ${sender} sur le serveur…`);
    uids = await imapService.searchUids(rec, folder, { from: sender });
    // Garde-fou : « tout l'expéditeur » ne veut PAS dire ses factures et ses
    // tickets. On retire de la liste les mails porteurs d'une pièce, connus
    // par l'index (retour utilisateur 29/07 — pubs et tickets de caisse
    // partagent la même adresse no_reply).
    const kept = await documentUidsOf(rec.account, folder, uids);
    if (kept.size > 0) {
      uids = uids.filter((u) => !kept.has(u));
      progress(
        `${kept.size} mail(s) mis de côté : ils portent une pièce (facture, ticket, document).`,
      );
    }
  }
  if (uids.length === 0) {
    progress('Aucun mail à traiter.');
    return { deleted: 0, batches: 0, destination: '' };
  }
  progress(`${uids.length} mails à déplacer vers la corbeille, par lots de ${CLEANUP_BATCH}.`);

  // Nom affiché + sujets/dates depuis l'index, pour un journal qui dit
  // exactement QUI et QUOI (pas juste un compteur).
  const senderRow = await db.sender.findUnique({
    where: { accountSlug_email: { accountSlug: rec.account, email: sender.toLowerCase() } },
    select: { displayName: true },
  });
  const senderName = senderRow?.displayName ?? sender;
  const detailMap = new Map<number, { subject: string; date: string | null }>();
  const folderRow = await db.folder.findUnique({
    where: { accountSlug_path: { accountSlug: rec.account, path: folder } },
    select: { id: true },
  });
  if (folderRow) {
    for (let i = 0; i < uids.length; i += 900) {
      const rows = await db.message.findMany({
        where: { folderId: folderRow.id, uid: { in: uids.slice(i, i + 900) } },
        select: { uid: true, subject: true, date: true },
      });
      for (const r of rows) {
        detailMap.set(r.uid, {
          subject: r.subject ?? '(sans sujet)',
          date: r.date?.toISOString() ?? null,
        });
      }
    }
  }

  const batches = [];
  for (let i = 0; i < uids.length; i += CLEANUP_BATCH) batches.push(uids.slice(i, i + CLEANUP_BATCH));

  let deleted = 0;
  let destination = '';
  const movedUids: number[] = [];
  try {
    for (let i = 0; i < batches.length; i++) {
      const batch = batches[i];
      const res = await imapService.moveToTrash(rec, folder, batch);
      destination = res.destination;
      deleted += res.moved;
      movedUids.push(...batch);
      progress(`Lot ${i + 1}/${batches.length} : ${res.moved} mails → ${res.destination}`);
    }
  } finally {
    // UNE entrée de journal pour toute l'opération (les lots de 200 restent un
    // garde-fou d'exécution IMAP, pas une unité d'historique) — avec la liste
    // complète des mails réellement déplacés, même en cas d'échec en cours.
    if (movedUids.length) {
      await recordOperation({
        account: rec.account,
        tool: 'ui_cleanup_sender',
        folder,
        dryRun: false,
        params: {
          sender,
          senderName,
          count: movedUids.length,
          batches: batches.length,
          destination,
        },
        affectedUids: movedUids,
        items: movedUids.map(
          (uid) => detailMap.get(uid) ?? { subject: '(hors index)', date: null },
        ),
        result: `soft-deleted ${deleted} -> ${destination}`,
      });
    }
  }

  // Mise à jour de l'index (sans attendre la prochaine sync).
  progress("Mise à jour de l'index local…");
  const f = await db.folder.findUnique({
    where: { accountSlug_path: { accountSlug: rec.account, path: folder } },
    select: { id: true },
  });
  if (f) {
    for (let i = 0; i < movedUids.length; i += 900) {
      await db.message.updateMany({
        where: { folderId: f.id, uid: { in: movedUids.slice(i, i + 900) } },
        data: { isDeleted: true },
      });
    }
    const [messageCount, unseenCount] = await Promise.all([
      db.message.count({ where: { folderId: f.id, isDeleted: false } }),
      db.message.count({ where: { folderId: f.id, isDeleted: false, isSeen: false } }),
    ]);
    await db.folder.update({ where: { id: f.id }, data: { messageCount, unseenCount } });
    await rebuildSenders(rec.account);
  }

  progress(`✅ Terminé : ${deleted} mails déplacés vers ${destination} (récupérables ~30 jours).`);
  return { deleted, batches: batches.length, destination };
}
