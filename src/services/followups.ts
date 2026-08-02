import { db, ensureDbReady } from '../db/client.js';
import {
  AUTO_SENDER_RE,
  IMPORTANT_SENDER_RE,
  URGENT_SUBJECT_RE,
  chunk,
  humanDelay,
  type ReplyCategory,
  type ReplyState,
} from './attention.js';

/**
 * Follow-up Engine — Phase 4, brique 2 : RELANCES (SPEC V2 §8.5, type B).
 *
 * Détecte, depuis l'index local, les fils où l'utilisateur a écrit en dernier
 * et attend une réponse externe : dernier message du fil SORTANT, envoyé à un
 * correspondant humain (pas de no-reply), sans retour depuis.
 *
 * Seuils (plus longs que les réponses : on laisse le temps de répondre) :
 * sujet pressant 3 j · banque/admin/pro 5 j · normal 7 j. Chaque élément porte
 * une `reason` explicite. Reporter/traiter réutilise AttentionState
 * (kind=followup) : un état devient caduc si un nouveau message arrive.
 */

export interface FollowupItem {
  account: string;
  threadId: number;
  /** id interne (Message.id) du mail envoyé — sert au suivi d'état. */
  messageId: number;
  uid: number;
  folder: string;
  /** Correspondant dont on attend la réponse. */
  counterpartyEmail: string;
  counterpartyName: string | null;
  subject: string;
  /** Date d'envoi du dernier message (le tien). */
  date: string;
  threadMessageCount: number;
  /** true si le fil contient au moins un mail reçu (vraie conversation). */
  hasInbound: boolean;
  category: ReplyCategory;
  categoryLabel: string;
  thresholdHours: number;
  waitingHours: number;
  overdue: boolean;
  /** Escalade pilotée (A5) : l'outil dit OÙ EN EST la relance. */
  stage: FollowupStage;
  stageLabel: string;
  /** Ce que l'assistant suggère de faire, en français. */
  suggestion: string;
  reason: string;
  state: ReplyState;
  snoozedUntil: string | null;
}

// waiting (seuil pas atteint) → due (à relancer) → urgent (2× le seuil) →
// stale (30 j sans réponse : probablement abandonné — clôturer ?).
export type FollowupStage = 'waiting' | 'due' | 'urgent' | 'stale';

const STALE_HOURS = 30 * 24;

const STAGE_LABELS: Record<FollowupStage, string> = {
  waiting: 'en attente',
  due: 'à relancer',
  urgent: 'urgent',
  stale: 'probablement abandonné',
};

const STAGE_SUGGESTIONS: Record<FollowupStage, string> = {
  waiting: 'Laisse-lui encore un peu de temps.',
  due: 'Envoie une relance polie.',
  urgent: 'Relance sans attendre — deux fois le délai est passé.',
  stale: 'Relance une dernière fois, ou clôture (bouton ✓ Traité).',
};

function followupStage(waitingHours: number, thresholdHours: number): FollowupStage {
  if (waitingHours > STALE_HOURS) return 'stale';
  if (waitingHours > 2 * thresholdHours) return 'urgent';
  if (waitingHours > thresholdHours) return 'due';
  return 'waiting';
}

export interface FollowupsOptions {
  scope?: 'all' | 'overdue';
  sinceDays?: number;
  limit?: number;
  includeHidden?: boolean;
}

export interface FollowupsResult {
  account: string;
  sinceDays: number;
  counts: { active: number; overdue: number; snoozed: number; dismissed: number };
  items: FollowupItem[];
  truncated: boolean;
}

const THRESHOLDS: Record<ReplyCategory, number> = {
  urgent: 3 * 24,
  important: 5 * 24,
  normal: 7 * 24,
};

const CATEGORY_LABELS: Record<ReplyCategory, string> = {
  urgent: 'Sujet pressant',
  important: 'Banque / admin / pro',
  normal: 'Normal',
};

