import { db, ensureDbReady } from '../db/client.js';
import { recordOperation } from './oplog.js';

/**
 * Attention Engine — Phase 4, brique 1 : RÉPONSES OUBLIÉES (SPEC V2 §8.3).
 *
 * Détecte, depuis l'index local (aucun accès IMAP), les mails entrants qui
 * attendent une réponse : dernier message de leur fil, reçus en boîte de
 * réception, sans réponse sortante depuis, et qui ressemblent à un mail écrit
 * par un humain (les newsletters/notifications sont ignorées).
 *
 * Seuils SPEC : urgent 24 h · banque/comptable/administration 48 h ·
 * normal 7 jours. Chaque élément porte une `reason` explicite en français.
 *
 * L'utilisateur peut reporter (snooze) ou ignorer (dismiss) un fil : l'état
 * est stocké dans AttentionState, lié au dernier message entrant du fil — si
 * un nouveau mail arrive ensuite dans le fil, l'état devient caduc et
 * l'élément réapparaît automatiquement.
 */

export type ReplyCategory = 'urgent' | 'important' | 'normal';
export type ReplyState = 'active' | 'snoozed' | 'dismissed';

export interface ReplyItem {
  account: string;
  threadId: number;
  /** id interne (colonne Message.id) du mail en attente — sert au suivi d'état. */
  messageId: number;
  uid: number;
  folder: string;
  fromEmail: string;
  fromName: string | null;
  subject: string;
  date: string;
  isSeen: boolean;
  /** Nombre de messages du fil (contexte). */
  threadMessageCount: number;
  category: ReplyCategory;
  categoryLabel: string;
  thresholdHours: number;
  waitingHours: number;
  /** true si le seuil de la catégorie est dépassé. */
  overdue: boolean;
  /** Type de demande détecté (B3) : réponse attendue / action / question / info. */
  requestKind: RequestKind;
  requestKindLabel: string;
  /** true si tu n'es pas dans les destinataires principaux (probablement en copie). */
  inCopy: boolean;
  /** Justification explicite, affichée telle quelle. */
  reason: string;
  state: ReplyState;
  snoozedUntil: string | null;
}

export interface UnansweredOptions {
  /** overdue = seulement les seuils dépassés (défaut all). */
  scope?: 'all' | 'overdue';
  /** Fenêtre d'analyse en jours (défaut 60, max 365). */
  sinceDays?: number;
  /** Nombre max d'éléments retournés (défaut 200). */
  limit?: number;
  /** Inclure aussi les éléments reportés/ignorés (pour les onglets de l'interface). */
  includeHidden?: boolean;
}

export interface UnansweredResult {
  account: string;
  sinceDays: number;
  counts: { active: number; overdue: number; snoozed: number; dismissed: number };
  items: ReplyItem[];
  truncated: boolean;
}

const THRESHOLDS: Record<ReplyCategory, number> = {
  urgent: 24,
  important: 48,
  normal: 7 * 24,
};

const CATEGORY_LABELS: Record<ReplyCategory, string> = {
  urgent: 'Urgent',
  important: 'Banque / admin / pro',
  normal: 'Normal',
};

/** Expéditeurs automatiques (même filtre que le nettoyage) : jamais « à répondre ». */
// Séparateurs [-._] optionnels partout : « no_reply@paypal », « do_not_reply@arlo »
// et « no.reply@vilogi » passaient la barrière et finissaient dans « Réponses en
// attente » (constaté sur données réelles le 02/08).
export const AUTO_SENDER_RE =
  /(no[-._]?reply|nepasrepondre|ne[-._]?pas[-._]?repondre|do[-._]?not[-._]?reply|notification|mailer-daemon|newsletter|automat|postmaster)/i;

/**
 * Sujet de RÉPONSE AUTOMATIQUE (répondeur, absence du bureau, accusé
 * d'orientation). Bug réel 02/08 : l'utilisateur répond, le répondeur du
 * destinataire renvoie « Ceci est une réponse automatique… » une minute plus
 * tard — chronologiquement le fil se termine par un entrant, donc il
 * retombait dans « À répondre » ET disparaissait de « À relancer ». Ces mails
 * ne comptent NI comme « attend ta réponse » NI comme « réponse reçue ».
 */
