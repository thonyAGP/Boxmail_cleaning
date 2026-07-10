import { db, ensureDbReady } from '../db/client.js';
import { logger } from '../logger.js';
import { imapService } from './imap.js';
import { recordOperation } from './oplog.js';
import { reflectBulkInIndex } from './search.js';
import type { AccountRecord } from './accounts.js';

/**
 * Rule Engine (L7 — SPEC V2 §8.8 « rangement/règles »). Des règles de
 * classement « si expéditeur/domaine/sujet → déplacer vers tel dossier »,
 * SUGGÉRÉES par heuristiques depuis l'index, puis validées, prévisualisées
 * et appliquées par l'utilisateur.
 *
 * GARDE-FOUS (non négociables) :
 *  - une suggestion n'est JAMAIS appliquée sans validation explicite ;
 *  - application = déplacement (jamais de suppression), lots de 200,
 *    UIDs revalidés, journal complet avec la liste exacte des mails ;
 *  - l'auto-application ne concerne que les règles ACTIVÉES par
 *    l'utilisateur avec l'option auto cochée.
 */

export type RuleMatchType = 'sender' | 'domain' | 'subject';

export interface MailRuleView {
  id: number;
  account: string;
  matchType: RuleMatchType;
  matchValue: string;
  targetFolder: string;
  status: 'suggested' | 'active' | 'paused';
  autoApply: boolean;
  reason: string;
  appliedCount: number;
  lastAppliedAt: string | null;
  /** Mails de l'INBOX qui matchent en ce moment (à ranger). */
  pendingCount: number;
}

const APPLY_BATCH = 200;

/** Clause Prisma des mails INBOX (non supprimés) matchés par une règle. */
function ruleWhere(account: string, matchType: string, matchValue: string) {
  const v = matchValue.toLowerCase();
  return {
    accountSlug: account,
    isDeleted: false,
    isOutbound: false,
    folder: { is: { role: 'inbox' } },
    ...(matchType === 'sender'
      ? { fromEmail: v }
      : matchType === 'domain'
        ? { fromEmail: { endsWith: `@${v.replace(/^@/, '')}` } }
        : { subject: { contains: matchValue } }),
  };
}

async function toView(r: {
  id: number;
  accountSlug: string;
  matchType: string;
  matchValue: string;
  targetFolder: string;
  status: string;
  autoApply: boolean;
  reason: string;
  appliedCount: number;
  lastAppliedAt: Date | null;
}): Promise<MailRuleView> {
  const pendingCount = await db.message.count({
    where: ruleWhere(r.accountSlug, r.matchType, r.matchValue),
  });
  return {
    id: r.id,
    account: r.accountSlug,
    matchType: r.matchType as RuleMatchType,
    matchValue: r.matchValue,
    targetFolder: r.targetFolder,
    status: r.status as MailRuleView['status'],
    autoApply: r.autoApply,
    reason: r.reason,
    appliedCount: r.appliedCount,
    lastAppliedAt: r.lastAppliedAt?.toISOString() ?? null,
    pendingCount,
  };
}

export async function listRules(account: string): Promise<MailRuleView[]> {
  await ensureDbReady();
  const rules = await db.mailRule.findMany({
    where: { accountSlug: account },
    orderBy: [{ status: 'asc' }, { id: 'desc' }], // active < paused < suggested (alpha)
  });
  return Promise.all(rules.map(toView));
}

/**
 * Suggestions de règles depuis l'index — deux heuristiques :
 *  1. « Tu l'as déjà rangé à la main » : un expéditeur a ≥ minRanged mails
 *     dans UN dossier personnalisé ET encore ≥ minPending en INBOX →
 *     suggérer d'automatiser ce rangement.
 *  2. « Grosse newsletter » : expéditeur kind=newsletter avec ≥ minNews
 *     mails en INBOX → suggérer un dossier « Newsletters ».
 * Upsert idempotent : n'écrase JAMAIS une règle active/paused, ne recrée
 * pas une suggestion existante.
 */
