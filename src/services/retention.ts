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
  { key: 'shipping30', label: 'Suivis de livraison de plus de 30 jours (hors litige/remboursement/garantie)', matchIntent: 'shipping', ageDays: 30 },
  { key: 'notif90', label: 'Notifications automatiques de plus de 90 jours (hors sécurité/banque)', matchCategory: 'notification', ageDays: 90 },
  { key: 'social90', label: 'Mails de réseaux sociaux de plus de 90 jours', matchCategory: 'social', ageDays: 90 },
  { key: 'confirm180', label: 'Confirmations (commandes, inscriptions…) de plus de 6 mois (hors résiliation/assurance/contrat)', matchIntent: 'confirmation', ageDays: 180 },
  { key: 'newsletter90', label: 'Newsletters JAMAIS ouvertes de plus de 90 jours (jamais si tu as déjà échangé)', matchCategory: 'newsletter', unseenOnly: true, ageDays: 90 },
  { key: 'promo30', label: 'Promotions JAMAIS ouvertes de plus de 30 jours (jamais si tu as déjà échangé)', matchIntent: 'promo', unseenOnly: true, ageDays: 30 },
];

// ---------------------------------------------------------------------------
// Affinage des stratégies à risque moyen (B5). Attachés à la CIBLE (intention
// ou catégorie), pas à la clé du preset : une stratégie personnalisée sur la
// même cible hérite des mêmes garde-fous. Exclure = GARDER le mail.
// ---------------------------------------------------------------------------

// Sujets sensibles par cible. LIKE SQLite = insensible à la casse ASCII ;
// variantes accentuées ET non accentuées listées pour couvrir les deux.
const SENSITIVE_SUBJECTS: { matchIntent?: string; matchCategory?: string; words: string[] }[] = [
  {
    // Confirmations : on ne garde que les sous-types sûrs (commande,
    // inscription…) — jamais une résiliation, une assurance, un contrat.
    matchIntent: 'confirmation',
    words: ['résiliation', 'resiliation', 'assurance', 'mutuelle', 'contrat', 'préavis', 'preavis'],
  },
  {
    // Notifications : jamais les alertes de sécurité / connexion / mot de
    // passe / banque — ce sont des traces utiles en cas de fraude.
    matchCategory: 'notification',
    words: ['sécurité', 'securite', 'connexion', 'mot de passe', 'password', 'alerte', 'fraude', 'banque', 'bancaire', 'virement'],
  },
  {
    // Livraisons : jamais un litige, un remboursement, un colis non reçu,
    // une garantie — dossiers potentiellement encore ouverts.
    matchIntent: 'shipping',
    words: ['litige', 'remboursement', 'rembours', 'garantie', 'réclamation', 'reclamation', 'non reçu', 'non recu', 'pas reçu', 'pas recu'],
  },
];

// Newsletters/promos : expéditeur écarté s'il a DÉJÀ compté pour toi —
// conversation engagée, mail étoilé ou répondu, tâche créée depuis un de
// ses mails. (Complète B1, qui ne protège que le mail concerné.)
/**
 * Horizon d'engagement (P2.1) : au-delà, un échange ancien ne protège plus.
 *
 * POURQUOI : sans borne, avoir répondu UNE fois dans un fil en 2019 protégeait
 * ce fil À VIE. Sur des boîtes accumulées depuis des années, cette protection
 * finissait par recouvrir l'essentiel du volume et rendait le nettoyage de
 * masse impossible — alors que c'est l'objectif premier de l'outil.
 *
 * Deux ans : assez long pour couvrir un dossier qui traîne (litige, garantie,
 * déclaration annuelle), assez court pour libérer les vieilles newsletters
 * auxquelles on a répondu une fois il y a longtemps.
 */
export const ENGAGEMENT_HORIZON_DAYS = 730;

// L'engagement compte s'il est RÉCENT : un expéditeur avec qui tu as échangé
// il y a six ans ne doit plus sanctuariser ses newsletters.
function engagedSenderClauses(now = Date.now()): { clauses: string[]; params: unknown[] } {
  const cutoff = now - ENGAGEMENT_HORIZON_DAYS * 86_400_000;
  return {
    clauses: [
      `NOT EXISTS (SELECT 1 FROM Message ms JOIN Message mo ON mo.threadId = ms.threadId AND mo.isOutbound = 1 AND mo.isDeleted = 0
         WHERE ms.accountSlug = m.accountSlug AND ms.fromEmail = m.fromEmail AND ms.isDeleted = 0
         AND (mo.date IS NULL OR mo.date >= ?))`,
      `NOT EXISTS (SELECT 1 FROM Message ms WHERE ms.accountSlug = m.accountSlug AND ms.fromEmail = m.fromEmail
         AND ms.isDeleted = 0 AND (ms.isFlagged = 1 OR ms.isAnswered = 1)
         AND (ms.date IS NULL OR ms.date >= ?))`,
      // Une tâche encore À FAIRE compte quelle que soit son ancienneté ;
      // une tâche déjà réglée ne compte que si elle est récente.
      `NOT EXISTS (SELECT 1 FROM Message ms JOIN Task t ON t.messageId = ms.id
         WHERE ms.accountSlug = m.accountSlug AND ms.fromEmail = m.fromEmail AND ms.isDeleted = 0
         AND (t.status = 'todo' OR t.createdAt >= ?))`,
    ],
    params: [cutoff, cutoff, cutoff],
  };
}

