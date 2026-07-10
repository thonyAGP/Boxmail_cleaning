import { db, ensureDbReady } from '../db/client.js';
import { getAccountRecord } from './accounts.js';
import { imapService } from './imap.js';
import { reflectBulkInIndex } from './search.js';
import { recordOperation } from './oplog.js';
import { logger } from '../logger.js';
import type { AccountRecord } from './accounts.js';

/**
 * Stratégies de rétention (A3 — Cap V3) : des dizaines de règles de bon sens
 * (« les codes OTP de plus de 7 jours ne servent plus à rien ») livrées en
 * PRESETS DÉSACTIVÉS. Garde-fous : activation explicite par stratégie,
 * simulation index-only affichée en permanence, aperçu EXACT avant toute
 * exécution, corbeille uniquement (récupérable ~30 j), lots de 200, journal
 * complet, autoApply impossible sur une stratégie non activée.
 */

const BATCH = 200;
const PREVIEW_CAP = 500;

// Presets livrés (upsert idempotent — on ne touche JAMAIS enabled/autoApply
// d'une ligne existante : ce sont les choix de l'utilisateur).
const PRESETS: {
  key: string;
  label: string;
  matchIntent?: string;
  matchCategory?: string;
  unseenOnly?: boolean;
  ageDays: number;
}[] = [
  { key: 'otp7', label: 'Codes de connexion (OTP) de plus de 7 jours', matchIntent: 'otp', ageDays: 7 },
  { key: 'shipping30', label: 'Suivis de livraison de plus de 30 jours', matchIntent: 'shipping', ageDays: 30 },
  { key: 'notif90', label: 'Notifications automatiques de plus de 90 jours', matchCategory: 'notification', ageDays: 90 },
  { key: 'social90', label: 'Mails de réseaux sociaux de plus de 90 jours', matchCategory: 'social', ageDays: 90 },
  { key: 'confirm180', label: 'Confirmations (commandes, inscriptions…) de plus de 6 mois', matchIntent: 'confirmation', ageDays: 180 },
  { key: 'newsletter90', label: 'Newsletters JAMAIS ouvertes de plus de 90 jours', matchCategory: 'newsletter', unseenOnly: true, ageDays: 90 },
  { key: 'promo30', label: 'Promotions JAMAIS ouvertes de plus de 30 jours', matchIntent: 'promo', unseenOnly: true, ageDays: 30 },
];

async function ensurePresets(): Promise<void> {
  for (const p of PRESETS) {
    await db.retentionPolicy.upsert({
      where: { key: p.key },
      create: {
        key: p.key,
        label: p.label,
        matchIntent: p.matchIntent ?? null,
        matchCategory: p.matchCategory ?? null,
        unseenOnly: p.unseenOnly ?? false,
        ageDays: p.ageDays,
      },
      // Libellé rafraîchi si on l'améliore ; les choix utilisateur restent.
      update: { label: p.label },
    });
  }
}

type PolicyRow = NonNullable<Awaited<ReturnType<typeof db.retentionPolicy.findUnique>>>;

// Fragment WHERE commun (SQL brut : le lien Message→Sender n'est pas une
// relation Prisma). Cible : boîtes de réception, entrants, non supprimés,
// plus vieux que ageDays (+ non lus si unseenOnly).
function policyWhere(p: PolicyRow, accountSlug?: string): { sql: string; params: unknown[] } {
  const clauses = [
    `m.isDeleted = 0`,
    `m.isOutbound = 0`,
    `f.role = 'inbox'`,
    `m.date < ?`,
    // GARANTIE Cap V3 : « 0 mail personnel supprimé » — un expéditeur classé
    // « personne » (ou marqué tel à la main) n'est JAMAIS visé, même si un de
    // ses mails matche une intention (promo transférée, etc.).
    `(s.category IS NULL OR s.category != 'person')`,
  ];
  const params: unknown[] = [Date.now() - p.ageDays * 86_400_000];
  if (p.unseenOnly) clauses.push(`m.isSeen = 0`);
  const targets: string[] = [];
  if (p.matchIntent) {
    targets.push(`m.intent = ?`);
    params.push(p.matchIntent);
  }
  if (p.matchCategory) {
    targets.push(`s.category = ?`);
    params.push(p.matchCategory);
  }
  // Intent ET catégorie posés → l'un OU l'autre suffit (cible élargie).
  if (targets.length) clauses.push(`(${targets.join(' OR ')})`);
  if (accountSlug) {
    clauses.push(`m.accountSlug = ?`);
    params.push(accountSlug);
  }
  return { sql: clauses.join(' AND '), params };
}

const FROM = `FROM Message m
  JOIN Folder f ON f.id = m.folderId
  LEFT JOIN Sender s ON s.accountSlug = m.accountSlug AND s.email = m.fromEmail`;

