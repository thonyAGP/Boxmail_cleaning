import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { db, ensureDbReady } from '../db/client.js';
import { logger } from '../logger.js';
import { recordOperation } from './oplog.js';
import { createTask } from './tasks.js';
import { imapService } from './imap.js';
import { resolveAccount } from './accounts.js';
import { chunk } from './attention.js';
import { isRentilaSender, parseRentilaMail, type RentilaMailInfo } from './rentila.js';
import { extractDeadlines } from './deadlines.js';

/**
 * Dépouillement du courrier entrant (Lot 1 du plan validé le 02/08).
 *
 * L'application savait détecter, classer et noter — mais s'arrêtait juste
 * avant le geste : rien ne prenait en charge « voici tes 20 nouveaux mails,
 * décide de leur sort ». Ce service introduit l'état manquant entre « mail
 * arrivé » et « mail traité » : le mail DÉPOUILLÉ, c'est-à-dire un mail sur
 * lequel une DÉCISION a été prise (reviewedAt + reviewDecision), indépendante
 * du statut lu/non-lu d'Outlook.
 *
 * Décisions possibles :
 *  - seen   : « Vu » — marqué lu (IMAP + index), rien d'autre ;
 *  - later  : « À lire plus tard » — décision prise, lecture reportée ;
 *  - keep   : « Garder dans la boîte » — décision prise, aucun effet ;
 *  - action : « Ajouter à mes actions » — crée une tâche liée au mail ;
 *  - trash  : corbeille (soft delete, lots de 200, récupérable ~30 j) —
 *             TOUJOURS confirmée côté interface avant d'arriver ici.
 * Tout est journalisé (ui_review_decide) avec la liste exacte des mails.
 */

export type ReviewClass = 'important' | 'read' | 'range';
export type ReviewDecision = 'seen' | 'later' | 'keep' | 'action' | 'trash';
export const REVIEW_DECISIONS: ReviewDecision[] = ['seen', 'later', 'keep', 'action', 'trash'];

// ---------------------------------------------------------------- Ligne de base
// Sans borne basse, le premier dépouillement présenterait les ~26 000 mails de
// l'historique. La ligne de base est posée au premier appel (48 h en arrière)
// et n'avance jamais : la file se vide par les DÉCISIONS (reviewedAt), pas par
// le temps. Les mails plus anciens que la ligne de base sont réputés dépouillés
// par l'âge.
const BASELINE_FILE = (): string => resolve(process.cwd(), 'data', 'review-baseline.json');

function getBaseline(): Date {
  try {
    if (existsSync(BASELINE_FILE())) {
      const raw = JSON.parse(readFileSync(BASELINE_FILE(), 'utf8')) as { baseline?: string };
      const d = raw.baseline ? new Date(raw.baseline) : null;
      if (d && !Number.isNaN(d.getTime())) return d;
    }
  } catch {
    /* fichier illisible : on repart de la valeur par défaut */
  }
  const baseline = new Date(Date.now() - 48 * 3600_000);
  try {
    mkdirSync(dirname(BASELINE_FILE()), { recursive: true });
    writeFileSync(BASELINE_FILE(), JSON.stringify({ baseline: baseline.toISOString() }), 'utf8');
  } catch (err) {
    logger.warn('ligne de base du dépouillement non écrite', { error: (err as Error).message });
  }
  return baseline;
}

// ---------------------------------------------------------------- Classification
/**
 * Classe de décision d'un mail — le tri du parcours (plan §11) :
 *  - important : à décider individuellement (personnes, banque/administration,
 *    demandes, factures, rendez-vous, verdict IA « répondre/payer ») ;
 *  - read      : mérite une lecture (informations, cas incertains) ;
 *  - range     : probablement rangeable d'un geste (notifications, newsletters,
 *    promos, confirmations…) — traité par LOTS homogènes.
 * Une analyse en confiance FAIBLE ne va jamais dans « range » : elle remonte
 * vers une décision humaine (« lire pour décider »).
 */
function classify(m: {
  intent: string | null;
  aiAction: string | null;
  analysisConfidence: string | null;
  senderCategory: string | null;
}): ReviewClass {
  const cat = m.senderCategory;
  if (cat === 'person') return 'important';
  if (cat === 'bank' || cat === 'admin' || cat === 'insurance') return 'important';
  if (m.aiAction === 'reply' || m.aiAction === 'pay') return 'important';
  if (
    m.intent === 'invoice' || m.intent === 'reply_expected' ||
    m.intent === 'appointment' || m.intent === 'reminder'
  ) {
    return 'important';
  }
  if (m.analysisConfidence === 'low') return 'read';
  if (cat === 'notification' || cat === 'newsletter' || cat === 'social' || cat === 'ad') return 'range';
  if (
    m.intent === 'promo' || m.intent === 'confirmation' ||
    m.intent === 'shipping' || m.intent === 'otp'
  ) {
    return 'range';
  }
  return 'read';
}

