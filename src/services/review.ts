import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { db, ensureDbReady } from '../db/client.js';
import { logger } from '../logger.js';
import { recordOperation } from './oplog.js';
import { createTask } from './tasks.js';
import { imapService } from './imap.js';
import { resolveAccount } from './accounts.js';
import { chunk } from './attention.js';

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
      intent: true, aiAction: true, aiSummary: true, analysisConfidence: true,
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

function toItem(m: CandidateRow, cls: ReviewClass, senderCategory: string | null) {
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
    const cls = classify({
      intent: m.intent,
      aiAction: m.aiAction,
      analysisConfidence: m.analysisConfidence,
      senderCategory: m.fromEmail ? senderCat.get(`${m.accountSlug}|${m.fromEmail}`) ?? null : null,
    });
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
    const cls = classify({
      intent: m.intent,
      aiAction: m.aiAction,
      analysisConfidence: m.analysisConfidence,
      senderCategory,
    });
    total++;
    if (cls !== 'range' || !m.fromEmail) {
      singles.push({ kind: 'single', item: toItem(m, cls, senderCategory) });
      continue;
    }
    const key = `${m.accountSlug}|${m.fromEmail}|${m.intent ?? ''}`;
    if (!lots.has(key)) {
      lots.set(key, {
        kind: 'lot',
        account: m.accountSlug,
        fromEmail: m.fromEmail,
        fromName: m.fromName,
        intent: m.intent,
        senderCategory,
        count: 0,
        ids: [],
        samples: [],
      });
    }
    const lot = lots.get(key)!;
    lot.count++;
    lot.ids.push(m.id);
    if (lot.samples.length < 10) {
      lot.samples.push({
        id: m.id,
        subject: m.subject ?? '(sans sujet)',
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
      ordered.push({ kind: 'single', item: toItem(row, 'range', lot.senderCategory) });
    } else {
      ordered.push(lot);
    }
  }
  return { groups: ordered.slice(0, 120), total };
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
