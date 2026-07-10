import { db, ensureDbReady } from '../db/client.js';
import {
  listPolicies,
  applyPolicy,
  updatePolicy,
  deletableUnion,
  type PolicyWithCount,
} from './retention.js';
import { SENDER_CATEGORY_LABELS } from './categorize.js';

/**
 * « Pourquoi ma boîte est pleine ? » + Grand ménage (A4 — Cap V3).
 * Rapport index-only instantané : répartition par catégorie A1, ancienneté,
 * top expéditeurs, et « tu peux récupérer X sans risque » = UNION des cibles
 * des stratégies de rétention (A3) — les mails d'expéditeurs « personne »
 * n'y entrent JAMAIS (garanti par policyWhere).
 * Périmètre : mails non supprimés hors corbeille/spam (la corbeille part
 * toute seule au bout d'~30 j côté Outlook).
 */

const SCOPE = `FROM Message m
  JOIN Folder f ON f.id = m.folderId
  LEFT JOIN Sender s ON s.accountSlug = m.accountSlug AND s.email = m.fromEmail
  WHERE m.isDeleted = 0 AND f.role NOT IN ('trash', 'spam')`;

export interface CategorySlice {
  category: string;
  label: string;
  count: number;
  sizeBytes: number;
  /** Pourcentage (0-100, arrondi) du nombre de mails du périmètre. */
  pct: number;
}

export interface MailboxReport {
  generatedAt: string;
  totals: { messages: number; sizeBytes: number; accounts: number };
  perAccount: { account: string; messages: number; sizeBytes: number }[];
  byCategory: CategorySlice[];
  byAge: { label: string; count: number; sizeBytes: number }[];
  topSendersByCount: TopSender[];
  topSendersBySize: TopSender[];
  /** Récupérable « sans risque » : union DISTINCTE des cibles des stratégies. */
  deletable: { count: number; sizeBytes: number; policies: PolicyWithCount[] };
}

export interface TopSender {
  account: string;
  email: string;
  name: string;
  category: string | null;
  messageCount: number;
  sizeBytes: number;
}

const CATEGORY_LABELS: Record<string, string> = {
  ...SENDER_CATEGORY_LABELS,
  outbound: 'Toi (mails envoyés)',
  unknown: 'Non catégorisé',
};