interface CandidateRow {
  id: number;
  accountSlug: string;
  uid: number;
  subject: string | null;
  snippet: string | null;
  fromEmail: string | null;
  fromName: string | null;
  date: Date | null;
  isSeen: boolean;
  intent: string | null;
  intentSource: string | null;
  aiAction: string | null;
  aiSummary: string | null;
  analysisConfidence: string | null;
  folder: { path: string };
}

async function loadCandidates(): Promise<{ rows: CandidateRow[]; senderCat: Map<string, string | null> }> {
  await ensureDbReady();
  const baseline = getBaseline();
  const rows = await db.message.findMany({
    where: {
      isDeleted: false,
      isOutbound: false,
      isAutoReply: false,
      reviewedAt: null,
      date: { gte: baseline },
      folder: { is: { role: 'inbox' } },
    },
    orderBy: { date: 'desc' },
    take: 500,
    select: {
      id: true, accountSlug: true, uid: true, subject: true, snippet: true,
      fromEmail: true, fromName: true, date: true, isSeen: true,
      intent: true, intentSource: true, aiAction: true, aiSummary: true, analysisConfidence: true,
      folder: { select: { path: true } },
    },
  });

  // Catégories d'expéditeur (par compte + adresse).
  const senderCat = new Map<string, string | null>();
  const pairs = new Map<string, Set<string>>();
  for (const m of rows) {
    if (!m.fromEmail) continue;
    if (!pairs.has(m.accountSlug)) pairs.set(m.accountSlug, new Set());
    pairs.get(m.accountSlug)!.add(m.fromEmail);
  }
  for (const [account, emails] of pairs) {
    for (const part of chunk([...emails], 500)) {
      const senders = await db.sender.findMany({
        where: { accountSlug: account, email: { in: part } },
        select: { email: true, category: true },
      });
      for (const s of senders) senderCat.set(`${account}|${s.email}`, s.category);
    }
  }
  return { rows, senderCat };
}

/**
 * Classement d'un mail pour le dépouillement, connecteur Rentila compris :
 * les notifications automatiques sont rangeables (les obligations qu'elles
 * portent vivent déjà en échéances), les messages relayés de locataires et
 * les alertes qui exigent un geste restent des décisions individuelles.
 */
function classifyRow(
  m: CandidateRow,
  senderCategory: string | null,
): { cls: ReviewClass; rentila: RentilaMailInfo | null } {
  if (isRentilaSender(m.fromEmail)) {
    const info = parseRentilaMail({
      subject: m.subject,
      fromEmail: m.fromEmail,
      fromName: m.fromName,
      date: m.date,
    });
    if (info) {
      if (info.noise) return { cls: 'range', rentila: info };
      const needsAction =
        info.kind === 'tenant_message' || info.kind === 'docs_missing' || info.kind === 'subscription';
      return { cls: needsAction ? 'important' : 'read', rentila: info };
    }
  }
  return {
    cls: classify({
      intent: m.intent,
      aiAction: m.aiAction,
      analysisConfidence: m.analysisConfidence,
      senderCategory,
    }),
    rentila: null,
  };
}

/** Libellé lisible d'une notification Rentila pour les listes exactes. */
function rentilaDisplay(info: RentilaMailInfo, subject: string | null): string {
  const base = info.property ? `${info.label} — ${info.property}` : info.label;
  const raw = (subject ?? '').trim();
  // Les copies/téléchargements gardent le sujet d'origine visible : le label
  // seul ne dirait pas QUEL envoi est concerné.
  if ((info.kind === 'outbound_copy' || info.kind === 'download_copy' || info.kind === 'support') && raw) {
    return `${base} (« ${raw} »)`;
  }
  return base;
}

// ---------------------------------------------------------------- Propositions (chantier 2)
// La review à deux régimes (spécifiée avec ChatGPT le 03/08) :
//  - régime A (signaux convergents) : l'écran est centré sur une PROPOSITION
//    pré-remplie et éditable — « Payer Foncia — avant le 15/09 » — validée
//    d'un geste ;
//  - régime B (incertain) : AUCUNE pré-sélection — l'assistant le dit
//    honnêtement plutôt que de fabriquer une proposition à 30 %.
// Bascule booléenne : ≥ 2 signaux positifs ET 0 contradiction. Pas de score.

export interface ReviewProposal {
  objectType: 'deadline' | 'task';
  mode: 'create' | 'confirm' | 'exists';
  title: string;
  /** ISO — échéances uniquement. */
  date: string | null;
  deadlineType: string;
  deadlineId: number | null;
  why: string;
}

interface ExistingDeadline { id: number; status: string; title: string; date: Date }

const FR_DATE = (d: Date): string => d.toLocaleDateString('fr-FR');

