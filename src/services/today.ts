import { db, ensureDbReady } from '../db/client.js';
import { listAccountNames } from './accounts.js';
import { getUnansweredEmails, type ReplyItem } from './attention.js';
import { getFollowupsDue, type FollowupItem } from './followups.js';
import { getImportantEmails, type ImportantItem } from './importance.js';
import { listDeadlines, type DeadlineItem } from './deadlines.js';
import { previewSnippet } from './search.js';
import { logger } from '../logger.js';

/**
 * Accueil « Aujourd'hui » (A2 — Cap V3). L'utilisateur ne voit plus des mails
 * mais des ACTIONS : à faire, important, peut attendre, bruit. Agrégat
 * index-only multi-comptes qui RÉUTILISE les moteurs existants (réponses,
 * relances, échéances, importance) + les catégories/intentions A1.
 * Un compte en erreur est signalé sans casser l'accueil.
 */

export type NoiseBucket = 'newsletter' | 'notification' | 'social' | 'promo';

export const NOISE_BUCKETS: NoiseBucket[] = ['newsletter', 'notification', 'social', 'promo'];

// GARDE-FOU (retour utilisateur 10/07) : un mail reçu ces N derniers jours
// n'est JAMAIS du « bruit » supprimable — une newsletter d'aujourd'hui peut
// encore être lue. Appliqué aux compteurs ET à l'aperçu/suppression.
export const NOISE_MIN_AGE_DAYS = 7;

// Affectation d'un mail de la boîte de réception à un « bruit » (disjoint —
// l'ordre du CASE fait foi) : expéditeur newsletter > notification > réseau
// social > pub (expéditeur publicitaire OU intention promo détectée).
const NOISE_BUCKET_CASE = `CASE
  WHEN s.category = 'newsletter' THEN 'newsletter'
  WHEN s.category = 'notification' THEN 'notification'
  WHEN s.category = 'social' THEN 'social'
  WHEN s.category = 'ad' OR m.intent = 'promo' THEN 'promo'
  ELSE NULL END`;

export interface InvoiceItem {
  account: string;
  folder: string;
  uid: number;
  subject: string;
  fromEmail: string;
  fromName: string | null;
  date: string | null;
  isSeen: boolean;
  reason: string;
}

export interface NoiseBucketStat {
  bucket: NoiseBucket;
  count: number;
  unseen: number;
  sizeBytes: number;
}

export interface TodaySummary {
  generatedAt: string;
  accounts: string[];
  skippedAccounts: { account: string; error: string }[];
  todo: {
    replies: ReplyItem[];
    followups: FollowupItem[];
    deadlines: DeadlineItem[];
    invoices: InvoiceItem[];
    total: number;
    /** Actions réellement présentes dans les listes (= ce que le parcours traitera). */
    queued: number;
  };
  important: ImportantItem[];
  canWait: { count: number; unseen: number };
  noise: { buckets: NoiseBucketStat[]; total: number; sizeBytes: number };
  /** false = catégories A1 jamais calculées → proposer le recalcul. */
  categorized: boolean;
}

const TOP = 10;

