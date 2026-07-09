import { db, ensureDbReady } from '../db/client.js';
import { recordOperation } from './oplog.js';
import { imapService } from './imap.js';
import type { AccountRecord } from './accounts.js';

/**
 * Deadline Engine — Phase 4, brique 4 (SPEC V2 §8.6, livraison L2).
 *
 * Détecte les dates limites dans les mails : passe rapide sur les SUJETS
 * (index local), passe approfondie optionnelle sur les CORPS (IMAP, plafonnée).
 * Chaque échéance est PROPOSÉE puis validée/ignorée par l'utilisateur —
 * jamais d'action automatique (garde-fou SPEC §11.5).
 *
 * Les newsletters sont exclues (leurs « offres valables jusqu'au… » ne sont
 * pas des échéances). Les statuts non-proposed ne sont jamais écrasés par une
 * nouvelle détection.
 */

export type DeadlineType = 'payment' | 'document' | 'appointment' | 'renewal' | 'other';
export type DeadlineStatus = 'proposed' | 'confirmed' | 'dismissed' | 'done';

export interface ExtractedDeadline {
  date: Date;
  type: DeadlineType;
  confidence: number;
  /** Extrait du texte contenant la date (pour justification). */
  sourceText: string;
  /** Tournure déclencheuse trouvée (« avant le », « échéance du »…), sinon null. */
  trigger: string | null;
}

// ---------------------------------------------------------------------------
// Parseur de dates françaises (aucune dépendance)
// ---------------------------------------------------------------------------

const MONTHS: Record<string, number> = {
  janvier: 1, janv: 1,
  fevrier: 2, février: 2, fevr: 2, févr: 2,
  mars: 3,
  avril: 4, avr: 4,
  mai: 5,
  juin: 6,
  juillet: 7, juil: 7,
  aout: 8, août: 8,
  septembre: 9, sept: 9,
  octobre: 10, oct: 10,
  novembre: 11, nov: 11,
  decembre: 12, décembre: 12, dec: 12, déc: 12,
};
const MONTH_ALT = Object.keys(MONTHS).join('|');