/** « EDF » depuis le nom affiché, sinon le domaine (« foncia »), sinon générique. */
function payeeName(m: CandidateRow): string {
  if (m.fromName?.trim()) return m.fromName.trim();
  const domain = m.fromEmail?.split('@')[1]?.split('.')[0];
  return domain ? domain.charAt(0).toUpperCase() + domain.slice(1) : 'le créancier';
}

function firstNameOf(m: CandidateRow): string {
  const first = (m.fromName ?? '').trim().split(/\s+/)[0];
  return first || m.fromEmail || '?';
}

/** Premier titre-verbe possible pour ce mail, ou null si aucune famille ne s'applique. */
function buildProposal(
  m: CandidateRow,
  existing: ExistingDeadline | null,
  rentila: RentilaMailInfo | null,
): ReviewProposal | null {
  const subject = (m.subject ?? '').replace(/\s+/g, ' ').trim() || '(sans sujet)';

  if (rentila?.kind === 'tenant_message') {
    return {
      objectType: 'task', mode: 'create',
      title: `Traiter avec le locataire — ${subject}`.slice(0, 200),
      date: null, deadlineType: 'other', deadlineId: null,
      why: 'Un locataire signale un problème qui demande probablement un suivi.',
    };
  }

  const wantsPay = m.intent === 'invoice' || m.aiAction === 'pay';
  const wantsReply = m.intent === 'reply_expected' || m.aiAction === 'reply';

  if (wantsPay) {
    const payee = payeeName(m);
    if (existing?.status === 'confirmed') {
      return {
        objectType: 'deadline', mode: 'exists',
        title: existing.title, date: existing.date.toISOString(),
        deadlineType: 'payment', deadlineId: existing.id,
        why: 'Cette facture a déjà son échéance confirmée.',
      };
    }
    const date = existing?.date ?? extractDeadlines(subject, m.date ?? new Date())[0]?.date ?? null;
    if (date) {
      return {
        objectType: 'deadline', mode: existing ? 'confirm' : 'create',
        title: `Payer ${payee} — avant le ${FR_DATE(date)}`.slice(0, 200),
        date: date.toISOString(), deadlineType: 'payment', deadlineId: existing?.id ?? null,
        why: `J'ai reconnu une facture et trouvé une échéance au ${FR_DATE(date)}.`,
      };
    }
    return {
      objectType: 'task', mode: 'create',
      title: `Payer ${payee}`.slice(0, 200), date: null, deadlineType: 'other', deadlineId: null,
      why: `J'ai reconnu une facture de ${payee}, sans date d'échéance lisible.`,
    };
  }

  if (wantsReply) {
    return {
      objectType: 'task', mode: 'create',
      title: `Répondre à ${firstNameOf(m)}`.slice(0, 200),
      date: null, deadlineType: 'other', deadlineId: null,
      why: 'Le dernier message du fil attend probablement ta réponse.',
    };
  }

  if (m.intent === 'appointment') {
    if (existing?.status === 'confirmed') {
      return {
        objectType: 'deadline', mode: 'exists',
        title: existing.title, date: existing.date.toISOString(),
        deadlineType: 'appointment', deadlineId: existing.id,
        why: 'Ce rendez-vous a déjà son échéance confirmée.',
      };
    }
    const date = existing?.date ?? extractDeadlines(subject, m.date ?? new Date())[0]?.date ?? null;
    if (!date) return null; // pas de date → rien à proposer honnêtement
    return {
      objectType: 'deadline', mode: existing ? 'confirm' : 'create',
      title: `Rendez-vous : ${subject}`.slice(0, 200),
      date: date.toISOString(), deadlineType: 'appointment', deadlineId: existing?.id ?? null,
      why: `Une date de rendez-vous a été détectée (${FR_DATE(date)}).`,
    };
  }

  return null;
}

/**
 * Régime A ou B ? Booléen : au moins 2 signaux positifs indépendants ET
 * aucune contradiction entre sources fortes.
 */
function convergence(
  m: CandidateRow,
  senderCategory: string | null,
  hasDate: boolean,
  history: { decision: ReviewDecision; count: number; mixed: boolean } | undefined,
): boolean {
  const positives: string[] = [];
  if (senderCategory) positives.push('sender');
  const intentReliable =
    m.intentSource === 'manual' || m.intentSource === 'rule' ||
    (m.intent !== null && m.analysisConfidence === 'high');
  if (intentReliable) positives.push('intent');
  if (hasDate) positives.push('date');
  if (history && !history.mixed && history.count >= 3) positives.push('history');

  const promoLike = m.intent === 'promo' || m.intent === 'otp';
  const trustedCat = ['bank', 'admin', 'insurance', 'person'].includes(senderCategory ?? '');
  const noiseCat = ['newsletter', 'notification', 'social', 'ad'].includes(senderCategory ?? '');
  const wantsReply = m.intent === 'reply_expected' || m.aiAction === 'reply';
  const wantsPay = m.intent === 'invoice' || m.aiAction === 'pay';
  const contradiction =
    (promoLike && trustedCat) ||
    (noiseCat && wantsReply) ||
    (history?.mixed === false && history.decision === 'trash' && (wantsPay || wantsReply));

  return positives.length >= 2 && !contradiction;
}