export async function generateMailboxReport(): Promise<MailboxReport> {
  await ensureDbReady();

  type CatRow = { cat: string; cnt: bigint; size: bigint | null };
  const catRows = await db.$queryRawUnsafe<CatRow[]>(
    `SELECT CASE WHEN m.isOutbound = 1 THEN 'outbound' ELSE COALESCE(s.category, 'unknown') END AS cat,
            COUNT(*) AS cnt, SUM(m.sizeBytes) AS size
     ${SCOPE} GROUP BY cat ORDER BY cnt DESC`,
  );
  const totalMessages = catRows.reduce((s, r) => s + Number(r.cnt), 0);
  const totalSize = catRows.reduce((s, r) => s + Number(r.size ?? 0), 0);
  const byCategory: CategorySlice[] = catRows.map((r) => ({
    category: r.cat,
    label: CATEGORY_LABELS[r.cat] ?? r.cat,
    count: Number(r.cnt),
    sizeBytes: Number(r.size ?? 0),
    pct: totalMessages ? Math.round((Number(r.cnt) / totalMessages) * 100) : 0,
  }));

  // Ancienneté (tranches fixes, lisibles).
  const now = Date.now();
  const y = 365 * 86_400_000;
  type AgeRow = { bucket: string; cnt: bigint; size: bigint | null };
  const ageRows = await db.$queryRawUnsafe<AgeRow[]>(
    `SELECT CASE
        WHEN m.date >= ${now - y} THEN 'a'
        WHEN m.date >= ${now - 3 * y} THEN 'b'
        WHEN m.date >= ${now - 5 * y} THEN 'c'
        ELSE 'd' END AS bucket,
       COUNT(*) AS cnt, SUM(m.sizeBytes) AS size
     ${SCOPE} GROUP BY bucket`,
  );
  const age = (k: string) => ageRows.find((r) => r.bucket === k);
  const byAge = [
    { key: 'a', label: 'Moins d’un an' },
    { key: 'b', label: '1 à 3 ans' },
    { key: 'c', label: '3 à 5 ans' },
    { key: 'd', label: 'Plus de 5 ans' },
  ].map(({ key, label }) => ({
    label,
    count: Number(age(key)?.cnt ?? 0),
    sizeBytes: Number(age(key)?.size ?? 0),
  }));

  const perAccountRows = await db.$queryRawUnsafe<{ account: string; cnt: bigint; size: bigint | null }[]>(
    `SELECT m.accountSlug AS account, COUNT(*) AS cnt, SUM(m.sizeBytes) AS size
     ${SCOPE} GROUP BY m.accountSlug ORDER BY cnt DESC`,
  );

  const topByCount = await db.sender.findMany({
    where: { messageCount: { gt: 0 } },
    orderBy: { messageCount: 'desc' },
    take: 10,
    select: {
      accountSlug: true,
      email: true,
      displayName: true,
      category: true,
      messageCount: true,
      totalSizeBytes: true,
    },
  });
  const topBySize = await db.sender.findMany({
    where: { messageCount: { gt: 0 } },
    orderBy: { totalSizeBytes: 'desc' },
    take: 10,
    select: {
      accountSlug: true,
      email: true,
      displayName: true,
      category: true,
      messageCount: true,
      totalSizeBytes: true,
    },
  });
  const mapTop = (rows: typeof topByCount): TopSender[] =>
    rows.map((r) => ({
      account: r.accountSlug,
      email: r.email,
      name: r.displayName ?? '',
      category: r.category,
      messageCount: r.messageCount,
      sizeBytes: Number(r.totalSizeBytes),
    }));

  // « Sans risque » : union DISTINCTE des cibles des stratégies (A3). Les
  // stratégies peuvent se recouvrir : l'union évite de compter deux fois.
  const policies = await listPolicies();
  const deletable = await deletableUnion();

  return {
    generatedAt: new Date().toISOString(),
    totals: {
      messages: totalMessages,
      sizeBytes: totalSize,
      accounts: perAccountRows.length,
    },
    perAccount: perAccountRows.map((r) => ({
      account: r.account,
      messages: Number(r.cnt),
      sizeBytes: Number(r.size ?? 0),
    })),
    byCategory,
    byAge,
    topSendersByCount: mapTop(topByCount),
    topSendersBySize: mapTop(topBySize),
    deletable: { ...deletable, policies },
  };
}

export interface GrandMenageReport {
  policies: { id: number; label: string; deleted: number; errors: string[] }[];
  deleted: number;
}

/**
 * Grand ménage : active puis applique les stratégies COCHÉES par
 * l'utilisateur, l'une après l'autre (lots de 200, journal par boîte —
 * mêmes garde-fous qu'A3). Cocher = valider : l'activation est persistée.
 */
export async function runGrandMenage(
  policyIds: number[],
  progress: (m: string) => void = () => {},
): Promise<GrandMenageReport> {
  await ensureDbReady();
  const report: GrandMenageReport = { policies: [], deleted: 0 };
  for (const id of policyIds) {
    const p = await db.retentionPolicy.findUnique({ where: { id } });
    if (!p) {
      report.policies.push({ id, label: `stratégie ${id}`, deleted: 0, errors: ['inconnue'] });
      continue;
    }
    progress(`Stratégie « ${p.label} »…`);
    try {
      if (!p.enabled) await updatePolicy(id, { enabled: true });
      const r = await applyPolicy(id, { confirm: true, progress, tool: 'grand_menage' });
      report.deleted += r.deleted;
      report.policies.push({
        id,
        label: p.label,
        deleted: r.deleted,
        errors: r.accounts.filter((a) => a.error).map((a) => `${a.account} : ${a.error}`),
      });
    } catch (err) {
      report.policies.push({ id, label: p.label, deleted: 0, errors: [(err as Error).message] });
    }
  }
  progress(`Grand ménage terminé : ${report.deleted} mails à la corbeille.`);
  return report;
}