function parseToEmails(json: string | null): string[] {
  if (!json) return [];
  try {
    const arr = JSON.parse(json);
    return Array.isArray(arr) ? arr.filter((a): a is string => typeof a === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * Fils où l'utilisateur attend une réponse externe (il a écrit en dernier).
 */
export async function getFollowupsDue(
  account: string,
  opts: FollowupsOptions = {},
): Promise<FollowupsResult> {
  await ensureDbReady();
  const sinceDays = Math.min(Math.max(opts.sinceDays ?? 60, 1), 365);
  const limit = Math.min(Math.max(opts.limit ?? 200, 1), 1000);
  const since = new Date(Date.now() - sinceDays * 86_400_000);
  const now = Date.now();

  const accountRow = await db.account.findUnique({
    where: { slug: account },
    select: { emailAddress: true },
  });
  if (!accountRow) {
    throw new Error(`Compte « ${account} » non indexé — lancer d'abord une synchronisation.`);
  }
  const selfEmail = accountRow.emailAddress.toLowerCase();

  // 1. Candidats : derniers mails ENVOYÉS (dossier Éléments envoyés).
  const raw = await db.message.findMany({
    where: {
      accountSlug: account,
      isDeleted: false,
      isOutbound: true,
      threadId: { not: null },
      date: { gte: since },
      folder: { is: { role: 'sent' } },
    },
    orderBy: { date: 'desc' },
    select: {
      id: true,
      threadId: true,
      uid: true,
      subject: true,
      toEmails: true,
      date: true,
      folder: { select: { path: true } },
    },
  });

  // Un candidat par fil : l'envoi le plus récent.
  const byThread = new Map<number, (typeof raw)[number]>();
  for (const m of raw) {
    if (m.threadId === null || m.date === null) continue;
    if (!byThread.has(m.threadId)) byThread.set(m.threadId, m);
  }
  const threadIds = [...byThread.keys()];

  // 2. Contexte des fils : dernier message toutes directions + dernier entrant
  //    (correspondant + savoir si une réponse est déjà arrivée).
  const lastAny = new Map<number, { max: Date | null; count: number }>();
  const lastInbound = new Map<
    number,
    { date: Date | null; fromEmail: string | null; fromName: string | null }
  >();
  for (const ids of chunk(threadIds, 500)) {
    const aggs = await db.message.groupBy({
      by: ['threadId'],
      // isAutoReply exclu : un répondeur automatique ne compte PAS comme une
      // réponse reçue — sans ça, il masquait la relance à faire (bug 02/08).
      where: { threadId: { in: ids }, isDeleted: false, isAutoReply: false },
      _max: { date: true },
      _count: { _all: true },
    });
    for (const a of aggs) {
      if (a.threadId !== null) lastAny.set(a.threadId, { max: a._max.date, count: a._count._all });
    }
    // Dernier entrant de chaque fil (pour le nom du correspondant).
    const inbounds = await db.message.findMany({
      where: { threadId: { in: ids }, isDeleted: false, isOutbound: false, isAutoReply: false },
      orderBy: { date: 'desc' },
      select: { threadId: true, date: true, fromEmail: true, fromName: true },
    });
    for (const m of inbounds) {
      if (m.threadId !== null && !lastInbound.has(m.threadId)) {
        lastInbound.set(m.threadId, { date: m.date, fromEmail: m.fromEmail, fromName: m.fromName });
      }
    }
  }

  // 3. États utilisateur (reporté / traité).
  const states = new Map<
    number,
    { messageId: number; state: string; snoozedUntil: Date | null }
  >();
  for (const ids of chunk(threadIds, 500)) {
    const rows = await db.attentionState.findMany({
      where: { accountSlug: account, kind: 'followup', threadId: { in: ids } },
    });
    for (const r of rows) {
      states.set(r.threadId, {
        messageId: r.messageId,
        state: r.state,
        snoozedUntil: r.snoozedUntil,
      });
    }
  }

  // 4. Construction.
  const items: FollowupItem[] = [];
  for (const [threadId, m] of byThread) {
    const any = lastAny.get(threadId);
    if (!any?.max || !m.date) continue;
    // Quelqu'un a écrit après ton envoi (réponse reçue, ou tu as relancé et
    // c'est l'envoi plus récent qui est le candidat) → pas de relance ici.
    if (any.max.getTime() > m.date.getTime()) continue;

    // Correspondant : le dernier entrant du fil, sinon le destinataire du mail.
    const inbound = lastInbound.get(threadId);
    let counterpartyEmail = inbound?.fromEmail ?? null;
    let counterpartyName = inbound?.fromName ?? null;
    if (!counterpartyEmail) {
      counterpartyEmail =
        parseToEmails(m.toEmails).find((a) => a.toLowerCase() !== selfEmail) ?? null;
    }
    if (!counterpartyEmail) continue; // pas de destinataire exploitable
    if (counterpartyEmail.toLowerCase() === selfEmail) continue; // note à soi-même
    // Écrit à un automate (noreply, formulaire…) : aucune réponse à attendre.
    if (AUTO_SENDER_RE.test(counterpartyEmail)) continue;

    const subject = m.subject ?? '';
    let category: ReplyCategory = 'normal';
    let why = 'correspondant classique';
    const urgentMatch = URGENT_SUBJECT_RE.exec(subject);
    const importantMatch = IMPORTANT_SENDER_RE.exec(
      `${counterpartyEmail} ${counterpartyName ?? ''}`,
    );
    if (urgentMatch) {
      category = 'urgent';
      why = `sujet pressant (« ${urgentMatch[0]} »)`;
    } else if (importantMatch) {
      category = 'important';
      why = `correspondant type banque/administration/pro (« ${importantMatch[0]} »)`;
    }

    const thresholdHours = THRESHOLDS[category];
    const waitingHours = (now - m.date.getTime()) / 3_600_000;
    const overdue = waitingHours > thresholdHours;
    const hasInbound = Boolean(inbound);

    let state: ReplyState = 'active';
    let snoozedUntil: string | null = null;
    const st = states.get(threadId);
    if (st && st.messageId === m.id) {
      if (st.state === 'dismissed') state = 'dismissed';
      else if (st.state === 'snoozed' && st.snoozedUntil && st.snoozedUntil.getTime() > now) {
        state = 'snoozed';
        snoozedUntil = st.snoozedUntil.toISOString();
      }
    }

    const reasons = [
      `Tu as écrit en dernier il y a ${humanDelay(waitingHours)}, aucune réponse reçue depuis`,
      why,
      hasInbound ? 'conversation déjà engagée' : 'premier contact (jamais répondu)',
      overdue
        ? `délai de relance de ${humanDelay(thresholdHours)} dépassé`
        : `délai de ${humanDelay(thresholdHours)} pas encore atteint`,
    ];

    items.push({
      account,
      threadId,
      messageId: m.id,
      uid: m.uid,
      folder: m.folder.path,
      counterpartyEmail,
      counterpartyName,
      subject: subject || '(sans sujet)',
      date: m.date.toISOString(),
      threadMessageCount: any.count,
      hasInbound,
      category,
      categoryLabel: CATEGORY_LABELS[category],
      thresholdHours,
      waitingHours: Math.round(waitingHours * 10) / 10,
      overdue,
      stage: followupStage(waitingHours, thresholdHours),
      stageLabel: STAGE_LABELS[followupStage(waitingHours, thresholdHours)],
      suggestion: STAGE_SUGGESTIONS[followupStage(waitingHours, thresholdHours)],
      reason: reasons.join(' · '),
      state,
      snoozedUntil,
    });
  }

  const counts = {
    active: items.filter((i) => i.state === 'active').length,
    overdue: items.filter((i) => i.state === 'active' && i.overdue).length,
    snoozed: items.filter((i) => i.state === 'snoozed').length,
    dismissed: items.filter((i) => i.state === 'dismissed').length,
  };

  let filtered = items;
  if (!opts.includeHidden) filtered = filtered.filter((i) => i.state === 'active');
  if (opts.scope === 'overdue') {
    filtered = filtered.filter((i) => i.state !== 'active' || i.overdue);
  }

  filtered.sort((a, b) => {
    const aActive = a.state === 'active' ? 0 : 1;
    const bActive = b.state === 'active' ? 0 : 1;
    if (aActive !== bActive) return aActive - bActive;
    if (a.overdue !== b.overdue) return a.overdue ? -1 : 1;
    return new Date(a.date).getTime() - new Date(b.date).getTime();
  });

  return {
    account,
    sinceDays,
    counts,
    items: filtered.slice(0, limit),
    truncated: filtered.length > limit,
  };
}
