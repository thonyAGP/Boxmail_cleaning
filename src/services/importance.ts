import { db, ensureDbReady } from '../db/client.js';
import {
  AUTO_SENDER_RE,
  IMPORTANT_SENDER_RE,
  URGENT_SUBJECT_RE,
  autoNoticeMuted,
  chunk,
} from './attention.js';
import {
  resolveMailSemanticState,
  getOpenActions,
  getAttentionState,
  type EtatSemantique,
} from './semantique.js';

/**
 * Importance Engine — Phase 4, brique 3 (L1) : MAILS IMPORTANTS (SPEC V2 §8.2).
 * BASCULÉ SUR LE SOCLE au lot 4e (12/08).
 *
 * Chaque mail entrant reçoit un score d'importance 0-100, par règles
 * additives explicites : chaque règle qui s'applique ajoute des points ET sa
 * justification en français dans `reasons[]` — c'est ce qui permet à
 * l'utilisateur de contester.
 *
 * LA RÈGLE DU LOT 4E (contre-revue du 12/08 : « sinon des cartes
 * sémantiquement justes, classées absurdement ») :
 *
 *   Le score se fonde sur une ACTION OUVERTE pour l'utilisateur, une
 *   ÉCHÉANCE proche, une CONSÉQUENCE (argent, document à valeur) et l'ÉTAT
 *   DU FIL — jamais sur `intent` ni `aiAction`. Une action ouverte (+35)
 *   pèse PLUS qu'un expéditeur connu (+30) : ce qu'il y a à FAIRE passe
 *   avant qui l'envoie.
 *
 * Ce qui vient de l'UTILISATEUR reste souverain : `Sender.priority`
 * (⭐ toujours important +40 / 🔕 jamais urgent plafond 30) est un acte, pas
 * une interprétation — aucun verdict ne le renverse.
 *
 * COHABITATION : les mails sans verdict sémantique gardent le score
 * historique (heuristiques de sujet) comme REPLI ; quand le verdict existe,
 * les heuristiques de contenu (montant du sujet, « ? », attente structurelle)
 * ne tournent plus — le socle a déjà lu le mail.
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
  /**
   * État de traitement (B3) : new = reçu il y a moins de 7 jours ;
   * untreated = plus ancien, SANS réponse / tâche / suivi (même s'il est lu) ;
   * treated = probablement traité (réponse envoyée, tâche liée, ⭐ suivi).
   */
  treatState: 'new' | 'untreated' | 'treated';
  /** Ancienneté en jours (arrondie). */
  daysSinceReceived: number;
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
  /** Priorité par relation (A5) : normal | always_important | never_urgent. */
  senderPriority: string;
  /** true si le fil contient au moins un message sortant (conversation). */
  threadHasOutbound: boolean;
  /** true si ce mail est le dernier du fil, sans réponse sortante depuis. */
  awaitingReply: boolean;
  /** true si une échéance (proposée/confirmée) est liée à ce mail (B3). */
  deadlineLinked?: boolean;
  /** true si l'expéditeur a relancé : ≥ 2 mails entrants sans réponse (B3). */
  senderReminded?: boolean;
  /** État sémantique résolu par le socle (lot 4e) — null/absent si le mail
   *  n'a pas été résolu ; sans verdict, le score retombe sur le repli. */
  etat?: EtatSemantique | null;
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

  // Le verdict sémantique, quand il existe, porte l'ouverture, l'échéance et
  // la conséquence ; les heuristiques de contenu ne tournent qu'en repli.
  const semantique = ctx.etat?.analyse.verdictPresent ? ctx.etat : null;
  const ouvertes = semantique ? getOpenActions(semantique) : [];
  const ageMs = m.date ? ctx.now - m.date.getTime() : Number.POSITIVE_INFINITY;
  // Règle utilisateur (31/07/2026) : un avis « relevé/document à disposition »
  // n'attend JAMAIS de traitement, et un avis « message dans ton espace » est
  // périmé après 60 jours. Dans les deux cas : pas de bonus d'attente ni de
  // relance (la banque « relance » chaque mois toute seule), et un malus type
  // notification pour le sortir de la liste des importants.
  const noticeMuted = autoNoticeMuted(m.subject, m.date, ctx.now);

  // Priorité par relation (A5) : le choix de l'utilisateur prime sur tout.
  if (ctx.senderPriority === 'always_important') {
    add(40, 'expéditeur marqué ⭐ toujours important (ton choix)');
  }
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
  if (!m.isSeen && ageMs < 7 * 86_400_000) {
    add(15, 'non lu et récent (moins de 7 jours)');
  }

  if (semantique) {
    // ------------------------------------------------ le socle (lot 4e)
    // +35 > +30 : une action ouverte pèse PLUS qu'un expéditeur connu. Ce
    // qu'il y a à FAIRE passe avant qui l'envoie — c'est ce qui fait remonter
    // « Votre paiement à Comptastar a échoué » (334 jours sans suite) devant
    // la newsletter de la banque.
    if (ouvertes.length > 0) {
      const a = ouvertes[0];
      add(
        35,
        `une action reste à faire de ta part : « ${a.fait.label ?? a.fait.kind} » (analyse du mail)`,
      );
      if (ouvertes.some((x) => x.enRetard)) {
        add(10, "son échéance est dépassée et rien ne l'a soldée — en retard, pas résolue");
      } else {
        const prochaine = ouvertes
          .map((x) => x.fait.dueAt)
          .filter((d): d is Date => d !== null)
          .sort((d1, d2) => d1.getTime() - d2.getTime())[0];
        if (prochaine && prochaine.getTime() - ctx.now < 7 * 86_400_000) {
          add(10, `à faire avant le ${prochaine.toLocaleDateString('fr-FR')} (moins de 7 jours)`);
        }
      }
      // Plus une action ouverte attend, plus elle compte (le cas Comptastar).
      const waitingDays = Number.isFinite(ageMs) ? ageMs / 86_400_000 : 0;
      if (waitingDays >= 14) add(10, `sans traitement depuis ${Math.round(waitingDays)} jours`);
      else if (waitingDays >= 7) add(5, `sans traitement depuis ${Math.round(waitingDays)} jours`);
    }
    // Conséquence : de l'argent en jeu (montant lu par l'analyse, jamais une
    // regex de sujet), un document à valeur porté par le mail.
    const enJeu =
      ouvertes
        .map((x) => ({ montant: x.fait.montant, devise: x.fait.devise }))
        .find((x) => x.montant !== null) ??
      semantique.faits.documentsPortes
        .map((d) => ({ montant: d.montant, devise: d.devise }))
        .find((x) => x.montant !== null) ??
      null;
    if (enJeu?.montant != null) {
      add(
        10,
        `de l'argent est en jeu (${enJeu.montant.toFixed(2).replace('.', ',')} ${enJeu.devise ?? '€'})`,
      );
    }
    if (semantique.faits.documentsPortes.length > 0) {
      add(10, 'porte un document à valeur (facture, contrat, attestation…)');
    }
    // Fenêtre d'attention passée et plus rien à faire : le mail ne doit plus
    // remonter — c'est ce qui empêche le rappel Air France d'un vol passé de
    // rester « important » sur la foi de son sujet (« dernier rappel »).
    // Jamais l'inverse : une action ouverte n'est PAS masquée par la fenêtre.
    if (ouvertes.length === 0 && getAttentionState(semantique).perimee) {
      add(-40, "la fenêtre d'attention est passée — plus rien à faire d'après l'analyse");
    }
  } else {
    // -------------------------- REPLI (pas encore de verdict sémantique)
    // Le score historique, inchangé : heuristiques de sujet et de structure,
    // en attendant que l'analyse passe sur ce mail.
    if (subject.includes('?')) {
      add(10, 'le sujet pose une question');
    }
    const amountMatch = AMOUNT_RE.exec(subject);
    if (amountMatch) {
      add(10, `montant dans le sujet (« ${amountMatch[0].trim()} »)`);
    }
    if (ctx.awaitingReply && !noticeMuted) {
      add(10, 'attend une réponse (dernier message du fil, rien envoyé depuis)');
      // B3 : plus un mail attend, plus il compte — « jours sans traitement ».
      const waitingDays = Number.isFinite(ageMs) ? ageMs / 86_400_000 : 0;
      if (waitingDays >= 14) add(10, `sans traitement depuis ${Math.round(waitingDays)} jours`);
      else if (waitingDays >= 7) add(5, `sans traitement depuis ${Math.round(waitingDays)} jours`);
    }
  }

  if (ctx.deadlineLinked) {
    add(10, 'une échéance est liée à ce mail');
  }
  if (ctx.senderReminded && !noticeMuted) {
    add(10, "l'expéditeur a relancé (plusieurs mails sans réponse de ta part)");
  }
  // Les malus « automatique » ne s'appliquent JAMAIS à un mail dont une action
  // reste ouverte pour l'utilisateur : une demande de réservation Airbnb
  // arrive avec un List-Unsubscribe, elle n'en est pas moins à traiter.
  if (noticeMuted && ouvertes.length === 0) {
    add(-40, noticeMuted);
  }
  if (
    (m.hasListUnsubscribe || ctx.senderKind === 'newsletter' || ctx.senderKind === 'notification') &&
    ouvertes.length === 0
  ) {
    add(-40, 'newsletter ou notification automatique (rarement important)');
  }

  score = Math.max(0, Math.min(100, score));
  // 🔕 est un ACTE de l'utilisateur : il plafonne même une action ouverte.
  if (ctx.senderPriority === 'never_urgent' && score > 30) {
    score = 30;
    reasons.push('plafonné à 30 : expéditeur marqué 🔕 jamais urgent (ton choix)');
  }
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