function toItem(m: CandidateRow, cls: ReviewClass, senderCategory: string | null, rentila?: RentilaMailInfo | null) {
  return {
    id: m.id,
    account: m.accountSlug,
    folder: m.folder.path,
    uid: m.uid,
    subject: m.subject ?? '(sans sujet)',
    snippet: (m.snippet ?? '').slice(0, 160),
    fromEmail: m.fromEmail,
    fromName: m.fromName,
    date: m.date?.toISOString() ?? null,
    isSeen: m.isSeen,
    intent: m.intent,
    aiAction: m.aiAction,
    aiSummary: m.aiSummary,
    confidence: m.analysisConfidence,
    senderCategory,
    class: cls,
    /** Lecture Rentila du mail (« Assurance locataire expirée — 101… »), sinon null. */
    rentilaLabel: rentila ? rentilaDisplay(rentila, m.subject) : null,
    /** Chantier 2 — posés par l'enrichissement de reviewQueue. */
    regime: null as 'A' | 'B' | null,
    proposal: null as ReviewProposal | null,
  };
}
export type ReviewItem = ReturnType<typeof toItem>;

export interface ReviewLot {
  kind: 'lot';
  account: string;
  fromEmail: string;
  fromName: string | null;
  intent: string | null;
  senderCategory: string | null;
  count: number;
  ids: number[];
  /** Échantillon (10 max) pour la liste exacte affichée avant décision. */
  samples: { id: number; subject: string; date: string | null; folder: string; uid: number }[];
  /** true = lot « 🏠 Alertes Rentila » (toutes notifications confondues). */
  rentila?: boolean;
}
export interface ReviewSingle {
  kind: 'single';
  item: ReviewItem;
}
export type ReviewGroup = ReviewSingle | ReviewLot;

/** Compteurs pour la carte « N nouveaux mails attendent une décision ». */
export async function reviewSummary(): Promise<{
  total: number;
  important: number;
  read: number;
  range: number;
  reviewedToday: number;
  laterCount: number;
  baseline: string;
}> {
  const { rows, senderCat } = await loadCandidates();
  let important = 0;
  let read = 0;
  let range = 0;
  for (const m of rows) {
    const { cls } = classifyRow(
      m,
      m.fromEmail ? senderCat.get(`${m.accountSlug}|${m.fromEmail}`) ?? null : null,
    );
    if (cls === 'important') important++;
    else if (cls === 'read') read++;
    else range++;
  }
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const [reviewedToday, laterCount] = await Promise.all([
    db.message.count({ where: { reviewedAt: { gte: startOfDay } } }),
    db.message.count({ where: { reviewDecision: 'later', isDeleted: false } }),
  ]);
  return {
    total: rows.length,
    important,
    read,
    range,
    reviewedToday,
    laterCount,
    baseline: getBaseline().toISOString(),
  };
}

/**
 * File du parcours : les importants un par un, puis les « à lire », puis le
 * rangeable par LOTS homogènes (même compte + même expéditeur + même
 * intention — les 5 notifications Rentila ne forment pas un lot avec la
 * newsletter Leroy Merlin, ni le loyer en retard avec les quittances).
 */
