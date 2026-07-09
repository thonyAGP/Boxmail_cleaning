import { db, ensureDbReady } from '../db/client.js';
import {
  AUTO_SENDER_RE,
  IMPORTANT_SENDER_RE,
  URGENT_SUBJECT_RE,
  chunk,
} from './attention.js';

/**
 * Importance Engine — Phase 4, brique 3 (L1) : MAILS IMPORTANTS (SPEC V2 §8.2).
 *
 * Chaque mail entrant reçoit un score d'importance 0-100, calculé depuis
 * l'index local (aucun accès IMAP) par des règles additives explicites :
 * chaque règle qui s'applique ajoute des points ET sa justification en
 * français dans `reasons[]`. Lecture seule en v1 (pas de snooze/dismiss).
 *
 * Niveaux : high ≥ 70 · medium 40-69 · low < 40.
 */

export type ImportanceLevel = 'high' | 'medium' | 'low';

export interface ImportantItem {
  account: string;
  threadId: number | null;
  /** id interne (colonne Message.id) — utilisable avec explain_importance. */
  messageId: number;
  uid: number;
  folder: string;
  fromEmail: string;
  fromName: string | null;
  subject: string;
  date: string;
  isSeen: boolean;
  /** Classification de l'expéditeur (person / company / newsletter / notification). */
  senderKind: string;
  /** Score d'importance 0-100. */
  score: number;
  level: ImportanceLevel;
  /** Justifications explicites, une par règle appliquée (avec ses points). */
  reasons: string[];
}

export interface ImportantOptions {
  /** Fenêtre d'analyse en jours (défaut 30, max 365). */
  sinceDays?: number;
  /** Score minimal pour apparaître dans la liste (défaut 40). */
  minScore?: number;
  /** true = inclure aussi les mails déjà lus (défaut : non lus uniquement). */
  includeRead?: boolean;
  /** Nombre max d'éléments retournés (défaut 100). */
  limit?: number;
}

export interface ImportantResult {
  account: string;
  sinceDays: number;
  minScore: number;
  includeRead: boolean;
  /** Répartition par niveau de TOUS les candidats analysés (avant minScore). */
  counts: { high: number; medium: number; low: number };
  items: ImportantItem[];
  truncated: boolean;
}

/** Montant d'argent dans un sujet : « 1 250,50 € », « 89 EUR », « 30 euros ». */
export const AMOUNT_RE = /\d+[ ,.]?\d*\s?(?:€|euros?\b|eur\b)/i;

export function importanceLevel(score: number): ImportanceLevel {
  if (score >= 70) return 'high';
  if (score >= 40) return 'medium';
  return 'low';
}

interface ScoreInput {
  subject: string | null;
  fromEmail: string;
  fromName: string | null;
  isSeen: boolean;
  date: Date | null;
  hasListUnsubscribe: boolean;
}

interface ScoreContext {
  /** Sender.kind de l'expéditeur (unknown si pas de fiche). */
  senderKind: string;
  /** true si le fil contient au moins un message sortant (conversation). */
  threadHasOutbound: boolean;
  /** true si ce mail est le dernier du fil, sans réponse sortante depuis. */
  awaitingReply: boolean;
  now: number;
}

/** Applique les règles de score : additif, plafonné 0-100, raisons explicites. */
export function scoreMessage(
  m: ScoreInput,
  ctx: ScoreContext,
): { score: number; level: ImportanceLevel; reasons: string[] } {
  const subject = m.subject ?? '';
  const senderText = `${m.fromEmail} ${m.fromName ?? ''}`;
  let score = 0;
  const reasons: string[] = [];
  const add = (points: number, reason: string) => {
    score += points;
    reasons.push(`${points > 0 ? '+' : ''}${points} ${reason}`);
  };

  const importantMatch = IMPORTANT_SENDER_RE.exec(senderText);
  if (importantMatch) {
    add(30, `expéditeur type banque/administration (« ${importantMatch[0]} »)`);
  }
  const urgentMatch = URGENT_SUBJECT_RE.exec(subject);
  if (urgentMatch) {
    add(20, `sujet urgent (« ${urgentMatch[0]} »)`);
  }
  if (ctx.senderKind === 'person') {
    add(15, 'expéditeur avec qui tu converses (vraie personne)');
  } else if (ctx.threadHasOutbound) {
    add(10, 'fil de conversation (tu y as déjà écrit)');
  }
  const ageMs = m.date ? ctx.now - m.date.getTime() : Number.POSITIVE_INFINITY;
  if (!m.isSeen && ageMs < 7 * 86_400_000) {
    add(15, 'non lu et récent (moins de 7 jours)');
  }
  if (subject.includes('?')) {
    add(10, 'le sujet pose une question');
  }
  const amountMatch = AMOUNT_RE.exec(subject);
  if (amountMatch) {
    add(10, `montant dans le sujet (« ${amountMatch[0].trim()} »)`);
  }
  if (ctx.awaitingReply) {
    add(10, 'attend une réponse (dernier message du fil, rien envoyé depuis)');
  }
  if (m.hasListUnsubscribe || ctx.senderKind === 'newsletter' || ctx.senderKind === 'notification') {
    add(-40, 'newsletter ou notification automatique (rarement important)');
  }

  score = Math.max(0, Math.min(100, score));
  return { score, level: importanceLevel(score), reasons };
}