export const AUTO_REPLY_SUBJECT_RE =
  /r[ée]ponse\s+automatique|r[ée]ponse\s+d['’]absence|absente?\s+du\s+bureau|automatic\s+reply|auto[-\s]?reply|autoreply|out\s+of\s+office|away\s+from\s+(the\s+)?office/i;

export function isAutoReplySubject(subject: string | null | undefined): boolean {
  return !!subject && AUTO_REPLY_SUBJECT_RE.test(subject);
}

/** Sujet qui réclame une réponse rapide. */
export const URGENT_SUBJECT_RE =
  /(urgent|au plus vite|asap|dernier rappel|derni[èe]re relance|mise en demeure|imp[ée]ratif|avant le)/i;

/**
 * Expéditeur type banque / administration / comptable / juridique (seuil 48 h).
 * Attention aux faux positifs : pas de domaines grand public (orange.fr, sfr…)
 * et frontières de mots sur les tokens courts (caf ≠ café, msa ≠ thomsa).
 */
export const IMPORTANT_SENDER_RE =
  /(banque|bank|cr[ée]dit|boursorama|fortuneo|\bbnp\b|societe ?generale|banquepostale|impot|finances|dgfip|tresor|urssaf|ameli|cpam|\bmsa\b|\bcaf\b|assurance|mutuelle|notaire|avocat|huissier|comptab|prefecture|mairie|gouv\.fr|pole-?emploi|francetravail|syndic|foncia)/i;

// ---------------------------------------------------------------------------
// Avis automatiques (règle utilisateur du 31/07/2026) — deux familles à ne
// PAS confondre :
//  · « relevé / documents à disposition » : la banque annonce la génération
//    d'un relevé mensuel. Il n'y a JAMAIS rien à traiter — ni réponse à
//    attendre, ni « non traité » à afficher, quel que soit l'âge du mail.
//  · « un message dans votre espace » : là il y a bien quelque chose à lire,
//    mais le message ne reste consultable que ~60 jours côté banque — passé
//    ce délai, l'avis est périmé et ne doit plus compter nulle part.
// Les avis d'espace de MOINS de 60 jours gardent le comportement normal.
// ---------------------------------------------------------------------------

/** Mise à disposition automatique d'un relevé/document (génération mensuelle). */
export const DOCUMENT_NOTICE_RE =
  /(relev[ée]s?[^\n]{0,40}\b(est |sont )?disponibles?\b|(relev[ée]s?|documents?)[^\n]{0,60}[àa] disposition\b|mise [àa] disposition[^\n]{0,40}(relev[ée]s?|documents?))/i;

/** Avis « un (nouveau) message t'attend dans ton espace / ta messagerie ». */
export const ESPACE_MESSAGE_RE =
  /((nouveaux?\s+)?messages?[^\n]{0,30}(dans|sur)\s+(votre|ton)\s+(espace|messagerie)|vous avez\s+(re[çc]u\s+)?(un|\d+)\s+(nouveaux?\s+)?messages?|messages? vous attend)/i;

/** Durée de vie d'un avis « message dans ton espace » avant péremption. */
export const ESPACE_MESSAGE_TTL_DAYS = 60;

/**
 * Si ce mail est un avis automatique qui ne réclame (plus) aucun traitement,
 * renvoie la raison en français ; sinon null. Sujet seul (index-only).
 */
export function autoNoticeMuted(
  subject: string | null | undefined,
  date: Date | null,
  now: number,
): string | null {
  const s = (subject ?? '').replace(/’/g, "'");
  if (DOCUMENT_NOTICE_RE.test(s)) {
    return 'avis automatique de mise à disposition d’un relevé/document — rien à traiter (ta règle)';
  }
  if (ESPACE_MESSAGE_RE.test(s)) {
    const ageDays = date ? (now - date.getTime()) / 86_400_000 : 0;
    if (ageDays > ESPACE_MESSAGE_TTL_DAYS) {
      return `avis « message dans ton espace » périmé (plus de ${ESPACE_MESSAGE_TTL_DAYS} jours) — plus rien à consulter (ta règle)`;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Réponse attendue v2 (B3) : TYPE DE DEMANDE. Beaucoup de mails réclament une
// réponse SANS poser de question (« merci de me transmettre », « dans
// l'attente de votre retour ») — motifs français explicites, appliqués au
// sujet (index-only) et, quand il est disponible, au corps SANS le texte cité.
// ---------------------------------------------------------------------------

export type RequestKind = 'reply_expected' | 'action' | 'question' | 'information';

export const REQUEST_KIND_LABELS: Record<RequestKind, string> = {
  reply_expected: 'Réponse explicitement attendue',
  action: 'Action demandée',
  question: 'Question posée',
  information: 'Information',
};

/** Réponse explicitement attendue, sans « ? » (tournures françaises). */
export const REPLY_EXPECTED_RE =
  /(dans l'attente de (votre|ta|ton) (r[ée]ponse|retour|confirmation|accord)|en attente de (votre|ta|ton) (r[ée]ponse|retour)|j'attends (votre|ta|ton) (r[ée]ponse|retour|accord|confirmation)|merci de (me |nous )?(r[ée]pondre|confirmer|tenir inform[ée])|r[ée]ponse (souhait[ée]e|attendue|rapide)|qu'en (penses?[- ]tu|pensez[- ]vous)|(tiens|tenez)[- ](moi|nous) (au courant|inform[ée]e?s?)|dis[- ]moi (ce que|si|quand|ce qu')|confirmez?[- ](moi|nous)|merci de (nous |me )?faire (un )?retour)/i;

/** Action demandée, sans « ? » (transmettre, signer, valider, régler…). */
export const ACTION_REQUEST_RE =
  /(merci de (me |nous |bien vouloir )?(transmettre|envoyer|renvoyer|retourner|fournir|valider|signer|compl[ée]ter|remplir|v[ée]rifier|payer|r[ée]gler|d[ée]poser)|veuillez (me |nous |bien vouloir )?(transmettre|envoyer|renvoyer|retourner|fournir|valider|signer|compl[ée]ter|remplir|proc[ée]der)|(pouvez|pourriez)[- ]vous|(peux|pourrais)[- ]tu|[àa] (me |nous )?retourner (sign[ée]|compl[ée]t[ée]|avant)|[àa] (compl[ée]ter|signer|valider|r[ée]gler) (avant|pour|imp[ée]rativement)|action requise|signature (requise|attendue)|piece[s]? [àa] fournir|document[s]? [àa] (fournir|signer|retourner))/i;

/**
 * Retire le texte CITÉ d'un corps de mail (lignes « > », blocs « Le … a
 * écrit : », séparateurs Outlook) : on n'analyse que ce que l'expéditeur a
 * réellement écrit, pas la conversation recopiée dessous.
 */
export function stripQuotedText(text: string): string {
  const kept: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*(>|\|)/.test(line)) continue; // ligne citée
    if (/^\s*Le .{4,100} a [ée]crit\s*:/.test(line)) break;
    if (/^\s*On .{4,100} wrote\s*:/i.test(line)) break;
    if (/^-{2,}\s*(Message d'origine|Message transf[ée]r[ée]|Original Message|Forwarded message)/i.test(line)) break;
    if (/^\s*_{6,}\s*$/.test(line)) break; // séparateur de citation Outlook
    if (/^\s*De\s?:\s.+/.test(line) || /^\s*From\s?:\s.+@/.test(line)) break;
    kept.push(line);
  }
  return kept.join('\n');
}

/**
 * Détecte le TYPE de demande d'un mail entrant : réponse explicitement
 * attendue > action demandée > question > information. Le sujet suffit
 * (index-only) ; le corps — déjà débarrassé du texte cité — affine quand
 * l'interface le fournit (analyse du mail ouvert).
 */
export function detectRequestKind(
  subject: string | null | undefined,
  body?: string | null,
): { kind: RequestKind; why: string } {
  const s = (subject ?? '').replace(/’/g, "'");
  const b = (body ?? '').replace(/’/g, "'").slice(0, 20_000);
  let m = REPLY_EXPECTED_RE.exec(s) ?? (b ? REPLY_EXPECTED_RE.exec(b) : null);
  if (m) return { kind: 'reply_expected', why: `réponse explicitement attendue (« ${m[0].trim()} »)` };
  m = ACTION_REQUEST_RE.exec(s) ?? (b ? ACTION_REQUEST_RE.exec(b) : null);
  if (m) return { kind: 'action', why: `action demandée (« ${m[0].trim()} »)` };
  if (s.includes('?')) return { kind: 'question', why: 'le sujet pose une question' };
  if (b && /^[^>\n]*\S.*\?\s*$/m.test(b)) {
    return { kind: 'question', why: 'le mail pose une question' };
  }
  return { kind: 'information', why: 'aucune demande explicite détectée' };
}

export function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

export function humanDelay(hours: number): string {
  if (hours < 1) return "moins d'une heure";
  if (hours < 48) return `${Math.round(hours)} h`;
  return `${Math.round(hours / 24)} jours`;
}

function categorize(c: {
  subject: string | null;
  fromEmail: string | null;
  fromName: string | null;
}): { category: ReplyCategory; why: string } {
  const subject = c.subject ?? '';
  const urgentMatch = URGENT_SUBJECT_RE.exec(subject);
  if (urgentMatch) {
    return { category: 'urgent', why: `sujet marqué urgent (« ${urgentMatch[0]} »)` };
  }
  const senderText = `${c.fromEmail ?? ''} ${c.fromName ?? ''}`;
  const importantMatch = IMPORTANT_SENDER_RE.exec(senderText);
  if (importantMatch) {
    return {
      category: 'important',
      why: `expéditeur type banque/administration/pro (« ${importantMatch[0]} »)`,
    };
  }
  return { category: 'normal', why: 'correspondant classique' };
}

/**
 * Liste les mails en attente de réponse d'un compte, avec état (actif /
 * reporté / ignoré), catégorie, seuil et justification.
 */
export async function getUnansweredEmails(
  account: string,
  opts: UnansweredOptions = {},
): Promise<UnansweredResult> {
  await ensureDbReady();
  const sinceDays = Math.min(Math.max(opts.sinceDays ?? 60, 1), 365);
  const limit = Math.min(Math.max(opts.limit ?? 200, 1), 1000);
  const since = new Date(Date.now() - sinceDays * 86_400_000);
  const now = Date.now();

  // Adresse du compte : sert à distinguer destinataire principal / copie (B3).
  const accountRow = await db.account.findUnique({
    where: { slug: account },
    select: { emailAddress: true },
  });
  const accountEmail = accountRow?.emailAddress?.toLowerCase() ?? null;

  // 1. Candidats : mails entrants « répondables » de la boîte de réception.
  //    (newsletters exclues via List-Unsubscribe, expéditeurs no-reply via regex)
  const raw = await db.message.findMany({
    where: {
      accountSlug: account,
      isDeleted: false,
      isOutbound: false,
      isAnswered: false,
      isAutoReply: false,
      hasListUnsubscribe: false,
      threadId: { not: null },
      fromEmail: { not: null },
      date: { gte: since },
      folder: { is: { role: 'inbox' } },
    },
    orderBy: { date: 'desc' },
    select: {
      id: true,
      threadId: true,
      uid: true,
      subject: true,
      fromEmail: true,
      fromName: true,
      toEmails: true,
      date: true,
      isSeen: true,
      intent: true,
      folder: { select: { path: true } },
    },
  });

  // Un candidat par fil : le plus récent (la liste est triée par date desc).
  const byThread = new Map<number, (typeof raw)[number]>();
  for (const m of raw) {
    if (m.threadId === null || m.date === null || !m.fromEmail) continue;
    if (AUTO_SENDER_RE.test(m.fromEmail)) continue;
    // Filet pour les mails indexés avant la colonne isAutoReply.
    if (isAutoReplySubject(m.subject)) continue;
    // Règle utilisateur : les avis « relevé à disposition » et les avis
    // d'espace périmés (> 60 j) n'attendent aucune réponse — jamais listés.
    if (autoNoticeMuted(m.subject, m.date, now)) continue;
    if (!byThread.has(m.threadId)) byThread.set(m.threadId, m);
  }
  const threadIds = [...byThread.keys()];

  // Mail TRANSACTIONNEL d'un expéditeur qui n'est pas une personne = pas de
  // réponse attendue : une facture se paie, un OTP se tape, une confirmation
  // se lit. Simulé sur les 7 boîtes réelles le 02/08 : 47 des 81 « en
  // attente » étaient de ce type (factures Amazon/Stripe, codes AXA/impots,
  // confirmations Crédit Agricole…) — c'est ce qui minait la confiance dans
  // l'écran. Les mails de PERSONNES restent listés quoi qu'ils contiennent :
  // l'artisan qui envoie sa facture attend parfois bel et bien un retour.
  const NO_REPLY_INTENTS = new Set(['otp', 'invoice', 'shipping', 'confirmation', 'promo', 'document']);
  const senderCat = new Map<string, string | null>();
  {
    const emails = [...new Set([...byThread.values()].map((m) => m.fromEmail as string))];
    for (const part of chunk(emails, 500)) {
      const rows = await db.sender.findMany({
        where: { accountSlug: account, email: { in: part } },
        select: { email: true, category: true },
      });
      for (const r of rows) senderCat.set(r.email, r.category);
    }
  }
  for (const [threadId, m] of [...byThread]) {
    if (
      m.intent &&
      NO_REPLY_INTENTS.has(m.intent) &&
      senderCat.get(m.fromEmail as string) !== 'person'
    ) {
      byThread.delete(threadId);
    }
  }

  // 2. Contexte des fils : dernier message toutes directions confondues et
  //    dernière réponse sortante — pour ne garder que les fils qui se
  //    terminent par ce mail entrant, sans réponse de l'utilisateur depuis.
  const lastAny = new Map<number, { max: Date | null; count: number }>();
  const lastOut = new Map<number, Date | null>();
  for (const ids of chunk(threadIds, 500)) {
    const aggs = await db.message.groupBy({
      by: ['threadId'],
      // isAutoReply exclu : un répondeur automatique ne « termine » pas un fil.
      where: { threadId: { in: ids }, isDeleted: false, isAutoReply: false },
      _max: { date: true },
      _count: { _all: true },
    });
    for (const a of aggs) {
      if (a.threadId !== null) lastAny.set(a.threadId, { max: a._max.date, count: a._count._all });
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

  // 3. États utilisateur (reporté / ignoré) sur ces fils.
  const states = new Map<
    number,
    { messageId: number; state: string; snoozedUntil: Date | null }
  >();
  for (const ids of chunk(threadIds, 500)) {
    const rows = await db.attentionState.findMany({
      where: { accountSlug: account, kind: 'reply', threadId: { in: ids } },
    });
    for (const r of rows) {
      states.set(r.threadId, {
        messageId: r.messageId,
        state: r.state,
        snoozedUntil: r.snoozedUntil,
      });
    }
  }

  // 4. Construction des éléments.
  const items: ReplyItem[] = [];
  for (const [threadId, m] of byThread) {
    const any = lastAny.get(threadId);
    if (!any?.max || !m.date) continue;
    // Un message plus récent existe dans le fil → ce mail n'est pas « le
    // dernier mot » (déjà répondu, ou suivi d'un autre mail) : pas en attente.
    if (any.max.getTime() > m.date.getTime()) continue;
    const out = lastOut.get(threadId);
    if (out && out.getTime() >= m.date.getTime()) continue;

    let { category, why } = categorize(m);

    // B3 : destinataire principal ou simple copie ? Si le compte n'apparaît
    // pas dans les destinataires principaux (To), la réponse n'est
    // probablement pas attendue de TOI → seuil normal, raison explicite.
    let inCopy = false;
    if (m.toEmails && accountEmail) {
      try {
        const to = JSON.parse(m.toEmails) as unknown;
        inCopy = Array.isArray(to) && to.length > 0 && !to.includes(accountEmail);
      } catch {
        /* toEmails illisible : on considère destinataire principal */
      }
    }
    if (inCopy && category !== 'normal') {
      category = 'normal';
      why = `${why} — mais tu es en copie, seuil ramené à normal`;
    }

    // B3 : type de demande (motifs FR sans « ? » inclus) depuis le sujet.
    const request = detectRequestKind(m.subject);

    const thresholdHours = THRESHOLDS[category];
    const waitingHours = (now - m.date.getTime()) / 3_600_000;
    const overdue = waitingHours > thresholdHours;

    // État effectif : un état lié à un ancien message du fil est caduc.
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
      `Dernier message du fil, reçu il y a ${humanDelay(waitingHours)}, aucune réponse envoyée depuis`,
      why,
    ];
    if (request.kind !== 'information') reasons.push(request.why);
    if (inCopy) reasons.push('tu es en copie (pas le destinataire principal)');
    if (!m.isSeen) reasons.push('jamais ouvert');
    reasons.push(
      overdue
        ? `seuil ${CATEGORY_LABELS[category].toLowerCase()} de ${humanDelay(thresholdHours)} dépassé`
        : `seuil de ${humanDelay(thresholdHours)} pas encore atteint`,
    );

    items.push({
      account,
      threadId,
      messageId: m.id,
      uid: m.uid,
      folder: m.folder.path,
      fromEmail: m.fromEmail as string,
      fromName: m.fromName,
      subject: m.subject ?? '(sans sujet)',
      date: m.date.toISOString(),
      isSeen: m.isSeen,
      threadMessageCount: any.count,
      category,
      categoryLabel: CATEGORY_LABELS[category],
      thresholdHours,
      waitingHours: Math.round(waitingHours * 10) / 10,
      overdue,
      requestKind: request.kind,
      requestKindLabel: REQUEST_KIND_LABELS[request.kind],
      inCopy,
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
  if (opts.scope === 'overdue') filtered = filtered.filter((i) => i.state !== 'active' || i.overdue);

  // En retard d'abord (les plus anciens en tête), puis les autres ; à état
  // égal, les mails où tu es en copie passent APRÈS (B3).
  filtered.sort((a, b) => {
    const aActive = a.state === 'active' ? 0 : 1;
    const bActive = b.state === 'active' ? 0 : 1;
    if (aActive !== bActive) return aActive - bActive;
    if (a.overdue !== b.overdue) return a.overdue ? -1 : 1;
    if (a.inCopy !== b.inCopy) return a.inCopy ? 1 : -1;
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

/** Réponses en retard uniquement (raccourci SPEC : get_overdue_replies). */
export async function getOverdueReplies(
  account: string,
  opts: Omit<UnansweredOptions, 'scope'> = {},
): Promise<UnansweredResult> {
  return getUnansweredEmails(account, { ...opts, scope: 'overdue' });
}

// ---------------------------------------------------------------------------
// Snooze / dismiss / restore — état utilisateur d'un fil.
// ---------------------------------------------------------------------------

async function lastThreadMessage(account: string, threadId: number) {
  const thread = await db.thread.findFirst({
    where: { id: threadId, accountSlug: account },
    select: { id: true },
  });
  if (!thread) throw new Error(`Fil ${threadId} introuvable pour le compte « ${account} ».`);
  const last = await db.message.findFirst({
    where: { threadId, isDeleted: false },
    orderBy: { date: 'desc' },
    select: {
      id: true,
      uid: true,
      subject: true,
      date: true,
      folder: { select: { path: true } },
    },
  });
  if (!last) throw new Error(`Fil ${threadId} vide (aucun message indexé).`);
  return last;
}

export interface ReplyStateChange {
  account: string;
  threadId: number;
  subject: string;
  state: ReplyState;
  snoozedUntil: string | null;
}

/**
 * Reporte un fil : il disparaît de la liste jusqu'à la date donnée
 * (`days` jours, défaut 3, max 365), puis réapparaît tout seul.
 */
async function snoozeItem(
  account: string,
  threadId: number,
  kind: 'reply' | 'followup',
  toolName: string,
  days = 3,
): Promise<ReplyStateChange> {
  await ensureDbReady();
  const d = Math.min(Math.max(Math.round(days), 1), 365);
  const until = new Date(Date.now() + d * 86_400_000);
  const last = await lastThreadMessage(account, threadId);
  await db.attentionState.upsert({
    where: { accountSlug_threadId_kind: { accountSlug: account, threadId, kind } },
    create: {
      accountSlug: account,
      threadId,
      messageId: last.id,
      kind,
      state: 'snoozed',
      snoozedUntil: until,
    },
    update: { messageId: last.id, state: 'snoozed', snoozedUntil: until },
  });
  await recordOperation({
    account,
    tool: toolName,
    folder: last.folder.path,
    params: { threadId, days: d, until: until.toISOString() },
    affectedUids: [last.uid],
    items: [{ subject: last.subject ?? '(sans sujet)', date: last.date?.toISOString() ?? null }],
    result: `reporté ${d} jour(s)`,
  });
  return {
    account,
    threadId,
    subject: last.subject ?? '(sans sujet)',
    state: 'snoozed',
    snoozedUntil: until.toISOString(),
  };
}

export function snoozeReply(account: string, threadId: number, days = 3): Promise<ReplyStateChange> {
  return snoozeItem(account, threadId, 'reply', 'snooze_reply', days);
}

/** Reporte une relance : cachée jusqu'à la date donnée, puis elle revient. */
export function snoozeFollowup(
  account: string,
  threadId: number,
  days = 3,
): Promise<ReplyStateChange> {
  return snoozeItem(account, threadId, 'followup', 'snooze_followup', days);
}

/**
 * Ignore un fil : il ne sera plus proposé — sauf si un NOUVEAU mail arrive
 * dans le fil (l'état est lié au dernier message au moment du clic).
 */
async function dismissItem(
  account: string,
  threadId: number,
  kind: 'reply' | 'followup',
  toolName: string,
  resultLabel: string,
): Promise<ReplyStateChange> {
  await ensureDbReady();
  const last = await lastThreadMessage(account, threadId);
  await db.attentionState.upsert({
    where: { accountSlug_threadId_kind: { accountSlug: account, threadId, kind } },
    create: {
      accountSlug: account,
      threadId,
      messageId: last.id,
      kind,
      state: 'dismissed',
    },
    update: { messageId: last.id, state: 'dismissed', snoozedUntil: null },
  });
  await recordOperation({
    account,
    tool: toolName,
    folder: last.folder.path,
    params: { threadId },
    affectedUids: [last.uid],
    items: [{ subject: last.subject ?? '(sans sujet)', date: last.date?.toISOString() ?? null }],
    result: resultLabel,
  });
  return {
    account,
    threadId,
    subject: last.subject ?? '(sans sujet)',
    state: 'dismissed',
    snoozedUntil: null,
  };
}

export function dismissReply(account: string, threadId: number): Promise<ReplyStateChange> {
  return dismissItem(account, threadId, 'reply', 'dismiss_reply', 'ignoré');
}

/** Marque une relance comme traitée (relance envoyée, ou plus nécessaire). */
export function markFollowupDone(account: string, threadId: number): Promise<ReplyStateChange> {
  return dismissItem(account, threadId, 'followup', 'mark_followup_done', 'traité');
}

/** Annule un report/ignore : le fil redevient visible immédiatement. */
async function restoreItem(
  account: string,
  threadId: number,
  kind: 'reply' | 'followup',
  toolName: string,
): Promise<ReplyStateChange> {
  await ensureDbReady();
  const last = await lastThreadMessage(account, threadId);
  await db.attentionState.deleteMany({
    where: { accountSlug: account, threadId, kind },
  });
  await recordOperation({
    account,
    tool: toolName,
    folder: last.folder.path,
    params: { threadId },
    affectedUids: [last.uid],
    items: [{ subject: last.subject ?? '(sans sujet)', date: last.date?.toISOString() ?? null }],
    result: 'remis en liste',
  });
  return {
    account,
    threadId,
    subject: last.subject ?? '(sans sujet)',
    state: 'active',
    snoozedUntil: null,
  };
}

export function restoreReply(account: string, threadId: number): Promise<ReplyStateChange> {
  return restoreItem(account, threadId, 'reply', 'restore_reply');
}

/** Annule le report/traité d'une relance : elle redevient visible. */
export function restoreFollowup(account: string, threadId: number): Promise<ReplyStateChange> {
  return restoreItem(account, threadId, 'followup', 'restore_followup');
}
