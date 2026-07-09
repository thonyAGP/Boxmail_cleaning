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
    candidates.push({
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
      .reduce((sum, c) => sum + c.messageCount, 0),
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

const CLEANUP_BATCH = 200;

/**
 * Exécute le nettoyage d'un expéditeur : recherche IMAP (vérité serveur),
 * déplacement vers la corbeille par lots de 200, journalisation de chaque lot,
 * puis mise à jour de l'index. Jamais d'EXPUNGE — récupérable ~30 j.
 */
export async function executeSenderCleanup(
  rec: AccountRecord,
  folder: string,
  sender: string,
  progress: (message: string) => void,
): Promise<{ deleted: number; batches: number; destination: string }> {
  progress(`Recherche des mails de ${sender} sur le serveur…`);
  const uids = await imapService.searchUids(rec, folder, { from: sender });
  if (uids.length === 0) {
    progress('Aucun mail trouvé côté serveur (déjà nettoyé ?).');
    return { deleted: 0, batches: 0, destination: '' };
  }
  progress(`${uids.length} mails à déplacer vers la corbeille, par lots de ${CLEANUP_BATCH}.`);

  const batches = [];
  for (let i = 0; i < uids.length; i += CLEANUP_BATCH) batches.push(uids.slice(i, i + CLEANUP_BATCH));

  let deleted = 0;
  let destination = '';
  const movedUids: number[] = [];
  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    const res = await imapService.moveToTrash(rec, folder, batch);
    destination = res.destination;
    deleted += res.moved;
    movedUids.push(...batch);
    await recordOperation({
      account: rec.account,
      tool: 'ui_cleanup_sender',
      folder,
      dryRun: false,
      params: { sender, batch: `${i + 1}/${batches.length}`, count: batch.length },
      affectedUids: batch,
      result: `soft-deleted ${res.moved} -> ${res.destination}`,
    });
    progress(`Lot ${i + 1}/${batches.length} : ${res.moved} mails → ${res.destination}`);
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