function refinementClauses(p: { matchIntent: string | null; matchCategory: string | null }): {
  clauses: string[];
  params: unknown[];
} {
  const clauses: string[] = [];
  const params: unknown[] = [];
  for (const rule of SENSITIVE_SUBJECTS) {
    const applies =
      (rule.matchIntent && p.matchIntent === rule.matchIntent) ||
      (rule.matchCategory && p.matchCategory === rule.matchCategory);
    if (!applies) continue;
    for (const w of rule.words) {
      clauses.push(`COALESCE(m.subject, '') NOT LIKE ?`);
      params.push(`%${w}%`);
    }
  }
  if (p.matchCategory === 'newsletter' || p.matchIntent === 'promo') {
    const engaged = engagedSenderClauses();
    clauses.push(...engaged.clauses);
    params.push(...engaged.params);
  }
  return { clauses, params };
}

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
/**
 * PROTECTION CENTRALE (B1 — fiabilisation). Un mail n'est JAMAIS visé par une
 * stratégie de rétention (ni par le Grand ménage ni par l'auto-rétention, qui
 * passent tous ici) si l'un de ces signaux « humains » est présent :
 *  - mail étoilé (⭐ suivi) ;
 *  - mail auquel tu as répondu (\Answered) ;
 *  - fil de discussion contenant un mail SORTANT (conversation engagée) ;
 *  - tâche « à faire » liée au mail ;
 *  - échéance proposée ou confirmée liée au mail ;
 *  - expéditeur marqué ⭐ toujours important (priorité manuelle A5) ;
 *  - confiance de l'analyse FAIBLE (B4 — analyse incertaine ou jugée
 *    incorrecte : on ne supprime jamais sur un doute).
 * S'ajoute à la garantie « 0 mail personnel » (catégorie person exclue).
 */
/**
 * Protections d'un mail. Deux familles :
 *  - ABSOLUES : signaux EXPLICITES de ta part (étoile, tâche à faire, échéance
 *    active, expéditeur « toujours important »), plus le garde-fou « analyse
 *    incertaine ». Elles ne s'éteignent jamais.
 *  - GRADUÉES : traces d'un échange (mail répondu, fil où tu as écrit). Elles
 *    ne valent que si l'échange est RÉCENT (voir ENGAGEMENT_HORIZON_DAYS).
 *
 * Une date inconnue est traitée comme récente : dans le doute, on protège.
 */
export function protectionClauses(now = Date.now()): { clauses: string[]; params: unknown[] } {
  const cutoff = now - ENGAGEMENT_HORIZON_DAYS * 86_400_000;
  return {
    clauses: [
      // --- Absolues ---
      `m.isFlagged = 0`,
      `NOT EXISTS (SELECT 1 FROM Task t WHERE t.messageId = m.id AND t.status = 'todo')`,
      `NOT EXISTS (SELECT 1 FROM Deadline d WHERE d.messageId = m.id AND d.status IN ('proposed','confirmed'))`,
      `(s.priority IS NULL OR s.priority != 'always_important')`,
      `(m.analysisConfidence IS NULL OR m.analysisConfidence != 'low')`,
      // Un mail qui PORTE un document ne se supprime pas (retour utilisateur
      // 29/07 : « tu confonds des mails de publicité avec des mails contenant
      // des pièces jointes de tickets »). Le même expéditeur — un no_reply de
      // magasin — envoie les pubs ET les tickets de caisse : classer par
      // expéditeur ne suffit pas, il faut regarder la NATURE du mail.
      `m.hasAttachments = 0`,
      `(m.intent IS NULL OR m.intent NOT IN ('invoice', 'document'))`,
      // --- Graduées ---
      // Répondu : protège tant que c'est récent. Une date inconnue protège.
      `(m.isAnswered = 0 OR (m.date IS NOT NULL AND m.date < ?))`,
      `NOT EXISTS (SELECT 1 FROM Message mo WHERE mo.threadId = m.threadId AND mo.isOutbound = 1
         AND (mo.date IS NULL OR mo.date >= ?))`,
    ],
    params: [cutoff, cutoff],
  };
}