export async function reviewQueue(): Promise<{ groups: ReviewGroup[]; total: number }> {
  const { rows, senderCat } = await loadCandidates();
  const singles: ReviewSingle[] = [];
  const lots = new Map<string, ReviewLot>();
  let total = 0;

  for (const m of rows) {
    const senderCategory = m.fromEmail
      ? senderCat.get(`${m.accountSlug}|${m.fromEmail}`) ?? null
      : null;
    const { cls, rentila } = classifyRow(m, senderCategory);
    total++;
    if (cls !== 'range' || !m.fromEmail) {
      singles.push({ kind: 'single', item: toItem(m, cls, senderCategory, rentila) });
      continue;
    }
    // Toutes les notifications Rentila d'un compte forment UN lot (peu importe
    // l'intention) : c'est la même décision — « j'ai vu, les obligations sont
    // déjà dans le calendrier ».
    const key = rentila
      ? `${m.accountSlug}|__rentila__`
      : `${m.accountSlug}|${m.fromEmail}|${m.intent ?? ''}`;
    if (!lots.has(key)) {
      lots.set(key, {
        kind: 'lot',
        account: m.accountSlug,
        fromEmail: m.fromEmail,
        fromName: rentila ? 'Rentila' : m.fromName,
        intent: rentila ? null : m.intent,
        senderCategory: rentila ? 'notification' : senderCategory,
        count: 0,
        ids: [],
        samples: [],
        ...(rentila ? { rentila: true } : {}),
      });
    }
    const lot = lots.get(key)!;
    lot.count++;
    lot.ids.push(m.id);
    if (lot.samples.length < 10) {
      lot.samples.push({
        id: m.id,
        subject: rentila ? rentilaDisplay(rentila, m.subject) : m.subject ?? '(sans sujet)',
        date: m.date?.toISOString() ?? null,
        folder: m.folder.path,
        uid: m.uid,
      });
    }
  }

  // Ordre du parcours (§11) : importants (récents d'abord — la liste l'est
  // déjà), à lire, puis les lots du plus gros au plus petit. Un « lot » d'un
  // seul mail redevient une décision individuelle.
  const ordered: ReviewGroup[] = [
    ...singles.filter((s) => s.item.class === 'important'),
    ...singles.filter((s) => s.item.class === 'read'),
  ];
  const sortedLots = [...lots.values()].sort((a, b) => b.count - a.count);
  for (const lot of sortedLots) {
    if (lot.count === 1) {
      const s = lot.samples[0];
      const row = rows.find((r) => r.id === s.id)!;
      const info = lot.rentila
        ? parseRentilaMail({ subject: row.subject, fromEmail: row.fromEmail, fromName: row.fromName, date: row.date })
        : null;
      ordered.push({ kind: 'single', item: toItem(row, 'range', lot.senderCategory, info) });
    } else {
      ordered.push(lot);
    }
  }
  const groups = ordered.slice(0, 120);

  // ---- Chantier 2 : régime A/B + proposition sur les décisions individuelles.
  const singleItems = groups
    .filter((g): g is ReviewSingle => g.kind === 'single')
    .map((g) => g.item)
    .filter((it) => it.class !== 'range'); // le bruit garde son écran actuel (Vu par défaut)

  if (singleItems.length > 0) {
    // Échéances déjà connues pour ces mails (dédoublonnage : confirmer, jamais recréer).
    const dls = await db.deadline.findMany({
      where: {
        messageId: { in: singleItems.map((it) => it.id) },
        status: { in: ['proposed', 'confirmed'] },
      },
      orderBy: { date: 'asc' },
      select: { id: true, messageId: true, status: true, title: true, date: true },
    });
    const dlByMsg = new Map<number, ExistingDeadline>();
    for (const d of dls) {
      // confirmée > proposée ; sinon la plus proche dans le temps.
      const prev = dlByMsg.get(d.messageId);
      if (!prev || (d.status === 'confirmed' && prev.status !== 'confirmed')) dlByMsg.set(d.messageId, d);
    }

    // Historique des gestes par motif (signal + contradiction).
    const decided = await db.message.groupBy({
      by: ['accountSlug', 'fromEmail', 'intent', 'reviewDecision'],
      where: { reviewedAt: { not: null }, reviewDecision: { in: ['seen', 'trash', 'keep'] }, fromEmail: { not: null } },
      _count: { _all: true },
    });
    const history = new Map<string, { decision: ReviewDecision; count: number; mixed: boolean }>();
    for (const d of decided) {
      const key = `${d.accountSlug}|${d.fromEmail}|${d.intent ?? ''}`;
      const prev = history.get(key);
      if (!prev) history.set(key, { decision: d.reviewDecision as ReviewDecision, count: d._count._all, mixed: false });
      else {
        prev.mixed = true;
        if (d._count._all > prev.count) {
          prev.decision = d.reviewDecision as ReviewDecision;
          prev.count = d._count._all;
        }
      }
    }

    for (const it of singleItems) {
      const row = rows.find((r) => r.id === it.id);
      if (!row) continue;
      const rentila = isRentilaSender(row.fromEmail)
        ? parseRentilaMail({ subject: row.subject, fromEmail: row.fromEmail, fromName: row.fromName, date: row.date })
        : null;
      const existing = dlByMsg.get(it.id) ?? null;
      const proposal = buildProposal(row, existing, rentila);
      const hist = row.fromEmail ? history.get(`${row.accountSlug}|${row.fromEmail}|${row.intent ?? ''}`) : undefined;
      // La grammaire Rentila est déterministe (construite sur les sujets réels) :
      // deux signaux par construction — expéditeur identifié + motif reconnu.
      const regimeA = proposal !== null
        && (rentila !== null
          || convergence(row, it.senderCategory, existing !== null || proposal.date !== null, hist));
      it.regime = regimeA ? 'A' : 'B';
      it.proposal = regimeA ? proposal : null;
    }
  }

  return { groups, total };
}

// ---------------------------------------------------------------- Apprentissage
// Lot 3 du plan : l'assistant observe les DÉCISIONS répétées (même compte,
// même expéditeur, même intention → même geste) et les restitue :
//  - 2 gestes identiques  → simple remarque en fin de dépouillement ;
//  - 3 gestes cohérents ou plus → proposition explicite, avec la liste exacte
//    des mails EN ATTENTE qui seraient concernés (« Voir les N mails »).
// Un motif contredit (gestes différents sur la même clé) n'est JAMAIS proposé,
// et « Ne plus proposer » est définitif (data/review-learning.json).
// L'application d'une proposition repasse par reviewDecide (journalisée), la
// corbeille restant confirmée côté interface — rien n'est jamais automatisé.