export async function suggestRules(
  account: string,
  opts: { minRanged?: number; minPending?: number; minNews?: number } = {},
): Promise<{ created: number; suggestions: MailRuleView[] }> {
  await ensureDbReady();
  const minRanged = opts.minRanged ?? 3;
  const minPending = opts.minPending ?? 2;
  const minNews = opts.minNews ?? 10;
  let created = 0;

  const upsert = async (
    matchType: RuleMatchType,
    matchValue: string,
    targetFolder: string,
    reason: string,
  ) => {
    const existing = await db.mailRule.findUnique({
      where: {
        accountSlug_matchType_matchValue: { accountSlug: account, matchType, matchValue },
      },
    });
    if (existing) return; // règle déjà connue (quel que soit son statut)
    await db.mailRule.create({
      data: { accountSlug: account, matchType, matchValue, targetFolder, reason },
    });
    created++;
  };

  // --- 1. Rangements manuels récurrents (dossiers custom) -----------------------
  const customFolders = await db.folder.findMany({
    where: { accountSlug: account, role: 'custom' },
    select: { id: true, path: true },
  });
  for (const f of customFolders) {
    const grouped = await db.message.groupBy({
      by: ['fromEmail'],
      where: { folderId: f.id, isDeleted: false, isOutbound: false, fromEmail: { not: null } },
      _count: { _all: true },
      having: { fromEmail: { _count: { gte: minRanged } } },
    });
    for (const g of grouped) {
      const sender = g.fromEmail as string;
      const pending = await db.message.count({ where: ruleWhere(account, 'sender', sender) });
      if (pending < minPending) continue;
      await upsert(
        'sender',
        sender,
        f.path,
        `Tu as déjà rangé ${g._count._all} mails de ${sender} dans « ${f.path} » — ` +
          `${pending} attendent encore en boîte de réception.`,
      );
    }
  }

  // --- 2. Newsletters volumineuses en INBOX --------------------------------------
  const newsletters = await db.sender.findMany({
    where: { accountSlug: account, kind: 'newsletter', messageCount: { gte: minNews } },
    orderBy: { messageCount: 'desc' },
    take: 20,
    select: { email: true, displayName: true },
  });
  for (const n of newsletters) {
    const pending = await db.message.count({ where: ruleWhere(account, 'sender', n.email) });
    if (pending < minNews) continue;
    await upsert(
      'sender',
      n.email,
      'Newsletters',
      `${pending} newsletters de ${n.displayName || n.email} encombrent la boîte de réception — ` +
        `le dossier « Newsletters » sera créé au besoin.`,
    );
  }

  const suggestions = (await listRules(account)).filter((r) => r.status === 'suggested');
  logger.info('suggestions de règles calculées', { account, created });
  return { created, suggestions };
}

/** Mails INBOX actuellement matchés par la règle (aperçu avant application). */
export async function previewRule(
  account: string,
  ruleId: number,
): Promise<{
  rule: MailRuleView;
  total: number;
  items: { uid: number; subject: string; fromEmail: string; date: string | null }[];
}> {
  await ensureDbReady();
  const rule = await db.mailRule.findFirst({ where: { id: ruleId, accountSlug: account } });
  if (!rule) throw new Error(`Règle ${ruleId} introuvable pour ${account}.`);
  const where = ruleWhere(account, rule.matchType, rule.matchValue);
  const [total, rows] = await Promise.all([
    db.message.count({ where }),
    db.message.findMany({
      where,
      orderBy: { date: 'desc' },
      take: 500,
      select: { uid: true, subject: true, fromEmail: true, date: true },
    }),
  ]);
  return {
    rule: await toView(rule),
    total,
    items: rows.map((m) => ({
      uid: m.uid,
      subject: m.subject ?? '(sans sujet)',
      fromEmail: m.fromEmail ?? '',
      date: m.date?.toISOString() ?? null,
    })),
  };
}

/**
 * Applique une règle MAINTENANT (action validée par l'utilisateur) :
 * déplace les mails INBOX matchés vers le dossier cible (créé au besoin),
 * par lots de 200, et journalise l'opération avec la liste exacte.
 * La règle passe en `active` si elle était suggérée.
 */
export async function applyRule(
  rec: AccountRecord,
  ruleId: number,
  opts: { tool?: string } = {},
): Promise<{ moved: number; targetFolder: string; rule: MailRuleView }> {
  await ensureDbReady();
  const rule = await db.mailRule.findFirst({ where: { id: ruleId, accountSlug: rec.account } });
  if (!rule) throw new Error(`Règle ${ruleId} introuvable pour ${rec.account}.`);

  const where = ruleWhere(rec.account, rule.matchType, rule.matchValue);
  const matched = await db.message.findMany({
    where,
    orderBy: { date: 'desc' },
    take: 20_000,
    select: { uid: true, subject: true, date: true, folder: { select: { path: true } } },
  });

  let moved = 0;
  if (matched.length > 0) {
    // Le dossier cible peut ne pas exister encore (ex. « Newsletters »).
    try {
      await imapService.createFolder(rec, rule.targetFolder);
    } catch {
      /* existe déjà — imapflow renvoie une erreur bénigne */
    }
    // Groupé par dossier source (en pratique : l'INBOX), lots de 200.
    const byFolder = new Map<string, number[]>();
    for (const m of matched) {
      const arr = byFolder.get(m.folder.path) ?? [];
      arr.push(m.uid);
      byFolder.set(m.folder.path, arr);
    }
    for (const [folder, uids] of byFolder) {
      for (let i = 0; i < uids.length; i += APPLY_BATCH) {
        const batch = uids.slice(i, i + APPLY_BATCH);
        const r = await imapService.moveEmails(rec, folder, batch, rule.targetFolder);
        moved += r.moved;
      }
      await reflectBulkInIndex(rec.account, folder, uids, 'move');
    }
  }

  await recordOperation({
    account: rec.account,
    tool: opts.tool ?? 'ui_rule_apply',
    folder: 'INBOX',
    params: {
      rule: `${rule.matchType}=${rule.matchValue}`,
      destination: rule.targetFolder,
      count: moved,
    },
    affectedUids: matched.map((m) => m.uid),
    items: matched.map((m) => ({ subject: m.subject ?? '(sans sujet)', date: m.date?.toISOString() ?? null })),
    result: `règle appliquée : ${moved} mails -> ${rule.targetFolder}`,
  });

  const updated = await db.mailRule.update({
    where: { id: rule.id },
    data: {
      status: rule.status === 'suggested' ? 'active' : rule.status,
      appliedCount: { increment: moved },
      lastAppliedAt: new Date(),
    },
  });
  return { moved, targetFolder: rule.targetFolder, rule: await toView(updated) };
}

