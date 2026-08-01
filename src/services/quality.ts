import { db, ensureDbReady } from './../db/client.js';
import { listAccountNames } from './accounts.js';
import { getUnansweredEmails } from './attention.js';
import { getImportantEmails } from './importance.js';
import { sampleRetentionTargets } from './retention.js';
import { logger } from '../logger.js';

/**
 * Contrôle qualité (B2 — Série B). L'écran « Vérifier l'analyse » tire un
 * ÉCHANTILLON RÉEL des détections de chaque moteur (réponses attendues,
 * importants, newsletters, notifications, candidats nettoyage) et demande à
 * l'utilisateur : Correct / Incorrect / Ne sais pas (+ raison). Les verdicts
 * sont stockés (AnalysisFeedback) et restitués en % de précision par moteur.
 * Les CORRECTIONS passent par les mécanismes existants (catégorie manuelle,
 * priorité par relation, dismissals) — jamais par un canal parallèle.
 */

export const REVIEW_ENGINES = [
  'reply',
  'important',
  'newsletter',
  'notification',
  'cleanup',
] as const;
export type ReviewEngine = (typeof REVIEW_ENGINES)[number];

export const REVIEW_ENGINE_LABELS: Record<ReviewEngine, string> = {
  reply: 'Réponses attendues',
  important: 'À ne pas manquer',
  newsletter: 'Newsletters',
  notification: 'Notifications',
  cleanup: 'Candidats au nettoyage',
};

export const REVIEW_VERDICTS = ['correct', 'incorrect', 'unsure'] as const;
export type ReviewVerdict = (typeof REVIEW_VERDICTS)[number];

export interface ReviewItem {
  engine: ReviewEngine;
  account: string;
  messageId: number;
  threadId: number | null;
  folder: string;
  uid: number;
  subject: string;
  fromEmail: string;
  fromName: string | null;
  date: string | null;
  isSeen: boolean;
  /** Ce que le moteur affirme — justification affichée telle quelle. */
  claim: string;
  /** Verdict déjà donné sur ce mail (revoter écrase), null sinon. */
  verdict: string | null;
  verdictReason: string | null;
}

export interface EngineStats {
  engine: ReviewEngine;
  label: string;
  total: number;
  correct: number;
  incorrect: number;
  unsure: number;
  /** % de précision = correct / (correct + incorrect) — null tant que rien de tranché. */
  precisionPct: number | null;
}

export interface ReviewSample {
  generatedAt: string;
  perEngine: number;
  engines: { engine: ReviewEngine; label: string; items: ReviewItem[] }[];
  stats: EngineStats[];
}

