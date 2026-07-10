import { db, ensureDbReady } from '../db/client.js';
import { listAccountNames } from './accounts.js';
import { suggestRules, listRules, type MailRuleView } from './rules.js';
import { readOperations } from './oplog.js';
import { logger } from '../logger.js';

/**
 * Mode apprentissage (A6 — Cap V3). L'assistant observe les DÉCISIONS
 * (journal des opérations, index, corrections manuelles) et en tire des
 * SUGGESTIONS typées, chacune avec sa preuve en français. Il ne fait JAMAIS
 * rien tout seul : valider une suggestion passe par les mécanismes existants
 * (règles L7, stratégies A3, priorités A5), « Ignorer » est mémorisé.
 */

export interface RuleSuggestion {
  account: string;
  rule: MailRuleView;
}

export interface RetentionAutoSuggestion {
  policyId: number;
  key: string;
  label: string;
  runs: number;
  lastRunAt: string | null;
  evidence: string;
}

export interface PrioritySuggestion {
  account: string;
  email: string;
  name: string;
  priority: 'always_important' | 'never_urgent';
  evidence: string;
}

export interface Suggestions {
  rules: RuleSuggestion[];
  retentionAuto: RetentionAutoSuggestion[];
  priorities: PrioritySuggestion[];
  total: number;
}