export interface PolicyWithCount {
  id: number;
  key: string;
  label: string;
  matchIntent: string | null;
  matchCategory: string | null;
  unseenOnly: boolean;
  ageDays: number;
  action: string;
  enabled: boolean;
  autoApply: boolean;
  appliedCount: number;
  lastAppliedAt: string | null;
  /** Simulation index-only : ce que la stratégie viserait AUJOURD'HUI. */
  matchCount: number;
  matchSizeBytes: number;
}

/** Toutes les stratégies (presets garantis) avec leur simulation. */
export async function listPolicies(): Promise<PolicyWithCount[]> {
  await ensureDbReady();
  await ensurePresets();
  const policies = await db.retentionPolicy.findMany({ orderBy: { id: 'asc' } });
  const out: PolicyWithCount[] = [];
  for (const p of policies) {
    const { sql, params } = policyWhere(p);
    const rows = await db.$queryRawUnsafe<{ cnt: bigint; size: bigint | null }[]>(
      `SELECT COUNT(*) AS cnt, SUM(m.sizeBytes) AS size ${FROM} WHERE ${sql}`,
      ...params,
    );
    out.push({
      id: p.id,
      key: p.key,
      label: p.label,
      matchIntent: p.matchIntent,
      matchCategory: p.matchCategory,
      unseenOnly: p.unseenOnly,
      ageDays: p.ageDays,
      action: p.action,
      enabled: p.enabled,
      autoApply: p.autoApply,
      appliedCount: p.appliedCount,
      lastAppliedAt: p.lastAppliedAt?.toISOString() ?? null,
      matchCount: Number(rows[0]?.cnt ?? 0),
      matchSizeBytes: Number(rows[0]?.size ?? 0),
    });
  }
  return out;
}

export interface PolicyPreviewItem {
  account: string;
  folder: string;
  uid: number;
  subject: string;
  fromEmail: string;
  fromName: string | null;
  date: string | null;
}

/** Liste EXACTE des mails visés (cap 500) — l'aperçu obligatoire avant action. */
export async function previewPolicy(
  id: number,
  accountSlug?: string,
): Promise<{ policy: PolicyWithCount['label']; total: number; truncated: boolean; items: PolicyPreviewItem[] }> {
  await ensureDbReady();
  const p = await db.retentionPolicy.findUnique({ where: { id } });
  if (!p) throw new Error(`Stratégie inconnue (id ${id}).`);
  const { sql, params } = policyWhere(p, accountSlug);
  type Row = {
    account: string;
    folder: string;
    uid: number;
    subject: string | null;
    fromEmail: string | null;
    fromName: string | null;
    date: string | number | bigint | null;
  };
  const [countRows, rows] = await Promise.all([
    db.$queryRawUnsafe<{ cnt: bigint }[]>(`SELECT COUNT(*) AS cnt ${FROM} WHERE ${sql}`, ...params),
    db.$queryRawUnsafe<Row[]>(
      `SELECT m.accountSlug AS account, f.path AS folder, m.uid, m.subject,
              m.fromEmail, m.fromName, m.date
       ${FROM} WHERE ${sql} ORDER BY m.date ASC LIMIT ${PREVIEW_CAP}`,
      ...params,
    ),
  ]);
  const total = Number(countRows[0]?.cnt ?? 0);
  return {
    policy: p.label,
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
    })),
  };
}

export interface ApplyReport {
  policy: string;
  dryRun: boolean;
  matched: number;
  deleted: number;
  accounts: { account: string; deleted: number; error?: string }[];
}

/**
 * Applique une stratégie : corbeille par lots de 200, groupé par boîte +
 * dossier, index reflété, UNE entrée de journal par boîte avec la liste
 * exacte. dryRun par défaut ; la stratégie doit être ACTIVÉE.
 */