/** Agrégat « Aujourd'hui » sur tous les comptes enrôlés. */
export async function generateToday(): Promise<TodaySummary> {
  await ensureDbReady();
  const names = await listAccountNames();
  const skipped: { account: string; error: string }[] = [];
  const endOfToday = new Date();
  endOfToday.setHours(23, 59, 59, 999);

  const replies: ReplyItem[] = [];
  const followups: FollowupItem[] = [];
  const deadlines: DeadlineItem[] = [];
  const important: ImportantItem[] = [];

  for (const name of names) {
    try {
      const r = await getUnansweredEmails(name, { sinceDays: 60, limit: 100 });
      replies.push(...r.items.filter((i) => i.state === 'active'));
      const f = await getFollowupsDue(name, { sinceDays: 60, limit: 100 });
      followups.push(...f.items.filter((i) => i.state === 'active'));
      const d = await listDeadlines(name, { toDate: endOfToday.toISOString(), limit: 100 });
      deadlines.push(
        ...d.filter(
          (x) =>
            (x.status === 'proposed' || x.status === 'confirmed') &&
            // échéances dépassées : on remonte 90 j max (au-delà = du passé, pas une action)
            x.inDays >= -90,
        ),
      );
      const imp = await getImportantEmails(name, { sinceDays: 7, minScore: 70, limit: 20 });
      important.push(...imp.items);
    } catch (err) {
      skipped.push({ account: name, error: (err as Error).message });
      logger.warn('aujourd’hui : compte ignoré', { account: name, error: (err as Error).message });
    }
  }

  // Grâce aux intentions A1 : un mail promo / code OTP / suivi de livraison /
  // confirmation automatique n'est JAMAIS une action « répondre à » sur
  // l'accueil (le moteur réponses, antérieur à A1, ne filtre que les
  // newsletters à en-tête et les no-reply).
  const NEVER_REPLY_INTENTS = new Set(['promo', 'otp', 'shipping', 'confirmation']);
  const replyIntentRows = replies.length
    ? await db.message.findMany({
        where: { id: { in: replies.map((r) => r.messageId) } },
        select: { id: true, intent: true },
      })
    : [];
  const intentById = new Map(replyIntentRows.map((r) => [r.id, r.intent]));
  const filteredReplies = replies.filter(
    (r) => !NEVER_REPLY_INTENTS.has(intentById.get(r.messageId) ?? ''),
  );
  replies.length = 0;
  replies.push(...filteredReplies);

  // Les plus en retard d'abord ; échéances par date croissante.
  replies.sort((a, b) => Number(b.overdue) - Number(a.overdue) || b.waitingHours - a.waitingHours);
  followups.sort((a, b) => Number(b.overdue) - Number(a.overdue) || b.waitingHours - a.waitingHours);
  deadlines.sort((a, b) => a.inDays - b.inDays);
  important.sort((a, b) => b.score - a.score);

  // Factures à traiter : entrants inbox non lus, intention invoice (A1), 30 j.
  type InvoiceRow = {
    account: string;
    folder: string;
    uid: number;
    subject: string | null;
    fromEmail: string | null;
    fromName: string | null;
    date: string | number | bigint | null;
    isSeen: number;
    intentReason: string | null;
  };
  const invoiceRows = await db.$queryRawUnsafe<InvoiceRow[]>(
    `SELECT m.accountSlug AS account, f.path AS folder, m.uid, m.subject,
            m.fromEmail, m.fromName, m.date, m.isSeen, m.intentReason
     FROM Message m JOIN Folder f ON f.id = m.folderId
     WHERE m.isDeleted = 0 AND m.isOutbound = 0 AND f.role = 'inbox'
       AND m.intent = 'invoice' AND m.isSeen = 0
       AND m.date >= ?
     ORDER BY m.date DESC LIMIT ${TOP}`,
    new Date(Date.now() - 30 * 86_400_000).getTime(),
  );
  const invoices: InvoiceItem[] = invoiceRows.map((r) => ({
    account: r.account,
    folder: r.folder,
    uid: r.uid,
    subject: r.subject ?? '(sans sujet)',
    fromEmail: r.fromEmail ?? '',
    fromName: r.fromName,
    date: rawDate(r.date),
    isSeen: r.isSeen === 1,
    reason: r.intentReason ?? 'facture détectée dans le sujet',
  }));

  // Bruit : compteurs par catégorie sur toutes les boîtes de réception.
  // Un mail récent (< NOISE_MIN_AGE_DAYS) n'est PAS du bruit : il bascule
  // dans « peut attendre » (bucket NULL) au lieu d'être supprimable.
  const noiseCutoff = Date.now() - NOISE_MIN_AGE_DAYS * 86_400_000;
  type NoiseRow = { bucket: string | null; cnt: bigint; unseen: bigint; size: bigint | null };
  const noiseRows = await db.$queryRawUnsafe<NoiseRow[]>(
    `SELECT CASE WHEN m.date >= ? THEN NULL ELSE (${NOISE_BUCKET_CASE}) END AS bucket,
            COUNT(*) AS cnt,
            SUM(CASE WHEN m.isSeen = 0 THEN 1 ELSE 0 END) AS unseen,
            SUM(m.sizeBytes) AS size
     FROM Message m
     JOIN Folder f ON f.id = m.folderId
     LEFT JOIN Sender s ON s.accountSlug = m.accountSlug AND s.email = m.fromEmail
     WHERE m.isDeleted = 0 AND m.isOutbound = 0 AND f.role = 'inbox'
     GROUP BY bucket`,
    noiseCutoff,
  );
  const buckets: NoiseBucketStat[] = NOISE_BUCKETS.map((b) => {
    const row = noiseRows.find((r) => r.bucket === b);
    return {
      bucket: b,
      count: Number(row?.cnt ?? 0),
      unseen: Number(row?.unseen ?? 0),
      sizeBytes: Number(row?.size ?? 0),
    };
  });
  const quiet = noiseRows.find((r) => r.bucket === null);

  // Peut attendre : les non-lus de l'inbox qui ne sont NI du bruit NI déjà
  // dans « à faire » (approximation : hors factures — les réponses attendues
  // s'y retrouvent mais restent peu nombreuses).
  type CanWaitRow = { cnt: bigint };
  const canWaitRows = await db.$queryRawUnsafe<CanWaitRow[]>(
    `SELECT COUNT(*) AS cnt
     FROM Message m
     JOIN Folder f ON f.id = m.folderId
     LEFT JOIN Sender s ON s.accountSlug = m.accountSlug AND s.email = m.fromEmail
     WHERE m.isDeleted = 0 AND m.isOutbound = 0 AND f.role = 'inbox'
       AND m.isSeen = 0
       AND ((${NOISE_BUCKET_CASE}) IS NULL OR m.date >= ?)
       AND (m.intent IS NULL OR m.intent != 'invoice')`,
    noiseCutoff,
  );

  const categorizedCount = await db.sender.count({ where: { category: { not: null } } });

  return {
    generatedAt: new Date().toISOString(),
    accounts: names,
    skippedAccounts: skipped,
    todo: {
      replies: replies.slice(0, TOP),
      followups: followups.slice(0, TOP),
      deadlines: deadlines.slice(0, TOP),
      invoices,
      total: replies.length + followups.length + deadlines.length + invoices.length,
      // Ce que le parcours « Commencer » pourra RÉELLEMENT traiter : les
      // listes sont plafonnées à TOP par famille. Sans ce chiffre, l'écran
      // annonçait « ≈ 78 min » pour 52 actions et le parcours disait
      // « Action 1 sur 35 » (incohérence signalée le 10/08).
      queued:
        Math.min(replies.length, TOP) +
        Math.min(followups.length, TOP) +
        Math.min(deadlines.length, TOP) +
        invoices.length,
    },
    important: important.slice(0, 5),
    canWait: {
      count: Number(quiet?.cnt ?? 0),
      unseen: Number(canWaitRows[0]?.cnt ?? 0),
    },
    noise: {
      buckets,
      total: buckets.reduce((s, b) => s + b.count, 0),
      sizeBytes: buckets.reduce((s, b) => s + b.sizeBytes, 0),
    },
    categorized: categorizedCount > 0,
  };
}