/** Toutes les suggestions courantes (idempotent, index + journal only). */
export async function listSuggestions(): Promise<Suggestions> {
  await ensureDbReady();
  const dismissed = new Set(
    (await db.suggestionDismissal.findMany()).map((d) => `${d.kind}:${d.refKey}`),
  );

  // 1. Règles de classement (moteur L7 existant, idempotent) : « tu ranges
  //    toujours X dans Y » / grosses newsletters. Cycle de vie propre aux
  //    règles (valider/supprimer dans l'écran Règles ou ici).
  const rules: RuleSuggestion[] = [];
  for (const account of await listAccountNames()) {
    try {
      await suggestRules(account);
      for (const rule of await listRules(account)) {
        if (rule.status === 'suggested') rules.push({ account, rule });
      }
    } catch (err) {
      logger.warn('apprentissage : suggestions de règles en échec', {
        account,
        error: (err as Error).message,
      });
    }
  }

  // 2. Stratégies de rétention appliquées À LA MAIN ≥ 2 fois → proposer
  //    « auto » (le journal fait foi : chaque application y est).
  const ops = await readOperations(5000);
  const runsByPolicy = new Map<string, { runs: number; last: string | null }>();
  for (const op of ops) {
    const tool = String(op.tool ?? '');
    if (tool !== 'retention_apply' && tool !== 'grand_menage') continue;
    const key = String((op.params as Record<string, unknown> | undefined)?.policy ?? '');
    if (!key) continue;
    const cur = runsByPolicy.get(key) ?? { runs: 0, last: null };
    cur.runs += 1;
    const ts = typeof op.ts === 'string' ? op.ts : null;
    if (ts && (!cur.last || ts > cur.last)) cur.last = ts;
    runsByPolicy.set(key, cur);
  }
  const retentionAuto: RetentionAutoSuggestion[] = [];
  const policies = await db.retentionPolicy.findMany({
    where: { enabled: true, autoApply: false },
  });
  for (const p of policies) {
    const runs = runsByPolicy.get(p.key);
    if (!runs || runs.runs < 2) continue;
    if (dismissed.has(`retention_auto:retention:${p.key}`)) continue;
    retentionAuto.push({
      policyId: p.id,
      key: p.key,
      label: p.label,
      runs: runs.runs,
      lastRunAt: runs.last,
      evidence: `Tu l'as appliquée toi-même ${runs.runs} fois — elle pourrait tourner seule après chaque synchronisation.`,
    });
  }

  // 3. Priorités par relation. B5 : DEUX signaux concordants exigés — le
  //    comportement de lecture (lu/non-lu) ne suffit plus seul, il faut
  //    aussi l'interaction (réponses envoyées, étoiles, tâches) pour ⭐,
  //    ou son ABSENCE totale pour 🔕.
  const priorities: PrioritySuggestion[] = [];
  const senders = await db.sender.findMany({
    where: { priority: 'normal', messageCount: { gte: 10 } },
    select: {
      accountSlug: true,
      email: true,
      displayName: true,
      category: true,
      messageCount: true,
      unseenCount: true,
    },
  });

  // Signaux d'interaction par expéditeur (une requête par lot de candidats) :
  // conversation (fil avec un sortant), engagement (étoile/répondu), tâche.
  const interactions = new Map<string, { conv: boolean; engaged: boolean; tasked: boolean }>();
  const byAccount = new Map<string, string[]>();
  for (const s of senders) {
    const arr = byAccount.get(s.accountSlug) ?? [];
    arr.push(s.email);
    byAccount.set(s.accountSlug, arr);
  }
  for (const [account, emails] of byAccount) {
    for (let i = 0; i < emails.length; i += 500) {
      const batch = emails.slice(i, i + 500);
      const placeholders = batch.map(() => '?').join(',');
      const rows = await db.$queryRawUnsafe<
        { email: string; conv: number; engaged: number; tasked: number }[]
      >(
        `SELECT ms.fromEmail AS email,
                MAX(CASE WHEN mo.id IS NOT NULL THEN 1 ELSE 0 END) AS conv,
                MAX(CASE WHEN ms.isFlagged = 1 OR ms.isAnswered = 1 THEN 1 ELSE 0 END) AS engaged,
                MAX(CASE WHEN t.id IS NOT NULL THEN 1 ELSE 0 END) AS tasked
         FROM Message ms
         LEFT JOIN Message mo ON mo.threadId = ms.threadId AND mo.isOutbound = 1 AND mo.isDeleted = 0
         LEFT JOIN Task t ON t.messageId = ms.id
         WHERE ms.accountSlug = ? AND ms.isDeleted = 0 AND ms.isOutbound = 0
           AND ms.fromEmail IN (${placeholders})
         GROUP BY ms.fromEmail`,
        account,
        ...batch,
      );
      for (const r of rows) {
        interactions.set(`${account}|${r.email}`, {
          conv: Number(r.conv) === 1,
          engaged: Number(r.engaged) === 1,
          tasked: Number(r.tasked) === 1,
        });
      }
    }
  }

  for (const s of senders) {
    const ratio = s.unseenCount / s.messageCount;
    const inter = interactions.get(`${s.accountSlug}|${s.email}`) ?? {
      conv: false,
      engaged: false,
      tasked: false,
    };
    const hasInteraction = inter.conv || inter.engaged || inter.tasked;
    const interactionLabel = inter.conv
      ? 'tu lui as déjà répondu'
      : inter.engaged
        ? 'tu as suivi ⭐ ou marqué répondu un de ses mails'
        : 'tu as créé une tâche depuis un de ses mails';
    let suggestion: PrioritySuggestion | null = null;
    if (
      ratio === 0 &&
      hasInteraction &&
      (s.category === 'person' || s.category === 'company' || s.category === null)
    ) {
      suggestion = {
        account: s.accountSlug,
        email: s.email,
        name: s.displayName ?? s.email,
        priority: 'always_important',
        evidence: `Deux signaux concordants : tu as ouvert TOUS ses mails (${s.messageCount}) ET ${interactionLabel} — marquer ⭐ toujours important ?`,
      };
    } else if (s.messageCount >= 20 && ratio >= 0.9 && s.category !== 'person' && !hasInteraction) {
      suggestion = {
        account: s.accountSlug,
        email: s.email,
        name: s.displayName ?? s.email,
        priority: 'never_urgent',
        evidence: `Deux signaux concordants : tu n'ouvres presque jamais ses mails (${s.unseenCount}/${s.messageCount} non lus) et tu n'as JAMAIS interagi (ni réponse, ni ⭐, ni tâche) — marquer 🔕 jamais urgent ?`,
      };
    }
    if (!suggestion) continue;
    if (dismissed.has(`priority:priority:${s.accountSlug}|${s.email}|${suggestion.priority}`)) continue;
    priorities.push(suggestion);
  }

  return {
    rules,
    retentionAuto,
    priorities: priorities.slice(0, 20),
    total: rules.length + retentionAuto.length + Math.min(priorities.length, 20),
  };
}

const DISMISSAL_KINDS = ['retention_auto', 'priority'] as const;
export type DismissalKind = (typeof DISMISSAL_KINDS)[number];

/** « Ignorer » : mémorisé, la suggestion ne sera jamais reproposée. */
export async function dismissSuggestion(kind: DismissalKind, refKey: string): Promise<void> {
  await ensureDbReady();
  if (!DISMISSAL_KINDS.includes(kind)) throw new Error(`Type de suggestion inconnu : ${kind}`);
  if (!refKey || refKey.length > 300) throw new Error('refKey invalide.');
  await db.suggestionDismissal.upsert({
    where: { kind_refKey: { kind, refKey } },
    create: { kind, refKey },
    update: {},
  });
}