const LEARNING_FILE = (): string => resolve(process.cwd(), 'data', 'review-learning.json');

function readLearningState(): { dismissed: Record<string, string> } {
  try {
    if (existsSync(LEARNING_FILE())) {
      const raw = JSON.parse(readFileSync(LEARNING_FILE(), 'utf8')) as { dismissed?: Record<string, string> };
      if (raw && typeof raw.dismissed === 'object' && raw.dismissed) return { dismissed: raw.dismissed };
    }
  } catch {
    /* fichier illisible : on repart d'un état vide */
  }
  return { dismissed: {} };
}

export interface LearningMotif {
  key: string;
  account: string;
  fromEmail: string;
  fromName: string | null;
  intent: string | null;
  decision: ReviewDecision;
  /** Nombre de gestes identiques déjà faits par l'utilisateur. */
  count: number;
  /** Mails encore en attente de décision qui correspondent au motif. */
  pendingIds: number[];
  pendingSamples: { subject: string; date: string | null }[];
}

/** Seuls ces gestes s'apprennent : un « plus tard » ou une tâche créée ne
 *  disent rien de généralisable sur l'expéditeur. */
const LEARNABLE: ReviewDecision[] = ['seen', 'trash', 'keep'];

export async function reviewLearning(): Promise<{ notes: LearningMotif[]; proposals: LearningMotif[] }> {
  await ensureDbReady();
  const decided = await db.message.findMany({
    where: { reviewedAt: { not: null }, reviewDecision: { in: LEARNABLE }, fromEmail: { not: null } },
    orderBy: { reviewedAt: 'desc' },
    take: 2000,
    select: { accountSlug: true, fromEmail: true, fromName: true, intent: true, reviewDecision: true },
  });

  // Décompte par clé compte|expéditeur|intention, toutes décisions confondues
  // (pour détecter les contradictions).
  const tally = new Map<string, {
    account: string; fromEmail: string; fromName: string | null; intent: string | null;
    byDecision: Map<ReviewDecision, number>;
  }>();
  for (const m of decided) {
    const key = `${m.accountSlug}|${m.fromEmail}|${m.intent ?? ''}`;
    if (!tally.has(key)) {
      tally.set(key, {
        account: m.accountSlug, fromEmail: m.fromEmail!, fromName: m.fromName,
        intent: m.intent, byDecision: new Map(),
      });
    }
    const t = tally.get(key)!.byDecision;
    const d = m.reviewDecision as ReviewDecision;
    t.set(d, (t.get(d) ?? 0) + 1);
  }

  const { dismissed } = readLearningState();
  const { rows } = await loadCandidates();
  const notes: LearningMotif[] = [];
  const proposals: LearningMotif[] = [];

  for (const [key, t] of tally) {
    // Motif cohérent = UNE seule décision observée sur la clé. Dès que
    // l'utilisateur a corrigé (gestes différents), le motif disparaît.
    if (t.byDecision.size !== 1) continue;
    const [decision, count] = [...t.byDecision.entries()][0];
    if (count < 2) continue;
    const motifKey = `${key}|${decision}`;
    if (dismissed[motifKey]) continue;

    const pending = rows.filter((r) =>
      r.accountSlug === t.account && r.fromEmail === t.fromEmail && (r.intent ?? '') === (t.intent ?? ''));
    const motif: LearningMotif = {
      key: motifKey,
      account: t.account,
      fromEmail: t.fromEmail,
      fromName: t.fromName,
      intent: t.intent,
      decision,
      count,
      pendingIds: pending.map((r) => r.id),
      pendingSamples: pending.slice(0, 8).map((r) => ({
        subject: r.subject ?? '(sans sujet)',
        date: r.date?.toISOString() ?? null,
      })),
    };
    // Proposition seulement si elle a une prise concrète (des mails en attente).
    if (count >= 3 && motif.pendingIds.length > 0) proposals.push(motif);
    else if (count === 2) notes.push(motif);
  }

  proposals.sort((a, b) => b.pendingIds.length - a.pendingIds.length);
  notes.sort((a, b) => b.count - a.count);
  return { notes: notes.slice(0, 5), proposals: proposals.slice(0, 5) };
}

/** « Ne plus proposer » — définitif, journalisé. */
export async function reviewLearningDismiss(key: string): Promise<void> {
  const state = readLearningState();
  state.dismissed[key] = new Date().toISOString();
  mkdirSync(dirname(LEARNING_FILE()), { recursive: true });
  writeFileSync(LEARNING_FILE(), JSON.stringify(state, null, 2), 'utf8');
  const [account] = key.split('|');
  await recordOperation({
    account: account || '*',
    tool: 'ui_review_learning_dismiss',
    params: { key },
    result: `apprentissage : proposition « ${key} » écartée définitivement`,
  });
}