export interface NoisePreview {
  bucket: NoiseBucket;
  total: number;
  truncated: boolean;
  items: {
    account: string;
    folder: string;
    uid: number;
    subject: string;
    fromEmail: string;
    fromName: string | null;
    date: string | null;
    isSeen: boolean;
    /** Début du texte du mail (C1) — null s'il n'a pas encore été capturé. */
    snippet: string | null;
  }[];
}

const PREVIEW_CAP = 500;

/**
 * Liste EXACTE des mails d'un « bruit » (aperçu avant toute action —
 * garde-fou Cap V3 : rien n'est supprimé sans que la liste ait été montrée).
 * Cap 500 : l'interface le signale et propose de recommencer.
 */
export async function listNoiseMessages(bucket: NoiseBucket): Promise<NoisePreview> {
  await ensureDbReady();
  if (!NOISE_BUCKETS.includes(bucket)) throw new Error(`Bruit inconnu : ${bucket}`);
  type Row = {
    account: string;
    folder: string;
    uid: number;
    subject: string | null;
    fromEmail: string | null;
    fromName: string | null;
    date: string | number | bigint | null;
    isSeen: number;
    snippet: string | null;
  };
  // Même garde-fou que les compteurs : jamais un mail des NOISE_MIN_AGE_DAYS
  // derniers jours. Tri ASC : le lot (cap 500) traite les PLUS ANCIENS
  // d'abord — on ne supprime pas la newsletter reçue ce matin.
  const noiseCutoff = Date.now() - NOISE_MIN_AGE_DAYS * 86_400_000;
  const base = `FROM Message m
     JOIN Folder f ON f.id = m.folderId
     LEFT JOIN Sender s ON s.accountSlug = m.accountSlug AND s.email = m.fromEmail
     WHERE m.isDeleted = 0 AND m.isOutbound = 0 AND f.role = 'inbox'
       AND m.date < ?
       AND (${NOISE_BUCKET_CASE}) = ?`;
  const [countRows, rows] = await Promise.all([
    db.$queryRawUnsafe<{ cnt: bigint }[]>(`SELECT COUNT(*) AS cnt ${base}`, noiseCutoff, bucket),
    db.$queryRawUnsafe<Row[]>(
      `SELECT m.accountSlug AS account, f.path AS folder, m.uid, m.subject,
              m.fromEmail, m.fromName, m.date, m.isSeen, m.snippet
       ${base} ORDER BY m.date ASC LIMIT ${PREVIEW_CAP}`,
      noiseCutoff,
      bucket,
    ),
  ]);
  const total = Number(countRows[0]?.cnt ?? 0);
  return {
    bucket,
    total,
    truncated: total > rows.length,
    items: rows.map((r) => ({
      account: r.account,
      folder: r.folder,
      uid: r.uid,
      subject: r.subject ?? '(sans sujet)',
      fromEmail: r.fromEmail ?? '',
      fromName: r.fromName,
      date: rawDate(r.date),
      isSeen: r.isSeen === 1,
      snippet: previewSnippet(r.snippet),
    })),
  };
}

function rawDate(v: string | number | bigint | null): string | null {
  if (v === null || v === undefined) return null;
  const d = typeof v === 'string' ? new Date(v) : new Date(Number(v));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}