/** Contexte de fils partagé : dernier message, dernier sortant, présence sortant. */
async function loadThreadContext(threadIds: number[]) {
  const lastAny = new Map<number, Date | null>();
  const lastOut = new Map<number, Date | null>();
  for (const ids of chunk(threadIds, 500)) {
    const aggs = await db.message.groupBy({
      by: ['threadId'],
      where: { threadId: { in: ids }, isDeleted: false },
      _max: { date: true },
    });
    for (const a of aggs) {
      if (a.threadId !== null) lastAny.set(a.threadId, a._max.date);
    }
    const outs = await db.message.groupBy({
      by: ['threadId'],
      where: { threadId: { in: ids }, isDeleted: false, isOutbound: true },
      _max: { date: true },
    });
    for (const o of outs) {
      if (o.threadId !== null) lastOut.set(o.threadId, o._max.date);
    }
  }
  return { lastAny, lastOut };
}

/** Sender.kind par adresse pour un lot d'expéditeurs (unknown si pas de fiche). */
async function loadSenderKinds(account: string, emails: string[]): Promise<Map<string, string>> {
  const kinds = new Map<string, string>();
  for (const batch of chunk([...new Set(emails)], 500)) {
    const rows = await db.sender.findMany({
      where: { accountSlug: account, email: { in: batch } },
      select: { email: true, kind: true },
    });
    for (const r of rows) kinds.set(r.email, r.kind);
  }
  return kinds;
}

type CandidateRow = {
  id: number;
  threadId: number | null;
  uid: number;
  subject: string | null;
  fromEmail: string | null;
  fromName: string | null;
  date: Date | null;
  isSeen: boolean;
  hasListUnsubscribe: boolean;
  folder: { path: string };
};

function buildItem(
  account: string,
  m: CandidateRow,
  ctx: ScoreContext,
): ImportantItem {
  const { score, level, reasons } = scoreMessage(
    {
      subject: m.subject,
      fromEmail: m.fromEmail as string,
      fromName: m.fromName,
      isSeen: m.isSeen,
      date: m.date,
      hasListUnsubscribe: m.hasListUnsubscribe,
    },
    ctx,
  );
  return {
    account,
    threadId: m.threadId,
    messageId: m.id,
    uid: m.uid,
    folder: m.folder.path,
    fromEmail: m.fromEmail as string,
    fromName: m.fromName,
    subject: m.subject ?? '(sans sujet)',
    date: m.date?.toISOString() ?? '',
    isSeen: m.isSeen,
    senderKind: ctx.senderKind,
    score,
    level,
    reasons,
  };
}

/**
 * Mails importants d'un compte : entrants de la boîte de réception, scorés
 * 0-100, triés par score décroissant. Par défaut : non lus des 30 derniers
 * jours, score ≥ 40.
 */