// ---------------------------------------------------------------- Décision
export interface DecideResult {
  count: number;
  decision: ReviewDecision;
  tasksCreated: number;
  errors: string[];
}

/**
 * Applique UNE décision à un ou plusieurs mails. Les effets réels (marquer lu,
 * corbeille) passent par IMAP compte par compte, dossier par dossier, lots de
 * 200 — et l'index est mis à jour dans la foulée. Un dossier injoignable
 * n'empêche pas la décision d'être enregistrée : l'état IMAP se recalera à la
 * synchronisation suivante.
 */
export async function reviewDecide(ids: number[], decision: ReviewDecision): Promise<DecideResult> {
  await ensureDbReady();
  if (!REVIEW_DECISIONS.includes(decision)) throw new Error(`Décision inconnue : ${decision}`);
  const unique = [...new Set(ids)].slice(0, 500);
  const messages = await db.message.findMany({
    where: { id: { in: unique }, isDeleted: false },
    select: {
      id: true, accountSlug: true, uid: true, subject: true, date: true,
      fromEmail: true, fromName: true, folder: { select: { path: true } },
    },
  });
  if (messages.length === 0) return { count: 0, decision, tasksCreated: 0, errors: [] };

  const errors: string[] = [];
  let tasksCreated = 0;

  // Effets réels, groupés par compte + dossier.
  if (decision === 'seen' || decision === 'trash') {
    const byTarget = new Map<string, { account: string; folder: string; uids: number[] }>();
    for (const m of messages) {
      const key = `${m.accountSlug}|${m.folder.path}`;
      if (!byTarget.has(key)) byTarget.set(key, { account: m.accountSlug, folder: m.folder.path, uids: [] });
      byTarget.get(key)!.uids.push(m.uid);
    }
    for (const t of byTarget.values()) {
      try {
        const rec = await resolveAccount(t.account);
        for (const part of chunk(t.uids, 200)) {
          if (decision === 'seen') await imapService.markEmails(rec, t.folder, part, ['\\Seen'], []);
          else await imapService.moveToTrash(rec, t.folder, part);
        }
      } catch (err) {
        errors.push(`${t.account}/${t.folder} : ${(err as Error).message}`);
        logger.warn('dépouillement : effet IMAP en échec (index quand même mis à jour)', {
          account: t.account, folder: t.folder, decision, error: (err as Error).message,
        });
      }
    }
  }
  if (decision === 'action') {
    for (const m of messages) {
      try {
        await createTask({
          title: `Traiter : ${m.subject ?? '(sans sujet)'}`,
          account: m.accountSlug,
          messageRef: { folder: m.folder.path, uid: m.uid },
          source: 'mail',
        });
        tasksCreated++;
      } catch (err) {
        errors.push(`tâche « ${m.subject ?? ''} » : ${(err as Error).message}`);
      }
    }
  }

  // La décision elle-même + reflet local des effets.
  const now = new Date();
  const idList = messages.map((m) => m.id);
  await db.message.updateMany({
    where: { id: { in: idList } },
    data: {
      reviewedAt: now,
      reviewDecision: decision,
      ...(decision === 'seen' ? { isSeen: true } : {}),
      ...(decision === 'trash' ? { isDeleted: true } : {}),
    },
  });

  const accounts = [...new Set(messages.map((m) => m.accountSlug))];
  const DECISION_LABELS: Record<ReviewDecision, string> = {
    seen: 'marqué(s) vu(s)',
    later: 'gardé(s) à lire plus tard',
    keep: 'gardé(s) dans la boîte',
    action: 'ajouté(s) aux actions (tâche créée)',
    trash: 'mis à la corbeille (récupérables ~30 j)',
  };
  await recordOperation({
    account: accounts.length === 1 ? accounts[0] : '*',
    tool: 'ui_review_decide',
    params: { decision, count: messages.length },
    affectedUids: messages.map((m) => m.uid),
    items: messages.slice(0, 500).map((m) => ({
      subject: m.subject ?? '(sans sujet)',
      date: m.date?.toISOString() ?? null,
      // Corbeille : le mail a bougé, pas de lien (il serait mort).
      ...(decision === 'trash' ? {} : { folder: m.folder.path, uid: m.uid }),
    })),
    result: `dépouillement : ${messages.length} mail(s) ${DECISION_LABELS[decision]}`,
  });

  return { count: messages.length, decision, tasksCreated, errors };
}

// ---------------------------------------------------------------- Validation (chantier 2)
export interface ValidateProposalInput {
  messageId: number;
  objectType: 'deadline' | 'task';
  title: string;
  /** ISO — requis pour une échéance. */
  date?: string | null;
  deadlineType?: string;
  deadlineId?: number | null;
}