/** Sender.kind + priorité par adresse (unknown/normal si pas de fiche). */
async function loadSenderKinds(
  account: string,
  emails: string[],
): Promise<Map<string, { kind: string; priority: string }>> {
  const kinds = new Map<string, { kind: string; priority: string }>();
  for (const batch of chunk([...new Set(emails)], 500)) {
    const rows = await db.sender.findMany({
      where: { accountSlug: account, email: { in: batch } },
      select: { email: true, kind: true, priority: true },
    });
    for (const r of rows) kinds.set(r.email, { kind: r.kind, priority: r.priority });
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
  isAnswered: boolean;
  hasListUnsubscribe: boolean;
  folder: { path: string };
};

function buildItem(
  account: string,
  m: CandidateRow,
  ctx: ScoreContext,
  treat: { treatState: ImportantItem['treatState']; daysSinceReceived: number },
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
  // Un avis auto muté (règle utilisateur) n'est jamais « non traité » :
  // il n'y a rien à traiter — il ne doit pas nourrir la pile des oublis.
  const treatState =
    treat.treatState === 'untreated' && autoNoticeMuted(m.subject, m.date, ctx.now)
      ? 'treated'
      : treat.treatState;
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
    treatState,
    daysSinceReceived: treat.daysSinceReceived,
  };
}