export async function getImportantEmails(
  account: string,
  opts: ImportantOptions = {},
): Promise<ImportantResult> {
  await ensureDbReady();
  const sinceDays = Math.min(Math.max(opts.sinceDays ?? 30, 1), 365);
  const minScore = Math.min(Math.max(opts.minScore ?? 40, 0), 100);
  const includeRead = opts.includeRead ?? false;
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 1000);
  const since = new Date(Date.now() - sinceDays * 86_400_000);
  const now = Date.now();

  const raw: CandidateRow[] = await db.message.findMany({
    where: {
      accountSlug: account,
      isDeleted: false,
      isOutbound: false,
      fromEmail: { not: null },
      date: { gte: since },
      folder: { is: { role: 'inbox' } },
      ...(includeRead ? {} : { isSeen: false }),
    },
    orderBy: { date: 'desc' },
    select: {
      id: true,
      threadId: true,
      uid: true,
      subject: true,
      fromEmail: true,
      fromName: true,
      date: true,
      isSeen: true,
      hasListUnsubscribe: true,
      folder: { select: { path: true } },
    },
  });

  const kinds = await loadSenderKinds(
    account,
    raw.map((m) => m.fromEmail as string),
  );
  const threadIds = [...new Set(raw.map((m) => m.threadId).filter((t): t is number => t !== null))];
  const { lastAny, lastOut } = await loadThreadContext(threadIds);

  const items: ImportantItem[] = [];
  const counts = { high: 0, medium: 0, low: 0 };
  for (const m of raw) {
    if (!m.fromEmail || !m.date) continue;
    const senderKind = kinds.get(m.fromEmail) ?? 'unknown';
    const last = m.threadId !== null ? lastAny.get(m.threadId) : null;
    const out = m.threadId !== null ? lastOut.get(m.threadId) : null;
    const isLastOfThread = !last || last.getTime() <= m.date.getTime();
    const awaitingReply =
      isLastOfThread &&
      (!out || out.getTime() < m.date.getTime()) &&
      !AUTO_SENDER_RE.test(m.fromEmail);
    const item = buildItem(account, m, {
      senderKind,
      threadHasOutbound: Boolean(out),
      awaitingReply,
      now,
    });
    counts[item.level]++;
    if (item.score >= minScore) items.push(item);
  }

  items.sort(
    (a, b) => b.score - a.score || new Date(b.date).getTime() - new Date(a.date).getTime(),
  );

  return {
    account,
    sinceDays,
    minScore,
    includeRead,
    counts,
    items: items.slice(0, limit),
    truncated: items.length > limit,
  };
}

/**
 * Explique le score d'importance d'un mail précis (par messageId, ou par
 * threadId → dernier mail entrant du fil), même s'il est lu ou ancien.
 */
export async function explainImportance(
  account: string,
  ref: { messageId?: number; threadId?: number },
): Promise<ImportantItem> {
  await ensureDbReady();
  if (!ref.messageId && !ref.threadId) {
    throw new Error('Indiquer messageId ou threadId.');
  }

  const select = {
    id: true,
    threadId: true,
    uid: true,
    subject: true,
    fromEmail: true,
    fromName: true,
    date: true,
    isSeen: true,
    hasListUnsubscribe: true,
    folder: { select: { path: true } },
  } as const;

  let m: CandidateRow | null;
  if (ref.messageId) {
    m = await db.message.findFirst({
      where: { id: ref.messageId, accountSlug: account, isDeleted: false },
      select,
    });
    if (!m) throw new Error(`Message ${ref.messageId} introuvable pour le compte « ${account} ».`);
  } else {
    m = await db.message.findFirst({
      where: {
        accountSlug: account,
        threadId: ref.threadId,
        isDeleted: false,
        isOutbound: false,
      },
      orderBy: { date: 'desc' },
      select,
    });
    if (!m) {
      throw new Error(
        `Aucun mail entrant dans le fil ${ref.threadId} du compte « ${account} ».`,
      );
    }
  }
  if (!m.fromEmail) throw new Error('Mail sans expéditeur : score impossible à calculer.');

  const kinds = await loadSenderKinds(account, [m.fromEmail]);
  const { lastAny, lastOut } = await loadThreadContext(
    m.threadId !== null ? [m.threadId] : [],
  );
  const last = m.threadId !== null ? lastAny.get(m.threadId) : null;
  const out = m.threadId !== null ? lastOut.get(m.threadId) : null;
  const isLastOfThread = !last || !m.date || last.getTime() <= m.date.getTime();
  const awaitingReply =
    isLastOfThread &&
    Boolean(m.date) &&
    (!out || out.getTime() < (m.date as Date).getTime()) &&
    !AUTO_SENDER_RE.test(m.fromEmail);

  return buildItem(account, m, {
    senderKind: kinds.get(m.fromEmail) ?? 'unknown',
    threadHasOutbound: Boolean(out),
    awaitingReply,
    now: Date.now(),
  });
}