/**
 * Valider une proposition = DEUX effets indissociables (spéc. actée 03/08) :
 * l'objet métier est créé/confirmé ET le mail est dépouillé — dans une même
 * transaction SQLite, avec UNE ligne de journal. L'effet IMAP (marquer lu)
 * reste hors transaction, tolérant comme partout. Idempotence par l'ÉTAT
 * COMPLET : objet présent + mail non dépouillé → seule la décision est
 * appliquée ; les deux présents → « déjà fait ».
 */
export async function validateProposal(input: ValidateProposalInput): Promise<{
  status: 'done' | 'already';
  label: string;
  errors: string[];
}> {
  await ensureDbReady();
  const title = (input.title ?? '').trim().slice(0, 300);
  if (!title) throw new Error('Le titre est vide.');
  const m = await db.message.findFirst({
    where: { id: input.messageId, isDeleted: false },
    select: {
      id: true, accountSlug: true, uid: true, subject: true, date: true,
      threadId: true, reviewedAt: true, fromEmail: true, fromName: true,
      folder: { select: { path: true } },
    },
  });
  if (!m) throw new Error("Mail introuvable dans l'index — resynchronise la boîte.");

  const errors: string[] = [];
  let label = '';
  let decisionApplied = false;

  if (input.objectType === 'deadline') {
    const date = input.date ? new Date(input.date) : null;
    if (!date || Number.isNaN(date.getTime())) throw new Error("Date d'échéance requise.");
    const dtype = ['payment', 'document', 'appointment', 'renewal', 'other'].includes(input.deadlineType ?? '')
      ? (input.deadlineType as string)
      : 'other';
    const existing = input.deadlineId
      ? await db.deadline.findFirst({ where: { id: input.deadlineId, accountSlug: m.accountSlug } })
      : await db.deadline.findFirst({
          where: { accountSlug: m.accountSlug, messageId: m.id, status: { in: ['proposed', 'confirmed'] } },
          orderBy: { date: 'asc' },
        });
    if (existing?.status === 'confirmed' && m.reviewedAt) {
      return { status: 'already', label: 'échéance déjà confirmée et mail déjà dépouillé', errors };
    }
    await db.$transaction(async (tx) => {
      if (existing) {
        if (existing.status !== 'confirmed' || existing.title !== title || existing.date.getTime() !== date.getTime()) {
          await tx.deadline.update({
            where: { id: existing.id },
            data: { title, date, status: 'confirmed' },
          });
        }
      } else {
        await tx.deadline.create({
          data: {
            accountSlug: m.accountSlug,
            messageId: m.id,
            threadId: m.threadId,
            title,
            date,
            type: dtype,
            // Née d'une validation humaine explicite : directement confirmée.
            status: 'confirmed',
            confidence: 1,
            reason: 'proposée au dépouillement, validée par toi',
            sourceText: m.subject ?? '',
            fromEmail: m.fromEmail,
            fromName: m.fromName,
            subject: m.subject,
          },
        });
      }
      if (!m.reviewedAt) {
        await tx.message.update({
          where: { id: m.id },
          data: { reviewedAt: new Date(), reviewDecision: 'seen', isSeen: true },
        });
        decisionApplied = true;
      }
    });
    label = existing
      ? `échéance confirmée « ${title} » (${date.toLocaleDateString('fr-FR')})`
      : `échéance créée « ${title} » (${date.toLocaleDateString('fr-FR')})`;
  } else {
    if (m.reviewedAt) return { status: 'already', label: 'mail déjà dépouillé', errors };
    const dueDate = input.date ? new Date(input.date) : null;
    await createTask({
      title,
      account: m.accountSlug,
      messageRef: { folder: m.folder.path, uid: m.uid },
      source: 'mail',
      ...(dueDate && !Number.isNaN(dueDate.getTime()) ? { dueDate } : {}),
    });
    await db.message.update({
      where: { id: m.id },
      data: { reviewedAt: new Date(), reviewDecision: 'action', isSeen: true },
    });
    decisionApplied = true;
    label = `tâche créée « ${title} »`;
  }

  // Effet IMAP hors transaction : l'index local fait foi, l'état distant se
  // recale à la synchronisation suivante en cas d'échec.
  if (decisionApplied) {
    try {
      const rec = await resolveAccount(m.accountSlug);
      await imapService.markEmails(rec, m.folder.path, [m.uid], ['\Seen'], []);
    } catch (err) {
      errors.push(`marquage lu : ${(err as Error).message}`);
    }
  }

  await recordOperation({
    account: m.accountSlug,
    tool: 'ui_review_validate',
    params: { messageId: m.id, objectType: input.objectType },
    affectedUids: [m.uid],
    items: [{ subject: m.subject ?? '(sans sujet)', date: m.date?.toISOString() ?? null, folder: m.folder.path, uid: m.uid }],
    result: `dépouillement : ${label} + mail traité`,
  });
  return { status: 'done', label, errors };
}