export async function applyPolicy(
  id: number,
  opts: { confirm?: boolean; accountSlug?: string; progress?: (m: string) => void; tool?: string } = {},
): Promise<ApplyReport> {
  await ensureDbReady();
  const progress = opts.progress ?? (() => {});
  const p = await db.retentionPolicy.findUnique({ where: { id } });
  if (!p) throw new Error(`Stratégie inconnue (id ${id}).`);
  if (!p.enabled) throw new Error('Stratégie désactivée — active-la avant de l’appliquer.');

  // Liste complète (pas de cap ici : on revalide depuis l'index, par lots).
  const { sql, params } = policyWhere(p, opts.accountSlug);
  type Row = {
    account: string;
    folder: string;
    uid: number;
    subject: string | null;
    date: string | number | bigint | null;
  };
  const rows = await db.$queryRawUnsafe<Row[]>(
    `SELECT m.accountSlug AS account, f.path AS folder, m.uid, m.subject, m.date
     ${FROM} WHERE ${sql} ORDER BY m.accountSlug, f.path, m.uid`,
    ...params,
  );

  const report: ApplyReport = {
    policy: p.label,
    dryRun: opts.confirm !== true,
    matched: rows.length,
    deleted: 0,
    accounts: [],
  };
  if (report.dryRun || rows.length === 0) return report;

  // Groupe par boîte + dossier.
  const groups = new Map<string, { account: string; folder: string; rows: Row[] }>();
  for (const r of rows) {
    const key = `${r.account} ${r.folder}`;
    const g = groups.get(key) ?? { account: r.account, folder: r.folder, rows: [] };
    g.rows.push(r);
    groups.set(key, g);
  }

  const byAccount = new Map<string, { deleted: number; error?: string }>();
  for (const g of groups.values()) {
    const acc = byAccount.get(g.account) ?? { deleted: 0 };
    byAccount.set(g.account, acc);
    if (acc.error) continue; // boîte déjà en échec : on n'insiste pas
    let rec: AccountRecord | null = null;
    try {
      rec = await getAccountRecord(g.account);
    } catch (err) {
      acc.error = (err as Error).message;
    }
    if (!rec) {
      acc.error ??= `Compte « ${g.account} » introuvable dans accounts.json.`;
      continue;
    }
    const uids = g.rows.map((r) => r.uid);
    let deleted = 0;
    try {
      for (let i = 0; i < uids.length; i += BATCH) {
        const batch = uids.slice(i, i + BATCH);
        const r = await imapService.moveToTrash(rec, g.folder, batch);
        deleted += r.moved;
        progress(`${g.account}/${g.folder} : ${deleted}/${uids.length} mails à la corbeille…`);
      }
      await reflectBulkInIndex(g.account, g.folder, uids, 'delete');
    } catch (err) {
      acc.error = (err as Error).message;
      progress(`⚠️ ${g.account}/${g.folder} en échec (${acc.error}) — on continue.`);
    }
    acc.deleted += deleted;
    report.deleted += deleted;
    if (deleted === 0 && acc.error) continue; // rien fait : rien à journaliser
    await recordOperation({
      account: g.account,
      tool: opts.tool ?? 'retention_apply',
      folder: g.folder,
      params: { policy: p.key, label: p.label, ageDays: p.ageDays },
      affectedUids: uids.slice(0, deleted || undefined),
      items: g.rows.map((r) => ({
        subject: r.subject ?? '(sans sujet)',
        date: rawDate(r.date),
      })),
      result: `${deleted} mails à la corbeille`,
    });
  }
  report.accounts = [...byAccount.entries()].map(([account, v]) => ({ account, ...v }));

  await db.retentionPolicy.update({
    where: { id },
    data: { appliedCount: { increment: report.deleted }, lastAppliedAt: new Date() },
  });
  return report;
}

/** Active/désactive/règle une stratégie. GARDE-FOU : autoApply ⇒ enabled. */
export async function updatePolicy(
  id: number,
  patch: { enabled?: boolean; autoApply?: boolean; ageDays?: number },
): Promise<PolicyRow> {
  await ensureDbReady();
  const p = await db.retentionPolicy.findUnique({ where: { id } });
  if (!p) throw new Error(`Stratégie inconnue (id ${id}).`);
  const enabled = patch.enabled ?? p.enabled;
  let autoApply = patch.autoApply ?? p.autoApply;
  if (patch.autoApply === true && !enabled) {
    throw new Error('Impossible : active d’abord la stratégie avant de la passer en automatique.');
  }
  if (!enabled) autoApply = false; // désactivation ⇒ plus d'automatique
  if (patch.ageDays !== undefined && (patch.ageDays < 1 || patch.ageDays > 3650)) {
    throw new Error('ageDays doit être entre 1 et 3650 jours.');
  }
  return db.retentionPolicy.update({
    where: { id },
    data: {
      enabled,
      autoApply,
      ...(patch.ageDays !== undefined ? { ageDays: patch.ageDays } : {}),
    },
  });
}

/**
 * Hook post-sync (non bloquant) : applique les stratégies ACTIVÉES et cochées
 * automatiques, sur CE compte uniquement. Chaque passage est journalisé.
 */
export async function runAutoRetention(
  rec: AccountRecord,
  progress: (m: string) => void = () => {},
): Promise<{ deleted: number; policies: number }> {
  await ensureDbReady();
  const autos = await db.retentionPolicy.findMany({ where: { enabled: true, autoApply: true } });
  let deleted = 0;
  for (const p of autos) {
    try {
      const r = await applyPolicy(p.id, {
        confirm: true,
        accountSlug: rec.account,
        progress,
        tool: 'retention_auto_apply',
      });
      deleted += r.deleted;
    } catch (err) {
      logger.warn('rétention auto en échec', {
        account: rec.account,
        policy: p.key,
        error: (err as Error).message,
      });
    }
  }
  return { deleted, policies: autos.length };
}

function rawDate(v: string | number | bigint | null): string | null {
  if (v === null || v === undefined) return null;
  const d = typeof v === 'string' ? new Date(v) : new Date(Number(v));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}