function shuffle<T>(arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/** Échantillon aléatoire de mails dont l'EXPÉDITEUR a été classé par la machine. */
async function sampleByCategory(category: 'newsletter' | 'notification', limit: number) {
  type Row = {
    id: number;
    threadId: number | null;
    account: string;
    folder: string;
    uid: number;
    subject: string | null;
    fromEmail: string | null;
    fromName: string | null;
    date: string | number | bigint | null;
    isSeen: number | boolean;
    categoryReason: string | null;
  };
  // categorySource='auto' : on ne juge que les décisions de la MACHINE (une
  // catégorie corrigée à la main est déjà un verdict de l'utilisateur).
  return db.$queryRawUnsafe<Row[]>(
    `SELECT m.id, m.threadId, m.accountSlug AS account, f.path AS folder, m.uid,
            m.subject, m.fromEmail, m.fromName, m.date, m.isSeen, s.categoryReason
     FROM Message m
     JOIN Folder f ON f.id = m.folderId
     JOIN Sender s ON s.accountSlug = m.accountSlug AND s.email = m.fromEmail
     WHERE m.isDeleted = 0 AND m.isOutbound = 0 AND f.role = 'inbox'
       AND s.category = ? AND s.categorySource = 'auto'
     ORDER BY RANDOM() LIMIT ${limit}`,
    category,
  );
}

function rawDate(v: string | number | bigint | null): string | null {
  if (v === null || v === undefined) return null;
  const d = typeof v === 'string' ? new Date(v) : new Date(Number(v));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * Tire l'échantillon : jusqu'à `perEngine` mails par moteur, toutes boîtes
 * confondues, tirés AU HASARD (index-only, aucun IMAP). Les verdicts déjà
 * donnés sont joints — on peut revoir un mail déjà jugé et changer d'avis.
 */
export async function getReviewSample(perEngine = 10): Promise<ReviewSample> {
  await ensureDbReady();
  const n = Math.min(Math.max(perEngine, 1), 50);
  const accounts = await listAccountNames();
  const engines: ReviewSample['engines'] = [];

  // 1. Réponses attendues (moteur attention.ts) — agrégées puis tirées au sort.
  const replies: ReviewItem[] = [];
  for (const account of accounts) {
    try {
      const r = await getUnansweredEmails(account, { limit: 100 });
      for (const it of r.items) {
        replies.push({
          engine: 'reply',
          account,
          messageId: it.messageId,
          threadId: it.threadId,
          folder: it.folder,
          uid: it.uid,
          subject: it.subject,
          fromEmail: it.fromEmail,
          fromName: it.fromName,
          date: it.date,
          isSeen: it.isSeen,
          claim: it.reason,
          verdict: null,
          verdictReason: null,
        });
      }
    } catch (err) {
      logger.warn('contrôle qualité : réponses en échec', {
        account,
        error: (err as Error).message,
      });
    }
  }
  engines.push({ engine: 'reply', label: REVIEW_ENGINE_LABELS.reply, items: shuffle(replies).slice(0, n) });

  // 2. Importants (moteur importance.ts) — lus inclus : on juge le score,
  //    pas l'état de lecture.
  const importants: ReviewItem[] = [];
  for (const account of accounts) {
    try {
      const r = await getImportantEmails(account, {
        minScore: 40,
        includeRead: true,
        sinceDays: 30,
        limit: 100,
      });
      for (const it of r.items) {
        importants.push({
          engine: 'important',
          account,
          messageId: it.messageId,
          threadId: it.threadId,
          folder: it.folder,
          uid: it.uid,
          subject: it.subject,
          fromEmail: it.fromEmail,
          fromName: it.fromName,
          date: it.date,
          isSeen: it.isSeen,
          claim: `score ${it.score}/100 · ${it.reasons.join(' · ')}`,
          verdict: null,
          verdictReason: null,
        });
      }
    } catch (err) {
      logger.warn('contrôle qualité : importants en échec', {
        account,
        error: (err as Error).message,
      });
    }
  }
  engines.push({
    engine: 'important',
    label: REVIEW_ENGINE_LABELS.important,
    items: shuffle(importants).slice(0, n),
  });

  // 3 & 4. Newsletters / notifications (moteur categorize.ts, décisions auto).
  for (const category of ['newsletter', 'notification'] as const) {
    const rows = await sampleByCategory(category, n);
    engines.push({
      engine: category,
      label: REVIEW_ENGINE_LABELS[category],
      items: rows.map((r) => ({
        engine: category,
        account: r.account,
        messageId: r.id,
        threadId: r.threadId,
        folder: r.folder,
        uid: r.uid,
        subject: r.subject ?? '(sans sujet)',
        fromEmail: r.fromEmail ?? '',
        fromName: r.fromName,
        date: rawDate(r.date),
        isSeen: Boolean(r.isSeen),
        claim: `expéditeur classé « ${REVIEW_ENGINE_LABELS[category].toLowerCase()} » — ${r.categoryReason ?? 'raison inconnue'}`,
        verdict: null,
        verdictReason: null,
      })),
    });
  }

  // 5. Candidats nettoyage (stratégies A3, protection B1 incluse).
  const targets = await sampleRetentionTargets(n);
  engines.push({
    engine: 'cleanup',
    label: REVIEW_ENGINE_LABELS.cleanup,
    items: targets.map((t) => ({
      engine: 'cleanup' as const,
      account: t.account,
      messageId: t.messageId,
      threadId: t.threadId,
      folder: t.folder,
      uid: t.uid,
      subject: t.subject,
      fromEmail: t.fromEmail,
      fromName: t.fromName,
      date: t.date,
      isSeen: t.isSeen,
      claim: `visé par « ${t.policyLabel} »`,
      verdict: null,
      verdictReason: null,
    })),
  });

  // Verdicts existants joints en une requête.
  const ids = engines.flatMap((e) => e.items.map((i) => i.messageId));
  if (ids.length) {
    const existing = await db.analysisFeedback.findMany({
      where: { messageId: { in: [...new Set(ids)] } },
    });
    const byKey = new Map(existing.map((f) => [`${f.engine} ${f.messageId}`, f]));
    for (const e of engines) {
      for (const it of e.items) {
        const f = byKey.get(`${it.engine} ${it.messageId}`);
        if (f) {
          it.verdict = f.verdict;
          it.verdictReason = f.reason;
        }
      }
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    perEngine: n,
    engines,
    stats: await feedbackStats(),
  };
}

/** Précision par moteur, calculée sur TOUS les verdicts stockés. */
export async function feedbackStats(): Promise<EngineStats[]> {
  await ensureDbReady();
  const rows = await db.analysisFeedback.groupBy({
    by: ['engine', 'verdict'],
    _count: { _all: true },
  });
  return REVIEW_ENGINES.map((engine) => {
    const count = (verdict: string) =>
      rows.find((r) => r.engine === engine && r.verdict === verdict)?._count._all ?? 0;
    const correct = count('correct');
    const incorrect = count('incorrect');
    const unsure = count('unsure');
    return {
      engine,
      label: REVIEW_ENGINE_LABELS[engine],
      total: correct + incorrect + unsure,
      correct,
      incorrect,
      unsure,
      precisionPct:
        correct + incorrect > 0 ? Math.round((correct / (correct + incorrect)) * 100) : null,
    };
  });
}

export interface FeedbackInput {
  engine: ReviewEngine;
  account: string;
  messageId: number;
  verdict: ReviewVerdict;
  reason?: string | null;
  /** Justification du moteur au moment du verdict (affichée dans l'écran). */
  claim?: string | null;
}

/**
 * Enregistre (ou remplace) le verdict de l'utilisateur sur une analyse.
 * Contexte dénormalisé depuis l'index — le verdict survit aux resync.
 */
export async function recordFeedback(input: FeedbackInput): Promise<{
  engine: ReviewEngine;
  messageId: number;
  verdict: ReviewVerdict;
  subject: string;
}> {
  await ensureDbReady();
  if (!REVIEW_ENGINES.includes(input.engine)) {
    throw new Error(`Moteur inconnu : ${input.engine}`);
  }
  if (!REVIEW_VERDICTS.includes(input.verdict)) {
    throw new Error(`Verdict inconnu : ${input.verdict}`);
  }
  const reason = (input.reason ?? '').trim().slice(0, 300) || null;
  const claim = (input.claim ?? '').trim().slice(0, 500) || null;
  const msg = await db.message.findFirst({
    where: { id: input.messageId, accountSlug: input.account },
    select: { subject: true, fromEmail: true, fromName: true },
  });
  if (!msg) {
    throw new Error(`Mail ${input.messageId} introuvable pour le compte « ${input.account} ».`);
  }
  await db.analysisFeedback.upsert({
    where: { engine_messageId: { engine: input.engine, messageId: input.messageId } },
    create: {
      engine: input.engine,
      accountSlug: input.account,
      messageId: input.messageId,
      verdict: input.verdict,
      reason,
      claim,
      subject: msg.subject,
      fromEmail: msg.fromEmail,
      fromName: msg.fromName,
    },
    update: { verdict: input.verdict, reason, claim },
  });

  // B4 : le verdict alimente la CONFIANCE de l'analyse pour les moteurs qui
  // nourrissent le nettoyage — « incorrect » ⇒ confiance faible ⇒ le mail est
  // protégé de toute suppression automatique ; « correct » ⇒ confiance forte.
  if (['newsletter', 'notification', 'cleanup'].includes(input.engine)) {
    const conf =
      input.verdict === 'incorrect'
        ? { level: 'low', reason: 'tu as jugé cette analyse incorrecte (Vérifier l’analyse)' }
        : input.verdict === 'correct'
          ? { level: 'high', reason: 'tu as jugé cette analyse correcte (Vérifier l’analyse)' }
          : null;
    if (conf) {
      await db.message.update({
        where: { id: input.messageId },
        data: { analysisConfidence: conf.level, analysisConfidenceReason: conf.reason },
      });
    }
  }
  return {
    engine: input.engine,
    messageId: input.messageId,
    verdict: input.verdict,
    subject: msg.subject ?? '(sans sujet)',
  };
}
