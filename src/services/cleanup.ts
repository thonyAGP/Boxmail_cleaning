import { db, ensureDbReady } from '../db/client.js';

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