/** Tournures qui annoncent une vraie date limite (confiance forte). */
const TRIGGER_RE =
  /(avant le|avant fin|d'ici(?: le| au)?|au plus tard(?: le| pour le)?|jusqu'au|[ée]ch[ée]ance(?: du| au| le|\s*:)?|date limite(?: du| le|\s*:)?|[àa] r[ée]gler (?:avant|pour) le|expire le|valable jusqu'au|renouveler avant le|rendez-vous(?: le| du)|rdv(?: le| du))\s*$/i;

const TYPE_RULES: { type: DeadlineType; re: RegExp; label: string }[] = [
  {
    type: 'payment',
    re: /(payer|paiement|r[ée]gler|r[èe]glement|facture|impay[ée]|pr[ée]l[èe]vement|cotisation|loyer|relance|montant|somme)/i,
    label: 'paiement',
  },
  {
    type: 'document',
    re: /(document|justificatif|transmettre|fournir|pi[èe]ces?|attestation|dossier|d[ée]claration|formulaire|signer|signature)/i,
    label: 'document à fournir',
  },
  {
    type: 'appointment',
    re: /(rendez-vous|\brdv\b|r[ée]union|entretien|visite|convocation|assembl[ée]e)/i,
    label: 'rendez-vous',
  },
  {
    type: 'renewal',
    re: /(renouvel|expire|expiration|r[ée]silier|r[ée]siliation|fin de contrat|[ée]ch[ée]ance de contrat)/i,
    label: 'renouvellement/expiration',
  },
];

function guessType(text: string): { type: DeadlineType; label: string } {
  for (const rule of TYPE_RULES) {
    if (rule.re.test(text)) return { type: rule.type, label: rule.label };
  }
  return { type: 'other', label: 'autre' };
}

/**
 * Résout jour/mois(/année) en Date. Année absente : prochaine occurrence
 * (si la date est déjà passée de plus de 45 j cette année → année suivante ;
 * la tolérance de 45 j permet de détecter les échéances récemment dépassées).
 */
function buildDate(
  day: number,
  month: number,
  year: number | null,
  hour: number | null,
  minute: number | null,
  ref: Date,
): Date | null {
  if (day < 1 || day > 31 || month < 1 || month > 12) return null;
  let y = year;
  if (y !== null && y < 100) y += 2000;
  if (y === null) {
    y = ref.getFullYear();
    const candidate = new Date(y, month - 1, day);
    if (candidate.getTime() < ref.getTime() - 45 * 86_400_000) y += 1;
  }
  if (y < 2000 || y > 2100) return null;
  const d = new Date(y, month - 1, day, hour ?? 9, minute ?? 0);
  // Rejette les dates invalides (31 février → 2/3 mars).
  if (d.getDate() !== day || d.getMonth() !== month - 1) return null;
  return d;
}

/** Extrait de contexte autour d'une position (pour sourceText). */
function excerpt(text: string, index: number, length: number): string {
  const start = Math.max(0, index - 40);
  const end = Math.min(text.length, index + length + 25);
  return `${start > 0 ? '…' : ''}${text.slice(start, end).replace(/\s+/g, ' ').trim()}${
    end < text.length ? '…' : ''
  }`;
}

/**
 * Trouve les échéances dans un texte français.
 * Chaque date détectée est qualifiée : tournure déclencheuse (confiance 0.9)
 * ou date « nue » (0.6, gardée seulement si le contexte évoque un type connu).
 */
export function extractDeadlines(text: string, refDate = new Date()): ExtractedDeadline[] {
  if (!text) return [];
  const found: ExtractedDeadline[] = [];
  const seen = new Set<string>();

  const timeRe = /(?:\s*(?:à|a)\s*(\d{1,2})\s*h\s*(\d{2})?)?/.source;
  const patterns: { re: RegExp; kind: 'numeric' | 'textual' }[] = [
    {
      // 15/07, 15/07/2026, 15.07.26 (+ heure optionnelle)
      re: new RegExp(
        String.raw`\b(\d{1,2})[\/.](\d{1,2})(?:[\/.](\d{2,4}))?\b` + timeRe,
        'gi',
      ),
      kind: 'numeric',
    },
    {
      // 15 juillet, 1er juillet 2026 (+ heure optionnelle)
      re: new RegExp(
        String.raw`\b(1er|\d{1,2})\s+(${MONTH_ALT})(?:\s+(\d{4}))?\b` + timeRe,
        'gi',
      ),
      kind: 'textual',
    },
  ];

  for (const { re, kind } of patterns) {
    for (const m of text.matchAll(re)) {
      const idx = m.index ?? 0;
      let day: number, month: number;
      let year: number | null = null;
      let hour: number | null = null;
      let minute: number | null = null;

      if (kind === 'numeric') {
        day = Number.parseInt(m[1], 10);
        month = Number.parseInt(m[2], 10);
        if (m[3] !== undefined) year = Number.parseInt(m[3], 10);
        if (m[4] !== undefined) hour = Number.parseInt(m[4], 10);
        if (m[5] !== undefined) minute = Number.parseInt(m[5], 10);
        // « 15/2026 » ou fragment de montant « 15/300 € » : mois invalide → rejet
        // via buildDate ; « 07/2026 » (mois/année) non géré volontairement (ambigu).
      } else {
        day = m[1].toLowerCase() === '1er' ? 1 : Number.parseInt(m[1], 10);
        month = MONTHS[m[2].toLowerCase()] ?? 0;
        if (m[3] !== undefined) year = Number.parseInt(m[3], 10);
        if (m[4] !== undefined) hour = Number.parseInt(m[4], 10);
        if (m[5] !== undefined) minute = Number.parseInt(m[5], 10);
      }

      const date = buildDate(day, month, year, hour, minute, refDate);
      if (!date) continue;

      // Tournure déclencheuse juste avant la date (fenêtre de 28 caractères).
      const before = text.slice(Math.max(0, idx - 28), idx);
      const triggerMatch = TRIGGER_RE.exec(before);
      const trigger = triggerMatch ? triggerMatch[1].trim() : null;

      const context = excerpt(text, idx, m[0].length);
      const { type } = guessType(context);

      // Une date « nue » sans tournure ni contexte typé = bruit → ignorée.
      if (!trigger && type === 'other') continue;

      const key = date.toISOString().slice(0, 16);
      if (seen.has(key)) continue;
      seen.add(key);

      found.push({
        date,
        type: hour !== null && type === 'other' ? 'appointment' : type,
        confidence: trigger ? 0.9 : 0.6,
        sourceText: context,
        trigger,
      });
    }
  }

  return found.sort((a, b) => a.date.getTime() - b.date.getTime());
}

// ---------------------------------------------------------------------------
// Détection sur les mails d'un compte
// ---------------------------------------------------------------------------

/** Pré-filtre des sujets candidats pour la passe approfondie (corps). */
const DEEP_SUBJECT_RE =
  /(avant le|[ée]ch[ée]ance|d'ici|date limite|au plus tard|rappel|relance|facture|payer|r[ée]gler|rdv|rendez-vous|renouvel|expire|d[ée]claration|justificatif|document)/i;

const DEEP_BODY_CAP = 50;

export interface DetectReport {
  account: string;
  scanned: number;
  bodiesRead: number;
  created: number;
  alreadyKnown: number;
  durationMs: number;
}

export async function detectDeadlines(
  rec: AccountRecord,
  opts: { sinceDays?: number; deep?: boolean; onProgress?: (m: string) => void } = {},
): Promise<DetectReport> {
  await ensureDbReady();
  const started = Date.now();
  const sinceDays = Math.min(Math.max(opts.sinceDays ?? 30, 1), 365);
  const since = new Date(Date.now() - sinceDays * 86_400_000);
  const progress = opts.onProgress ?? (() => {});
  const account = rec.account;

  // Mails entrants récents, hors newsletters/corbeille/spam/brouillons.
  const messages = await db.message.findMany({
    where: {
      accountSlug: account,
      isDeleted: false,
      isOutbound: false,
      hasListUnsubscribe: false,
      date: { gte: since },
      folder: { is: { role: { notIn: ['trash', 'spam', 'drafts'] } } },
    },
    orderBy: { date: 'desc' },
    select: {
      id: true,
      uid: true,
      threadId: true,
      subject: true,
      fromEmail: true,
      fromName: true,
      date: true,
      folder: { select: { path: true } },
    },
  });
  progress(`${messages.length} mails à analyser (sujets)…`);

  let created = 0;
  let alreadyKnown = 0;
  let bodiesRead = 0;
  const createdItems: { subject: string; date: string | null }[] = [];

  const record = async (
    msg: (typeof messages)[number],
    ex: ExtractedDeadline,
    source: 'sujet' | 'contenu',
  ) => {
    const existing = await db.deadline.findUnique({
      where: {
        accountSlug_messageId_date: { accountSlug: account, messageId: msg.id, date: ex.date },
      },
    });
    if (existing) {
      alreadyKnown++;
      // Ne jamais écraser un statut travaillé par l'utilisateur ; on peut
      // seulement renforcer la confiance d'une proposition.
      if (existing.status === 'proposed' && ex.confidence > existing.confidence) {
        await db.deadline.update({
          where: { id: existing.id },
          data: { confidence: ex.confidence, sourceText: ex.sourceText, reason: reason() },
        });
      }
      return;
    }

    function reason(): string {
      const parts = [
        ex.trigger
          ? `le ${source} mentionne « ${ex.trigger} » suivi d'une date`
          : `date trouvée dans le ${source} avec un contexte de type connu`,
        `extrait : « ${ex.sourceText} »`,
      ];
      return parts.join(' · ');
    }

    await db.deadline.create({
      data: {
        accountSlug: account,
        messageId: msg.id,
        threadId: msg.threadId,
        title: msg.subject ?? '(sans sujet)',
        date: ex.date,
        type: ex.type,
        confidence: ex.confidence,
        reason: reason(),
        sourceText: ex.sourceText,
        fromEmail: msg.fromEmail,
        fromName: msg.fromName,
        subject: msg.subject,
      },
    });
    created++;
    createdItems.push({
      subject: `${msg.subject ?? '(sans sujet)'} → ${ex.date.toLocaleDateString('fr-FR')}`,
      date: msg.date?.toISOString() ?? null,
    });
  };

  // Passe 1 : sujets (instantané).
  for (const msg of messages) {
    for (const ex of extractDeadlines(msg.subject ?? '', msg.date ?? new Date())) {
      await record(msg, ex, 'sujet');
    }
  }

  // Passe 2 (optionnelle) : corps des mails au sujet évocateur, via IMAP.
  if (opts.deep) {
    const candidates = messages
      .filter((m) => DEEP_SUBJECT_RE.test(m.subject ?? ''))
      .slice(0, DEEP_BODY_CAP);
    progress(`Analyse approfondie : lecture de ${candidates.length} contenus de mails…`);
    for (const msg of candidates) {
      try {
        const body = await imapService.readEmail(rec, msg.folder.path, msg.uid);
        bodiesRead++;
        for (const ex of extractDeadlines(body.text, msg.date ?? new Date())) {
          await record(msg, ex, 'contenu');
        }
        if (bodiesRead % 10 === 0) progress(`…${bodiesRead}/${candidates.length} contenus lus`);
      } catch {
        // Mail déplacé/supprimé depuis la sync : on continue.
      }
    }
  }

  if (created > 0) {
    await recordOperation({
      account,
      tool: 'detect_deadlines',
      params: { sinceDays, deep: Boolean(opts.deep), created, scanned: messages.length },
      items: createdItems.slice(0, 100),
      result: `${created} échéance(s) proposée(s)`,
    });
  }
  progress(`✅ ${created} nouvelle(s) échéance(s) proposée(s) (${alreadyKnown} déjà connues).`);

  return {
    account,
    scanned: messages.length,
    bodiesRead,
    created,
    alreadyKnown,
    durationMs: Date.now() - started,
  };
}

// ---------------------------------------------------------------------------
// Liste et cycle de vie
// ---------------------------------------------------------------------------

export interface DeadlineItem {
  id: number;
  account: string;
  messageId: number;
  threadId: number | null;
  title: string;
  date: string;
  type: DeadlineType;
  status: DeadlineStatus;
  confidence: number;
  reason: string;
  sourceText: string;
  fromEmail: string | null;
  fromName: string | null;
  subject: string | null;
  /** Jours restants (négatif si passée). */
  inDays: number;
  /** Localisation du mail source dans l'index (null s'il a disparu) —
   *  permet d'ouvrir le mail depuis l'interface. */
  folder: string | null;
  uid: number | null;
  msgDate: string | null;
  isSeen: boolean | null;
}

/** Métadonnées du mail source encore présent dans l'index. */
type SourceMeta = { uid: number; isSeen: boolean; date: Date | null; folder: { path: string } };

async function loadSourceMeta(messageIds: number[]): Promise<Map<number, SourceMeta>> {
  const metas = new Map<number, SourceMeta>();
  for (let i = 0; i < messageIds.length; i += 500) {
    const rows = await db.message.findMany({
      where: { id: { in: messageIds.slice(i, i + 500) }, isDeleted: false },
      select: {
        id: true,
        uid: true,
        isSeen: true,
        date: true,
        folder: { select: { path: true } },
      },
    });
    for (const r of rows) metas.set(r.id, r);
  }
  return metas;
}

function toItem(
  d: {
    id: number;
    accountSlug: string;
    messageId: number;
    threadId: number | null;
    title: string;
    date: Date;
    type: string;
    status: string;
    confidence: number;
    reason: string;
    sourceText: string;
    fromEmail: string | null;
    fromName: string | null;
    subject: string | null;
  },
  source?: SourceMeta,
): DeadlineItem {
  return {
    id: d.id,
    account: d.accountSlug,
    messageId: d.messageId,
    threadId: d.threadId,
    title: d.title,
    date: d.date.toISOString(),
    type: d.type as DeadlineType,
    status: d.status as DeadlineStatus,
    confidence: d.confidence,
    reason: d.reason,
    sourceText: d.sourceText,
    fromEmail: d.fromEmail,
    fromName: d.fromName,
    subject: d.subject,
    inDays: Math.round((d.date.getTime() - Date.now()) / 86_400_000),
    folder: source?.folder.path ?? null,
    uid: source?.uid ?? null,
    msgDate: source?.date?.toISOString() ?? null,
    isSeen: source?.isSeen ?? null,
  };
}

export async function listDeadlines(
  account: string,
  opts: { fromDate?: string; toDate?: string; status?: DeadlineStatus; limit?: number } = {},
): Promise<DeadlineItem[]> {
  await ensureDbReady();
  const rows = await db.deadline.findMany({
    where: {
      accountSlug: account,
      ...(opts.status ? { status: opts.status } : {}),
      ...(opts.fromDate || opts.toDate
        ? {
            date: {
              ...(opts.fromDate ? { gte: new Date(opts.fromDate) } : {}),
              ...(opts.toDate ? { lte: new Date(opts.toDate) } : {}),
            },
          }
        : {}),
    },
    orderBy: { date: 'asc' },
    take: Math.min(Math.max(opts.limit ?? 200, 1), 1000),
  });
  const metas = await loadSourceMeta(rows.map((r) => r.messageId));
  return rows.map((r) => toItem(r, metas.get(r.messageId)));
}

async function setStatus(
  account: string,
  id: number,
  status: DeadlineStatus,
  toolName: string,
  resultLabel: string,
): Promise<DeadlineItem> {
  await ensureDbReady();
  const row = await db.deadline.findFirst({ where: { id, accountSlug: account } });
  if (!row) throw new Error(`Échéance ${id} introuvable pour le compte « ${account} ».`);
  const updated = await db.deadline.update({ where: { id }, data: { status } });
  await recordOperation({
    account,
    tool: toolName,
    params: { deadlineId: id, date: row.date.toISOString() },
    items: [{ subject: row.title, date: row.date.toISOString() }],
    result: resultLabel,
  });
  const metas = await loadSourceMeta([updated.messageId]);
  return toItem(updated, metas.get(updated.messageId));
}

export function confirmDeadline(account: string, id: number): Promise<DeadlineItem> {
  return setStatus(account, id, 'confirmed', 'confirm_deadline', 'échéance confirmée');
}

export function dismissDeadline(account: string, id: number): Promise<DeadlineItem> {
  return setStatus(account, id, 'dismissed', 'dismiss_deadline', 'échéance ignorée');
}

export function completeDeadline(account: string, id: number): Promise<DeadlineItem> {
  return setStatus(account, id, 'done', 'complete_deadline', 'échéance faite');
}

/** Remet une échéance ignorée/faite en « proposée » (annulation). */
export function restoreDeadline(account: string, id: number): Promise<DeadlineItem> {
  return setStatus(account, id, 'proposed', 'restore_deadline', 'échéance remise en proposition');
}

/**
 * Propose une échéance depuis le panneau de lecture (L5.4) : l'utilisateur a
 * vu la date dans le mail ouvert et clique « Proposer ». Idempotent (contrainte
 * unique compte+mail+date) et jamais d'écrasement d'un statut travaillé.
 */
export async function proposeDeadline(
  account: string,
  messageId: number,
  input: { date: Date; type?: DeadlineType; sourceText?: string },
): Promise<DeadlineItem> {
  await ensureDbReady();
  const msg = await db.message.findFirst({
    where: { id: messageId, accountSlug: account, isDeleted: false },
    select: {
      id: true,
      threadId: true,
      subject: true,
      fromEmail: true,
      fromName: true,
    },
  });
  if (!msg) throw new Error(`Mail ${messageId} introuvable pour le compte « ${account} ».`);
  if (Number.isNaN(input.date.getTime())) throw new Error('Date invalide.');

  const existing = await db.deadline.findUnique({
    where: {
      accountSlug_messageId_date: { accountSlug: account, messageId, date: input.date },
    },
  });
  const metas = await loadSourceMeta([messageId]);
  if (existing) return toItem(existing, metas.get(messageId));

  const row = await db.deadline.create({
    data: {
      accountSlug: account,
      messageId,
      threadId: msg.threadId,
      title: msg.subject ?? '(sans sujet)',
      date: input.date,
      type: input.type ?? 'other',
      status: 'proposed',
      confidence: 0.9,
      reason: 'proposée depuis le panneau de lecture (date vérifiée dans le mail ouvert)',
      sourceText: (input.sourceText ?? '').slice(0, 300),
      fromEmail: msg.fromEmail,
      fromName: msg.fromName,
      subject: msg.subject,
    },
  });
  await recordOperation({
    account,
    tool: 'propose_deadline',
    params: { messageId, date: input.date.toISOString(), type: row.type },
    items: [{ subject: row.title, date: input.date.toISOString() }],
    result: 'échéance proposée depuis la lecture',
  });
  return toItem(row, metas.get(messageId));
}