/** Modifie l'état d'une règle (validation, pause, auto, dossier cible). */
export async function updateRule(
  account: string,
  ruleId: number,
  patch: { status?: 'active' | 'paused'; autoApply?: boolean; targetFolder?: string },
): Promise<MailRuleView> {
  await ensureDbReady();
  const rule = await db.mailRule.findFirst({ where: { id: ruleId, accountSlug: account } });
  if (!rule) throw new Error(`Règle ${ruleId} introuvable pour ${account}.`);
  // GARDE-FOU : pas d'auto-application sur une règle non validée.
  const status = patch.status ?? (rule.status as 'active' | 'paused' | 'suggested');
  const autoApply = patch.autoApply ?? rule.autoApply;
  if (autoApply && status !== 'active') {
    throw new Error("L'application automatique exige une règle validée (active).");
  }
  const updated = await db.mailRule.update({
    where: { id: rule.id },
    data: {
      ...(patch.status ? { status: patch.status } : {}),
      ...(patch.autoApply !== undefined ? { autoApply: patch.autoApply } : {}),
      ...(patch.targetFolder ? { targetFolder: patch.targetFolder.trim() } : {}),
    },
  });
  return toView(updated);
}

/** Création manuelle d'une règle (directement active, choix de l'utilisateur). */
export async function createRule(
  account: string,
  input: { matchType: RuleMatchType; matchValue: string; targetFolder: string },
): Promise<MailRuleView> {
  await ensureDbReady();
  const matchValue = input.matchValue.trim();
  const targetFolder = input.targetFolder.trim();
  if (!matchValue || !targetFolder) throw new Error('Critère et dossier cible requis.');
  const rule = await db.mailRule.upsert({
    where: {
      accountSlug_matchType_matchValue: {
        accountSlug: account,
        matchType: input.matchType,
        matchValue,
      },
    },
    create: {
      accountSlug: account,
      matchType: input.matchType,
      matchValue,
      targetFolder,
      status: 'active',
      reason: 'Règle créée manuellement.',
    },
    update: { targetFolder, status: 'active' },
  });
  return toView(rule);
}

export async function deleteRule(account: string, ruleId: number): Promise<void> {
  await ensureDbReady();
  await db.mailRule.deleteMany({ where: { id: ruleId, accountSlug: account } });
}

/**
 * Application automatique post-sync : UNIQUEMENT les règles actives dont
 * l'utilisateur a coché « auto ». Non bloquant — une erreur n'arrête pas
 * la sync, elle est loggée.
 */
export async function runAutoRules(
  rec: AccountRecord,
  progress?: (m: string) => void,
): Promise<{ applied: number; moved: number }> {
  await ensureDbReady();
  const rules = await db.mailRule.findMany({
    where: { accountSlug: rec.account, status: 'active', autoApply: true },
  });
  let applied = 0;
  let moved = 0;
  for (const rule of rules) {
    const pending = await db.message.count({
      where: ruleWhere(rec.account, rule.matchType, rule.matchValue),
    });
    if (pending === 0) continue;
    try {
      const r = await applyRule(rec, rule.id, { tool: 'rule_auto_apply' });
      applied++;
      moved += r.moved;
      progress?.(`Règle auto « ${rule.matchValue} → ${rule.targetFolder} » : ${r.moved} mails rangés.`);
    } catch (err) {
      logger.warn('règle auto en échec', {
        account: rec.account,
        rule: rule.matchValue,
        error: (err as Error).message,
      });
    }
  }
  return { applied, moved };
}