/**
 * État de traitement d'un mail (B3) : « nouveaux » (moins de 7 jours),
 * « probablement traités » (réponse envoyée, marqué répondu ou tâche liée),
 * « non traités » (anciens, rien fait — même s'ils ont été lus).
 */
export function treatStateOf(m: {
  date: Date | null;
  isAnswered: boolean;
  outboundAfter: boolean;
  hasTask: boolean;
  now: number;
}): { treatState: ImportantItem['treatState']; daysSinceReceived: number } {
  const days = m.date ? Math.max(0, Math.round((m.now - m.date.getTime()) / 86_400_000)) : 9999;
  if (days < 7) return { treatState: 'new', daysSinceReceived: days };
  if (m.outboundAfter || m.isAnswered || m.hasTask) {
    return { treatState: 'treated', daysSinceReceived: days };
  }
  return { treatState: 'untreated', daysSinceReceived: days };
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
      isAnswered: true,
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

  // L'état sémantique de tout le lot, résolu EN UNE PASSE (lot 4e — jamais
  // mail par mail, SQLite connection_limit=1) : c'est lui qui porte les
  // actions ouvertes, les montants et la fenêtre d'attention du score.
  const etats = await resolveMailSemanticState(raw.map((m) => m.id));

  // B3 : tâches et échéances liées aux candidats (requêtes par lots).
  const candidateIds = raw.map((m) => m.id);
  const taskedIds = new Set<number>();
  const deadlineIds = new Set<number>();
  for (const ids of chunk(candidateIds, 500)) {
    const tasks = await db.task.findMany({
      where: { accountSlug: account, messageId: { in: ids } },
      select: { messageId: true },
    });
    for (const t of tasks) if (t.messageId !== null) taskedIds.add(t.messageId);
    const deadlines = await db.deadline.findMany({
      where: { accountSlug: account, messageId: { in: ids }, status: { in: ['proposed', 'confirmed'] } },
      select: { messageId: true },
    });
    for (const d of deadlines) deadlineIds.add(d.messageId);
  }

  // B3 : « l'expéditeur a relancé » — plusieurs mails ENTRANTS du même
  // expéditeur dans le fil, plus récents que ta dernière réponse. Calculé
  // depuis la liste candidate elle-même (même fenêtre, même périmètre).
  const inboundByThread = new Map<number, { date: Date; fromEmail: string }[]>();
  for (const m of raw) {
    if (m.threadId === null || !m.date || !m.fromEmail) continue;
    const arr = inboundByThread.get(m.threadId) ?? [];
    arr.push({ date: m.date, fromEmail: m.fromEmail });
    inboundByThread.set(m.threadId, arr);
  }

  const items: ImportantItem[] = [];
  const counts = { high: 0, medium: 0, low: 0 };
  for (const m of raw) {
    if (!m.fromEmail || !m.date) continue;
    const meta = kinds.get(m.fromEmail);
    const senderKind = meta?.kind ?? 'unknown';
    const last = m.threadId !== null ? lastAny.get(m.threadId) : null;
    const out = m.threadId !== null ? lastOut.get(m.threadId) : null;
    const isLastOfThread = !last || last.getTime() <= m.date.getTime();
    const awaitingReply =
      isLastOfThread &&
      (!out || out.getTime() < m.date.getTime()) &&
      !AUTO_SENDER_RE.test(m.fromEmail);
    const outTime = out?.getTime() ?? 0;
    const senderReminded =
      awaitingReply &&
      (inboundByThread.get(m.threadId ?? -1) ?? []).filter(
        (x) => x.fromEmail === m.fromEmail && x.date.getTime() > outTime,
      ).length >= 2;
    const item = buildItem(
      account,
      m,
      {
        senderKind,
        senderPriority: meta?.priority ?? 'normal',
        threadHasOutbound: Boolean(out),
        awaitingReply,
        deadlineLinked: deadlineIds.has(m.id),
        senderReminded,
        etat: etats.get(m.id) ?? null,
        now,
      },
      treatStateOf({
        date: m.date,
        isAnswered: m.isAnswered,
        outboundAfter: Boolean(out && out.getTime() >= m.date.getTime()),
        hasTask: taskedIds.has(m.id),
        now,
      }),
    );
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
    isAnswered: true,
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

  // L'état sémantique de ce mail (socle, lot 4e) — même source que la liste.
  const etats = await resolveMailSemanticState([m.id]);

  // Signaux B3 pour CE mail : échéance liée, tâche liée, relance reçue.
  const [deadline, task, inboundSinceOut] = await Promise.all([
    db.deadline.findFirst({
      where: { accountSlug: account, messageId: m.id, status: { in: ['proposed', 'confirmed'] } },
      select: { id: true },
    }),
    db.task.findFirst({
      where: { accountSlug: account, messageId: m.id },
      select: { id: true },
    }),
    m.threadId !== null
      ? db.message.count({
          where: {
            threadId: m.threadId,
            isDeleted: false,
            isOutbound: false,
            fromEmail: m.fromEmail,
            ...(out ? { date: { gt: out } } : {}),
          },
        })
      : Promise.resolve(0),
  ]);
  const now = Date.now();

  return buildItem(
    account,
    m,
    {
      senderKind: kinds.get(m.fromEmail)?.kind ?? 'unknown',
      senderPriority: kinds.get(m.fromEmail)?.priority ?? 'normal',
      threadHasOutbound: Boolean(out),
      awaitingReply,
      deadlineLinked: Boolean(deadline),
      senderReminded: awaitingReply && inboundSinceOut >= 2,
      etat: etats.get(m.id) ?? null,
      now,
    },
    treatStateOf({
      date: m.date,
      isAnswered: m.isAnswered,
      outboundAfter: Boolean(out && m.date && out.getTime() >= m.date.getTime()),
      hasTask: Boolean(task),
      now,
    }),
  );
}