function policyWhere(
  p: PolicyRow,
  accountSlug?: string,
  opts: { withProtection?: boolean } = {},
): { sql: string; params: unknown[] } {
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
  // Protections B1 + graduation temporelle P2.1 (clauses ET paramètres :
  // l'ordre des deux tableaux doit rester aligné).
  if (opts.withProtection !== false) {
    const protection = protectionClauses();
    clauses.push(...protection.clauses);
    params.push(...protection.params);
  }
  // Affinage B5 (sujets sensibles, expéditeurs déjà « engagés ») : compté
  // comme protection — le badge 🛡️ inclut ces mails écartés.
  if (opts.withProtection !== false) {
    const refinement = refinementClauses(p);
    clauses.push(...refinement.clauses);
    params.push(...refinement.params);
  }
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
  /** Mails qui matcheraient mais que la protection centrale écarte (B1). */
  protectedCount: number;
}

/** Toutes les stratégies (presets garantis) avec leur simulation. */
export async function listPolicies(): Promise<PolicyWithCount[]> {
  await ensureDbReady();
  await ensurePresets();
  const policies = await db.retentionPolicy.findMany({ orderBy: { id: 'asc' } });
  const out: PolicyWithCount[] = [];
  for (const p of policies) {
    const { sql, params } = policyWhere(p);
    const raw = policyWhere(p, undefined, { withProtection: false });
    const [rows, rawRows] = await Promise.all([
      db.$queryRawUnsafe<{ cnt: bigint; size: bigint | null }[]>(
        `SELECT COUNT(*) AS cnt, SUM(m.sizeBytes) AS size ${FROM} WHERE ${sql}`,
        ...params,
      ),
      db.$queryRawUnsafe<{ cnt: bigint }[]>(
        `SELECT COUNT(*) AS cnt ${FROM} WHERE ${raw.sql}`,
        ...raw.params,
      ),
    ]);
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
      protectedCount: Math.max(0, Number(rawRows[0]?.cnt ?? 0) - Number(rows[0]?.cnt ?? 0)),
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

/**
 * Union DISTINCTE des mails visés par AU MOINS une stratégie — le
 * « récupérable sans risque » du rapport A4. Passe par policyWhere :
 * garanties person + protections B1/B4/B5 incluses, le rapport promet
 * EXACTEMENT ce que l'application ferait.
 */
export async function deletableUnion(): Promise<{ count: number; sizeBytes: number }> {
  await ensureDbReady();
  await ensurePresets();
  const policies = await db.retentionPolicy.findMany({ orderBy: { id: 'asc' } });
  if (policies.length === 0) return { count: 0, sizeBytes: 0 };
  const selects: string[] = [];
  const params: unknown[] = [];
  for (const p of policies) {
    const w = policyWhere(p);
    selects.push(`SELECT m.id AS id, m.sizeBytes AS size ${FROM} WHERE ${w.sql}`);
    params.push(...w.params);
  }
  const rows = await db.$queryRawUnsafe<{ cnt: bigint; size: bigint | null }[]>(
    `SELECT COUNT(*) AS cnt, SUM(size) AS size FROM (${selects.join(' UNION ')})`,
    ...params,
  );
  return { count: Number(rows[0]?.cnt ?? 0), sizeBytes: Number(rows[0]?.size ?? 0) };
}

export interface RetentionTargetSample {
  messageId: number;
  threadId: number | null;
  account: string;
  folder: string;
  uid: number;
  subject: string;
  fromEmail: string;
  fromName: string | null;
  date: string | null;
  isSeen: boolean;
  policyKey: string;
  policyLabel: string;
}

/**
 * Échantillon ALÉATOIRE des mails visés par les stratégies (B2 — contrôle
 * qualité). Passe par policyWhere : protection centrale B1 et garantie
 * « personne » incluses — on juge exactement ce qui serait supprimé.
 */
export async function sampleRetentionTargets(limit = 10): Promise<RetentionTargetSample[]> {
  await ensureDbReady();
  await ensurePresets();
  const policies = await db.retentionPolicy.findMany({ orderBy: { id: 'asc' } });
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
  };
  const byMessage = new Map<number, RetentionTargetSample>();
  for (const p of policies) {
    const { sql, params } = policyWhere(p);
    const rows = await db.$queryRawUnsafe<Row[]>(
      `SELECT m.id, m.threadId, m.accountSlug AS account, f.path AS folder, m.uid,
              m.subject, m.fromEmail, m.fromName, m.date, m.isSeen
       ${FROM} WHERE ${sql} ORDER BY RANDOM() LIMIT ${limit}`,
      ...params,
    );
    for (const r of rows) {
      if (byMessage.has(r.id)) continue;
      byMessage.set(r.id, {
        messageId: r.id,
        threadId: r.threadId,
        account: r.account,
        folder: r.folder,
        uid: r.uid,
        subject: r.subject ?? '(sans sujet)',
        fromEmail: r.fromEmail ?? '',
        fromName: r.fromName,
        date: rawDate(r.date),
        isSeen: Boolean(r.isSeen),
        policyKey: p.key,
        policyLabel: p.label,
      });
    }
  }
  const all = [...byMessage.values()];
  for (let i = all.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [all[i], all[j]] = [all[j], all[i]];
  }
  return all.slice(0, limit);
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
